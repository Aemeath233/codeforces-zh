import requests
from bs4 import BeautifulSoup
import re
import json
import logging
import time

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

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

def scrape_cf_problem(contest_id: int, index: str) -> dict:
    """
    Scrapes a Codeforces problem by contest ID and index (e.g. 1800, 'C').
    Orchestrates fallback loops through main servers, mirror servers, and gym sections.
    Forces English language content.
    """
    index_upper = index.strip().upper()
    
    # Exhaustive fallback checklist to bypass Cloudflare blocks and gym routes
    # Appending ?locale=en strictly forces Codeforces to return the English version of the page.
    urls = [
        f"https://codeforces.com/contest/{contest_id}/problem/{index_upper}?locale=en",
        f"https://codeforces.com/problemset/problem/{contest_id}/{index_upper}?locale=en",
        f"https://mirror.codeforces.com/contest/{contest_id}/problem/{index_upper}?locale=en",
        f"https://mirror.codeforces.com/problemset/problem/{contest_id}/{index_upper}?locale=en",
        f"https://codeforces.com/gym/{contest_id}/problem/{index_upper}?locale=en",
        f"https://mirror.codeforces.com/gym/{contest_id}/problem/{index_upper}?locale=en"
    ]
    
    html = None
    last_err = None
    for url in urls:
        try:
            logger.info(f"Fetching Codeforces problem from: {url}")
            # Add a small delay to respect CF's rate limit
            time.sleep(0.5)
            
            response = requests.get(url, headers=HEADERS, timeout=15.0)
            if response.status_code == 200:
                # Check if it's the actual problem statement or a redirect to the list page
                if "problem-statement" in response.text:
                    html = response.text
                    break
                else:
                    logger.warning(f"URL loaded successfully but 'problem-statement' not found: {url}")
            else:
                logger.warning(f"Failed to fetch {url}, status code: {response.status_code}")
        except Exception as e:
            logger.error(f"Error fetching {url}: {str(e)}")
            last_err = e
            
    if not html:
        raise Exception(f"Failed to fetch problem {contest_id}{index_upper} from Codeforces. Error: {last_err or 'Page not found'}")
        
    soup = BeautifulSoup(html, "html.parser")
    problem_node = soup.find("div", class_="problem-statement")
    
    if not problem_node:
        raise Exception("Failed to locate problem-statement element in the retrieved page.")
        
    # 1. Parse Header
    header = problem_node.find("div", class_="header")
    if not header:
        raise Exception("Header of the problem statement not found.")
        
    title_node = header.find("div", class_="title")
    title = clean_latex(title_node.text.strip()) if title_node else f"{index_upper}. Problem"
    # Remove index prefix from title if present (e.g., "A. Soft Drinking" -> "Soft Drinking")
    if title.startswith(f"{index_upper}."):
        title = title[len(index_upper) + 1:].strip()
    elif title.startswith(f"{index_upper} "):
        title = title[len(index_upper) + 1:].strip()
        
    time_limit_node = header.find("div", class_="time-limit")
    time_limit = time_limit_node.text.replace("time limit per test", "").strip() if time_limit_node else ""
    
    memory_limit_node = header.find("div", class_="memory-limit")
    memory_limit = memory_limit_node.text.replace("memory limit per test", "").strip() if memory_limit_node else ""
    
    input_file_node = header.find("div", class_="input-file")
    input_file = input_file_node.text.replace("input", "").strip() if input_file_node else ""
    
    output_file_node = header.find("div", class_="output-file")
    output_file = output_file_node.text.replace("output", "").strip() if output_file_node else ""
    
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
                # Clean up <pre> structure. Codeforces wraps text in <pre>, sometimes with <br/> or nested divs for lines.
                pre_in = inp.find("pre") or inp
                pre_out = outp.find("pre") or outp
                
                # Extract text and structured lines preserving alternating class names
                def extract_pre_info(pre_elem):
                    if not pre_elem:
                        return "", []
                    # Handle <br/> to actual newlines
                    for br in pre_elem.find_all("br"):
                        try:
                            br.replace_with("\n")
                        except Exception:
                            pass
                    
                    # Exclude the title div if pre_elem is the parent inp/outp div
                    title_div = pre_elem.find("div", class_="title")
                    title_len = 0
                    if title_div:
                        # Extract title text length to slice off
                        title_len = len(title_div.text)
                    
                    # Some inputs/outputs are split into divs by Codeforces
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
                            lines_data.append({
                                "text": d.text,
                                "class": line_class
                            })
                        nested_text = "\n".join([d.text for d in nested_divs])
                        return nested_text, lines_data
                    
                    raw_text = pre_elem.text
                    if title_len > 0 and raw_text.strip().startswith(title_div.text.strip()):
                        # Safely slice off the header title text
                        start_idx = raw_text.find(title_div.text) + title_len
                        raw_text = raw_text[start_idx:].strip()
                    else:
                        raw_text = raw_text.strip()
                        
                    # Split raw text by newlines and assign none class
                    lines_data = [{"text": line, "class": "none"} for line in raw_text.split("\n")]
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
        
    return {
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
