import logging
from logging.handlers import RotatingFileHandler
from flask import Flask, request, jsonify, g

from database import init_db
from pages import pages_bp
from api import api_bp

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

# Register Blueprints
app.register_blueprint(pages_bp)
app.register_blueprint(api_bp)


# Helper to get DB session inside Flask request lifecycle (for compatibility if imported elsewhere)
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


# Initialize DB tables on startup
init_db()
logger.info("Flask database initialized successfully.")

if __name__ == "__main__":
    # Standard development server launch on port 8000
    app.run(host="127.0.0.1", port=8000, debug=True)