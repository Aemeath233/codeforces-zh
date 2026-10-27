import logging
import os
from collections import deque

from flask import jsonify

from ..paths import get_data_path
from . import api_bp

logger = logging.getLogger(__name__)


@api_bp.route("/api/logs", methods=["GET"])
def api_get_logs():
    log_file = str(get_data_path("backend_app.log"))
    if not os.path.exists(log_file):
        return jsonify({"logs": "暂无日志内容"})
    try:
        with open(log_file, "r", encoding="utf-8", errors="ignore") as f:
            last_lines = deque(f, maxlen=200)
            return jsonify({"logs": "".join(last_lines)})
    except Exception as e:
        return jsonify({"logs": f"读取日志出错: {str(e)}"}), 500


@api_bp.route("/api/logs", methods=["DELETE"])
def api_clear_logs():
    log_file = str(get_data_path("backend_app.log"))
    try:
        with open(log_file, "w", encoding="utf-8") as f:
            f.write("")
        return jsonify({"status": "success", "message": "日志已成功清空"})
    except Exception as e:
        return jsonify({"detail": f"清空日志出错: {str(e)}"}), 500
