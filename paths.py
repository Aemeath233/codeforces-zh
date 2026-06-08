import os
import sys
from pathlib import Path


APP_NAME = "CFMirror"


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def get_resource_root() -> Path:
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS")).resolve()
    return Path(__file__).resolve().parent


def get_data_dir() -> Path:
    configured = os.getenv("CF_MIRROR_DATA_DIR")
    if configured:
        data_dir = Path(configured).expanduser().resolve()
    elif is_frozen():
        project_backend_dir = Path(sys.executable).resolve().parent.parent / "backend"
        if (project_backend_dir / "cf_mirror.db").exists():
            data_dir = project_backend_dir
        else:
            base = os.getenv("LOCALAPPDATA") or os.getenv("APPDATA") or str(Path.home())
            data_dir = Path(base) / APP_NAME
    else:
        data_dir = Path(__file__).resolve().parent

    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


def get_data_path(filename: str) -> Path:
    return get_data_dir() / filename


def get_frontend_dist() -> Path:
    # Retained for compatibility/desktop.py checks if needed
    configured = os.getenv("CF_MIRROR_FRONTEND_DIST")
    if configured:
        return Path(configured).expanduser().resolve()
    return get_resource_root() / "static"
