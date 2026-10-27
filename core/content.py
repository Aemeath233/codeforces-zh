"""Sanitize fetched statements and model output before rendering."""
import re
from urllib.parse import urljoin, urlsplit

import bleach
from bs4 import BeautifulSoup

HTML_FIELDS = ("description_html", "input_spec_html", "output_spec_html", "note_html")
FIELDS = ("title",) + HTML_FIELDS
TAGS = {"p", "div", "span", "br", "b", "strong", "i", "em", "u", "s", "sub", "sup",
        "ul", "ol", "li", "pre", "code", "blockquote", "table", "thead", "tbody",
        "tr", "td", "th", "caption", "img", "a", "h2", "h3", "h4", "hr", "center"}


def sanitize_html(value):
    soup = BeautifulSoup(value or "", "html.parser")
    for node in soup.find_all(["script", "style", "iframe", "object", "embed", "form", "svg", "math"]):
        node.decompose()
    for node in soup.select(".translation-badge, .translation-badge-success, .translation-badge-error, .translation-badge-warning"):
        node.decompose()
    for node in soup.find_all(["a", "img"]):
        attr = "href" if node.name == "a" else "src"
        if node.get(attr):
            url = urljoin("https://codeforces.com/", node[attr])
            if urlsplit(url).scheme in ("http", "https"):
                node[attr] = url
            else:
                del node[attr]
        if node.name == "a":
            node["rel"] = "noopener noreferrer"
        else:
            node["loading"] = "lazy"
    return bleach.clean(str(soup), tags=TAGS, attributes={
        "*": ["class"], "a": ["href", "title", "rel"],
        "img": ["src", "alt", "title", "width", "height", "loading"],
        "td": ["colspan", "rowspan"], "th": ["colspan", "rowspan"], "ol": ["start"],
    }, protocols={"https", "http"}, strip=True)


def normalize_problem(contest_id, index):
    index = str(index).strip().upper()
    if type(contest_id) is not int or not 1 <= contest_id <= 2147483647 or not re.fullmatch(r"[A-Z][A-Z0-9]{0,9}", index):
        raise ValueError("比赛 ID 应为 1 到 2147483647 的整数，题号应为 A、B、A1 等格式")
    return contest_id, index


def is_translated(problem):
    return problem.translation_status == "translated"
