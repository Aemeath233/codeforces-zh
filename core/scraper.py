import copy
import json
import logging
import re
import threading
import time

import requests
from bs4 import BeautifulSoup

from .content import HTML_FIELDS, normalize_problem, sanitize_html

logger = logging.getLogger(__name__)

# Keep the request profile known to work with CF. A bare "Mozilla/5.0"
# regressed public statement fetching: 2232A returned a challenge with it,
# while this existing profile returned the statement on the same connection.
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
    "Cache-Control": "max-age=0",
    "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}
_page_lock = threading.Lock()
_last_page_request = 0.0
_contest_lock = threading.Lock()
_contest_cache = {}


def clean_latex(html_content):
    """
    Codeforces raw HTML uses $$$ for LaTeX block and inline equations.
    This replaces $$$ with standard $ for markdown-friendly and LLM-friendly LaTeX notation.
    """
    if not html_content:
        return ""
    # Codeforces uses triple dollar signs $$$ for equations
    return html_content.replace("$$$", "$")

def extract_inner_html(element):
    """
    Extracts the inner HTML of a BeautifulSoup element while converting $$$ to $.
    """
    if not element:
        return ""
    # We clean the text/HTML to ensure $$$ becomes $
    raw_html = "".join([str(child) for child in element.children])
    return clean_latex(raw_html)

def _fetch_cf_html(paths, selector, label):
    """Use the tested request profile and shared page gate for public HTML."""
    global _last_page_request
    urls = [f"https://{host}/{path}?locale=en"
            for host in ("codeforces.com", "mirror.codeforces.com") for path in paths]
    html = None
    errors = []
    with requests.Session() as session:
        session.headers.update(HEADERS)
        for url in urls:
            route = url.removeprefix("https://").split("?", 1)[0]
            try:
                with _page_lock:
                    delay = 1.0 - (time.monotonic() - _last_page_request)
                    if delay > 0:
                        time.sleep(delay)
                    _last_page_request = time.monotonic()
                    response = session.get(url, timeout=(4, 12))
                has_content = response.status_code == 200 and BeautifulSoup(
                    response.text, "html.parser").select_one(selector) is not None
                challenge = response.headers.get("cf-mitigated") == "challenge" or (
                    not has_content and any(t in response.text.lower() for t in
                        ("just a moment", "cf-challenge", "verify you are human", "checking your browser")))
                logger.info("CF statement response: %s HTTP %s, challenge=%s",
                            route, response.status_code, challenge)
                if response.status_code == 429:
                    raise PermissionError("Codeforces 暂时限流（HTTP 429），请稍后重试，或打开官网复制题面到本地翻译。")
                if challenge:
                    errors.append(f"{route}：返回浏览器验证页")
                    continue
                if response.status_code == 403:
                    errors.append(f"{route}：拒绝访问（HTTP 403）")
                    continue
                response.raise_for_status()
                if has_content:
                    html = response.text
                    break
                errors.append(f"{route}：未找到题面，可能需要登录或比赛尚未开放")
            except PermissionError:
                raise
            except requests.HTTPError as exc:
                logger.warning("CF statement HTTP error: %s HTTP %s", route, exc.response.status_code)
                errors.append(f"{route}：HTTP {exc.response.status_code}")
            except requests.RequestException as exc:
                logger.warning("CF statement request failed: %s (%s)", route, type(exc).__name__)
                errors.append(f"{route}：连接失败或响应超时（{type(exc).__name__}）")
    if not html:
        raise ValueError(f"无法获取{label}：" + "；".join(errors))
    return html


def scrape_cf_problem(contest_id: int, index: str) -> dict:
    """Fetch an English statement; Gym has no public problemset route."""
    contest_id, index = normalize_problem(contest_id, index)
    paths = ([f"gym/{contest_id}/problem/{index}"] if contest_id >= 100000 else
             [f"contest/{contest_id}/problem/{index}", f"problemset/problem/{contest_id}/{index}"])
    return parse_problem_html(_fetch_cf_html(paths, "div.problem-statement", "英文原题"), contest_id, index)


