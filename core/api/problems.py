import json
import logging
from datetime import datetime, timezone
from html import escape

from flask import jsonify, request
from sqlalchemy import text

from ..cf_client import cf_api
from ..cf_sync import (
    get_batch_queue_status,
    get_user_solved_status_map,
    sync_problemset_library_internal,
)
from ..content import is_translated, normalize_problem
from ..database import CachedProblem, ContestCache, ProblemsetLibrary, ProblemTag
from ..database import get_flask_db as get_db
from ..problem_service import (
    ACTIVE,
    ProblemBusyError,
    delete_cached_problems,
    get_translation_job,
    problem_data,
    start_translation_job,
)
from ..scraper import clean_latex, parse_problem_html, scrape_cf_contest_problems
from . import api_bp

logger = logging.getLogger(__name__)


@api_bp.route("/api/problems/sync", methods=["POST"])
def api_sync_problems():
    db = get_db()
    try:
        count = sync_problemset_library_internal(db)
        return jsonify({"status": "success", "count": count})
    except Exception as e:
        logger.error(f"Error syncing problemset: {str(e)}")
        return jsonify({"detail": f"同步官方题库失败，错误详情: {str(e)}"}), 500


@api_bp.route("/api/problems", methods=["GET"])
def api_get_problems():
    db = get_db()
    query = request.args.get("query")
    tag = request.args.get("tag")

    min_rating = request.args.get("min_rating")
    max_rating = request.args.get("max_rating")
    try:
        min_rating = int(min_rating) if min_rating else None
        max_rating = int(max_rating) if max_rating else None
    except ValueError:
        return jsonify({"detail": "难度应为整数"}), 400
    if any(r is not None and not 0 <= r <= 10000 for r in (min_rating, max_rating)):
        return jsonify({"detail": "难度应在 0 到 10000 之间"}), 400
    if min_rating is not None and max_rating is not None and min_rating > max_rating:
        return jsonify({"detail": "最低难度不能超过最高难度"}), 400
    if query and len(query) > 200:
        return jsonify({"detail": "搜索内容不能超过 200 个字符"}), 400

    sort_by = request.args.get("sort_by")
    sort_order = request.args.get("sort_order", "asc")

    try:
        page = int(request.args.get("page", "1"))
        limit = int(request.args.get("limit", "50"))
    except ValueError:
        return jsonify({"detail": "页码与每页数量必须是整数"}), 400
    if not 1 <= page <= 1000000:
        return jsonify({"detail": "页码应为 1 到 1000000 的整数"}), 400
    if limit is None or limit < 1 or limit > 100:
        return jsonify({"detail": "每页数量必须是 1 到 100 之间的整数"}), 400

    count = db.query(ProblemsetLibrary).count()
    if count == 0:
        logger.info("Local problem library is empty. Auto-triggering sync...")
        try:
            sync_problemset_library_internal(db, only_if_empty=True)
        except Exception as e:
            logger.warning("Initial library sync failed: %s", type(e).__name__)
            return jsonify({"detail": "首次同步题库失败，请检查网络后点击重试。已有缓存题目仍可阅读。"}), 502

    query_obj = db.query(ProblemsetLibrary)

    if tag:
        query_obj = query_obj.join(ProblemTag, ProblemsetLibrary.id == ProblemTag.problem_id).filter(ProblemTag.tag == tag.strip())

    if query:
        q_str = query.strip()
        if q_str.isascii() and q_str.isdigit() and len(q_str) <= 10:
            query_obj = query_obj.filter(
                (ProblemsetLibrary.contest_id == int(q_str)) |
                (ProblemsetLibrary.id.ilike(f"%{q_str}%"))
            )
        else:
            # FTS5 match query formatting
            clean_q = q_str.replace('"', '').replace("'", "")
            fts_match_expr = " OR ".join([f'"{word}"*' for word in clean_q.split() if word])

            # Keep full-text matches in SQL instead of materializing thousands of bound IDs.
            fts_condition = ProblemsetLibrary.id.in_(text(
                "SELECT problem_id FROM problem_fts WHERE problem_fts MATCH :fts_q"
            ).bindparams(fts_q=fts_match_expr)) if fts_match_expr else False
            query_obj = query_obj.filter(
                fts_condition |
                ProblemsetLibrary.id.ilike(f"%{q_str}%") |
                ProblemsetLibrary.name.ilike(f"%{q_str}%") |
                ProblemsetLibrary.id.in_(db.query(CachedProblem.id).filter(CachedProblem.translated_title.ilike(f"%{q_str}%")))
            )

    if min_rating is not None:
        query_obj = query_obj.filter(ProblemsetLibrary.rating >= min_rating)
    if max_rating is not None:
        query_obj = query_obj.filter(ProblemsetLibrary.rating <= max_rating)

    total = query_obj.count()

    if sort_by == "rating":
        if sort_order == "desc":
            query_obj = query_obj.order_by(
                ProblemsetLibrary.rating.is_(None),
                ProblemsetLibrary.rating.desc(),
                ProblemsetLibrary.contest_id.desc(),
                ProblemsetLibrary.index.asc()
            )
        else:
            query_obj = query_obj.order_by(
                ProblemsetLibrary.rating.is_(None),
                ProblemsetLibrary.rating.asc(),
                ProblemsetLibrary.contest_id.desc(),
                ProblemsetLibrary.index.asc()
            )
    else:
        query_obj = query_obj.order_by(
            ProblemsetLibrary.contest_id.desc(),
            ProblemsetLibrary.index.asc()
        )

    problems_list = query_obj.offset((page - 1) * limit).limit(limit).all()
    status_map = get_user_solved_status_map(db)

    page_problem_ids = [p.id for p in problems_list]
    cached_ids = set(
        r[0] for r in db.query(CachedProblem.id).filter(CachedProblem.id.in_(page_problem_ids), CachedProblem.translation_status == "translated").all()
    )

    problems_mapped = []
    for p in problems_list:
        problems_mapped.append({
            "id": p.id,
            "contest_id": p.contest_id,
            "index": p.index,
            "name": p.name,
            "rating": p.rating,
            "solved_count": p.solved_count,
            "tags": json.loads(p.tags_json) if p.tags_json else [],
            "solved_status": status_map.get(p.id, "NONE"),
            "is_cached": p.id in cached_ids
        })

    return jsonify({
        "status": "success",
        "total": total,
        "page": page,
        "limit": limit,
        "problems": problems_mapped
    })


