"""One process-wide request gate for the public CF API (one request per 2 seconds)."""
import copy
import threading
import time

import requests

_lock = threading.Lock()
_last_request = 0.0
_cache = {}


def cf_api(method, params=None, ttl=0):
    global _last_request
    params = dict(params or {}, lang="en")
    key = (method, tuple(sorted(params.items())))
    with _lock:
        cached = _cache.get(key)
        if cached and time.monotonic() - cached[0] < ttl:
            return copy.deepcopy(cached[1])
        delay = 2.1 - (time.monotonic() - _last_request)
        if delay > 0:
            time.sleep(delay)
        _last_request = time.monotonic()
        response = requests.get(f"https://codeforces.com/api/{method}", params=params,
                                timeout=(5, 25), headers={"User-Agent": "CFMirror/0.2 (local practice)"})
        response.raise_for_status()
        data = response.json()
        if data.get("status") != "OK":
            raise ValueError(data.get("comment", "Codeforces API 请求失败"))
        if ttl:
            if len(_cache) > 128:
                _cache.clear()
            _cache[key] = (time.monotonic(), data["result"])
        return data["result"]