def parse_contest_html(html, contest_id):
    contest_id, _ = normalize_problem(contest_id, "A")
    soup = BeautifulSoup(html, "html.parser")
    table = soup.select_one("table.problems")
    problems, seen = [], set()
    for cell in table.select("td.id") if table else []:
        link = cell.find("a", href=True)
        match = re.fullmatch(rf"/(?:contest|gym)/{contest_id}/problem/([A-Z][A-Z0-9]{{0,9}})/?", link["href"]) if link else None
        if not match or match[1] in seen:
            continue
        name_cell = cell.find_next_sibling("td")
        name_link = name_cell.find("a", href=link["href"]) if name_cell else None
        if not name_link:
            continue
        seen.add(match[1])
        problems.append({"contest_id": contest_id, "index": match[1],
                         "name": name_link.get_text(" ", strip=True), "type": "PROGRAMMING",
                         "rating": None, "tags": []})
    if not problems:
        raise ValueError("未找到公开的比赛题目列表，比赛可能尚未开始或需要登录")
    name = soup.title.get_text(" ", strip=True) if soup.title else f"Contest {contest_id}"
    name = name.removeprefix("Dashboard - ").removesuffix(" - Codeforces")
    return {"contest": {"id": contest_id, "name": name}, "problems": problems}


def scrape_cf_contest_problems(contest_id):
    contest_id, _ = normalize_problem(contest_id, "A")
    with _contest_lock:
        cached = _contest_cache.get(contest_id)
        if cached and time.monotonic() - cached[0] < 300:
            return copy.deepcopy(cached[1])
        section = "gym" if contest_id >= 100000 else "contest"
        html = _fetch_cf_html([f"{section}/{contest_id}"], "table.problems", "比赛题目列表")
        result = parse_contest_html(html, contest_id)
        if len(_contest_cache) >= 64:
            _contest_cache.clear()
        _contest_cache[contest_id] = (time.monotonic(), result)
        return copy.deepcopy(result)


