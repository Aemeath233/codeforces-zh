from fastapi import FastAPI, Depends, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
import httpx
import requests
import json
import logging
from logging.handlers import RotatingFileHandler
import time
from typing import Optional, List
from datetime import datetime
from bs4 import BeautifulSoup
from database import init_db, get_db, SystemConfig, LLMConfig, CachedProblem, ProblemsetLibrary, ContestCache
from scraper import scrape_cf_problem, HEADERS as CRAWLER_HEADERS
from translator import translate_problem, test_llm_connection

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

app = FastAPI(title="Codeforces Translation Mirror API")

@app.middleware("http")
async def log_requests(request: Request, call_next):
    start_time = time.time()
    client_ip = request.client.host if request.client else "unknown"
    method = request.method
    url = request.url.path
    
    try:
        response = await call_next(request)
        process_time = (time.time() - start_time) * 1000
        logger.info(f"[{client_ip}] {method} {url} - {response.status_code} - {process_time:.2f}ms")
        return response
    except Exception as e:
        process_time = (time.time() - start_time) * 1000
        logger.error(f"[{client_ip}] {method} {url} - 500 ERROR - {process_time:.2f}ms - {str(e)}", exc_info=True)
        raise e

# Setup CORS for development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize database tables
@app.on_event("startup")
def on_startup():
    init_db()
    logger.info("Database initialized successfully.")

# Helper to mask API keys for frontend security
def mask_api_key(key: str) -> str:
    if not key or key == "your_api_key_here":
        return ""
    if len(key) <= 8:
        return "****"
    return f"{key[:4]}...{key[-4:]}"

# --- Configuration Endpoints ---

@app.get("/api/config/system_prompt")
def get_system_prompt(db: Session = Depends(get_db)):
    config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
    if not config:
        raise HTTPException(status_code=404, detail="Configuration not found")
    return {"system_prompt": config.system_prompt}

@app.post("/api/config/system_prompt")
def update_system_prompt(payload: dict, db: Session = Depends(get_db)):
    config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
    if not config:
        config = SystemConfig(id=1)
        db.add(config)
    
    system_prompt = payload.get("system_prompt")
    if system_prompt is not None:
        config.system_prompt = system_prompt.strip()
    db.commit()
    return {"status": "success", "message": "系统提示词更新成功"}

@app.get("/api/config/llm")
def get_llm_configs(db: Session = Depends(get_db)):
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
    return results

@app.post("/api/config/llm")
def save_llm_config(payload: dict, db: Session = Depends(get_db)):
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
            raise HTTPException(status_code=404, detail="LLM 配置未找到")
            
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
    return {"status": "success", "message": "API 节点已保存并更新！"}

@app.delete("/api/config/llm/{config_id}")
def delete_llm_config(config_id: int, db: Session = Depends(get_db)):
    config = db.query(LLMConfig).filter(LLMConfig.id == config_id).first()
    if not config:
        raise HTTPException(status_code=404, detail="LLM 配置未找到")
        
    db.delete(config)
    db.commit()
    return {"status": "success", "message": "API 节点已成功删除！"}

@app.post("/api/config/test")
def test_config(payload: dict, db: Session = Depends(get_db)):
    config_id = payload.get("id")
    api_key = payload.get("api_key", "").strip()
    base_url = payload.get("base_url", "").strip()
    model = payload.get("model", "").strip()
    
    if config_id and (not api_key or api_key == "****" or "..." in api_key):
        db_config = db.query(LLMConfig).filter(LLMConfig.id == config_id).first()
        if db_config:
            api_key = db_config.api_key
            
    if not api_key or api_key == "your_api_key_here":
        raise HTTPException(status_code=400, detail="API Key 不能为空")
    if not model:
        raise HTTPException(status_code=400, detail="Model 不能为空")
        
    try:
        reply = test_llm_connection(api_key, base_url, model)
        return {
            "status": "success", 
            "message": "大模型接口连接测试成功！",
            "reply": reply
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"连接测试失败：{str(e)}")

