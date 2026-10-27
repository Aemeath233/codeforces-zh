"""Windows desktop helpers; stop only a verified instance of this project."""
import json
import os
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener

from core.paths import get_data_path
from core.process_identity import get_process_identity

ROOT = Path(__file__).resolve().parent
URL = "http://127.0.0.1:18780"


def is_running():
    try:
        # Local health probes must not go through a system proxy.
        with build_opener(ProxyHandler({})).open(URL + "/api/health", timeout=0.5) as response:
            return json.load(response).get("app") == "cf-mirror"
    except (OSError, URLError, ValueError):
        return False


def start():
    if is_running():
        webbrowser.open(URL)
        return
    interpreter = ROOT / ".venv" / "Scripts" / "pythonw.exe"
    if not interpreter.exists():
        raise RuntimeError("未找到虚拟环境，请先在项目目录执行 uv sync")
    process = subprocess.Popen([str(interpreter), str(ROOT / "main.py")], cwd=str(ROOT),
                               creationflags=subprocess.CREATE_NO_WINDOW)
    for _ in range(60):
        if is_running():
            webbrowser.open(URL)
            return
        if process.poll() is not None:
            raise RuntimeError("服务启动失败，请检查端口占用和 backend_app.log")
        time.sleep(0.2)
    raise RuntimeError("服务启动超时，请查看 backend_app.log")


def stop():
    pid_path = get_data_path("cf_mirror.pid")
    if not pid_path.exists():
        print("No recorded CF Mirror process. Nothing was stopped.")
        return
    record = json.loads(pid_path.read_text(encoding="utf-8"))
    if not isinstance(record, dict) or record.get("project") != str(ROOT / "main.py"):
        raise RuntimeError("Invalid or obsolete process record; nothing was stopped")
    pid = record.get("pid")
    if type(pid) is not int:
        raise RuntimeError("Invalid process record")
    if pid <= 0:
        raise RuntimeError("Invalid process record")
    process = get_process_identity(pid)
    if not process:
        pid_path.unlink(missing_ok=True)
        print("CF Mirror is already stopped.")
        return
    # The exact Windows creation timestamp also works with uv's redirecting executables.
    if process.get("created") != record.get("created") or process.get("executable") != record.get("executable"):
        raise RuntimeError("Process does not match this project; nothing was stopped")
    subprocess.run(["taskkill", "/PID", str(pid), "/F"], check=True,
                   creationflags=subprocess.CREATE_NO_WINDOW, capture_output=True)
    pid_path.unlink(missing_ok=True)
    print("CF Mirror stopped.")


if __name__ == "__main__":
    try:
        if os.name != "nt":
            raise RuntimeError("请使用 python main.py 在当前平台启动服务")
        if len(sys.argv) > 1 and sys.argv[1] == "stop":
            stop()
        else:
            start()
    except Exception as exc:
        if Path(sys.executable).name.lower() == "pythonw.exe":
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, str(exc), "CF 练习助手", 0x10)
        else:
            print(str(exc), file=sys.stderr)
        sys.exit(1)
