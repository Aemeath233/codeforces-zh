"""Regression checks use a disposable database and never call CF or a paid model."""
import json
import logging
import os
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from requests import Response
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker

_TEMP = tempfile.TemporaryDirectory(prefix="cf-review-tests-")
os.environ["CF_MIRROR_DATA_DIR"] = _TEMP.name

import launcher
from core import cf_client, cf_sync, database, problem_service
from core.content import FIELDS, sanitize_html
from core.database import (
    CachedProblem,
    LLMConfig,
    ProblemsetLibrary,
    ProblemTag,
    SessionLocal,
    SystemConfig,
)
from core.problem_service import _locks, ensure_problem
from core.scraper import (
    parse_contest_html,
    parse_problem_html,
    scrape_cf_contest_problems,
    scrape_cf_problem,
)
from core.translator import (
    TranslationError,
    protect_formulas,
    request_completion,
    translate_problem,
    validate_translation,
)
from core.web_security import validate_proxy_origin
from main import app


def source(cid=4, index="A"):
    return {"contest_id": cid, "index": index, "title": "Watermelon", "time_limit": "1 second",
            "memory_limit": "256 MB", "input_file": "standard input", "output_file": "standard output",
            "description_html": r"<p>Split $w$ into two even parts with $a + b = w$.</p>",
            "input_spec_html": r"<p>An integer $w$.</p>", "output_spec_html": "<p>Print YES or NO.</p>",
            "note_html": "", "samples_json": json.dumps([{"input": "8\n", "output": "YES\n"}])}


def translated():
    return {"translated_" + f: ("西瓜" if f == "title" else "<p>中文题面</p>" if f != "note_html" else "") for f in FIELDS}