# --- Codeforces User Authentication Config ---

@app.get("/api/config/user")
def get_user_auth(db: Session = Depends(get_db)):
    config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
    if not config:
        return {"cf_handle": "", "cf_cookies_configured": False}
    return {
        "cf_handle": config.cf_handle or "",
        "cf_cookies_configured": bool(config.cf_cookies and config.cf_cookies.strip() not in ("", "your_cookies_here")),
        "cf_cookies_masked": "****" if config.cf_cookies else ""
    }

@app.post("/api/config/user")
def update_user_auth(payload: dict, db: Session = Depends(get_db)):
    config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
    if not config:
        config = SystemConfig(id=1)
        db.add(config)
        
    cf_handle = payload.get("cf_handle", "").strip()
    cf_cookies = payload.get("cf_cookies")
    
    config.cf_handle = cf_handle
    
    # Do not overwrite if masked string is sent back
    if cf_cookies is not None and cf_cookies != "****" and cf_cookies.strip() != "":
        raw_cookies = cf_cookies.strip()
        # Strip outer quotes if they exist
        if (raw_cookies.startswith("'") and raw_cookies.endswith("'")) or (raw_cookies.startswith('"') and raw_cookies.endswith('"')):
            raw_cookies = raw_cookies[1:-1].strip()
        config.cf_cookies = raw_cookies
        
    db.commit()
    return {"status": "success", "message": "Codeforces 账户登录信息已保存！"}

# --- Codeforces Solution Direct Submission ---

