# -*- coding: utf-8 -*-
import os
import sys
import subprocess
import platform
import time
import socket
import webbrowser
import signal

# Colored console outputs
class Color:
    HEADER = '\033[95m'
    BLUE = '\033[94m'
    GREEN = '\033[92m'
    WARNING = '\033[93m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'

def log_info(msg):
    print(f"{Color.BLUE}[信息]{Color.ENDC} {msg}")

def log_success(msg):
    print(f"{Color.GREEN}[成功]{Color.ENDC} {msg}")

def log_warning(msg):
    print(f"{Color.WARNING}[警告]{Color.ENDC} {msg}")

def log_error(msg):
    print(f"{Color.FAIL}[错误]{Color.ENDC} {msg}")

# --- Cross-platform venv Python resolver ---
def get_venv_python():
    if platform.system() == "Windows":
        return os.path.abspath(os.path.join(".venv", "Scripts", "python.exe"))
    else:
        return os.path.abspath(os.path.join(".venv", "bin", "python"))

# --- 自动环境检测与自愈 (Auto Python venv Setup & Relaunch) ---
venv_dir = os.path.abspath(".venv")
venv_python = get_venv_python()

# If the virtual environment does not exist, create it
if not os.path.exists(venv_dir) or not os.path.exists(venv_python):
    print(f"{Color.WARNING}[初始化]{Color.ENDC} 未检测到本地 Python 虚拟环境 (.venv)，正在为您自动创建并初始化...")
    try:
        subprocess.check_call([sys.executable, "-m", "venv", ".venv"])
        print(f"{Color.GREEN}[成功]{Color.ENDC} 本地虚拟环境 (.venv) 创建成功！")
        
        # Upgrade pip inside venv
        print(f"{Color.BLUE}[信息]{Color.ENDC} 正在升级虚拟环境中的 pip...")
        subprocess.check_call([venv_python, "-m", "pip", "install", "--upgrade", "pip", "--quiet"])
    except Exception as venv_err:
        print(f"{Color.FAIL}[错误]{Color.ENDC} 无法初始化虚拟环境: {str(venv_err)}")
        print(f"提示：请确保系统已正确安装 Python 核心组件并支持 venv 模块。")
        sys.exit(1)

# Relaunch the script using the virtual environment's Python interpreter
if sys.executable.lower() != venv_python.lower():
    print(f"{Color.BLUE}[环境重定向]{Color.ENDC} 正在重定向至本地虚拟环境 (.venv) 启动镜像站...")
    try:
        # Standard sys.argv redirect
        result = subprocess.run([venv_python] + sys.argv)
        sys.exit(result.returncode)
    except Exception as redirect_err:
        print(f"{Color.FAIL}[错误]{Color.ENDC} 自动跳转虚拟环境失败: {str(redirect_err)}")
        sys.exit(1)

# --- Below this line, we are guaranteed to run inside .venv ---

# Global list to track active subprocesses
processes = []

