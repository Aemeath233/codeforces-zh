"""Run an isolated, offline UI fixture: python tests/preview_server.py (port 18781)."""
import json
import logging
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
_TEMP = tempfile.TemporaryDirectory(prefix="cf-ui-preview-")
os.environ["CF_MIRROR_DATA_DIR"] = _TEMP.name
import core.api.problems as problems
import core.cf_sync as sync
import core.problem_service as service
import core.translator as translator
from core.database import (
    LLMConfig,
    ProblemsetLibrary,
    SessionLocal,
    create_cached_problem,
)
from main import app

app.config["TEMPLATES_AUTO_RELOAD"] = True

SOURCE = {"contest_id": 4, "index": "A", "title": "Watermelon", "time_limit": "1 second",
          "memory_limit": "256 MB", "input_file": "standard input", "output_file": "standard output",
          "description_html": r"<p>Split $w$ into two even parts with $a + b = w$.</p>",
          "input_spec_html": r"<p>An integer $w$ ($1 \le w \le 100$).</p>",
          "output_spec_html": '<p>Print <code>YES</code> or <code>NO</code>.</p>', "note_html": "",
          "samples_json": json.dumps([{"input": "8\n", "output": "YES\n"}])}
ZH = {"translated_title": "西瓜", "translated_description_html": r"<p>将重量为 $w$ 的西瓜分成两部分，每部分的重量都是正偶数，并满足 $a + b = w$。</p>",
      "translated_input_spec_html": r"<p>输入一个整数 $w$（$1 \le w \le 100$）。</p>",
      "translated_output_spec_html": '<p>如果可以分成两部分，输出 <code>YES</code>；否则输出 <code>NO</code>。</p>', "translated_note_html": ""}
with SessionLocal() as db:
    db.query(LLMConfig).delete()
    db.add(LLMConfig(name="离线预览节点", api_key="fixture-not-a-real-key", model="fixture"))
    db.add(create_cached_problem("4_A", 4, "A", SOURCE, ZH))
    db.add(create_cached_problem("4_B", 4, "B", dict(SOURCE, index="B"), {}))
    db.add_all([ProblemsetLibrary(id=f"4_{index}", contest_id=4, index=index, name="Watermelon", rating=800, solved_count=100,
                                tags_json='["math", "brute force"]') for index in ("A", "B")])
    db.commit()


def completion(key, url, model, messages, **kwargs):
    time.sleep(1)
    data = json.loads(messages[1]["content"])
    for key in data:
        for before, after in {"Watermelon": "西瓜", "Split": "分割", "into two even parts with": "为两个偶数部分，满足", "An integer": "输入整数", "Print": "输出", "or": "或"}.items():
            data[key] = data[key].replace(before, after)
    return json.dumps(data, ensure_ascii=False)


def api(method, params=None, **kwargs):
    if method == "contest.list":
        return [{"id": 4, "name": "Codeforces Beta Round 4 (Div. 2)", "phase": "FINISHED", "durationSeconds": 7200, "startTimeSeconds": 1268935200}]
    if method == "user.status":
        return []
    raise ValueError("Offline preview fixture has no such record")

translator.request_completion = completion
def scrape(cid, index):
    if cid == 9:
        raise PermissionError("CF 需要浏览器验证，请打开官网后复制题面到本地翻译")
    return dict(SOURCE, contest_id=cid, index=index)

service.scrape_cf_problem = scrape
sync.cf_api = api
problems.cf_api = api
if __name__ == "__main__":
    from waitress import serve
    print("Offline preview: http://127.0.0.1:18781/problem/4/A", flush=True)
    try:
        serve(app, host="127.0.0.1", port=18781, threads=4)
    finally:
        from core.database import engine
        engine.dispose()
        logging.shutdown()
        _TEMP.cleanup()