@app.post("/api/submit")
def submit_solution(payload: dict, db: Session = Depends(get_db)):
    """
    Submits the solution code directly to Codeforces by simulating browser actions.
    Steps:
      1. Fetch saved Cookies and Handle.
      2. Perform a GET request to extract the current CSRF Token.
      3. Perform a POST request to submit the code block.
      4. Poll public API user.status to match and return the newly generated Submission ID.
    """
    contest_id = payload.get("contest_id")
    index = payload.get("index", "").strip().upper()
    program_type_id = payload.get("program_type_id")
    source_code = payload.get("source", "")
    
    if not contest_id or not index or not program_type_id or not source_code:
        raise HTTPException(status_code=400, detail="参数缺失，请提供比赛ID、题号、语言ID和源码。")
        
    # 1. Fetch credentials
    config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
    if not config or not config.cf_handle or not config.cf_cookies:
        raise HTTPException(
            status_code=400, 
            detail="请先前往“管理后台（设置）”，填写您的 Codeforces 用户名 (Handle) 和浏览器登录 Cookie！"
        )
        
    cf_handle = config.cf_handle.strip()
    cf_cookies = config.cf_cookies.strip()
    
    # Auto-strip any outer single or double quotes
    if (cf_cookies.startswith("'") and cf_cookies.endswith("'")) or (cf_cookies.startswith('"') and cf_cookies.endswith('"')):
        cf_cookies = cf_cookies[1:-1].strip()
        
    # Check if JSESSIONID is missing in the cookie
    has_jsessionid = "JSESSIONID" in cf_cookies
    
    # 2. Build custom request headers with the user's cookies
    client_headers = CRAWLER_HEADERS.copy()
    client_headers["Cookie"] = cf_cookies
    
    # Determine URL structure (Gym vs Regular Contest)
    is_gym = int(contest_id) > 100000
    base_domain = "https://mirror.codeforces.com"  # Using mirror site for maximum speed and lower Cloudflare friction
    
    contest_path = f"gym/{contest_id}" if is_gym else f"contest/{contest_id}"
    get_url = f"{base_domain}/{contest_path}/submit?locale=en"
    post_url = f"{base_domain}/{contest_path}/submit?action=submitSolution&locale=en"
    
    logger.info(f"Preparing direct submission for {contest_id}{index} via {cf_handle}...")
    
    try:
        # STEP A: GET CSRF Token
        # Using requests.Session to bypass protocol-level SSL handshake failures on Windows
        session = requests.Session()
        session.headers.update(client_headers)
        
        response_get = session.get(get_url, timeout=15.0)
        if response_get.status_code != 200:
            raise Exception(f"无法访问 Codeforces 提交页面，HTTP 状态码: {response_get.status_code}")
            
        # Strongly verify if we are logged in by checking the final URL
        if "submit" not in response_get.url:
            error_tip = "您的 Codeforces 登录 Cookie 已失效或不正确，无法访问提交页面！请在“管理后台”重新录入有效的 Cookie。"
            if not has_jsessionid:
                error_tip += " (提示：检测到您的 Cookie 中似乎缺少 JSESSIONID 字段，这通常是未复制完整 Cookie 导致的，请确保复制包含 JSESSIONID 的完整 Cookie 文字)"
            raise Exception(error_tip)
            
        soup = BeautifulSoup(response_get.text, "html.parser")
        
        # Check if user is actually logged in (if cookie is valid)
        # If the page contains a login form, cookies are expired
        login_form = soup.find("form", id="enterForm")
        if login_form or ("Login" in response_get.text and "Logout" not in response_get.text):
            raise Exception("您的 Codeforces 登录 Cookie 已失效或不正确，被系统拒之门外，请在“管理后台”重新录入！")
            
        # Extract csrf token
        csrf_token = None
        meta = soup.find("meta", {"name": "X-Csrf-Token"})
        if meta:
            csrf_token = meta.get("content")
        if not csrf_token:
            # Fallback check
            span = soup.find("span", class_="csrf-token")
            if span:
                csrf_token = span.get("data-csrf")
                
        if not csrf_token:
            raise Exception("未能在页面中提取到 CSRF 安全 Token，可能受到防火墙拦截或页面结构改变，请重试！")
            
        logger.info(f"Successfully retrieved CSRF Token. Submitting solution code...")
        
        # STEP B: POST Solution Code
        post_data = {
            "csrf_token": csrf_token,
            "action": "submitSolution",
            "submittedProblemIndex": index,
            "programTypeId": int(program_type_id),
            "source": source_code,
            "tabSize": 4,
            "sourceFile": ""
        }
        
        response_post = session.post(post_url, data=post_data, timeout=15.0)
        
        # If it redirected to a page that is not contest or gym (e.g. home page due to logout)
        if "contest" not in response_post.url and "gym" not in response_post.url:
            raise Exception("Codeforces 拒绝了提交，可能是登录 Cookie 已失效，导致提交时会话被强制退出。请重新录入有效 Cookie。")
            
        # If the final response URL is still the submit page, it indicates a warning/error (like identical code)
        if "submit" in response_post.url:
            post_soup = BeautifulSoup(response_post.text, "html.parser")
            # Look for warning alerts on the page
            error_span = post_soup.find("span", class_="error")
            if error_span:
                err_txt = error_span.text.strip()
                raise Exception(f"Codeforces 官网拒绝了您的提交：{err_txt}")
            else:
                raise Exception("Codeforces 拒绝了提交，可能是语言类型选择错误或代码与上一发完全相同。")
                
        logger.info("Submission POST complete. Querying recent submissions via public API to find Submission ID...")
        
        # STEP C: Poll user.status API in a retry loop to find the newly registered Submission ID
        # Codeforces API can take 3-5 seconds to register a new submission. We poll up to 5 times (1.5s interval).
        submission_id = None
        for attempt in range(5):
            time.sleep(1.5)
            logger.info(f"Polling user.status (attempt {attempt + 1}/5) for user {cf_handle}...")
            api_status_url = f"https://codeforces.com/api/user.status?handle={cf_handle}&from=1&count=10"
            try:
                api_res = session.get(api_status_url, timeout=10.0)
                if api_res.status_code == 200:
                    api_data = api_res.json()
                    if api_data.get("status") == "OK":
                        submissions = api_data.get("result", [])
                        # Match by contest_id and problem index
                        for s in submissions:
                            prob = s.get("problem", {})
                            if prob.get("contestId") == int(contest_id) and prob.get("index", "").upper() == index:
                                submission_id = s.get("id")
                                break
                if submission_id:
                    break
            except Exception as poll_err:
                logger.warning(f"Submission ID polling warning: {str(poll_err)}")
                
        if submission_id:
            logger.info(f"Successfully matched Submission ID: {submission_id}")
            return {
                "status": "success",
                "message": "代码已成功代提交至 Codeforces！正在为您实时监控评测进度...",
                "submission_id": submission_id
            }
                        
        # If API poll fails, return general success but warn user
        return {
            "status": "partial_success",
            "message": "代码已成功提交，但由于 Codeforces 官方 API 响应延迟，未能即时同步出评测 ID，请登录官网查看结果。",
            "submission_id": None
        }
        
    except Exception as e:
        logger.error(f"Failed to submit solution: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/api/submission/{submission_id}")