@api_bp.route("/api/contests", methods=["GET"])
def api_get_contests():
    db = get_db()
    cache = db.query(ContestCache).filter(ContestCache.id == 1).first()
    if cache:
        cache_age = (datetime.now(timezone.utc).replace(tzinfo=None) - cache.updated_at).total_seconds()
        if cache_age < 15 * 60:
            logger.info(f"Serving contests list from local sqlite cache. Age: {cache_age:.1f}s")
            try:
                cached_data = json.loads(cache.data_json)
                return jsonify({
                    "status": "success",
                    "upcoming": cached_data.get("upcoming", []),
                    "recent": cached_data.get("recent", []),
                    "cached_at": cache.updated_at.isoformat()
                })
            except Exception as e:
                logger.error(f"Error parsing local contest cache: {str(e)}")

    fetch_success = False
    upcoming, finished = [], []
    try:
        contests = cf_api("contest.list", {"gym": "false"}, ttl=60)
        upcoming = sorted((c for c in contests if c.get("phase") in ("BEFORE", "CODING")),
                          key=lambda c: c.get("startTimeSeconds", 0))
        finished = sorted((c for c in contests if c.get("phase") not in ("BEFORE", "CODING")),
                          key=lambda c: c.get("startTimeSeconds", 0), reverse=True)
        fetch_success = True
    except Exception as exc:
        logger.warning("Unable to refresh contests: %s", type(exc).__name__)

    if fetch_success:
        try:
            new_cache = ContestCache(
                id=1,
                data_json=json.dumps({"upcoming": upcoming, "recent": finished}),
                updated_at=datetime.now(timezone.utc).replace(tzinfo=None)
            )
            db.merge(new_cache)
            db.commit()
            logger.info("Successfully updated local SQLite contest cache.")
        except Exception as cache_err:
            db.rollback()
            logger.error("Unable to write contest cache: %s", type(cache_err).__name__)

        return jsonify({
            "status": "success",
            "upcoming": upcoming,
            "recent": finished
        })
    else:
        if cache:
            try:
                cached_data = json.loads(cache.data_json)
                logger.warning("Codeforces API is offline. Serving expired database cache as safety fallback!")
                return jsonify({
                    "status": "success",
                    "upcoming": cached_data.get("upcoming", []),
                    "recent": cached_data.get("recent", []),
                    "fallback": True,
                    "cached_at": cache.updated_at.isoformat()
                })
            except Exception:
                pass

        return jsonify({"detail": "暂时无法连接 Codeforces，尚无比赛缓存，请稍后重试。"}), 502