class RegressionTests(unittest.TestCase):
    def setUp(self):
        with problem_service._guard:
            self.assertFalse(any(job["phase"] in problem_service.ACTIVE for job in problem_service._jobs.values()))
            problem_service._jobs.clear()
        self.network_get = patch("requests.get", side_effect=AssertionError("Unexpected network request"))
        self.network_post = patch("requests.post", side_effect=AssertionError("Unexpected paid model request"))
        self.network_get.start()
        self.network_post.start()
        self.addCleanup(self.network_get.stop)
        self.addCleanup(self.network_post.stop)
        with SessionLocal() as db:
            for table in (CachedProblem, ProblemTag, ProblemsetLibrary, LLMConfig):
                db.query(table).delete()
            config = db.get(SystemConfig, 1)
            config.cf_handle = None
            config.batch_cooldown = 0
            db.commit()
        cf_sync.reset_user_status_cache()
        self.client = app.test_client()

    def test_math_round_trip_and_html_entities(self):
        fields = {k: source().get(k, "") for k in FIELDS}
        fields["description_html"] = r"<p>$\color{red}{a_i} &lt; b$ and $$\frac{x}{y}$$.</p>"
        protected, formulas = protect_formulas(fields)
        output = dict(protected, title="西瓜", description_html=protected["description_html"] + "中文")
        restored = validate_translation(output, protected, formulas)
        self.assertEqual(restored["translated_description_html"], fields["description_html"] + "中文")

    def test_missing_duplicated_and_moved_formulas_are_rejected(self):
        protected, formulas = protect_formulas({k: source().get(k, "") for k in FIELDS})
        token = next(iter(formulas))
        for modification in ("missing", "duplicated", "moved"):
            output = dict(protected)
            output["description_html"] += "中文"
            if modification == "missing":
                output["description_html"] = output["description_html"].replace(token, "")
            elif modification == "duplicated":
                output["description_html"] += token
            else:
                output["description_html"] = output["description_html"].replace(token, "")
                output["note_html"] += token
            with self.subTest(modification=modification), self.assertRaises(TranslationError):
                validate_translation(output, protected, formulas)

    def test_partial_translation_and_non_string_fields_are_rejected(self):
        protected, formulas = protect_formulas({k: source().get(k, "") for k in FIELDS})
        for output in ({}, dict(protected, input_spec_html=""), dict(protected, title={}), []):
            with self.assertRaises(TranslationError):
                validate_translation(output, protected, formulas)

    def test_added_formulas_and_changed_code_literals_are_rejected(self):
        fields = {k: source().get(k, "") for k in FIELDS}
        fields["output_spec_html"] = '<p>Print <code>YES</code> or <span class="tex-font-style-tt">NO</span>.</p>'
        protected, formulas = protect_formulas(fields)
        self.assertNotIn("YES", protected["output_spec_html"])
        good = dict(protected, title="西瓜", description_html=protected["description_html"] + "中文")
        result = validate_translation(good, protected, formulas)
        self.assertEqual(result["translated_output_spec_html"], fields["output_spec_html"])
        for bad in (dict(good, description_html=good["description_html"] + "$invented$"),
                    dict(good, input_spec_html="<p>中文</p><p>新增条件</p>")):
            with self.assertRaises(TranslationError):
                validate_translation(bad, protected, formulas)

    def test_html_is_sanitized_and_relative_images_work(self):
        result = sanitize_html('<script>alert(1)</script><img src="/pic.png" onerror="alert(1)"><a href="javascript:alert(1)">link</a><iframe src="http://bad/"></iframe>')
        self.assertNotIn("script", result)
        self.assertNotIn("onerror", result)
        self.assertNotIn("iframe", result)
        self.assertIn('src="https://codeforces.com/pic.png"', result)

    def test_samples_preserve_backslashes_quotes_and_newlines(self):
        html = r'''<div class="problem-statement"><div class="header"><div class="title">A. Sample</div></div><div><p>Given $$$x$$$.</p><img src="/a.png"></div><div class="sample-tests"><div class="sample-test"><div class="input"><pre>a'b\n<br>second</pre></div><div class="output"><pre><div class="test-example-line">YES</div><div class="test-example-line">NO</div></pre></div></div></div></div>'''
        data = parse_problem_html(html, 4, "a")
        samples = json.loads(data["samples_json"])
        self.assertEqual(samples[0]["input"], "a'b\\n\nsecond")
        self.assertEqual(samples[0]["output"], "YES\nNO")
        self.assertIn("$x$", data["description_html"])
        self.assertIn("https://codeforces.com/a.png", data["description_html"])

    def test_no_model_raises_and_never_invents_a_translation(self):
        with SessionLocal() as db, self.assertRaises(TranslationError):
            translate_problem(source(), db)

    def test_model_fallback_rejects_corrupted_output(self):
        with SessionLocal() as db:
            db.add_all([LLMConfig(name="bad", api_key="not-a-secret", model="test", priority=1),
                        LLMConfig(name="good", api_key="not-a-secret", model="test", priority=2)])
            db.commit()
            def complete(key, url, model, messages):
                value = json.loads(messages[1]["content"])
                value["title"] = "西瓜"
                value["description_html"] += "中文"
                return json.dumps(value, ensure_ascii=False)
            with patch("core.translator.request_completion", side_effect=["{}", None]) as call:
                call.side_effect = lambda *args: "{}" if call.call_count == 1 else complete(*args)
                result = translate_problem(source(), db)
                self.assertEqual(call.call_count, 2)
                self.assertIn("$w$", result["translated_description_html"])

    def test_failed_translation_keeps_original_and_retry_uses_cache(self):
        with patch("core.problem_service.scrape_cf_problem", return_value=source()) as scrape:
            with patch("core.problem_service.translate_problem", side_effect=TranslationError("offline")):
                with self.assertRaises(TranslationError):
                    ensure_problem(4, "A")
            with SessionLocal() as db:
                cached = db.get(CachedProblem, "4_A")
                self.assertEqual(cached.description_html, source()["description_html"])
                self.assertEqual(cached.translation_status, "original")
            with patch("core.problem_service.translate_problem", return_value=translated()):
                ensure_problem(4, "A")
            self.assertEqual(scrape.call_count, 1)
        with SessionLocal() as db:
            self.assertEqual(db.get(CachedProblem, "4_A").translation_status, "translated")

    def test_failed_refresh_preserves_previous_good_translation(self):
        with patch("core.problem_service.scrape_cf_problem", return_value=source()), patch("core.problem_service.translate_problem", return_value=translated()):
            ensure_problem(4, "A")
        with patch("core.problem_service.translate_problem", side_effect=TranslationError("offline")):
            with self.assertRaises(TranslationError):
                ensure_problem(4, "A", force=True)
        with SessionLocal() as db:
            self.assertEqual(db.get(CachedProblem, "4_A").translated_title, "西瓜")
            self.assertEqual(db.get(CachedProblem, "4_A").translation_status, "translated")

    def test_foreground_and_batch_share_one_translation_under_contention(self):
        entered = threading.Event()
        release = threading.Event()
        def slow_translation(*args):
            entered.set()
            self.assertTrue(release.wait(3))
            return translated()
        with patch("core.problem_service.scrape_cf_problem", return_value=source()) as scrape, patch("core.problem_service.translate_problem", side_effect=slow_translation) as translate:
            with ThreadPoolExecutor(max_workers=6) as pool:
                futures = [pool.submit(ensure_problem, 4, "A") for _ in range(6)]
                self.assertTrue(entered.wait(2))
                release.set()
                for future in futures:
                    future.result(timeout=5)
            self.assertEqual(scrape.call_count, 1)
            self.assertEqual(translate.call_count, 1)
        self.assertEqual(_locks, {})

    def test_library_sync_works_with_999_bind_limit_and_removes_old_tags(self):
        result = {"problems": [{"contestId": i + 1, "index": "A", "name": f"Problem {i}", "tags": ["math"]} for i in range(1200)]}
        with SessionLocal() as db:
            raw = db.connection().connection.driver_connection
            previous_limit = raw.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 999)
            try:
                with patch("core.cf_sync.cf_api", return_value=result):
                    self.assertEqual(cf_sync.sync_problemset_library_internal(db), 1200)
                self.assertEqual(db.query(ProblemTag).count(), 1200)
                with patch("core.api.problems.get_db", return_value=db):
                    response = self.client.get("/api/problems?query=Problem")
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json["total"], 1200)
                result["problems"] = [{"contestId": 1, "index": "A", "name": "New title", "tags": ["dp"]}]
                with patch("core.cf_sync.cf_api", return_value=result):
                    cf_sync.sync_problemset_library_internal(db)
                self.assertEqual([row.tag for row in db.query(ProblemTag)], ["dp"])
                self.assertEqual(db.query(ProblemsetLibrary).count(), 1)
            finally:
                raw.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, previous_limit)

    def test_empty_library_response_preserves_previous_data(self):
        with SessionLocal() as db:
            db.add(ProblemsetLibrary(id="4_A", contest_id=4, index="A", name="Watermelon"))
            db.commit()
            with patch("core.cf_sync.cf_api", return_value={"problems": []}), self.assertRaises(ValueError):
                cf_sync.sync_problemset_library_internal(db)
            self.assertEqual(db.query(ProblemsetLibrary).count(), 1)

    def test_library_write_failure_rolls_back_entire_snapshot(self):
        with SessionLocal() as db:
            db.add(ProblemsetLibrary(id="4_A", contest_id=4, index="A", name="Old"))
            db.add(ProblemTag(problem_id="4_A", tag="math"))
            db.commit()
            def fail_tags(conn, cursor, statement, parameters, context, many):
                if statement.startswith("INSERT INTO problem_tag"):
                    raise RuntimeError("simulated disk failure")
            event.listen(database.engine, "before_cursor_execute", fail_tags)
            try:
                with patch("core.cf_sync.cf_api", return_value={"problems": [{"contestId": 5, "index": "A", "name": "New", "tags": ["dp"]}]}), self.assertRaises(RuntimeError):
                    cf_sync.sync_problemset_library_internal(db)
            finally:
                event.remove(database.engine, "before_cursor_execute", fail_tags)
            self.assertEqual(db.get(ProblemsetLibrary, "4_A").name, "Old")
            self.assertEqual(db.query(ProblemTag).first().tag, "math")

    def test_legacy_migration_backs_up_db_and_retires_only_mock_translations(self):
        path = os.path.join(_TEMP.name, "legacy.db")
        legacy_engine = create_engine("sqlite:///" + path)
        factory = sessionmaker(bind=legacy_engine)
        database.Base.metadata.create_all(legacy_engine)
        with factory() as db:
            mock = dict(translated(), translated_description_html="<p>(模拟描述) fabricated text</p>")
            db.add(database.create_cached_problem("4_A", 4, "A", source(), mock))
            db.add(database.create_cached_problem("5_A", 5, "A", source(5), translated()))
            db.commit()
        with legacy_engine.begin() as conn:
            conn.execute(text("ALTER TABLE cached_problem DROP COLUMN translation_status"))
        try:
            with patch.object(database, "engine", legacy_engine), patch.object(database, "SessionLocal", factory), patch.object(database, "db_path", path):
                database.init_db()
                database.init_db()  # Migration is idempotent.
            with factory() as db:
                self.assertEqual(db.get(CachedProblem, "4_A").translation_status, "original")
                self.assertEqual(db.get(CachedProblem, "4_A").description_html, source()["description_html"])
                self.assertIsNone(db.get(CachedProblem, "4_A").translated_description_html)
                self.assertEqual(db.get(CachedProblem, "5_A").translation_status, "translated")
            self.assertTrue(os.path.exists(path + ".before-v02.db.bak"))
        finally:
            legacy_engine.dispose()

    def test_user_sync_ignores_old_account_result_after_settings_change(self):
        generation = cf_sync._status_generation
        def old_result(*args, **kwargs):
            cf_sync.reset_user_status_cache()
            return [{"contestId": 4, "problem": {"index": "A"}, "verdict": "OK"}]
        with patch("core.cf_sync.cf_api", side_effect=old_result):
            cf_sync._bg_fetch_user_status("old-user", generation)
        cache, syncing = cf_sync.get_user_status_cache()
        self.assertIsNone(cache["handle"])
        self.assertFalse(syncing)

    def test_testing_is_not_marked_failed_and_accepted_is_never_downgraded(self):
        submissions = [{"contestId": 4, "problem": {"index": "A"}, "verdict": "WRONG_ANSWER"},
                       {"contestId": 4, "problem": {"index": "A"}, "verdict": "OK"},
                       {"contestId": 4, "problem": {"index": "B"}, "verdict": "TESTING"}]
        with patch("core.cf_sync.cf_api", return_value=submissions):
            cf_sync._bg_fetch_user_status("user", cf_sync._status_generation)
        cache, _ = cf_sync.get_user_status_cache()
        self.assertEqual(cache["status_map"], {"4_A": "OK"})

    def test_api_rejects_cross_origin_dns_rebinding_and_bad_payloads(self):
        self.assertEqual(self.client.get("/api/config/llm", headers={"Host": "attacker.invalid"}).status_code, 403)
        self.assertEqual(self.client.post("/api/config/user", json={}, headers={"Origin": "https://attacker.invalid"}).status_code, 403)
        self.assertEqual(self.client.post("/api/config/user", json=[]).status_code, 400)
        self.assertEqual(self.client.post("/api/config/llm", json={"model": None}).status_code, 400)
        self.assertEqual(self.client.get("/api/problems?page=nope").status_code, 400)
        self.assertEqual(self.client.post("/api/batch-translate/start", json={"problems": [{"contest_id": 4, "index": "A?bad"}]}).status_code, 400)

    def test_private_proxy_origin_keeps_local_host_and_cross_site_guards(self):
        with patch.dict(app.config, PUBLIC_ORIGIN="https://cf.example.test"):
            response = self.client.post("/api/config/system_prompt",
                                        json={"system_prompt": "中文翻译"},
                                        headers={"Origin": "https://cf.example.test"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(self.client.get("/problemset").headers["Cache-Control"], "no-store")
            for headers in ({"Origin": "https://evil.example.test"},
                            {"Origin": "https://cf.example.test", "Sec-Fetch-Site": "cross-site"},
                            {"Host": "cf.example.test"},
                            {"Host": "evil.example.test", "X-Forwarded-Host": "localhost"}):
                self.assertEqual(self.client.get("/api/config/llm", headers=headers).status_code, 403)
            self.assertEqual(self.client.get("/api/health", environ_overrides={
                "REMOTE_ADDR": "198.51.100.10"}).status_code, 403)
        self.assertEqual(self.client.get("/api/health", headers={
            "Origin": "https://cf.example.test"}).status_code, 403)

    def test_vpn_origin_is_explicit_and_rejects_plaintext_public_origins(self):
        self.assertEqual(validate_proxy_origin("http://10.77.0.1:18780/"), "http://10.77.0.1:18780")
        self.assertEqual(validate_proxy_origin("https://cf.example.test"), "https://cf.example.test")
        for origin in ("http://example.test", "http://47.94.222.194:18780", "http://0.0.0.0",
                       "http://127.0.0.1", "https://user:password@example.test",
                       "http://10.77.0.1:99999", "http://10.77.0.1/path", "http://10.77.0.1?key=x"):
            with self.subTest(origin=origin), self.assertRaises(RuntimeError):
                validate_proxy_origin(origin)
        with patch.dict(app.config, PUBLIC_ORIGIN="http://10.77.0.1:18780"):
            self.assertEqual(self.client.post("/api/config/system_prompt",
                json={"system_prompt": "中文翻译"}, headers={"Origin": "http://10.77.0.1:18780"}).status_code, 200)
            self.assertEqual(self.client.get("/api/health", headers={
                "Origin": "https://cf.homeofmjr.top"}).status_code, 403)

    def test_cached_pages_render_sanitized_content_and_sample_handlers(self):
        data = source()
        data["description_html"] += '<script>window.BAD=1</script>'
        with SessionLocal() as db:
            db.add(database.create_cached_problem("4_A", 4, "A", data, translated()))
            db.commit()
        response = self.client.get("/problem/4/A")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(b"window.BAD", response.data)
        self.assertNotIn(b"code-draft", response.data)
        self.assertIn(b"data-submit-link", response.data)
        self.assertIn(b'copyProblem', response.data)
        self.assertEqual(self.client.get("/cached").status_code, 200)
        self.assertEqual(self.client.get("/settings").status_code, 200)
        self.assertEqual(self.client.get("/problem/8/B").status_code, 200)

    def test_async_endpoint_returns_without_waiting_for_model(self):
        with patch("core.api.problems.start_translation_job", return_value={"phase": "queued"}) as start:
            response = self.client.post("/api/problem/4/a/translate", json={})
            self.assertEqual(response.status_code, 202)
            self.assertEqual(response.json["phase"], "queued")
            start.assert_called_once_with(4, "A", force=False, source=None)

    def test_stop_refuses_a_recycled_pid_belonging_to_another_program(self):
        pid = os.path.join(_TEMP.name, "cf_mirror.pid")
        with open(pid, "w", encoding="ascii") as file:
            json.dump({"pid": 12345, "created": 1, "executable": "python.exe", "project": str(launcher.ROOT / "main.py")}, file)
        unrelated = {"executable": "python.exe", "created": 2}
        with patch("launcher.get_process_identity", return_value=unrelated), patch("launcher.subprocess.run") as run, self.assertRaises(RuntimeError):
            launcher.stop()
        run.assert_not_called()
        os.unlink(pid)

    def test_scraper_stops_on_429_instead_of_retrying_every_route(self):
        response = Response()
        response.status_code = 429
        response._content = b"rate limited"
        with patch("core.scraper.requests.Session") as session, patch("core.scraper.time.sleep"):
            session.return_value.__enter__.return_value.get.return_value = response
            with self.assertRaises(PermissionError):
                scrape_cf_problem(4, "A")
            self.assertEqual(session.return_value.__enter__.return_value.get.call_count, 1)

    def test_scraper_uses_archive_route_before_mirror_if_contest_is_blocked(self):
        blocked, success = Response(), Response()
        blocked.status_code, blocked._content = 403, b"Just a moment..."
        success.status_code, success._content = 200, b'<div class="problem-statement"></div>'
        with patch("core.scraper.requests.Session") as session, patch("core.scraper.time.sleep"), patch("core.scraper.parse_problem_html", return_value=source()) as parse:
            client = session.return_value.__enter__.return_value
            client.get.side_effect = [blocked, success]
            self.assertEqual(scrape_cf_problem(2232, "a"), source())
            urls = [call.args[0] for call in client.get.call_args_list]
            self.assertEqual(urls, ["https://codeforces.com/contest/2232/problem/A?locale=en",
                                    "https://codeforces.com/problemset/problem/2232/A?locale=en"])
            sent_headers = client.headers.update.call_args.args[0]
            self.assertIn("Chrome/", sent_headers["User-Agent"])
            self.assertIn("text/html", sent_headers["Accept"])
            parse.assert_called_once_with(success.text, 2232, "A")

    def test_scraper_does_not_label_every_403_as_browser_verification(self):
        response = Response()
        response.status_code, response._content = 403, b"Forbidden"
        with patch("core.scraper.requests.Session") as session, patch("core.scraper.time.sleep"):
            session.return_value.__enter__.return_value.get.return_value = response
            with self.assertRaises(ValueError) as result:
                scrape_cf_problem(2232, "A")
        self.assertIn("HTTP 403", str(result.exception))
        self.assertNotIn("浏览器验证", str(result.exception))

    def test_gym_only_uses_gym_routes_and_reports_challenge_header(self):
        response = Response()
        response.status_code, response._content = 403, b"Please wait"
        response.headers["cf-mitigated"] = "challenge"
        with patch("core.scraper.requests.Session") as session, patch("core.scraper.time.sleep"):
            client = session.return_value.__enter__.return_value
            client.get.return_value = response
            with self.assertRaises(ValueError) as result:
                scrape_cf_problem(100001, "A")
            self.assertEqual([call.args[0] for call in client.get.call_args_list],
                             ["https://codeforces.com/gym/100001/problem/A?locale=en",
                              "https://mirror.codeforces.com/gym/100001/problem/A?locale=en"])
        self.assertIn("浏览器验证页", str(result.exception))

    def test_model_errors_do_not_expose_provider_body_or_key(self):
        class Response:
            status_code = 401
            text = "SECRET_PROVIDER_RESPONSE"
        with patch("requests.post", return_value=Response()), self.assertRaises(TranslationError) as result:
            request_completion("SECRET_API_KEY", "https://example.com/v1", "model", [])
        self.assertNotIn("SECRET", str(result.exception))

    def test_cf_api_enforces_shared_spacing_and_coalesces_cached_reads(self):
        cf_client._cache.clear()
        cf_client._last_request = 0
        response = type("Response", (), {"raise_for_status": lambda self: None, "json": lambda self: {"status": "OK", "result": [1]}})()
        with patch("requests.get", return_value=response) as get, patch("core.cf_client.time.monotonic", return_value=100), patch("core.cf_client.time.sleep") as sleep:
            self.assertEqual(cf_client.cf_api("method", ttl=10), [1])
            self.assertEqual(cf_client.cf_api("method", ttl=10), [1])
            cf_client.cf_api("other")
            self.assertEqual(get.call_count, 2)
            self.assertGreater(sleep.call_args.args[0], 1.5)

    def test_deletion_is_rejected_during_translation_then_succeeds(self):
        entered, release = threading.Event(), threading.Event()
        def slow_translation(*args):
            entered.set()
            self.assertTrue(release.wait(4))
            return translated()
        with patch("core.problem_service.scrape_cf_problem", return_value=source()), patch("core.problem_service.translate_problem", side_effect=slow_translation):
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(ensure_problem, 4, "A")
                try:
                    self.assertTrue(entered.wait(2))
                    self.assertEqual(self.client.delete("/api/problem/4/A").status_code, 409)
                    self.assertEqual(self.client.delete("/api/problems", json={"all": True}).status_code, 409)
                finally:
                    release.set()
                future.result(timeout=5)
        self.assertEqual(self.client.delete("/api/problem/4/A").status_code, 200)
        with SessionLocal() as db:
            self.assertIsNone(db.get(CachedProblem, "4_A"))

    def test_batch_joins_foreground_job_and_exposes_same_progress(self):
        entered, release = threading.Event(), threading.Event()
        def slow_translation(*args):
            entered.set()
            self.assertTrue(release.wait(4))
            return translated()
        queue = {"is_active": True, "total": 1, "completed": 0, "failed": 0, "errors": [],
                 "current_problem": None, "remaining_problems": [{"contest_id": 4, "index": "A"}],
                 "cancel_flag": False, "timer_countdown": 0}
        with patch("core.problem_service.scrape_cf_problem", return_value=source()) as scrape, patch("core.problem_service.translate_problem", side_effect=slow_translation) as translate, patch.object(cf_sync, "_batch_queue", queue):
            problem_service.start_translation_job(4, "A")
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(cf_sync._bg_batch_translate, SessionLocal, queue)
                try:
                    self.assertTrue(entered.wait(2))
                    status = self.client.get("/api/problem/4/A/status").json
                    self.assertEqual(status["phase"], "translating")
                    self.assertTrue(status["has_original"])
                    self.assertNotIn("_done", status)
                    self.assertEqual(self.client.delete("/api/problems", json={"all": True}).status_code, 409)
                finally:
                    release.set()
                future.result(timeout=5)
            self.assertEqual(queue["completed"], 1)
            self.assertEqual(queue["failed"], 0)
            self.assertEqual(scrape.call_count, 1)
            self.assertEqual(translate.call_count, 1)
            self.assertEqual(self.client.get("/api/problem/4/A/status").json["phase"], "complete")

    def test_batch_waiter_receives_translation_failure(self):
        with patch("core.problem_service.scrape_cf_problem", return_value=source()), patch("core.problem_service.translate_problem", side_effect=TranslationError("offline")):
            with self.assertRaisesRegex(TranslationError, "offline"):
                problem_service.start_translation_job(4, "A", wait=True)
        self.assertEqual(self.client.get("/api/problem/4/A/status").json["phase"], "failed")

    def test_old_batch_worker_cannot_clear_newly_started_queue(self):
        old_queue = {"is_active": True, "remaining_problems": [], "cancel_flag": False}
        mutex = threading.Lock()
        result = []
        class HandoffLock:
            armed = True
            def __enter__(self):
                mutex.acquire()
            def __exit__(self, *args):
                mutex.release()
                if self.armed:
                    self.armed = False
                    # Schedule a new request exactly between the old worker's
                    # queue-empty check and its finally block.
                    result.append(cf_sync.start_batch_queue([{"contest_id": 5, "index": "A"}], SessionLocal))
        with patch.object(cf_sync, "_batch_queue", old_queue), patch.object(cf_sync, "_batch_queue_lock", HandoffLock()), patch("core.cf_sync.threading.Thread"):
            cf_sync._bg_batch_translate(SessionLocal, old_queue)
            self.assertEqual(result, [("started", 1)])
            self.assertTrue(cf_sync._batch_queue["is_active"])
            self.assertEqual(cf_sync._batch_queue["remaining_problems"], [{"contest_id": 5, "index": "A"}])

    def test_batch_start_count_is_not_changed_by_a_fast_worker(self):
        with patch.object(cf_sync, "_batch_queue", {"is_active": False}), patch("core.cf_sync.threading.Thread") as thread:
            thread.return_value.start.side_effect = lambda: cf_sync._batch_queue["remaining_problems"].clear()
            self.assertEqual(cf_sync.start_batch_queue([{"contest_id": 4, "index": "A"}], SessionLocal), ("started", 1))

    def test_large_numeric_inputs_and_missing_pages_do_not_crash_sqlite(self):
        with SessionLocal() as db:
            db.add(ProblemsetLibrary(id="4_A", contest_id=4, index="A", name="Watermelon"))
            db.add(database.create_cached_problem("4_A", 4, "A", source(), translated()))
            db.commit()
        huge = "9" * 80
        self.assertEqual(self.client.get("/api/problems", query_string={"query": huge}).status_code, 200)
        self.assertEqual(self.client.get("/api/problems", query_string={"page": huge}).status_code, 400)
        self.assertEqual(self.client.get(f"/api/problem/{huge}/A").status_code, 400)
        response = self.client.get("/cached", query_string={"page": huge})
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Watermelon", response.data)

    def test_metadata_labels_do_not_remove_parts_of_input_output_filenames(self):
        html = '''<div class="problem-statement"><div class="header"><div class="title">A. Files</div>
        <div class="input-file"><div class="property-title">input</div>input.txt</div>
        <div class="output-file"><div class="property-title">output</div>output.txt</div>
        <div class="time-limit"><div class="property-title">time limit per test</div>1 second</div></div>
        <div><p>Read the file.</p></div></div>'''
        result = parse_problem_html(html, 4, "A")
        self.assertEqual(result["input_file"], "input.txt")
        self.assertEqual(result["output_file"], "output.txt")
        self.assertEqual(result["time_limit"], "1 second")

    def test_real_statement_can_contain_words_used_on_challenge_pages(self):
        response = Response()
        response.status_code = 200
        response._content = b'<div class="problem-statement"><div class="header"><div class="title">A. Wait</div></div><div><p>Just a moment, Alice said.</p></div></div>'
        with patch("core.scraper.requests.Session") as session, patch("core.scraper.time.sleep"):
            session.return_value.__enter__.return_value.get.return_value = response
            self.assertEqual(scrape_cf_problem(4, "A")["title"], "Wait")
            self.assertEqual(session.return_value.__enter__.return_value.get.call_count, 1)

    def test_model_test_validates_id_and_releases_transaction_before_network(self):
        self.assertEqual(self.client.post("/api/config/test", json={"id": {}}).status_code, 400)
        with SessionLocal() as db:
            node = LLMConfig(name="test", api_key="test-only", model="test")
            db.add(node)
            db.commit()
            node_id = node.id
        def complete(*args):
            self.assertFalse(database.get_flask_db().in_transaction())
            return "received"
        with patch("core.api.config.test_llm_connection", side_effect=complete):
            response = self.client.post("/api/config/test", json={"id": node_id, "api_key": "****", "model": "test"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["reply"], "received")

    def test_malformed_model_shapes_fail_safely_instead_of_attribute_error(self):
        for payload in ({"choices": [None]}, {"choices": [{"message": []}]}):
            response = type("Response", (), {"status_code": 200, "json": lambda self: payload})()
            with self.subTest(payload=payload), patch("requests.post", return_value=response), self.assertRaises(TranslationError):
                request_completion("test-only", "https://example.com/v1", "test", [])

    def test_oversized_api_payload_returns_readable_json(self):
        response = self.client.post("/api/config/llm", data=b" " * (2 * 1024 * 1024 + 1), content_type="application/json")
        self.assertEqual(response.status_code, 413)
        self.assertIn("detail", response.json)

    def test_contest_overview_handles_cf_unclosed_rows_and_multichar_indexes(self):
        html = '''<title>Dashboard - Test Round - Codeforces</title><table class="problems">
        <tr><td class="id"><a href="/contest/2232/problem/A">A</a></td>
        <td><a href="/contest/2232/problem/A">First problem</a><div>1 s, 256 MB</div></td>
        <tr><td class="id"><a href="/contest/2232/problem/C1">C1</a></td>
        <td><a href="/contest/2232/problem/C1">Easy version</a></td></table>'''
        result = parse_contest_html(html, 2232)
        self.assertEqual(result["contest"]["name"], "Test Round")
        self.assertEqual([(p["index"], p["name"]) for p in result["problems"]],
                         [("A", "First problem"), ("C1", "Easy version")])
        with self.assertRaises(ValueError):
            parse_contest_html('<html>Please log in</html>', 2232)

    def test_contest_screen_fetches_overview_without_download_of_full_standings(self):
        result = {"contest": {"id": 2232, "name": "Test Round"},
                  "problems": [{"contest_id": 2232, "index": "A", "name": "First problem", "tags": []}]}
        with patch("core.api.problems.scrape_cf_contest_problems", return_value=result) as fetch, patch("core.api.problems.cf_api", side_effect=AssertionError("Must not fetch full standings")):
            response = self.client.get("/api/contest/2232/problems")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["problems"][0]["name"], "First problem")
        fetch.assert_called_once_with(2232)

    def test_contest_overview_cache_does_not_refetch_or_share_mutable_results(self):
        from core import scraper
        html = '<table class="problems"><tr><td class="id"><a href="/contest/2232/problem/A">A</a></td><td><a href="/contest/2232/problem/A">First problem</a></td></tr></table>'
        scraper._contest_cache.clear()
        try:
            with patch("core.scraper._fetch_cf_html", return_value=html) as fetch:
                first = scrape_cf_contest_problems(2232)
                first["problems"][0]["name"] = "Changed locally"
                second = scrape_cf_contest_problems(2232)
                self.assertEqual(second["problems"][0]["name"], "First problem")
                self.assertEqual(fetch.call_count, 1)
        finally:
            scraper._contest_cache.clear()


def tearDownModule():
    database.engine.dispose()
    logging.shutdown()
    _TEMP.cleanup()


if __name__ == "__main__":
    unittest.main()