def check_submission_verdict(submission_id: int, db: Session = Depends(get_db)):
    """
    Polls the latest status/verdict of a specific submission ID.
    """
    config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
    if not config or not config.cf_handle:
        raise HTTPException(status_code=400, detail="用户名未配置")
        
    cf_handle = config.cf_handle.strip()
    api_url = f"https://codeforces.com/api/user.status?handle={cf_handle}&from=1&count=20"
    
    try:
        response = requests.get(api_url, timeout=10.0, headers={"User-Agent": "Mozilla/5.0"})
        if response.status_code != 200:
            raise Exception("API connection failed")
            
        data = response.json()
        if data.get("status") == "OK":
            submissions = data.get("result", [])
            for s in submissions:
                if s.get("id") == submission_id:
                    return {
                        "status": "success",
                        "id": s.get("id"),
                        "verdict": s.get("verdict"),  # TESTING, OK, WRONG_ANSWER, TIME_LIMIT_EXCEEDED, etc.
                        "passed_test_count": s.get("passedTestCount", 0),
                        "time_consumed_ms": s.get("timeConsumedMillis", 0),
                        "memory_consumed_bytes": s.get("memoryConsumedBytes", 0)
                    }
            raise HTTPException(status_code=404, detail="未找到该提交记录")
        else:
            raise Exception(data.get("comment", "API failed"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取提交结果失败: {str(e)}")

# --- Local Cache / Translated Problems Endpoints ---

@app.get("/api/problems/cached")
def get_cached_problems(db: Session = Depends(get_db)):
    """
    Returns all locally cached translated problems, sorted by translation date.
    """
    cached_list = db.query(
        CachedProblem,
        ProblemsetLibrary.rating
    ).outerjoin(
        ProblemsetLibrary,
        CachedProblem.id == ProblemsetLibrary.id
    ).order_by(
        CachedProblem.created_at.desc()
    ).all()
    
    # Fetch user solved status map
    status_map = get_user_solved_status_map(db)
    
    results = []
    for p, rating in cached_list:
        prob_key = f"{p.contest_id}_{p.index.strip().upper()}"
        results.append({
            "id": p.id,
            "contest_id": p.contest_id,
            "index": p.index,
            "title": p.title,
            "translated_title": p.translated_title,
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "solved_status": status_map.get(prob_key, "NONE"),
            "rating": rating
        })
    return {"status": "success", "problems": results}

@app.delete("/api/problem/{contest_id}/{index}")
def delete_cached_problem(contest_id: int, index: str, db: Session = Depends(get_db)):
    """
    Deletes the local cached translation of a specific problem.
    """
    problem_id = f"{contest_id}_{index.strip().upper()}"
    cached = db.query(CachedProblem).filter(CachedProblem.id == problem_id).first()
    if not cached:
        raise HTTPException(status_code=404, detail="未找到该题目的本地缓存")
    db.delete(cached)
    db.commit()
    return {"status": "success", "message": "已成功清除该题目的本地缓存"}

_user_status_cache = {
    "handle": None,
    "last_fetched": 0,
    "status_map": {}  # Key: "contestId_index" -> "OK" / "FAILED"
}

def get_user_solved_status_map(db: Session) -> dict:
    global _user_status_cache
    
    config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
    if not config or not config.cf_handle:
        return {}
        
    handle = config.cf_handle.strip()
    if not handle:
        return {}
        
    current_time = time.time()
    # Cache valid for 30 seconds
    if _user_status_cache["handle"] == handle and (current_time - _user_status_cache["last_fetched"]) < 30:
        return _user_status_cache["status_map"]
        
    url = f"https://codeforces.com/api/user.status?handle={handle}&from=1&count=10000"
    try:
        logger.info(f"Fetching Codeforces submissions history for user {handle}...")
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
                                
                _user_status_cache["handle"] = handle
                _user_status_cache["last_fetched"] = current_time
                _user_status_cache["status_map"] = status_map
                logger.info(f"User solved status cache updated for {handle}. Found {len(status_map)} unique problems.")
                return status_map
    except Exception as e:
        logger.error(f"Error fetching user solved status from Codeforces API: {str(e)}")
        if _user_status_cache["handle"] == handle:
            logger.info("Using expired user solved status cache as safety fallback.")
            return _user_status_cache["status_map"]
            
    return {}

# --- Problemset Library Endpoints ---

@app.get("/api/problems/sync")
def sync_problemset_library(db: Session = Depends(get_db)):
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
                
        db.query(ProblemsetLibrary).delete()
        db.commit()
        
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
            
        db.bulk_insert_mappings(ProblemsetLibrary, mappings)
        db.commit()
        logger.info(f"Sync complete. Cached {len(mappings)} problems locally.")
        return {"status": "success", "count": len(mappings)}
        
    except Exception as e:
        logger.error(f"Error syncing problemset: {str(e)}")
        raise HTTPException(status_code=500, detail=f"同步官方题库失败，错误详情: {str(e)}")

@app.get("/api/problems")
def get_problems(
    query: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    min_rating: Optional[int] = Query(None),
    max_rating: Optional[int] = Query(None),
    sort_by: Optional[str] = Query(None),
    sort_order: Optional[str] = Query("asc"),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_db)
):
    count = db.query(ProblemsetLibrary).count()
    if count == 0:
        logger.info("Local problem library is empty. Auto-triggering sync...")
        sync_problemset_library(db)
        
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
    
    # Rating sorting or default newest contest ordering
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
    
    # Fetch user solved status map
    status_map = get_user_solved_status_map(db)
    
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
            "solved_status": status_map.get(p.id, "NONE")
        })
        
    return {
        "status": "success",
        "total": total,
        "page": page,
        "limit": limit,
        "problems": problems_mapped
    }