@api_bp.route("/api/contest/<int:contest_id>/problems", methods=["GET"])
def api_contest_problems(contest_id):
    contest_id, _ = normalize_problem(contest_id, "A")
    db = get_db()
    logger.info(f"Fetching problem list for contest {contest_id}...")
    status_map = get_user_solved_status_map(db)

    try:
        local_probs = db.query(ProblemsetLibrary).filter(ProblemsetLibrary.contest_id == contest_id).all()
        if local_probs:
            logger.info(f"Serving problems for contest {contest_id} from local database. Count: {len(local_probs)}")
            contest_name = f"Contest {contest_id}"
            cache = db.query(ContestCache).filter(ContestCache.id == 1).first()
            if cache:
                try:
                    cached_data = json.loads(cache.data_json)
                    for c in cached_data.get("upcoming", []) + cached_data.get("recent", []):
                        if c.get("id") == contest_id:
                            contest_name = c.get("name")
                            break
                except Exception:
                    pass

            sorted_probs = sorted(local_probs, key=lambda x: x.index)
            return jsonify({
                "status": "success",
                "contest": {
                    "id": contest_id,
                    "name": contest_name,
                    "type": "CF",
                    "phase": "FINISHED"
                },
                "problems": [
                    {
                        "contest_id": p.contest_id,
                        "index": p.index,
                        "name": p.name,
                        "type": "PROGRAMMING",
                        "rating": p.rating,
                        "tags": json.loads(p.tags_json) if p.tags_json else [],
                        "solved_status": status_map.get(f"{p.contest_id}_{p.index.upper()}", "NONE")
                    }
                    for p in sorted_probs
                ]
            })
    except Exception as db_err:
        logger.error(f"Error querying local DB for contest problems: {str(db_err)}")

    try:
        # Public standings now disallow pagination and return the full scoreboard.
        # The contest overview supplies the few names/links this screen needs.
        db.rollback()
        result = scrape_cf_contest_problems(contest_id)
        contest = result.get("contest", {})
        return jsonify({"status": "success", "contest": contest, "problems": [
            {"contest_id": p.get("contest_id", contest_id), "index": p.get("index"),
             "name": p.get("name"), "type": p.get("type"), "rating": p.get("rating"),
             "tags": p.get("tags", []),
             "solved_status": status_map.get(f"{contest_id}_{p.get('index', '').upper()}", "NONE")}
            for p in result.get("problems", [])
        ]})
    except Exception as exc:
        logger.warning("Unable to fetch contest problems: %s", type(exc).__name__)
        return jsonify({"detail": "无法获取比赛题目，请检查网络或稍后重试。"}), 502


@api_bp.route("/api/problem/<int:contest_id>/<string:index>", methods=["GET"])
def api_get_problem(contest_id, index):
    contest_id, index = normalize_problem(contest_id, index)
    cached = get_db().get(CachedProblem, f"{contest_id}_{index}")
    if not cached:
        return jsonify({"detail": "尚无题面缓存，请先启动翻译"}), 404
    return jsonify({"status": "success", "source": "cache", "problem": problem_data(cached)})