def is_port_in_use(port, host="127.0.0.1"):
    """
    Checks if a given port is already in use.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host, port))
            return False
        except socket.error:
            return True

def check_dependencies():
    """
    Checks and installs missing Python and Node dependencies.
    """
    log_info("正在检查后端 Python 虚拟环境依赖项...")
    req_file = os.path.join("backend", "requirements.txt")
    if os.path.exists(req_file):
        try:
            # Check importability of key libraries
            import fastapi
            import uvicorn
            import httpx
            import bs4
            import sqlalchemy
            # Ensure sqlalchemy is >= 2.0.35 under Python 3.13+ to avoid AssertionError
            import sys as pysys
            if pysys.version_info >= (3, 13):
                v_parts = [int(x) for x in sqlalchemy.__version__.split(".") if x.isdigit()]
                if v_parts and (v_parts[0] < 2 or (v_parts[0] == 2 and v_parts[1] == 0 and len(v_parts) > 2 and v_parts[2] < 35)):
                    raise Exception("sqlalchemy must be >= 2.0.35 under Python 3.13+")
            import openai
            import urllib3
            # Ensure urllib3 is < 2.0.0 on Windows to avoid protocol EOF handshake bugs
            v_parts = [int(x) for x in urllib3.__version__.split(".") if x.isdigit()]
            if v_parts and v_parts[0] >= 2:
                raise Exception("urllib3 must be < 2")
            log_success("Python 依赖库已就绪。")
        except Exception:
            log_warning("检测到部分 Python 依赖库缺失或异常，正在自动为您安装/修复到虚拟环境中...")
            try:
                subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", req_file, "--quiet"])
                log_success("Python 依赖库自动修复完成！")
            except Exception as e:
                log_error(f"自动化安装 Python 依赖库失败，请手动在虚拟环境下运行 'pip install -r {req_file}': {str(e)}")
                sys.exit(1)
    else:
        log_warning(f"未找到 {req_file} 文件，跳过 Python 依赖检查。")

    log_info("正在检查前端 Node 依赖项...")
    front_dir = "frontend"
    node_modules = os.path.join(front_dir, "node_modules")
    if not os.path.exists(node_modules):
        log_warning("未检测到 frontend/node_modules，正在为您自动进行 npm install ...")
        log_info("为了确保在国内网络下的极速下载，我们已为您选用淘宝镜像源。请稍候...")
        try:
            shell_option = True if platform.system() == "Windows" else False
            subprocess.check_call(
                ["npm", "install", "--registry=https://registry.npmmirror.com", "--legacy-peer-deps"],
                cwd=front_dir,
                shell=shell_option
            )
            log_success("前端依赖依赖库安装成功！")
        except Exception as e:
            log_error(f"前端 npm install 失败，请手动在 frontend 目录下运行 'npm install --legacy-peer-deps': {str(e)}")
            sys.exit(1)
    else:
        log_success("前端 Node 依赖库已就绪。")

def clean_exit(signum=None, frame=None):
    """
    Ensures both backend and frontend processes are cleanly killed on exit.
    """
    print("\n")
    log_info("正在安全退出系统并清理后台运行进程...")
    for p in processes:
        try:
            p.terminate()
            p.wait(timeout=1.0)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass
    log_success("进程清理完毕。感谢使用！")
    sys.exit(0)

def main():
    # Setup exit signal handlers for safe Ctrl+C cleanup
    signal.signal(signal.SIGINT, clean_exit)
    signal.signal(signal.SIGTERM, clean_exit)

    print(f"{Color.HEADER}{Color.BOLD}======================================================={Color.ENDC}")
    print(f"{Color.HEADER}{Color.BOLD}     Codeforces AI 智能翻译镜像站 - 一键启动脚本{Color.ENDC}")
    print(f"{Color.HEADER}{Color.BOLD}======================================================={Color.ENDC}\n")

    # 1. Check dependencies
    check_dependencies()
    print("")

    # 2. Ports availability check
    log_info("正在进行本地网络端口可用性自检...")
    backend_port = 8000
    frontend_port = 5173

    if is_port_in_use(backend_port):
        log_error(f"检测到后端端口 {backend_port} 已被占用，请先关闭占用该端口的服务再运行本脚本。")
        sys.exit(1)
        
    if is_port_in_use(frontend_port):
        log_error(f"检测到前端端口 {frontend_port} 已被占用，请先关闭占用该端口的服务再运行本脚本。")
        sys.exit(1)

    log_success("本地服务端口自检通过！")
    print("")

    # 3. Launch Backend
    log_info("正在唤起后端 FastAPI 翻译服务器 (端口 8000)...")
    try:
        backend_proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "8000", "--reload"],
            cwd="backend",
            shell=False
        )
        processes.append(backend_proc)
    except Exception as e:
        log_error(f"后端启动异常，错误详情: {str(e)}")
        clean_exit()

    # 4. Launch Frontend
    log_info("正在唤起前端 React/Vite 静态服务器 (端口 5173)...")
    try:
        shell_option = True if platform.system() == "Windows" else False
        frontend_proc = subprocess.Popen(
            ["npm", "run", "dev"],
            cwd="frontend",
            shell=shell_option
        )
        processes.append(frontend_proc)
    except Exception as e:
        log_error(f"前端启动异常，错误详情: {str(e)}")
        clean_exit()

    # 5. Monitor startup log and auto-launch default browser
    log_info("正在等待本地服务初始化...")
    time.sleep(3.0)

    # Simple verify servers are running
    if backend_proc.poll() is not None:
        log_error("后端服务启动失败，进程意外退出了！请检查控制台输出的日志。")
        clean_exit()

    if frontend_proc.poll() is not None:
        log_error("前端服务启动失败，进程意外退出了！请检查控制台输出的日志。")
        clean_exit()

    log_success("所有本地服务正常运行！")
    log_info("正在为您唤醒默认浏览器加载翻译站主页...")
    webbrowser.open(f"http://localhost:{frontend_port}")

    print("")
    log_success("【镜像站已成功就绪！】")
    print(f"{Color.BOLD}提示：请勿关闭此命令行终端。如果您需要退出，请在此处按 {Color.FAIL}Ctrl + C{Color.ENDC}{Color.BOLD}，系统会自动安全清理并关闭所有后台进程。{Color.ENDC}")
    print("=======================================================\n")

    # Keep script running to monitor processes
    try:
        while True:
            if backend_proc.poll() is not None:
                log_error("后端服务意外退出！")
                clean_exit()
            if frontend_proc.poll() is not None:
                log_error("前端服务意外退出！")
                clean_exit()
            time.sleep(1.0)
    except KeyboardInterrupt:
        clean_exit()

if __name__ == "__main__":
    main()
