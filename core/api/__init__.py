from flask import Blueprint

api_bp = Blueprint("api", __name__)

# Import sub-modules to register routes on api_bp
from . import batch as batch
from . import config as config
from . import logs as logs
from . import problems as problems
