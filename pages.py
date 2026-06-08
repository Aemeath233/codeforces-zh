import json
import logging
from flask import Blueprint, render_template, redirect, url_for

from database import get_flask_db as get_db, SystemConfig, LLMConfig, CachedProblem, ProblemsetLibrary
from scraper import scrape_cf_problem
from translator import translate_problem
from cf_sync import get_user_solved_status_map, get_active_translations

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


@pages_bp.route("/problem/<int:contest_id>/<string:index>")
def view_problem_page(contest_id, index):
    db = get_db()
    index_upper = index.strip().upper()
    problem_id = f"{contest_id}_{index_upper}"
    
    # 1. Check if cached
    cached = db.query(CachedProblem).filter(CachedProblem.id == problem_id).first()
    
    # 2. If not cached, trigger blocking scrape and translation
    if not cached:
        logger.info(f"Page request cache miss. Translating on-the-fly: {problem_id}")
        
        active_translations, active_translations_lock = get_active_translations()
        with active_translations_lock:
            if problem_id not in active_translations:
                import threading
                active_translations[problem_id] = threading.Lock()
            problem_lock = active_translations[problem_id]
            
        with problem_lock:
            # Double check cache inside lock
            cached = db.query(CachedProblem).filter(CachedProblem.id == problem_id).first()
            if not cached:
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
                    return redirect(url_for("pages.view_problemset"))
                finally:
                    with active_translations_lock:
                        if active_translations.get(problem_id) is problem_lock:
                            active_translations.pop(problem_id, None)

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
        "cf_cookies_configured": bool(system_config.cf_cookies and system_config.cf_cookies.strip() not in ("", "your_cookies_here")),
    }

    return render_template("settings.html", active_tab="settings", system_prompt=system_prompt, llm_configs=llm_configs, user_config=user_config)
