import json
import logging
import threading
import time
from datetime import datetime, timezone

from sqlalchemy import text

from .cf_client import cf_api
from .content import is_translated, normalize_problem
from .database import (
    CachedProblem,
    ProblemsetLibrary,
    ProblemTag,
    SessionLocal,
    SystemConfig,
    UserStatusCache,
)
from .problem_service import start_translation_job

logger = logging.getLogger(__name__)
_user_status_cache_lock = threading.Lock()
_status_sync_lock = threading.Lock()
_library_sync_lock = threading.Lock()
_is_syncing_status = False
_status_generation = 0
_user_status_cache = {"handle": None, "last_fetched": 0, "last_attempt": 0,
                      "status_map": {}, "last_error": None, "status": "pending"}


def get_user_status_cache():
    with _status_sync_lock:
        syncing = _is_syncing_status
    with _user_status_cache_lock:
        return dict(_user_status_cache), syncing


def reset_user_status_cache():
    global _user_status_cache, _status_generation
    with _user_status_cache_lock:
        _status_generation += 1
        _user_status_cache = {"handle": None, "last_fetched": 0, "last_attempt": 0,
                              "status_map": {}, "last_error": None, "status": "pending"}


def trigger_bg_fetch_user_status(handle):
    global _is_syncing_status
    with _status_sync_lock:
        if _is_syncing_status:
            return
        with _user_status_cache_lock:
            if _user_status_cache["handle"] == handle and time.time() - _user_status_cache.get("last_attempt", 0) < 10:
                return
            generation = _status_generation
        _is_syncing_status = True
    threading.Thread(target=_bg_fetch_user_status, args=(handle, generation), daemon=True).start()


def _bg_fetch_user_status(handle, generation):
    global _user_status_cache, _is_syncing_status
    with _user_status_cache_lock:
        previous = dict(_user_status_cache) if _user_status_cache["handle"] == handle else {}
    status_map = dict(previous.get("status_map", {}))
    since = previous.get("last_fetched", 0) - 60 if previous.get("last_fetched") else None
    try:
        offset, size = 1, 1000
        while True:
            submissions = cf_api("user.status", {"handle": handle, "from": offset, "count": size})
            for submission in submissions:
                problem = submission.get("problem", {})
                cid = problem.get("contestId") or submission.get("contestId")
                index = problem.get("index")
                verdict = submission.get("verdict")
                if cid and index and verdict and verdict != "TESTING":
                    key = f"{cid}_{index.upper()}"
                    if verdict == "OK":
                        status_map[key] = "OK"
                    elif status_map.get(key) != "OK":
                        status_map[key] = "FAILED"
            if len(submissions) < size or (since is not None and submissions[-1].get("creationTimeSeconds", time.time()) < since):
                break
            offset += size
            with _user_status_cache_lock:
                if generation != _status_generation:
                    return
        now = time.time()
        with _user_status_cache_lock:
            if generation != _status_generation:
                return
            _user_status_cache = {"handle": handle, "last_fetched": now, "last_attempt": now,
                                  "status_map": status_map, "last_error": None, "status": "success"}
        with SessionLocal() as db:
            db.merge(UserStatusCache(handle=handle, status_json=json.dumps(status_map),
                                     updated_at=datetime.fromtimestamp(now, timezone.utc).replace(tzinfo=None)))
            db.commit()
    except Exception as exc:
        logger.warning("User status sync failed: %s", type(exc).__name__)
        with _user_status_cache_lock:
            if generation == _status_generation:
                previous = _user_status_cache if _user_status_cache["handle"] == handle else {}
                _user_status_cache = {"handle": handle, "last_fetched": previous.get("last_fetched", 0),
                                      "last_attempt": time.time(), "status_map": previous.get("status_map", {}),
                                      "last_error": "无法同步 CF 做题记录，请检查 Handle 和网络，稍后重试", "status": "failed"}
    finally:
        with _status_sync_lock:
            _is_syncing_status = False


def get_user_solved_status_map(db):
    global _user_status_cache
    config = db.get(SystemConfig, 1)
    handle = (config.cf_handle or "").strip() if config else ""
    if not handle:
        return {}
    with _user_status_cache_lock:
        if _user_status_cache["handle"] != handle:
            persisted = db.get(UserStatusCache, handle)
            if persisted:
                try:
                    last = persisted.updated_at.replace(tzinfo=timezone.utc).timestamp()
                    _user_status_cache = {"handle": handle, "last_fetched": last, "last_attempt": last,
                                          "status_map": json.loads(persisted.status_json),
                                          "last_error": None, "status": "success"}
                except (TypeError, ValueError):
                    logger.warning("Invalid persisted solved-status cache")
        cache = dict(_user_status_cache)
    if cache["handle"] != handle or time.time() - cache.get("last_attempt", 0) >= 300:
        trigger_bg_fetch_user_status(handle)
    return cache["status_map"] if cache["handle"] == handle else {}


