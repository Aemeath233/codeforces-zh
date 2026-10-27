import logging
import re
from urllib.parse import urlsplit

from flask import jsonify, request

from ..cf_sync import (
    get_user_solved_status_map,
    get_user_status_cache,
    reset_user_status_cache,
    trigger_bg_fetch_user_status,
)
from ..database import LLMConfig, SystemConfig
from ..database import get_flask_db as get_db
from ..translator import test_llm_connection
from . import api_bp

logger = logging.getLogger(__name__)


def string_field(payload, name, default="", maximum=1000):
    value = payload.get(name, default)
    if not isinstance(value, str) or len(value) > maximum:
        raise ValueError(f"{name} 格式不正确或内容过长")
    return value.strip()


def validate_endpoint(base_url):
    parsed = urlsplit(base_url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("API 地址应是完整的 http/https 地址，例如 https://api.example.com/v1")


def mask_api_key(key: str) -> str:
    if not key or key == "your_api_key_here":
        return ""
    if len(key) <= 8:
        return "****"
    return f"{key[:4]}...{key[-4:]}"


@api_bp.route("/api/config/system_prompt", methods=["GET", "POST"])
def api_system_prompt():
    db = get_db()
    if request.method == "POST":
        payload = request.json or {}
        config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
        if not config:
            config = SystemConfig(id=1)
            db.add(config)
        system_prompt = string_field(payload, "system_prompt", maximum=20000)
        if system_prompt is not None:
            config.system_prompt = system_prompt.strip()
        db.commit()
        return jsonify({"status": "success", "message": "翻译要求已保存"})
    else:
        config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
        if not config:
            return jsonify({"detail": "Configuration not found"}), 404
        return jsonify({"system_prompt": config.system_prompt})


@api_bp.route("/api/config/llm", methods=["GET", "POST"])
def api_llm_configs():
    db = get_db()
    if request.method == "POST":
        payload = request.json or {}
        config_id = payload.get("id")
        name = string_field(payload, "name", "未命名 API", 100)
        api_key = payload.get("api_key")
        base_url = string_field(payload, "base_url", "https://api.openai.com/v1")
        model = string_field(payload, "model", "gpt-4o-mini", 100)
        priority = payload.get("priority", 1)
        is_active = payload.get("is_active", True)
        validate_endpoint(base_url)
        if not name or not model:
            raise ValueError("节点名称和模型名称不能为空")
        if type(priority) is not int or not 0 <= priority <= 10000 or type(is_active) is not bool:
            raise ValueError("优先级应为 0 到 10000 的整数，启用状态应为布尔值")
        if api_key is not None and not isinstance(api_key, str):
            raise ValueError("API Key 格式不正确")
        if config_id is not None and type(config_id) is not int:
            raise ValueError("节点 ID 格式不正确")

        if config_id:
            config = db.query(LLMConfig).filter(LLMConfig.id == config_id).first()
            if not config:
                return jsonify({"detail": "未找到该模型"}), 404

            config.name = name
            config.base_url = base_url
            config.model = model
            config.priority = priority
            config.is_active = is_active

            if api_key is not None and api_key != "****":
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
        return jsonify({"status": "success", "message": "模型已保存"})
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


@api_bp.route("/api/config/llm/<int:config_id>", methods=["DELETE"])
def api_delete_llm_config(config_id):
    db = get_db()
    config = db.query(LLMConfig).filter(LLMConfig.id == config_id).first()
    if not config:
        return jsonify({"detail": "未找到该模型"}), 404
    db.delete(config)
    db.commit()
    return jsonify({"status": "success", "message": "模型已删除"})


@api_bp.route("/api/config/test", methods=["POST"])
def api_test_config():
    db = get_db()
    payload = request.json or {}
    config_id = payload.get("id")
    if config_id is not None and (type(config_id) is not int or config_id <= 0):
        raise ValueError("节点 ID 应为正整数")
    api_key = string_field(payload, "api_key")
    base_url = string_field(payload, "base_url", "https://api.openai.com/v1")
    model = string_field(payload, "model", maximum=100)
    validate_endpoint(base_url)

    if config_id and (not api_key or api_key == "****" or "..." in api_key):
        db_config = db.query(LLMConfig).filter(LLMConfig.id == config_id).first()
        if db_config:
            api_key = db_config.api_key

    if not api_key or api_key == "your_api_key_here":
        return jsonify({"detail": "API Key 不能为空"}), 400
    if not model:
        return jsonify({"detail": "Model 不能为空"}), 400

    db.rollback()  # Do not retain a DB connection while waiting for the provider.
    try:
        reply = test_llm_connection(api_key, base_url, model)
        return jsonify({
            "status": "success",
            "message": "连接成功",
            "reply": reply
        })
    except Exception as e:
        return jsonify({"detail": f"连接测试失败：{str(e)}"}), 500


@api_bp.route("/api/config/user", methods=["GET", "POST"])
def api_user_config():
    db = get_db()
    if request.method == "POST":
        payload = request.json or {}
        config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
        if not config:
            config = SystemConfig(id=1)
            db.add(config)

        cf_handle = string_field(payload, "cf_handle", maximum=100)
        if cf_handle and not re.fullmatch(r"[A-Za-z0-9_.-]+", cf_handle):
            raise ValueError("Handle 只能包含英文字母、数字、下划线、点或连字符")
        batch_cooldown = payload.get("batch_cooldown")

        config.cf_handle = cf_handle
        config.cf_cookies = None  # Clear existing cookies as proxy submission is removed

        if batch_cooldown is not None:
            try:
                cooldown_seconds = int(batch_cooldown)
            except (TypeError, ValueError):
                return jsonify({"detail": "批量翻译冷却时间必须是非负整数"}), 400
            if cooldown_seconds < 0 or cooldown_seconds > 3600:
                return jsonify({"detail": "批量翻译间隔应在 0 到 3600 秒之间"}), 400
            config.batch_cooldown = cooldown_seconds

        db.commit()

        reset_user_status_cache()
        return jsonify({"status": "success", "message": "设置已保存"})
    else:
        get_user_solved_status_map(db)
        config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
        if not config:
            return jsonify({"cf_handle": "", "cf_cookies_configured": False, "ac_sync_configured": False, "batch_cooldown": 60})
        return jsonify({
            "cf_handle": config.cf_handle or "",
            "cf_cookies_configured": False,
            "cf_cookies_masked": "",
            "ac_sync_configured": bool(config.cf_handle and config.cf_handle.strip()),
            "batch_cooldown": config.batch_cooldown if config.batch_cooldown is not None else 60
        })


@api_bp.route("/api/user/status-sync", methods=["GET", "POST"])
def api_status_sync():
    db = get_db()
    if request.method == "POST":
        config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
        if not config or not config.cf_handle:
            return jsonify({"detail": "未配置 Codeforces Handle"}), 400

        handle = config.cf_handle.strip()
        if not handle:
            return jsonify({"detail": "Codeforces Handle 不能为空"}), 400

        trigger_bg_fetch_user_status(handle)
        return jsonify({"status": "success", "message": "已在后台启动 AC 状态同步"})
    else:
        get_user_solved_status_map(db)
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

        cache, is_syncing = get_user_status_cache()

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
            trigger_bg_fetch_user_status(handle)
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