# --- Codeforces Data Endpoints ---

@app.get("/api/contests")
def get_contests(db: Session = Depends(get_db)):
    # 1. Check database cache
    cache = db.query(ContestCache).filter(ContestCache.id == 1).first()
    if cache:
        # Check if the cache is older than 6 hours (21600 seconds)
        cache_age = (datetime.utcnow() - cache.updated_at).total_seconds()
        if cache_age < 6 * 3600:
            logger.info(f"Serving contests list from local sqlite cache. Age: {cache_age:.1f}s")
            try:
                cached_data = json.loads(cache.data_json)
                return {
                    "status": "success",
                    "upcoming": cached_data.get("upcoming", []),
                    "recent": cached_data.get("recent", []),
                    "cached_at": cache.updated_at.isoformat()
                }
            except Exception as e:
                logger.error(f"Error parsing local contest cache: {str(e)}")
    
    # 2. Cache miss or expired, fetch from Codeforces
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
        else:
            logger.warning(f"Failed to fetch contests from CF. HTTP Status: {response.status_code}")
    except Exception as e:
        logger.error(f"Network error fetching contests from Codeforces: {str(e)}")
        
    if fetch_success:
        # 3. Save new data to database cache
        try:
            # Delete existing
            db.query(ContestCache).filter(ContestCache.id == 1).delete()
            db.commit()
            
            # Save new
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
            
        return {
            "status": "success",
            "upcoming": upcoming,
            "recent": finished
        }
    else:
        # 4. Fetch failed, fallback to expired cache if available!
        if cache:
            try:
                cached_data = json.loads(cache.data_json)
                logger.warning("Codeforces API is offline. Serving expired database cache as safety fallback!")
                return {
                    "status": "success",
                    "upcoming": cached_data.get("upcoming", []),
                    "recent": cached_data.get("recent", []),
                    "fallback": True,
                    "cached_at": cache.updated_at.isoformat()
                }
            except Exception:
                pass
                
        # 5. Last resort fallback to mock data
        logger.warning("No cache available and CF is offline. Serving mock fallback!")
        return {
            "status": "fallback",
            "upcoming": [
                {"id": 1900, "name": "Codeforces Round 999 (Div. 2) [模拟数据]", "type": "CF", "phase": "BEFORE", "durationSeconds": 7200, "startTimeSeconds": 1780362231}
            ],
            "recent": [
                {"id": 1899, "name": "Codeforces Round 998 (Div. 3) [模拟数据]", "type": "CF", "phase": "FINISHED", "durationSeconds": 7200, "startTimeSeconds": 1780275831}
            ]
        }