def parse_problem_html(html, contest_id, index):
    contest_id, index_upper = normalize_problem(contest_id, index)
    soup = BeautifulSoup(html, "html.parser")
    problem_node = soup.find("div", class_="problem-statement")

    if not problem_node:
        raise ValueError("粘贴内容中未找到完整的 problem-statement 题面区域")

    # 1. Parse Header
    header = problem_node.find("div", class_="header")
    if not header:
        raise ValueError("题面缺少标题区域，请粘贴完整的原题 HTML")

    title_node = header.find("div", class_="title")
    title = clean_latex(title_node.text.strip()) if title_node else f"{index_upper}. Problem"
    # Remove index prefix from title if present (e.g., "A. Soft Drinking" -> "Soft Drinking")
    if title.startswith(f"{index_upper}."):
        title = title[len(index_upper) + 1:].strip()
    elif title.startswith(f"{index_upper} "):
        title = title[len(index_upper) + 1:].strip()

    def header_value(class_name):
        node = header.find("div", class_=class_name)
        if node is None:
            return ""
        for label in node.find_all(class_="property-title"):
            label.decompose()
        return node.get_text(" ", strip=True)

    time_limit = header_value("time-limit")
    memory_limit = header_value("memory-limit")
    input_file = header_value("input-file")
    output_file = header_value("output-file")

    # 2. Parse Description (Everything after header, but before input/output specs, samples or notes)
    description_elements = []
    started = False
    for child in problem_node.children:
        if not child.name:
            continue
        if child.name == "div" and child.get("class") and "header" in child.get("class"):
            started = True
            continue
        if not started:
            continue
        if child.name == "div" and child.get("class"):
            classes = child.get("class")
            if any(c in classes for c in ["input-specification", "output-specification", "sample-tests", "note"]):
                break
        description_elements.append(str(child))

    description_html = clean_latex("".join(description_elements)).strip()

    # 3. Parse Input Specification
    input_spec_node = problem_node.find("div", class_="input-specification")
    input_spec_html = ""
    if input_spec_node:
        # Remove the section-title header (e.g. "Input")
        title_div = input_spec_node.find("div", class_="section-title")
        if title_div:
            title_div.decompose()
        input_spec_html = extract_inner_html(input_spec_node).strip()

    # 4. Parse Output Specification
    output_spec_node = problem_node.find("div", class_="output-specification")
    output_spec_html = ""
    if output_spec_node:
        title_div = output_spec_node.find("div", class_="section-title")
        if title_div:
            title_div.decompose()
        output_spec_html = extract_inner_html(output_spec_node).strip()

    # 5. Parse Samples
    samples_node = problem_node.find("div", class_="sample-tests")
    samples = []
    if samples_node:
        sample_test_nodes = samples_node.find_all("div", class_="sample-test")
        for test_node in sample_test_nodes:
            inputs = test_node.find_all("div", class_="input")
            outputs = test_node.find_all("div", class_="output")

            for inp, outp in zip(inputs, outputs):
                pre_in = inp.find("pre") or inp
                pre_out = outp.find("pre") or outp

                # Extract text and structured lines preserving alternating class names
                def extract_pre_info(pre_elem):
                    if not pre_elem:
                        return "", []
                    for br in pre_elem.find_all("br"):
                        try:
                            br.replace_with("\n")
                        except Exception:
                            pass

                    title_div = pre_elem.find("div", class_="title")
                    title_len = 0
                    if title_div:
                        title_len = len(title_div.text)

                    nested_divs = pre_elem.find_all("div", class_="test-example-line")
                    if nested_divs:
                        lines_data = []
                        for d in nested_divs:
                            cls_list = d.get("class", [])
                            line_class = "none"
                            if "test-example-line-even" in cls_list:
                                line_class = "even"
                            elif "test-example-line-odd" in cls_list:
                                line_class = "odd"

                            group = None
                            for cls in cls_list:
                                if cls.startswith("test-example-line-"):
                                    suffix = cls[len("test-example-line-"):]
                                    if suffix.isdigit():
                                        group = int(suffix)
                                        break

                            lines_data.append({
                                "text": d.text,
                                "class": line_class,
                                "group": group
                            })
                        nested_text = "\n".join([d.text for d in nested_divs])
                        return nested_text, lines_data

                    raw_text = pre_elem.text
                    if title_len > 0 and raw_text.strip().startswith(title_div.text.strip()):
                        start_idx = raw_text.find(title_div.text) + title_len
                        raw_text = raw_text[start_idx:].lstrip("\r\n")

                    lines_data = [{"text": line, "class": "none", "group": None} for line in raw_text.split("\n")]
                    return raw_text, lines_data

                input_text, input_lines = extract_pre_info(pre_in)
                output_text, output_lines = extract_pre_info(pre_out)

                samples.append({
                    "input": input_text,
                    "output": output_text,
                    "input_lines": input_lines,
                    "output_lines": output_lines
                })

    # 6. Parse Note
    note_node = problem_node.find("div", class_="note")
    note_html = ""
    if note_node:
        title_div = note_node.find("div", class_="section-title")
        if title_div:
            title_div.decompose()
        note_html = extract_inner_html(note_node).strip()

    result = {
        "contest_id": contest_id,
        "index": index_upper,
        "title": title,
        "time_limit": time_limit,
        "memory_limit": memory_limit,
        "input_file": input_file,
        "output_file": output_file,
        "description_html": description_html,
        "input_spec_html": input_spec_html,
        "output_spec_html": output_spec_html,
        "samples_json": json.dumps(samples),
        "note_html": note_html
    }

    for field in HTML_FIELDS:
        result[field] = sanitize_html(result[field])
    return result
