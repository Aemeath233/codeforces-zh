# Codeforces 中文练习助手

一个运行在本机的 Codeforces 中文题面与练习工具，方便不熟悉英文题面的用户日常刷题。

**找题 → 翻译成中文 → 中英对照阅读 → 在本地编辑器写代码 → 打开 CF → 在官网手动提交。**

![练习页面预览](docs/practice-preview.png)

[窄屏预览](docs/practice-mobile.png)

> 截图使用离线测试数据，展示功能与排版，不代表实际模型的翻译质量。

## 功能

- **找题与筛选**：浏览公开题库和比赛，按名称、难度、算法标签筛选；输入 `4A` 或 CF 题目链接可以直接打开。
- **中文与双语阅读**：通过兼容 Chat Completions 的模型接口翻译题面，支持中文、英文和双语模式，以及样例和完整题面的复制。
- **公式保护**：翻译前保护公式与代码常量，返回后校验字段、占位符、HTML 结构、图片及链接。异常结果不会覆盖已有成功译文。
- **本地缓存与批量翻译**：原题和译文保存到 SQLite；批量任务支持去重、追加、间隔等待和取消。
- **官网手动提交**：点击“去 CF 提交”，在官网粘贴代码或选择代码文件，核对语言后提交。填写 CF Handle 后可同步公开的做题记录。

## 快速开始