@app.get("/api/contest/{contest_id}/problems")
async def get_contest_problems(contest_id: int, db: Session = Depends(get_db)):
    """
    Fetches the list of problems in a specific Codeforces contest.
    Strategy:
    1. First check the local SQLite database (ProblemsetLibrary) to see if the contest's problems are cached.
       This is extremely fast (< 1ms).
    2. If not in DB, scrape the contest page from the mirror site (https://mirror.codeforces.com/contest/{contest_id}?locale=en)
       which has no Cloudflare protection and is very fast (~500ms).
    3. If scraping mirror fails, fallback to the official Codeforces API (https://codeforces.com/api/contest.standings?contestId={contest_id})
       without extra parameters (like from/count), which is slow (~3s) but guaranteed.
    """
    logger.info(f"Fetching problem list for contest {contest_id}...")
    
    # Get user solved status map
    status_map = get_user_solved_status_map(db)
    
    # Step 1: Check local database (ProblemsetLibrary)
    try:
        local_probs = db.query(ProblemsetLibrary).filter(ProblemsetLibrary.contest_id == contest_id).all()
        if local_probs:
            logger.info(f"Serving problems for contest {contest_id} from local database. Count: {len(local_probs)}")
            # Try to get contest name from ContestCache
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
            
            # Sort problems naturally by index (e.g. A, B, C1, C2...)
            sorted_probs = sorted(local_probs, key=lambda x: x.index)
            return {
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
            }
    except Exception as db_err:
        logger.error(f"Error querying local DB for contest problems: {str(db_err)}")
    
    # Step 2: Fallback to scraping the mirror contest page
    mirror_url = f"https://mirror.codeforces.com/contest/{contest_id}?locale=en"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    try:
        logger.info(f"Cache miss or empty local library. Scraping mirror contest page: {mirror_url}")
        response = requests.get(mirror_url, headers=headers, timeout=10.0)
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
                        # Remove extra newlines
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
                
                # Extract contest name from title
                contest_name = f"Contest {contest_id}"
                title_tag = soup.title
                if title_tag:
                    title_str = title_tag.text.strip()
                    if title_str.startswith("Dashboard - "):
                        contest_name = title_str[len("Dashboard - "):]
                        if contest_name.endswith(" - Codeforces"):
                            contest_name = contest_name[:-len(" - Codeforces")]
                
                logger.info(f"Successfully scraped problems from mirror page. Count: {len(problems)}")
                return {
                    "status": "success",
                    "contest": {
                        "id": contest_id,
                        "name": contest_name,
                        "type": "CF",
                        "phase": "FINISHED"
                    },
                    "problems": problems
                }
    except Exception as scrap_err:
        logger.error(f"Failed to scrape mirror contest page: {str(scrap_err)}")
        
    # Step 3: Fallback to the official standings API without parameters
    # (This is 8.4MB but guaranteed to work)
    cf_standings_url = f"https://codeforces.com/api/contest.standings?contestId={contest_id}"
    try:
        logger.info(f"Scraping failed. Falling back to official standings API: {cf_standings_url}")
        async with httpx.AsyncClient() as client:
            response = await client.get(cf_standings_url, timeout=20.0)
            if response.status_code == 200:
                data = response.json()
                if data.get("status") == "OK":
                    result = data.get("result", {})
                    problems = result.get("problems", [])
                    contest = result.get("contest", {})
                    
                    logger.info(f"Successfully fetched problems from standings API. Count: {len(problems)}")
                    return {
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
                    }
    except Exception as api_err:
        logger.error(f"Failed to fetch from official standings API: {str(api_err)}")
        
    # If all else fails
    raise HTTPException(status_code=500, detail="无法获取该比赛的题目列表，请检查网络或稍后重试。")