@api_bp.route("/api/problem/<int:contest_id>/<string:index>/translate", methods=["POST"])
def api_translate_problem(contest_id, index):
    contest_id, index = normalize_problem(contest_id, index)
    payload = request.get_json(silent=True) or {}
    source = None
    statement = payload.get("statement")
    if type(payload.get("force", False)) is not bool:
        return jsonify({"detail": "force 必须是布尔值"}), 400
    if statement is not None:
        current = get_translation_job(f"{contest_id}_{index}")
        if current and current["phase"] in ACTIVE:
            return jsonify({"detail": "当前题面仍在准备，请任务结束后再导入"}), 409
        if not isinstance(statement, str) or not statement.strip() or len(statement) > 500000:
            return jsonify({"detail": "请粘贴英文题面，最多支持 50 万字符"}), 400
        if "problem-statement" in statement:
            source = parse_problem_html(statement, contest_id, index)
        else:
            source = {"contest_id": contest_id, "index": index, "title": f"{contest_id}{index}",
                      "description_html": '<div class="imported-statement">' + escape(clean_latex(statement)) + '</div>',
                      "input_spec_html": "", "output_spec_html": "", "note_html": "",
                      "samples_json": "[]", "time_limit": "", "memory_limit": "",
                      "input_file": "", "output_file": ""}
    job = start_translation_job(contest_id, index, force=bool(payload.get("force")) or source is not None, source=source)
    return jsonify(job), 202


@api_bp.route("/api/problem/<int:contest_id>/<string:index>/status", methods=["GET"])
def api_problem_status(contest_id, index):
    contest_id, index = normalize_problem(contest_id, index)
    problem_id = f"{contest_id}_{index}"
    cached = get_db().get(CachedProblem, problem_id)
    job = get_translation_job(problem_id) or {"phase": "idle", "detail": ""}
    return jsonify(dict(job, has_original=cached is not None, translated=bool(cached and is_translated(cached))))


@api_bp.route("/api/problem/<int:contest_id>/<string:index>", methods=["DELETE"])
def api_delete_problem(contest_id, index):
    db = get_db()
    contest_id, index = normalize_problem(contest_id, index)
    problem_id = f"{contest_id}_{index}"
    if get_batch_queue_status()["is_active"]:
        return jsonify({"detail": "批量任务仍在运行，请结束或取消后再删除缓存"}), 409
    try:
        count = delete_cached_problems(db, [problem_id])
    except ProblemBusyError as exc:
        return jsonify({"detail": str(exc)}), 409
    if not count:
        return jsonify({"detail": "未找到该题目的本地缓存"}), 404
    return jsonify({"status": "success", "message": "已成功清除该题目的本地缓存"})


@api_bp.route("/api/problems", methods=["DELETE"])
def api_delete_problems():
    db = get_db()
    payload = request.json or {}
    ids = payload.get("ids", [])
    delete_all = payload.get("all", False)

    if type(delete_all) is not bool or not isinstance(ids, list) or len(ids) > 500 or any(not isinstance(i, str) for i in ids):
        return jsonify({"detail": "删除参数格式不正确，单次最多 500 题"}), 400

    if not delete_all and not ids:
        return jsonify({"detail": "未指定要删除的题目列表"}), 400
    if get_batch_queue_status()["is_active"]:
        return jsonify({"detail": "批量任务仍在运行，请结束或取消后再删除缓存"}), 409
    try:
        num_deleted = delete_cached_problems(db, None if delete_all else ids)
    except ProblemBusyError as exc:
        return jsonify({"detail": str(exc)}), 409
    return jsonify({"status": "success", "message": f"已成功清除 {num_deleted} 道题目的本地缓存"})


@api_bp.route("/api/problem/submit", methods=["POST"])
def api_submit_solution():
    return jsonify({"detail": "请使用「复制代码并前往 CF」，在官网手动提交。"}), 410