推荐 **Python 3.12**（最低 3.10）和 [uv](https://docs.astral.sh/uv/getting-started/installation/)。

```powershell
git clone https://github.com/Aemeath233/codeforces-zh.git
cd codeforces-zh
uv sync --locked
uv run python main.py
```

打开 [http://127.0.0.1:18780](http://127.0.0.1:18780)。服务默认仅监听本机。

### Windows 双击启动

首次执行 `uv sync --locked` 创建虚拟环境后：

- 双击 `启动.vbs`：后台启动服务并打开浏览器；服务已运行时直接打开页面。
- 双击 `停止.bat`：停止本项目记录并校验过身份的服务进程。

### 使用 pip

没有 uv 时，可以手动创建虚拟环境。以下为 Windows PowerShell 命令：

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe main.py
```

macOS / Linux 对应使用 `.venv/bin/python` 启动，或按上面的 uv 命令运行。

## 首次配置

1. 打开“设置 → 大模型 API”，添加一个可用节点。
2. 填写 API Key、模型名称和接口地址，例如 `https://api.example.com/v1`；地址不需要附加 `/chat/completions`。
3. 按需测试连接，再从题库打开一道题目开始翻译。
4. 如需显示做题状态，在账号设置中填写 CF Handle。

支持多个模型节点按优先级回退。**连接测试和翻译都会调用你配置的模型接口，费用取决于服务商。**

只需要 Handle 即可同步公开记录，不需要 CF 密码或 Cookie。模型密钥保存在本机数据库中。

## 日常使用

首次打开未缓存的题目时，工具在后台获取英文原题并生成译文。原题先保存，模型失败时仍能阅读英文，并可点击“重新翻译”。已有译文的题目重译失败时，上一份成功译文会保留。

在本地编辑器写好代码后，点击“去 CF 提交”，到官网粘贴代码或选择代码文件、核对题号和语言并提交。回到本地页面后会尝试同步做题状态，也可以从导航栏的同步状态入口刷新记录。最终语言选择以 CF 提交页为准。

批量翻译期间可以继续阅读题目。取消操作会让当前已进入处理的题目结束后停止后续任务；已完成的结果保留。清理缓存前，请先结束或取消相关翻译任务。

### 自动抓题失败

自动获取可能受网络故障、限流、浏览器验证或登录要求影响。工具保留原站与官方镜像的后备路径；失败时页面会显示原因，并提供手动导入入口：

1. 点击“打开官网”，确认能正常看到题目，需要时在浏览器完成验证。
2. 把英文题目全文粘贴到“CF 访问受限？粘贴英文题面后翻译”。
3. 点击翻译，继续在本地阅读和练习。

也可以粘贴包含 `problem-statement` 区域的原始 HTML，以保留公式和样例结构。纯文本可能已经丢失公式格式，请对照原题检查；纯文本导入会完整放入描述区，不猜测输入输出分区。

## 数据与限制

默认数据保存在项目目录，可以通过 `CF_MIRROR_DATA_DIR` 指定其他目录。例如 PowerShell：

```powershell
$env:CF_MIRROR_DATA_DIR = "$env:LOCALAPPDATA\CFMirror"
uv run python main.py
```

| 文件或内容 | 用途 |
| --- | --- |
| `cf_mirror.db` | 原题、译文、题库、比赛缓存、做题记录和模型配置，包含模型密钥 |
| `cf_mirror.db-wal`、`cf_mirror.db-shm` | SQLite 运行文件 |
| `cf_mirror.db.before-v02.db.bak` | 旧数据库结构升级前生成的备份 |
| `backend_app.log` 及轮转日志 | 本机运行日志 |
| `cf_mirror.pid` | Windows 启停使用的进程身份记录 |
| 浏览器本地存储 | 阅读模式、默认提交语言和部分界面设置 |

这些数据库、备份、日志和运行文件已加入 `.gitignore`。不要把包含密钥的数据库或备份上传到公开仓库；备份运行中的数据库时应使用 SQLite 备份方式，或先停止服务。

- **保持单进程运行**：后台队列和限速保存在进程内，默认使用 Waitress 单进程、多线程。重启后需要重新发起未完成的任务，已保存的题面不受影响。
- **离线阅读的范围**：文字、数学排版及本地界面资源可离线使用；题面的远程插图仍依赖网络。
- **翻译需要英文对照**：结构校验无法保证语义完全正确，关键限定词、量词和边界条件应与原题核对。
- **原题可能更新**：“重新翻译”使用缓存中的英文原题；需要重新获取官网修订时，先删除该题缓存，再打开题目。

## 开发与验证

技术栈：**Flask + Jinja2 + 原生 JavaScript + SQLite / SQLAlchemy**。没有前端构建步骤。

```text
core/
  api/                 本地 JSON 接口
  scraper.py           CF 页面获取、题目和比赛列表解析
  translator.py        模型调用、公式保护与译文校验
  problem_service.py   单题与批量共用的翻译任务
  cf_sync.py           题库、做题状态和批量队列
  database.py          数据模型、SQLite 配置与迁移
static/                样式、脚本和本地第三方资源
templates/             Jinja2 页面
tests/                 回归测试及离线预览
main.py                本地服务入口
launcher.py            Windows 启停辅助
```

运行检查：

```powershell
uv run python -m unittest discover -s tests -v
node tests/frontend.cjs
```

Node.js 仅用于前端回归脚本，正常使用无需安装。后端测试使用临时数据库，模型请求被替换，不会调用实际付费接口。

启动隔离的离线预览：

```powershell
uv run python tests/preview_server.py
```

打开 [http://127.0.0.1:18781/problem/4/A](http://127.0.0.1:18781/problem/4/A)。预览使用临时数据库和固定响应，不读取真实模型密钥。

开发调试可设置 `CF_MIRROR_DEBUG=1`；常规使用保持默认配置。具体审查记录见[首轮审查](docs/code-review.md)和 [2026-10-27 复审](docs/code-review-2026-10-27.md)。

## 第三方资源

- [Codeforces](https://codeforces.com/)：题目、比赛与公开做题记录来源。本项目为个人练习辅助工具，与 Codeforces 官方无关联。
- [MathJax](https://www.mathjax.org/)：本地数学排版资源，许可见 [static/mathjax/LICENSE](static/mathjax/LICENSE)。
- [Lucide](https://lucide.dev/)：本地图标资源，许可见 [static/js/lucide.LICENSE](static/js/lucide.LICENSE)。
