"""Shared translation path for interactive requests and batch jobs."""
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

from .content import (
    FIELDS,
    HTML_FIELDS,
    is_translated,
    normalize_problem,
    sanitize_html,
)
from .database import CachedProblem, SessionLocal, create_cached_problem
from .scraper import scrape_cf_problem
from .translator import TranslationError, translate_problem

logger = logging.getLogger(__name__)
_guard = threading.Lock()
_locks = {}
_jobs = {}
_workers = ThreadPoolExecutor(max_workers=2, thread_name_prefix="translation")
_translation_slots = threading.BoundedSemaphore(2)
ACTIVE = {"queued", "scraping", "translating"}


class ProblemBusyError(ValueError):
    pass


def _job_snapshot(job):
    return {key: value for key, value in job.items() if key != "_done"}


def delete_cached_problems(db, ids=None):
    """Serialize deletion with job registration and in-flight cache writes."""
    db.rollback()
    with _guard:
        busy = set(_locks) | {pid for pid, job in _jobs.items() if job["phase"] in ACTIVE}
        if busy and (ids is None or busy.intersection(ids)):
            raise ProblemBusyError("有题目正在准备或翻译，请任务结束后再删除缓存")
        query = db.query(CachedProblem)
        if ids is not None:
            query = query.filter(CachedProblem.id.in_(ids))
        count = query.delete(synchronize_session=False)
        db.commit()
        return count


@contextmanager
def problem_lock(problem_id):
    # Reference counts include waiting callers; a live waiter must never lose its lock.
    with _guard:
        entry = _locks.setdefault(problem_id, [threading.Lock(), 0])
        entry[1] += 1
    try:
        with entry[0]:
            yield
    finally:
        with _guard:
            entry[1] -= 1
            if entry[1] == 0:
                del _locks[problem_id]


def original_data(problem):
    return {name: getattr(problem, name) for name in (
        "contest_id", "index", "time_limit", "memory_limit", "input_file", "output_file",
        "samples_json", *FIELDS,
    )}


def problem_data(problem):
    data = original_data(problem)
    for field in HTML_FIELDS:
        data[field] = sanitize_html(data[field])
    data["samples"] = json.loads(data.pop("samples_json") or "[]")
    for field in FIELDS:
        value = getattr(problem, "translated_" + field)
        data["translated_" + field] = sanitize_html(value) if field in HTML_FIELDS else value
    data["translation_status"] = problem.translation_status
    return data


def ensure_problem(contest_id, index, force=False, source=None, progress=None,
                   session_factory=SessionLocal):
    contest_id, index = normalize_problem(contest_id, index)
    problem_id = f"{contest_id}_{index}"
    notify = progress or (lambda phase: None)
    with problem_lock(problem_id), _translation_slots:
        with session_factory() as db:
            cached = db.get(CachedProblem, problem_id)
            if cached and is_translated(cached) and not force:
                return
            if source is None and cached:
                source = original_data(cached)
            db.rollback()
            if source is None:
                notify("scraping")
                source = scrape_cf_problem(contest_id, index)
            for field in HTML_FIELDS:
                source[field] = sanitize_html(source.get(field, ""))
            cached = db.get(CachedProblem, problem_id)
            if cached is None:
                db.add(create_cached_problem(problem_id, contest_id, index, source, {}))
                db.commit()  # Make the original readable before the LLM finishes.
            else:
                db.rollback()
            notify("translating")
            translated = translate_problem(source, db)
            replacement = create_cached_problem(problem_id, contest_id, index, source, translated)
            db.merge(replacement)
            db.commit()  # One atomic replacement; a failed refresh keeps the previous translation.


def get_translation_job(problem_id):
    with _guard:
        job = _jobs.get(problem_id)
        return _job_snapshot(job) if job else None


def start_translation_job(contest_id, index, force=False, source=None,
                          session_factory=SessionLocal, wait=False):
    contest_id, index = normalize_problem(contest_id, index)
    problem_id = f"{contest_id}_{index}"
    with _guard:
        old = _jobs.get(problem_id)
        if old and old["phase"] in ACTIVE:
            job, created = old, False
        else:
            if sum(j["phase"] in ACTIVE for j in _jobs.values()) >= 16:
                raise ValueError("等待翻译的题目较多，请稍后再试")
            for key in list(_jobs):
                if _jobs[key]["phase"] not in ACTIVE and time.time() - _jobs[key]["updated_at"] > 3600:
                    del _jobs[key]
            job = {"phase": "queued", "detail": "等待翻译", "updated_at": time.time(),
                   "_done": threading.Event()}
            _jobs[problem_id] = job
            created = True

    def update(phase, detail=""):
        with _guard:
            job.update(phase=phase, detail=detail, updated_at=time.time())

    def run():
        try:
            ensure_problem(contest_id, index, force, source, update, session_factory=session_factory)
            update("complete")
        except Exception as exc:
            logger.warning("Problem %s could not be translated: %s", problem_id, type(exc).__name__)
            detail = str(exc) if isinstance(exc, (ValueError, PermissionError)) else "题面准备失败，请检查网络与翻译配置后重试"
            if isinstance(exc, TranslationError):
                detail = str(exc)
            update("failed", detail)
        finally:
            job["_done"].set()

    if created:
        try:
            _workers.submit(run)
        except RuntimeError:
            update("failed", "本地服务正在关闭，请重启后重试")
            job["_done"].set()
    if wait:
        job["_done"].wait()
        if job["phase"] == "failed":
            raise TranslationError(job["detail"])
    with _guard:
        return _job_snapshot(job)
