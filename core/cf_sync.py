import time
import json
import logging
import threading
import requests
from datetime import datetime

from .database import SystemConfig, ProblemsetLibrary, ContestCache, CachedProblem

logger = logging.getLogger(__name__)

# --- Codeforces User Authentication Config & Cache ---
_user_status_cache = {
    "handle": None,
    "last_fetched": 0,
    "status_map": {},  # Key: "contestId_index" -> "OK" / "FAILED"
    "last_error": None,
    "status": "pending"  # "success", "failed", or "pending"
}
_user_status_cache_lock = threading.Lock()
_status_sync_lock = threading.Lock()
_is_syncing_status = False

# Global dictionary to track in-progress translations and prevent duplicate parallel LLM calls
active_translations = {}
active_translations_lock = threading.Lock()


def get_active_translations():
    return active_translations, active_translations_lock


def get_user_status_cache():
    global _user_status_cache, _is_syncing_status
    with _user_status_cache_lock:
        return dict(_user_status_cache), _is_syncing_status


def reset_user_status_cache():
    global _user_status_cache
    with _user_status_cache_lock:
        _user_status_cache = {
            "handle": None,
            "last_fetched": 0,
            "status_map": {},
            "last_error": None,
            "status": "pending"
        }


def trigger_bg_fetch_user_status(handle: str):
    global _is_syncing_status
    with _status_sync_lock:
        if not _is_syncing_status:
            _is_syncing_status = True
            t = threading.Thread(target=_bg_fetch_user_status, args=(handle,))
            t.daemon = True
            t.start()


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
        trigger_bg_fetch_user_status(handle)

    if cache.get("handle") == handle:
        return cache.get("status_map", {})

    return {}


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
