import os
import time
import json
import logging
from logging.handlers import RotatingFileHandler
import threading
from datetime import datetime
from typing import Optional, List
from bs4 import BeautifulSoup
import requests
from flask import Flask, request, jsonify, render_template, redirect, url_for, g

from database import init_db, get_db, SystemConfig, LLMConfig, CachedProblem, ProblemsetLibrary, ContestCache
from scraper import scrape_cf_problem, HEADERS as CRAWLER_HEADERS
from translator import translate_problem, test_llm_connection, heal_latex_colors

# Advanced Logging Configuration
log_formatter = logging.Formatter(
    fmt="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)

file_handler = RotatingFileHandler("backend_app.log", maxBytes=10*1024*1024, backupCount=5, encoding="utf-8")
file_handler.setFormatter(log_formatter)

console_handler = logging.StreamHandler()
console_handler.setFormatter(log_formatter)

logging.basicConfig(level=logging.INFO, handlers=[file_handler, console_handler])
logger = logging.getLogger(__name__)

# Initialize Flask App
app = Flask(__name__, template_folder="templates", static_folder="static")

# Helper to get DB session inside Flask request lifecycle
def get_db():
    if 'db' not in g:
        from database import SessionLocal
        g.db = SessionLocal()
    return g.db

@app.teardown_appcontext
def teardown_db(exception=None):
    db = g.pop('db', None)
    if db is not None:
        db.close()

# Request source IP security validation check
@app.before_request
def check_client_ip():
    client_ip = request.remote_addr or "unknown"
    # Strictly reject non-local IP accesses for local self-use security
    if client_ip not in ("127.0.0.1", "::1", "localhost", "unknown"):
        logger.warning(f"Forbidden: Blocked access from non-local IP {client_ip} on path {request.path}")
        return jsonify({"detail": "Forbidden: This Codeforces Mirror server is strictly restricted to local machine access for security reasons."}), 403

# Helper to mask API keys for frontend security
def mask_api_key(key: str) -> str:
    if not key or key == "your_api_key_here":
        return ""
    if len(key) <= 8:
        return "****"
    return f"{key[:4]}...{key[-4:]}"

# Internal auto-sync helper if problem library is empty
def sync_problemset_library_internal(db):
    cf_url = "https://codeforces.com/api/problemset.problems"
    logger.info("Syncing Codeforces problemset list to SQLite (internal auto-trigger)...")
    try:
        response = requests.get(cf_url, timeout=20.0, headers={"User-Agent": "Mozilla/5.0"})
        if response.status_code == 200:
            data = response.json()
            if data.get("status") == "OK":
                result = data.get("result", {})
                problems = result.get("problems", [])
                statistics = result.get("problemStatistics", [])

                stats_map = {}
                for s in statistics:
                    cid = s.get("contestId")
                    idx = s.get("index")
                    if cid and idx:
                        stats_map[f"{cid}_{idx}"] = s.get("solvedCount", 0)

                mappings = []
                for p in problems:
                    cid = p.get("contestId")
                    idx = p.get("index")
                    name = p.get("name", "Unknown Problem")
                    if not cid or not idx:
                        continue

                    pid = f"{cid}_{idx}"
                    rating = p.get("rating")
                    solved_count = stats_map.get(pid, 0)
                    tags = p.get("tags", [])

                    mappings.append({
                        "id": pid,
                        "contest_id": cid,
                        "index": idx,
                        "name": name,
                        "rating": rating,
                        "solved_count": solved_count,
                        "tags_json": json.dumps(tags)
                    })

                db.query(ProblemsetLibrary).delete()
                db.bulk_insert_mappings(ProblemsetLibrary, mappings)
                db.commit()
                logger.info(f"Auto-sync complete. Cached {len(mappings)} problems.")
    except Exception as e:
        logger.error(f"Failed to run auto-sync library: {str(e)}")

# --- Codeforces User Authentication Config ---
_user_status_cache = {
    "handle": None,
    "last_fetched": 0,
    "status_map": {},  # Key: "contestId_index" -> "OK" / "FAILED"
    "last_error": None,
    "status": "pending"  # "success" or "failed" or "pending"
}
_user_status_cache_lock = threading.Lock()
_status_sync_lock = threading.Lock()
_is_syncing_status = False

def _bg_fetch_user_status(handle: str):
    global _user_status_cache, _is_syncing_status
    url = f"https://codeforces.com/api/user.status?handle={handle}&from=1&count=10000"
    error_msg = None
    try:
        logger.info(f"Background fetching Codeforces submissions history for user {handle}...")
        response = requests.get(url, timeout=10.0, headers={"User-Agent": "Mozilla/5.0"})
        if response.status_code == 200:
            data = response.json()
            if data.get("status") == "OK":
                submissions = data.get("result", [])
                status_map = {}
                # Sort submissions chronologically so that later OKs overwrite previous FAILEDs
                for s in reversed(submissions):
                    contest_id = s.get("contestId")
                    prob = s.get("problem", {})
                    index = prob.get("index")
                    verdict = s.get("verdict")

                    if contest_id and index:
                        key = f"{contest_id}_{index.upper()}"
                        if verdict == "OK":
                            status_map[key] = "OK"
                        else:
                            if status_map.get(key) != "OK":
                                status_map[key] = "FAILED"

                new_cache = {
                    "handle": handle,
                    "last_fetched": time.time(),
                    "status_map": status_map,
                    "last_error": None,
                    "status": "success"
                }
                with _user_status_cache_lock:
                    _user_status_cache = new_cache
                logger.info(f"Background user solved status cache updated for {handle}. Found {len(status_map)} unique problems.")
            else:
                error_msg = data.get("comment", "API returned non-OK status")
        else:
            error_msg = f"HTTP Error {response.status_code}"
    except Exception as e:
        error_msg = str(e)

    if error_msg:
        logger.error(f"Background error fetching user solved status from Codeforces API: {error_msg}")
        with _user_status_cache_lock:
            # Retain previous status_map as fallback
            prev_status_map = _user_status_cache.get("status_map", {}) if _user_status_cache.get("handle") == handle else {}
            new_cache = {
                "handle": handle,
                "last_fetched": time.time(),
                "status_map": prev_status_map,
                "last_error": error_msg,
                "status": "failed"
            }
            _user_status_cache = new_cache

    with _status_sync_lock:
        _is_syncing_status = False

def get_user_solved_status_map(db) -> dict:
    global _user_status_cache, _is_syncing_status

    config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
    if not config or not config.cf_handle:
        return {}

    handle = config.cf_handle.strip()
    if not handle:
        return {}

    current_time = time.time()
    with _user_status_cache_lock:
        cache = _user_status_cache

    is_handle_changed = (cache.get("handle") != handle)
    is_expired = (current_time - cache.get("last_fetched", 0)) >= 300  # 5 minutes TTL

    if (is_handle_changed or is_expired) and not _is_syncing_status:
        with _status_sync_lock:
            if not _is_syncing_status:
                _is_syncing_status = True
                t = threading.Thread(target=_bg_fetch_user_status, args=(handle,))
                t.daemon = True
                t.start()

    if cache.get("handle") == handle:
        return cache.get("status_map", {})

    return {}


# --- Page Routes (Jinja2 Rendered) ---

@app.route("/")
def index():
    return redirect(url_for("view_problemset"))

@app.route("/problemset")
def view_problemset():
    return render_template("problemset.html", active_tab="problemset")

@app.route("/dashboard")
def view_dashboard():
    return render_template("dashboard.html", active_tab="dashboard")

@app.route("/cached")
def view_cached_problems():
    db = get_db()
    # Query cached problems
    cached_list = db.query(CachedProblem, ProblemsetLibrary.rating).outerjoin(
        ProblemsetLibrary, CachedProblem.id == ProblemsetLibrary.id
    ).order_by(CachedProblem.created_at.desc()).all()

    # Get solved status map
    status_map = get_user_solved_status_map(db)

    problems = []
    for p, rating in cached_list:
        prob_key = f"{p.contest_id}_{p.index.strip().upper()}"
        problems.append({
            "id": p.id,
            "contest_id": p.contest_id,
            "index": p.index,
            "title": p.title,
            "translated_title": p.translated_title,
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "solved_status": status_map.get(prob_key, "NONE"),
            "rating": rating
        })

    return render_template("cached.html", active_tab="cached", problems=problems)

# Global dictionary to track in-progress translations and prevent duplicate parallel LLM calls
active_translations = {}
active_translations_lock = threading.Lock()

@app.route("/problem/<int:contest_id>/<string:index>")
def view_problem_page(contest_id, index):
    db = get_db()
    index_upper = index.strip().upper()
    problem_id = f"{contest_id}_{index_upper}"
    
    # 1. Check if cached
    cached = db.query(CachedProblem).filter(CachedProblem.id == problem_id).first()
    
    # 2. If not cached, trigger blocking scrape and translation
    if not cached:
        logger.info(f"Page request cache miss. Translating on-the-fly: {problem_id}")
        try:
            scraped_data = scrape_cf_problem(contest_id, index_upper)
            translated_data = translate_problem(scraped_data, db)
            
            is_mock = translated_data.get("is_mock", False)
            if not is_mock:
                new_cache = CachedProblem(
                    id=problem_id,
                    contest_id=contest_id,
                    index=index_upper,
                    title=scraped_data["title"],
                    time_limit=scraped_data["time_limit"],
                    memory_limit=scraped_data["memory_limit"],
                    input_file=scraped_data["input_file"],
                    output_file=scraped_data["output_file"],
                    description_html=scraped_data["description_html"],
                    input_spec_html=scraped_data["input_spec_html"],
                    output_spec_html=scraped_data["output_spec_html"],
                    samples_json=scraped_data["samples_json"],
                    note_html=scraped_data["note_html"],
                    translated_title=translated_data["translated_title"],
                    translated_description_html=translated_data["translated_description_html"],
                    translated_input_spec_html=translated_data["translated_input_spec_html"],
                    translated_output_spec_html=translated_data["translated_output_spec_html"],
                    translated_note_html=translated_data["translated_note_html"]
                )
                db.add(new_cache)
                db.commit()
                cached = new_cache
            else:
                # Mock translation object (temporary, don't write to DB)
                class TempCached:
                    pass
                cached = TempCached()
                cached.id = problem_id
                cached.contest_id = contest_id
                cached.index = index_upper
                cached.title = scraped_data["title"]
                cached.time_limit = scraped_data["time_limit"]
                cached.memory_limit = scraped_data["memory_limit"]
                cached.input_file = scraped_data["input_file"]
                cached.output_file = scraped_data["output_file"]
                cached.description_html = scraped_data["description_html"]
                cached.input_spec_html = scraped_data["input_spec_html"]
                cached.output_spec_html = scraped_data["output_spec_html"]
                cached.samples_json = scraped_data["samples_json"]
                cached.note_html = scraped_data["note_html"]
                cached.translated_title = translated_data["translated_title"]
                cached.translated_description_html = translated_data["translated_description_html"]
                cached.translated_input_spec_html = translated_data["translated_input_spec_html"]
                cached.translated_output_spec_html = translated_data["translated_output_spec_html"]
                cached.translated_note_html = translated_data["translated_note_html"]
        except Exception as e:
            logger.error(f"Failed to fetch/translate for page request: {str(e)}")
            # Redirect back to problemset on critical failure
            return redirect(url_for("view_problemset"))

    # Convert cached object to dictionary structures for template
    prob_data = {
        "contest_id": cached.contest_id,
        "index": cached.index,
        "title": cached.title,
        "time_limit": cached.time_limit,
        "memory_limit": cached.memory_limit,
        "input_file": cached.input_file,
        "output_file": cached.output_file,
        "description_html": cached.description_html,
        "input_spec_html": cached.input_spec_html,
        "output_spec_html": cached.output_spec_html,
        "samples": json.loads(cached.samples_json) if cached.samples_json else [],
        "note_html": cached.note_html,
        "translated_title": cached.translated_title,
        "translated_description_html": cached.translated_description_html,
        "translated_input_spec_html": cached.translated_input_spec_html,
        "translated_output_spec_html": cached.translated_output_spec_html,
        "translated_note_html": cached.translated_note_html
    }

    has_note = bool(prob_data["note_html"] or (prob_data["translated_note_html"]))

    return render_template("problem.html", active_tab="problem", problem=prob_data, has_note=has_note)

@app.route("/settings")
def view_settings_page():
    db = get_db()
    system_config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
    system_prompt = system_config.system_prompt if system_config else ""
    
    # LLM nodes
    llm_configs_list = db.query(LLMConfig).order_by(LLMConfig.priority.asc()).all()
    llm_configs = []
    for c in llm_configs_list:
        llm_configs.append({
            "id": c.id,
            "name": c.name,
            "api_key_configured": bool(c.api_key and c.api_key != "your_api_key_here"),
            "base_url": c.base_url,
            "model": c.model,
            "priority": c.priority,
            "is_active": c.is_active
        })

    # User config
    user_config = {
        "cf_handle": system_config.cf_handle or "",
        "cf_cookies_configured": bool(system_config.cf_cookies and system_config.cf_cookies.strip() not in ("", "your_cookies_here")),
    }

    return render_template("settings.html", active_tab="settings", system_prompt=system_prompt, llm_configs=llm_configs, user_config=user_config)


# --- REST API Endpoints (JSON) ---

@app.route("/api/config/system_prompt", methods=["GET", "POST"])
def api_system_prompt():
    db = get_db()
    if request.method == "POST":
        payload = request.json or {}
        config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
        if not config:
            config = SystemConfig(id=1)
            db.add(config)
        system_prompt = payload.get("system_prompt")
        if system_prompt is not None:
            config.system_prompt = system_prompt.strip()
        db.commit()
        return jsonify({"status": "success", "message": "系统提示词更新成功"})
    else:
        config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
        if not config:
            return jsonify({"detail": "Configuration not found"}), 404
        return jsonify({"system_prompt": config.system_prompt})

@app.route("/api/config/llm", methods=["GET", "POST"])
def api_llm_configs():
    db = get_db()
    if request.method == "POST":
        payload = request.json or {}
        config_id = payload.get("id")
        name = payload.get("name", "未命名 API").strip()
        api_key = payload.get("api_key")
        base_url = payload.get("base_url", "https://api.openai.com/v1").strip()
        model = payload.get("model", "gpt-4o-mini").strip()
        priority = payload.get("priority", 1)
        is_active = payload.get("is_active", True)

        if config_id:
            config = db.query(LLMConfig).filter(LLMConfig.id == config_id).first()
            if not config:
                return jsonify({"detail": "LLM 配置未找到"}), 404

            config.name = name
            config.base_url = base_url
            config.model = model
            config.priority = priority
            config.is_active = is_active

            if api_key and not (api_key.startswith("http") or "..." in api_key or api_key == "****"):
                config.api_key = api_key.strip()
        else:
            new_key = api_key.strip() if api_key else ""
            config = LLMConfig(
                name=name,
                api_key=new_key,
                base_url=base_url,
                model=model,
                priority=priority,
                is_active=is_active
            )
            db.add(config)

        db.commit()
        return jsonify({"status": "success", "message": "API 节点已保存并更新！"})
    else:
        configs = db.query(LLMConfig).order_by(LLMConfig.priority.asc()).all()
        results = []
        for c in configs:
            results.append({
                "id": c.id,
                "name": c.name,
                "api_key_masked": mask_api_key(c.api_key),
                "api_key_configured": bool(c.api_key and c.api_key != "your_api_key_here"),
                "base_url": c.base_url,
                "model": c.model,
                "priority": c.priority,
                "is_active": c.is_active
            })
        return jsonify(results)

@app.route("/api/config/llm/<int:config_id>", methods=["DELETE"])
def api_delete_llm_config(config_id):
    db = get_db()
    config = db.query(LLMConfig).filter(LLMConfig.id == config_id).first()
    if not config:
        return jsonify({"detail": "LLM 配置未找到"}), 404
    db.delete(config)
    db.commit()
    return jsonify({"status": "success", "message": "API 节点已成功删除！"})

@app.route("/api/config/test", methods=["POST"])
def api_test_config():
    db = get_db()
    payload = request.json or {}
    config_id = payload.get("id")
    api_key = payload.get("api_key", "").strip()
    base_url = payload.get("base_url", "").strip()
    model = payload.get("model", "").strip()

    if config_id and (not api_key or api_key == "****" or "..." in api_key):
        db_config = db.query(LLMConfig).filter(LLMConfig.id == config_id).first()
        if db_config:
            api_key = db_config.api_key

    if not api_key or api_key == "your_api_key_here":
        return jsonify({"detail": "API Key 不能为空"}), 400
    if not model:
        return jsonify({"detail": "Model 不能为空"}), 400

    try:
        reply = test_llm_connection(api_key, base_url, model)
        return jsonify({
            "status": "success",
            "message": "大模型接口连接测试成功！",
            "reply": reply
        })
    except Exception as e:
        return jsonify({"detail": f"连接测试失败：{str(e)}"}), 500

@app.route("/api/config/user", methods=["GET", "POST"])
def api_user_config():
    db = get_db()
    if request.method == "POST":
        payload = request.json or {}
        config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
        if not config:
            config = SystemConfig(id=1)
            db.add(config)

        cf_handle = payload.get("cf_handle", "").strip()
        cf_cookies = payload.get("cf_cookies")

        config.cf_handle = cf_handle

        if cf_cookies is not None and cf_cookies != "****" and cf_cookies.strip() != "":
            raw_cookies = cf_cookies.strip()
            if (raw_cookies.startswith("'") and raw_cookies.endswith("'")) or (raw_cookies.startswith('"') and raw_cookies.endswith('"')):
                raw_cookies = raw_cookies[1:-1].strip()
            config.cf_cookies = raw_cookies

        db.commit()

        # Reset status cache to trigger a fresh background fetch
        global _user_status_cache
        with _user_status_cache_lock:
            _user_status_cache = {
                "handle": None,
                "last_fetched": 0,
                "status_map": {},
                "last_error": None,
                "status": "pending"
            }
        return jsonify({"status": "success", "message": "Codeforces 账户登录信息已保存！"})
    else:
        config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
        if not config:
            return jsonify({"cf_handle": "", "cf_cookies_configured": False, "ac_sync_configured": False})
        return jsonify({
            "cf_handle": config.cf_handle or "",
            "cf_cookies_configured": bool(config.cf_cookies and config.cf_cookies.strip() not in ("", "your_cookies_here")),
            "cf_cookies_masked": "****" if config.cf_cookies else "",
            "ac_sync_configured": bool(config.cf_handle and config.cf_handle.strip())
        })

@app.route("/api/user/status-sync", methods=["GET", "POST"])
def api_status_sync():
    db = get_db()
    if request.method == "POST":
        config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
        if not config or not config.cf_handle:
            return jsonify({"detail": "未配置 Codeforces Handle"}), 400

        handle = config.cf_handle.strip()
        if not handle:
            return jsonify({"detail": "Codeforces Handle 不能为空"}), 400

        global _is_syncing_status
        with _status_sync_lock:
            if not _is_syncing_status:
                _is_syncing_status = True
                t = threading.Thread(target=_bg_fetch_user_status, args=(handle,))
                t.daemon = True
                t.start()

        return jsonify({"status": "success", "message": "已在后台启动 AC 状态同步"})
    else:
        config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
        handle = config.cf_handle.strip() if (config and config.cf_handle) else ""

        if not handle:
            return jsonify({
                "handle": "",
                "syncing": False,
                "last_fetched": 0,
                "problem_count": 0,
                "record_count": 0,
                "accepted_count": 0,
                "failed_count": 0,
                "last_error": None,
                "status": "pending"
            })

        global _user_status_cache
        with _user_status_cache_lock:
            cache = _user_status_cache
            is_syncing = _is_syncing_status

        if cache.get("handle") == handle:
            status_map = cache.get("status_map", {})
            record_count = len(status_map)
            accepted_count = sum(1 for v in status_map.values() if v == "OK")
            failed_count = sum(1 for v in status_map.values() if v == "FAILED")
            return jsonify({
                "handle": handle,
                "syncing": is_syncing,
                "last_fetched": cache.get("last_fetched", 0),
                "problem_count": record_count,
                "record_count": record_count,
                "accepted_count": accepted_count,
                "failed_count": failed_count,
                "last_error": cache.get("last_error"),
                "status": cache.get("status", "pending")
            })
        else:
            # Trigger background sync if handles mismatch
            with _status_sync_lock:
                if not _is_syncing_status:
                    _is_syncing_status = True
                    t = threading.Thread(target=_bg_fetch_user_status, args=(handle,))
                    t.daemon = True
                    t.start()
            return jsonify({
                "handle": handle,
                "syncing": True,
                "last_fetched": 0,
                "problem_count": 0,
                "record_count": 0,
                "accepted_count": 0,
                "failed_count": 0,
                "last_error": None,
                "status": "pending"
            })

@app.route("/api/problems/sync", methods=["GET"])
def api_sync_problems():
    db = get_db()
    cf_url = "https://codeforces.com/api/problemset.problems"
    logger.info("Syncing Codeforces problemset list to SQLite...")
    try:
        response = requests.get(cf_url, timeout=30.0, headers={"User-Agent": "Mozilla/5.0"})
        if response.status_code != 200:
            raise Exception(f"CF API HTTP Status: {response.status_code}")

        data = response.json()
        if data.get("status") != "OK":
            raise Exception(f"CF API error: {data.get('comment', 'Unknown')}")

        result = data.get("result", {})
        problems = result.get("problems", [])
        statistics = result.get("problemStatistics", [])

        stats_map = {}
        for s in statistics:
            cid = s.get("contestId")
            idx = s.get("index")
            if cid and idx:
                stats_map[f"{cid}_{idx}"] = s.get("solvedCount", 0)

        mappings = []
        for p in problems:
            cid = p.get("contestId")
            idx = p.get("index")
            name = p.get("name", "Unknown Problem")
            if not cid or not idx:
                continue

            pid = f"{cid}_{idx}"
            rating = p.get("rating")
            solved_count = stats_map.get(pid, 0)
            tags = p.get("tags", [])

            mappings.append({
                "id": pid,
                "contest_id": cid,
                "index": idx,
                "name": name,
                "rating": rating,
                "solved_count": solved_count,
                "tags_json": json.dumps(tags)
            })

        db.query(ProblemsetLibrary).delete()
        db.bulk_insert_mappings(ProblemsetLibrary, mappings)
        db.commit()
        logger.info(f"Sync complete. Cached {len(mappings)} problems locally.")
        return jsonify({"status": "success", "count": len(mappings)})
    except Exception as e:
        logger.error(f"Error syncing problemset: {str(e)}")
        return jsonify({"detail": f"同步官方题库失败，错误详情: {str(e)}"}), 500

@app.route("/api/problems", methods=["GET"])
def api_get_problems():
    db = get_db()
    query = request.args.get("query")
    tag = request.args.get("tag")
    
    min_rating = request.args.get("min_rating")
    max_rating = request.args.get("max_rating")
    min_rating = int(min_rating) if min_rating and min_rating.isdigit() else None
    max_rating = int(max_rating) if max_rating and max_rating.isdigit() else None
    
    sort_by = request.args.get("sort_by")
    sort_order = request.args.get("sort_order", "asc")
    
    page = request.args.get("page", 1, type=int)
    limit = request.args.get("limit", 50, type=int)

    count = db.query(ProblemsetLibrary).count()
    if count == 0:
        logger.info("Local problem library is empty. Auto-triggering sync...")
        sync_problemset_library_internal(db)

    query_obj = db.query(ProblemsetLibrary)

    if query:
        q = f"%{query.strip()}%"
        if query.strip().isdigit():
            query_obj = query_obj.filter(
                (ProblemsetLibrary.name.ilike(q)) |
                (ProblemsetLibrary.contest_id == int(query.strip()))
            )
        else:
            query_obj = query_obj.filter(
                (ProblemsetLibrary.name.ilike(q)) |
                (ProblemsetLibrary.id.ilike(q))
            )

    if tag:
        query_obj = query_obj.filter(ProblemsetLibrary.tags_json.like(f'%"{tag.strip()}"%'))

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
        r[0] for r in db.query(CachedProblem.id).filter(CachedProblem.id.in_(page_problem_ids)).all()
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

@app.route("/api/contests", methods=["GET"])
def api_get_contests():
    db = get_db()
    cache = db.query(ContestCache).filter(ContestCache.id == 1).first()
    if cache:
        cache_age = (datetime.utcnow() - cache.updated_at).total_seconds()
        if cache_age < 6 * 3600:
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

    logger.info("Local contest cache miss or expired. Fetching from Codeforces API...")
    cf_url = "https://codeforces.com/api/contest.list?gym=false"
    fetch_success = False
    upcoming = []
    finished = []

    try:
        response = requests.get(cf_url, timeout=10.0, headers={"User-Agent": "Mozilla/5.0"})
        if response.status_code == 200:
            data = response.json()
            if data.get("status") == "OK":
                contests = data.get("result", [])
                upcoming = [c for c in contests if c.get("phase") in ("BEFORE", "CODING")]
                finished = [c for c in contests if c.get("phase") not in ("BEFORE", "CODING")]

                upcoming = sorted(upcoming, key=lambda x: x.get("startTimeSeconds", 0))
                finished = sorted(finished, key=lambda x: x.get("startTimeSeconds", 0), reverse=True)
                fetch_success = True
    except Exception as e:
        logger.error(f"Network error fetching contests from Codeforces: {str(e)}")

    if fetch_success:
        try:
            db.query(ContestCache).filter(ContestCache.id == 1).delete()
            db.commit()
            new_cache = ContestCache(
                id=1,
                data_json=json.dumps({"upcoming": upcoming, "recent": finished}),
                updated_at=datetime.utcnow()
            )
            db.add(new_cache)
            db.commit()
            logger.info("Successfully updated local SQLite contest cache.")
        except Exception as cache_err:
            logger.error(f"Error writing contest cache to database: {str(cache_err)}")

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

        logger.warning("No cache available and CF is offline. Serving mock fallback!")
        return jsonify({
            "status": "fallback",
            "upcoming": [
                {"id": 1900, "name": "Codeforces Round 999 (Div. 2) [模拟数据]", "type": "CF", "phase": "BEFORE", "durationSeconds": 7200, "startTimeSeconds": 1780362231}
            ],
            "recent": [
                {"id": 1899, "name": "Codeforces Round 998 (Div. 3) [模拟数据]", "type": "CF", "phase": "FINISHED", "durationSeconds": 7200, "startTimeSeconds": 1780275831}
            ]
        })

@app.route("/api/contest/<int:contest_id>/problems", methods=["GET"])
def api_contest_problems(contest_id):
    db = get_db()
    logger.info(f"Fetching problem list for contest {contest_id}...")
    status_map = get_user_solved_status_map(db)

    # Step 1: Check local database (ProblemsetLibrary)
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

    # Step 2: Fallback to scraping the mirror contest page
    mirror_url = f"https://mirror.codeforces.com/contest/{contest_id}?locale=en"
    try:
        logger.info(f"Cache miss or empty local library. Scraping mirror contest page: {mirror_url}")
        response = requests.get(mirror_url, headers=CRAWLER_HEADERS, timeout=10.0)
        if response.status_code == 200 and "problems" in response.text:
            soup = BeautifulSoup(response.text, "html.parser")
            table = soup.find("table", class_="problems")
            if table:
                problems = []
                for tr in table.find_all("tr")[1:]:
                    tds = tr.find_all("td")
                    if len(tds) >= 2:
                        idx = tds[0].text.strip()
                        name_div = tds[1].find("div")
                        name = name_div.text.strip() if name_div else tds[1].text.strip()
                        name = name.split("\n")[0].strip()
                        problems.append({
                            "contest_id": contest_id,
                            "index": idx,
                            "name": name,
                            "type": "PROGRAMMING",
                            "rating": None,
                            "tags": [],
                            "solved_status": status_map.get(f"{contest_id}_{idx.upper()}", "NONE")
                        })

                contest_name = f"Contest {contest_id}"
                title_tag = soup.title
                if title_tag:
                    title_str = title_tag.text.strip()
                    if title_str.startswith("Dashboard - "):
                        contest_name = title_str[len("Dashboard - "):]
                        if contest_name.endswith(" - Codeforces"):
                            contest_name = contest_name[:-len(" - Codeforces")]

                logger.info(f"Successfully scraped problems from mirror page. Count: {len(problems)}")
                return jsonify({
                    "status": "success",
                    "contest": {
                        "id": contest_id,
                        "name": contest_name,
                        "type": "CF",
                        "phase": "FINISHED"
                    },
                    "problems": problems
                })
    except Exception as scrap_err:
        logger.error(f"Failed to scrape mirror contest page: {str(scrap_err)}")

    # Step 3: Fallback to official standings API
    cf_standings_url = f"https://codeforces.com/api/contest.standings?contestId={contest_id}"
    try:
        logger.info(f"Scraping failed. Falling back to official standings API: {cf_standings_url}")
        response = requests.get(cf_standings_url, timeout=20.0)
        if response.status_code == 200:
            data = response.json()
            if data.get("status") == "OK":
                result = data.get("result", {})
                problems = result.get("problems", [])
                contest = result.get("contest", {})

                logger.info(f"Successfully fetched problems from standings API. Count: {len(problems)}")
                return jsonify({
                    "status": "success",
                    "contest": {
                        "id": contest.get("id"),
                        "name": contest.get("name"),
                        "type": contest.get("type"),
                        "phase": contest.get("phase")
                    },
                    "problems": [
                        {
                            "contest_id": p.get("contestId"),
                            "index": p.get("index"),
                            "name": p.get("name"),
                            "type": p.get("type"),
                            "rating": p.get("rating"),
                            "tags": p.get("tags", []),
                            "solved_status": status_map.get(f"{p.get('contestId')}_{p.get('index', '').upper()}", "NONE")
                        }
                        for p in problems
                    ]
                })
    except Exception as api_err:
        logger.error(f"Failed to fetch from official standings API: {str(api_err)}")

    return jsonify({"detail": "无法获取该比赛的题目列表，请检查网络或稍后重试。"}), 500

@app.route("/api/problem/<int:contest_id>/<string:index>", methods=["GET"])
def api_get_problem(contest_id, index):
    db = get_db()
    force_refresh = request.args.get("force_refresh", "false").lower() == "true"
    index_upper = index.strip().upper()
    problem_id = f"{contest_id}_{index_upper}"

    # 1. Quick check cache first without lock
    if not force_refresh:
        cached = db.query(CachedProblem).filter(CachedProblem.id == problem_id).first()
        if cached:
            logger.info(f"Serving cached translation (quick check): {problem_id}")
            return jsonify({
                "status": "success",
                "source": "cache",
                "problem_id": problem_id,
                "contest_id": contest_id,
                "index": index_upper,
                "title": cached.title,
                "time_limit": cached.time_limit,
                "memory_limit": cached.memory_limit,
                "input_file": cached.input_file,
                "output_file": cached.output_file,
                "description_html": cached.description_html,
                "input_spec_html": cached.input_spec_html,
                "output_spec_html": cached.output_spec_html,
                "samples": json.loads(cached.samples_json) if cached.samples_json else [],
                "note_html": cached.note_html,
                "translated": {
                    "title": heal_latex_colors(cached.translated_title),
                    "description_html": heal_latex_colors(cached.translated_description_html),
                    "input_spec_html": heal_latex_colors(cached.translated_input_spec_html),
                    "output_spec_html": heal_latex_colors(cached.translated_output_spec_html),
                    "note_html": heal_latex_colors(cached.translated_note_html),
                }
            })

    # 2. Acquire or create a lock for this specific problem_id to prevent parallel race condition
    with active_translations_lock:
        if problem_id not in active_translations:
            active_translations[problem_id] = Lock = threading.Lock()
        problem_lock = active_translations[problem_id]

    with problem_lock:
        try:
            # Double-check cache inside lock
            if not force_refresh:
                cached = db.query(CachedProblem).filter(CachedProblem.id == problem_id).first()
                if cached:
                    logger.info(f"Serving cached translation after waiting on lock: {problem_id}")
                    return jsonify({
                        "status": "success",
                        "source": "cache",
                        "problem_id": problem_id,
                        "contest_id": contest_id,
                        "index": index_upper,
                        "title": cached.title,
                        "time_limit": cached.time_limit,
                        "memory_limit": cached.memory_limit,
                        "input_file": cached.input_file,
                        "output_file": cached.output_file,
                        "description_html": cached.description_html,
                        "input_spec_html": cached.input_spec_html,
                        "output_spec_html": cached.output_spec_html,
                        "samples": json.loads(cached.samples_json) if cached.samples_json else [],
                        "note_html": cached.note_html,
                        "translated": {
                            "title": heal_latex_colors(cached.translated_title),
                            "description_html": heal_latex_colors(cached.translated_description_html),
                            "input_spec_html": heal_latex_colors(cached.translated_input_spec_html),
                            "output_spec_html": heal_latex_colors(cached.translated_output_spec_html),
                            "note_html": heal_latex_colors(cached.translated_note_html),
                        }
                    })

            # Cache miss - proceed to scrape and translate
            logger.info(f"Cache miss for problem (executing translation): {problem_id}")
            try:
                scraped_data = scrape_cf_problem(contest_id, index_upper)
            except Exception as e:
                logger.error(f"Scraping failed: {str(e)}")
                return jsonify({"detail": f"无法从 Codeforces 获取该题目。详情: {str(e)}"}), 404

            translated_data = translate_problem(scraped_data, db)

            # Save to Cache ONLY if it's not a mock fallback!
            is_mock = translated_data.get("is_mock", False)
            if not is_mock:
                existing = db.query(CachedProblem).filter(CachedProblem.id == problem_id).first()
                if existing:
                    db.delete(existing)
                    db.commit()

                new_cache = CachedProblem(
                    id=problem_id,
                    contest_id=contest_id,
                    index=index_upper,
                    title=scraped_data["title"],
                    time_limit=scraped_data["time_limit"],
                    memory_limit=scraped_data["memory_limit"],
                    input_file=scraped_data["input_file"],
                    output_file=scraped_data["output_file"],
                    description_html=scraped_data["description_html"],
                    input_spec_html=scraped_data["input_spec_html"],
                    output_spec_html=scraped_data["output_spec_html"],
                    samples_json=scraped_data["samples_json"],
                    note_html=scraped_data["note_html"],
                    translated_title=translated_data["translated_title"],
                    translated_description_html=translated_data["translated_description_html"],
                    translated_input_spec_html=translated_data["translated_input_spec_html"],
                    translated_output_spec_html=translated_data["translated_output_spec_html"],
                    translated_note_html=translated_data["translated_note_html"]
                )

                db.add(new_cache)
                db.commit()

            return jsonify({
                "status": "success",
                "source": "mock" if is_mock else "network",
                "problem_id": problem_id,
                "contest_id": contest_id,
                "index": index_upper,
                "title": scraped_data["title"],
                "time_limit": scraped_data["time_limit"],
                "memory_limit": scraped_data["memory_limit"],
                "input_file": scraped_data["input_file"],
                "output_file": scraped_data["output_file"],
                "description_html": scraped_data["description_html"],
                "input_spec_html": scraped_data["input_spec_html"],
                "output_spec_html": scraped_data["output_spec_html"],
                "samples": json.loads(scraped_data["samples_json"]) if scraped_data["samples_json"] else [],
                "note_html": scraped_data["note_html"],
                "translated": {
                    "title": translated_data["translated_title"],
                    "description_html": translated_data["translated_description_html"],
                    "input_spec_html": translated_data["translated_input_spec_html"],
                    "output_spec_html": translated_data["translated_output_spec_html"],
                    "note_html": translated_data["translated_note_html"],
                }
            })
        finally:
            with active_translations_lock:
                if active_translations.get(problem_id) is problem_lock:
                    active_translations.pop(problem_id, None)

@app.route("/api/problem/<int:contest_id>/<string:index>", methods=["DELETE"])
def api_delete_problem(contest_id, index):
    db = get_db()
    problem_id = f"{contest_id}_{index.strip().upper()}"
    cached = db.query(CachedProblem).filter(CachedProblem.id == problem_id).first()
    if not cached:
        return jsonify({"detail": "未找到该题目的本地缓存"}), 404
    db.delete(cached)
    db.commit()
    return jsonify({"status": "success", "message": "已成功清除该题目的本地缓存"})


# Initialize DB tables on startup
init_db()
logger.info("Flask database initialized successfully.")

if __name__ == "__main__":
    # Standard development server launch on port 8000
    app.run(host="127.0.0.1", port=8000, debug=True)