from threading import Lock

# Global dictionary to track in-progress translations and prevent duplicate parallel LLM calls
active_translations = {}
active_translations_lock = Lock()

@app.get("/api/problem/{contest_id}/{index}")
def get_problem(contest_id: int, index: str, force_refresh: bool = False, db: Session = Depends(get_db)):
    index_upper = index.strip().upper()
    problem_id = f"{contest_id}_{index_upper}"
    
    # 1. Quick check cache first without lock
    if not force_refresh:
        cached = db.query(CachedProblem).filter(CachedProblem.id == problem_id).first()
        if cached:
            logger.info(f"Serving cached translation (quick check): {problem_id}")
            return {
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
                    "title": cached.translated_title,
                    "description_html": cached.translated_description_html,
                    "input_spec_html": cached.translated_input_spec_html,
                    "output_spec_html": cached.translated_output_spec_html,
                    "note_html": cached.translated_note_html,
                }
            }
            
    # 2. Acquire or create a lock for this specific problem_id to prevent parallel race condition
    with active_translations_lock:
        if problem_id not in active_translations:
            active_translations[problem_id] = Lock()
        problem_lock = active_translations[problem_id]
        
    with problem_lock:
        # Double-check cache inside lock (in case another thread just completed it)
        if not force_refresh:
            cached = db.query(CachedProblem).filter(CachedProblem.id == problem_id).first()
            if cached:
                logger.info(f"Serving cached translation after waiting on lock: {problem_id}")
                return {
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
                        "title": cached.translated_title,
                        "description_html": cached.translated_description_html,
                        "input_spec_html": cached.translated_input_spec_html,
                        "output_spec_html": cached.translated_output_spec_html,
                        "note_html": cached.translated_note_html,
                    }
                }
                
        # Cache miss - proceed to scrape and translate
        logger.info(f"Cache miss for problem (executing translation): {problem_id}")
        try:
            scraped_data = scrape_cf_problem(contest_id, index_upper)
        except Exception as e:
            logger.error(f"Scraping failed: {str(e)}")
            raise HTTPException(status_code=404, detail=f"无法从 Codeforces 获取该题目。详情: {str(e)}")
            
        translated_data = translate_problem(scraped_data, db)
        
        # Save to Cache
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
        
        # Clean up the lock from the active dict safely to save memory
        with active_translations_lock:
            active_translations.pop(problem_id, None)
            
        return {
            "status": "success",
            "source": "network",
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
        }
