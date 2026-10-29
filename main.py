import atexit
import json
import logging
import os
import time
from logging.handlers import RotatingFileHandler
from urllib.parse import urlsplit

from flask import Flask, g, jsonify, request
from werkzeug.exceptions import HTTPException

from core.api import api_bp
from core.database import init_db
from core.pages import pages_bp
from core.paths import get_data_path
from core.process_identity import get_process_identity

# Advanced Logging Configuration
log_formatter = logging.Formatter(
    fmt="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)

file_handler = RotatingFileHandler(str(get_data_path("backend_app.log")), maxBytes=10*1024*1024, backupCount=5, encoding="utf-8")
file_handler.setFormatter(log_formatter)

console_handler = logging.StreamHandler()
console_handler.setFormatter(log_formatter)

logging.basicConfig(level=logging.INFO, handlers=[file_handler, console_handler])
logger = logging.getLogger(__name__)

# Initialize Flask App
app = Flask(__name__, template_folder="templates", static_folder="static")
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024
# A password-protected HTTPS reverse proxy may supply one public browser origin.
# This setting does not enable remote listening or provide authentication itself.
public_origin = os.getenv("CF_MIRROR_PUBLIC_ORIGIN", "").rstrip("/")
if public_origin:
    parsed_origin = urlsplit(public_origin)
    if (parsed_origin.scheme != "https" or not parsed_origin.hostname
            or parsed_origin.username or parsed_origin.password
            or parsed_origin.path or parsed_origin.query or parsed_origin.fragment):
        raise RuntimeError("CF_MIRROR_PUBLIC_ORIGIN must be an HTTPS origin without a path")
app.config["PUBLIC_ORIGIN"] = public_origin


# Register Blueprints
app.register_blueprint(pages_bp)
app.register_blueprint(api_bp)


@app.get("/api/health")
def health():
    return jsonify({"app": "cf-mirror", "version": "0.2.0"})




@app.teardown_appcontext
def teardown_db(exception=None):
    db = g.pop('db', None)
    if db is not None:
        db.close()


# Request source IP security validation check
@app.before_request
def check_client_ip():
    g.request_started = time.monotonic()
    client_ip = request.remote_addr or ""
    # Strictly reject non-local IP accesses for local self-use security
    if client_ip not in ("127.0.0.1", "::1"):
        logger.warning(f"Forbidden: Blocked access from non-local IP {client_ip} on path {request.path}")
        return jsonify({"detail": "Forbidden: This Codeforces Mirror server is strictly restricted to local machine access for security reasons."}), 403
    if urlsplit(request.host_url).hostname not in ("localhost", "127.0.0.1", "::1"):
        return jsonify({"detail": "只允许通过 localhost 或 127.0.0.1 访问"}), 403
    origin = request.headers.get("Origin")
    if origin and origin not in (request.host_url.rstrip("/"), app.config["PUBLIC_ORIGIN"]):
        return jsonify({"detail": "已拒绝其他网站发起的本地请求"}), 403
    if request.path.startswith("/api/") and request.headers.get("Sec-Fetch-Site") == "cross-site":
        return jsonify({"detail": "已拒绝跨站请求"}), 403
    if request.path.startswith("/api/") and request.method in ("POST", "DELETE") and request.data:
        if not request.is_json or not isinstance(request.get_json(silent=True), dict):
            return jsonify({"detail": "请求内容必须是 JSON 对象"}), 400


@app.after_request
def response_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["X-Frame-Options"] = "DENY"
    if app.config["PUBLIC_ORIGIN"] or request.path.startswith("/api/") or request.path == "/settings":
        response.headers["Cache-Control"] = "no-store"
    if request.path.startswith("/api/") and response.status_code >= 400:
        logger.warning("%s %s: %s (%.0fms)", request.method, request.path, response.status_code,
                       (time.monotonic() - getattr(g, "request_started", time.monotonic())) * 1000)
    return response


@app.errorhandler(ValueError)
def invalid_input(error):
    return jsonify({"detail": str(error)}), 400


@app.errorhandler(500)
def internal_error(error):
    return jsonify({"detail": "本地服务遇到错误，请稍后重试；详情可在设置中的日志查看"}), 500


@app.errorhandler(HTTPException)
def http_error(error):
    if request.path.startswith("/api/"):
        detail = "请求内容过大，最多支持 2 MB" if error.code == 413 else error.description
        return jsonify({"detail": detail}), error.code
    return error





# Initialize DB tables on startup
init_db()
logger.info("Flask database initialized successfully.")

if __name__ == "__main__":
    if os.getenv("CF_MIRROR_DEBUG") == "1":
        app.run(host="127.0.0.1", port=18780, debug=True, use_reloader=False)
    else:
        from waitress import create_server
        server = create_server(app, host="127.0.0.1", port=18780, threads=8)
        pid_path = get_data_path("cf_mirror.pid")
        identity = get_process_identity(os.getpid()) or {}
        process_record = dict(identity, pid=os.getpid(), project=os.path.abspath(__file__))
        pid_path.write_text(json.dumps(process_record), encoding="utf-8")

        def remove_pid():
            if pid_path.exists() and json.loads(pid_path.read_text(encoding="utf-8")).get("pid") == os.getpid():
                pid_path.unlink()

        atexit.register(remove_pid)
        server.run()