def sync_problemset_library_internal(db, only_if_empty=False):
    """Replace the full library, tags and FTS index in one bounded-size transaction."""
    with _library_sync_lock:
        db.rollback()
        if only_if_empty and db.query(ProblemsetLibrary).count():
            return db.query(ProblemsetLibrary).count()
        db.rollback()
        result = cf_api("problemset.problems", ttl=60)
        problems = result.get("problems", [])
        if not problems:
            raise ValueError("CF 返回了空题库，已保留现有数据")
        stats = {f"{s.get('contestId')}_{s.get('index')}": s.get("solvedCount", 0)
                 for s in result.get("problemStatistics", [])}
        mappings, tags, fts = [], [], []
        seen = set()
        for problem in problems:
            cid, index = problem.get("contestId"), problem.get("index")
            if not cid or not index:
                continue
            pid = f"{cid}_{index}"
            if pid in seen:
                continue
            seen.add(pid)
            problem_tags = list(dict.fromkeys(problem.get("tags", [])))
            name = problem.get("name", pid)
            mappings.append({"id": pid, "contest_id": cid, "index": index, "name": name,
                             "rating": problem.get("rating"), "solved_count": stats.get(pid, 0),
                             "tags_json": json.dumps(problem_tags)})
            tags.extend({"problem_id": pid, "tag": tag} for tag in problem_tags)
            fts.append({"problem_id": pid, "name": name})
        if not mappings:
            raise ValueError("CF 返回的题库内容无效，已保留现有数据")
        try:
            db.query(ProblemTag).delete()
            db.query(ProblemsetLibrary).delete()
            db.execute(text("DELETE FROM problem_fts"))
            # Executemany binds one row at a time, avoiding SQLite's variable limit.
            for rows, table in ((mappings, ProblemsetLibrary.__table__), (tags, ProblemTag.__table__)):
                for offset in range(0, len(rows), 500):
                    db.execute(table.insert(), rows[offset:offset + 500])
            db.execute(text("INSERT INTO problem_fts (problem_id, name) VALUES (:problem_id, :name)"), fts)
            config = db.get(SystemConfig, 1)
            if config:
                config.problemset_updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
            db.commit()
        except Exception:
            db.rollback()
            raise
        return len(mappings)


_batch_queue_lock = threading.Lock()
_last_request_time = 0.0
_batch_queue = {"is_active": False, "total": 0, "completed": 0, "failed": 0, "mocked": 0,
                "current_problem": None, "remaining_problems": [], "cancel_flag": False,
                "timer_countdown": 0, "errors": []}


def _normalize_queue_problem(problem):
    return normalize_problem(int(str(problem.get("contest_id", "")).strip()), problem.get("index", ""))


def get_batch_queue_status():
    with _batch_queue_lock:
        return dict(_batch_queue, remaining_problems=list(_batch_queue["remaining_problems"]),
                    errors=list(_batch_queue["errors"]))


def cancel_batch_queue():
    with _batch_queue_lock:
        if _batch_queue["is_active"]:
            _batch_queue["cancel_flag"] = True


def start_batch_queue(problems_list, db_session_factory):
    global _batch_queue
    normalized, seen = [], set()
    for problem in problems_list:
        key = _normalize_queue_problem(problem)
        if key not in seen:
            seen.add(key)
            normalized.append({"contest_id": key[0], "index": key[1]})
    if not normalized:
        return "no_change", 0
    initial_count = len(normalized)
    with _batch_queue_lock:
        if _batch_queue["is_active"]:
            if _batch_queue["cancel_flag"]:
                return "cancelling", 0
            queued = {_normalize_queue_problem(p) for p in _batch_queue["remaining_problems"]}
            additions = [p for p in normalized if _normalize_queue_problem(p) not in queued
                         and f"{p['contest_id']}{p['index']}" != _batch_queue["current_problem"]]
            if len(_batch_queue["remaining_problems"]) + len(additions) > 500:
                raise ValueError("队列最多同时等待 500 道题目")
            _batch_queue["remaining_problems"].extend(additions)
            _batch_queue["total"] += len(additions)
            return ("appended" if additions else "no_change"), len(additions)
        _batch_queue = {"is_active": True, "total": len(normalized), "completed": 0, "failed": 0,
                        "mocked": 0, "current_problem": None, "remaining_problems": normalized,
                        "cancel_flag": False, "timer_countdown": 0, "errors": []}
        queue = _batch_queue
    threading.Thread(target=_bg_batch_translate, args=(db_session_factory, queue), daemon=True).start()
    return "started", initial_count


def _bg_batch_translate(db_session_factory, queue):
    global _last_request_time
    try:
        while True:
            with _batch_queue_lock:
                if queue["cancel_flag"] or not queue["remaining_problems"]:
                    # Publish completion atomically, so an append cannot be accepted
                    # after the worker has already decided to exit.
                    queue.update(is_active=False, current_problem=None, remaining_problems=[], timer_countdown=0)
                    return
                problem = queue["remaining_problems"].pop(0)
                cid, index = _normalize_queue_problem(problem)
                queue["current_problem"] = f"{cid}{index}"
            try:
                with db_session_factory() as db:
                    cached = db.get(CachedProblem, f"{cid}_{index}")
                    ready = bool(cached and is_translated(cached))
                    config = db.get(SystemConfig, 1)
                    cooldown = max(0, config.batch_cooldown or 0) if config else 60
                if not ready:
                    deadline = _last_request_time + cooldown
                    while time.monotonic() < deadline:
                        with _batch_queue_lock:
                            if queue["cancel_flag"]:
                                return
                            queue["timer_countdown"] = max(1, int(deadline - time.monotonic()))
                        time.sleep(min(0.5, max(0, deadline - time.monotonic())))
                    with _batch_queue_lock:
                        queue["timer_countdown"] = 0
                        if queue["cancel_flag"]:
                            return
                    _last_request_time = time.monotonic()
                    start_translation_job(cid, index, session_factory=db_session_factory, wait=True)
                with _batch_queue_lock:
                    queue["completed"] += 1
            except Exception as exc:
                logger.warning("Batch translation %s%s failed: %s", cid, index, type(exc).__name__)
                with _batch_queue_lock:
                    queue["failed"] += 1
                    queue["errors"] = (queue["errors"] + [f"{cid}{index}：{exc}"])[-20:]
    finally:
        with _batch_queue_lock:
            queue.update(is_active=False, current_problem=None, remaining_problems=[], timer_countdown=0)
