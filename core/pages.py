import logging

from flask import Blueprint, redirect, render_template, request, url_for

from .cf_sync import get_user_solved_status_map
from .content import normalize_problem
from .database import CachedProblem, LLMConfig, ProblemsetLibrary, SystemConfig
from .database import get_flask_db as get_db
from .problem_service import get_translation_job, problem_data

logger = logging.getLogger(__name__)

pages_bp = Blueprint("pages", __name__)


@pages_bp.route("/")
def index():
    return redirect(url_for("pages.view_problemset"))


@pages_bp.route("/problemset")
def view_problemset():
    return render_template("problemset.html", active_tab="problemset")


@pages_bp.route("/dashboard")
def view_dashboard():
    return render_template("dashboard.html", active_tab="dashboard")


@pages_bp.route("/cached")
def view_cached_problems():
    db = get_db()
    total = db.query(CachedProblem).count()
    page = min(max(1, request.args.get("page", 1, type=int)), max(1, (total + 49) // 50))
    cached_list = db.query(CachedProblem, ProblemsetLibrary.rating).outerjoin(
        ProblemsetLibrary, CachedProblem.id == ProblemsetLibrary.id
    ).order_by(CachedProblem.created_at.desc()).offset((page - 1) * 50).limit(50).all()

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
            "rating": rating,
            "translation_status": p.translation_status
        })

    return render_template("cached.html", active_tab="cached", problems=problems, page=page, total=total)


@pages_bp.route("/problem/<int:contest_id>/<string:index>")
def view_problem_page(contest_id, index):
    db = get_db()
    contest_id, index_upper = normalize_problem(contest_id, index)
    problem_id = f"{contest_id}_{index_upper}"
    
    # 1. Check if cached
    cached = db.query(CachedProblem).filter(CachedProblem.id == problem_id).first()
    
    if not cached:
        logger.info(f"Page request cache miss. Rendering async loading page: {problem_id}")
        return render_template(
            "problem_loading.html",
            active_tab="problem",
            contest_id=contest_id,
            index=index_upper
        )

    # Convert cached object to dictionary structures for template
    prob_data = problem_data(cached)

    has_note = bool(prob_data["note_html"] or (prob_data["translated_note_html"]))

    return render_template("problem.html", active_tab="problem", problem=prob_data, has_note=has_note,
                           translation_job=get_translation_job(problem_id))


@pages_bp.route("/settings")
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
        "cf_cookies_configured": False,
        "batch_cooldown": system_config.batch_cooldown if system_config.batch_cooldown is not None else 60
    }

    # Cache Stats
    total_cached = db.query(CachedProblem).count()
    total_library = db.query(ProblemsetLibrary).count()

    return render_template(
        "settings.html",
        active_tab="settings",
        system_prompt=system_prompt,
        llm_configs=llm_configs,
        user_config=user_config,
        total_cached=total_cached,
        total_library=total_library
    )
