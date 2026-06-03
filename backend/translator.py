import json
import logging
import concurrent.futures
import time
import re
from openai import OpenAI
from sqlalchemy.orm import Session
from database import SystemConfig, LLMConfig

logger = logging.getLogger(__name__)

def heal_latex_colors(text: str) -> str:
    if not text or not isinstance(text, str):
        return text
    colors = r'red|green|blue|yellow|orange|purple|cyan|magenta|white|black|gray|grey|brown|lime|pink|teal|violet'
    healed = text
    # Restore broken LaTeX colors from LLM output, e.g. \colorred -> \color{red}.
    healed = re.sub(
        rf'\\color({colors})\b',
        r'\\color{\1}',
        healed,
        flags=re.IGNORECASE
    )
    # Restore variants where braces were stripped but whitespace remains, e.g. \color red ) -> \color{red} ).
    healed = re.sub(
        rf'\\color\s+({colors})\b',
        r'\\color{\1}',
        healed,
        flags=re.IGNORECASE
    )
    # Some models emit \color{red}x where MathJax's color package applies the color to following tokens.
    # Keep that form intact; MathJax handles it once the color package is loaded.
    return healed

def get_mock_translation(problem_data: dict, error_logs: list = None) -> dict:
    """
    Returns a mock translation for testing purposes when no API keys are available or all fail.
    """
    logger.info("Using mock translator fallback.")
    
    error_html = ""
    if error_logs:
        error_html = (
            "<div style='background: #fee2e2; color: #991b1b; padding: 10px; border-radius: 6px; margin-bottom: 12px; font-size: 13.5px; border: 1px solid #fecaca;'>"
            "<b>❌ [多API回退告警] 您的所有配置大模型节点调用均已失败：</b>"
            "<ul style='margin-left: 20px; margin-top: 6px;'>"
            + "".join([f"<li><b>{name}</b>: {err}</li>" for name, err in error_logs]) +
            "</ul>"
            "已为您平滑回退至系统<b>模拟翻译模式</b>。请前往“管理后台”修复密钥。"
            "</div>"
        )
    else:
        error_html = "<div style='background: #fef08a; color: #854d0e; padding: 10px; border-radius: 6px; margin-bottom: 12px; font-size: 14px; border: 1px solid #fef08a;'>⚠️ [系统提示] 检测到您尚未配置大模型 API Key。当前正处于<b>模拟翻译模式</b>。请前往“管理后台”添加您的大模型密钥以激活真正的 AI 智能翻译。</div>"
    
    return {
        "is_mock": True,
        "translated_title": f"[译] {problem_data.get('title', '')}",
        "translated_description_html": f"{error_html}<p><b>(模拟描述)</b> 这是题目的中文模拟翻译文本。为了方便您调试页面，我们在未配置 API Key 时提供此内容。</p>{problem_data.get('description_html', '')}",
        "translated_input_spec_html": f"<p><b>(模拟输入)</b> 第一行包含一个整数 $t$ ($1 \\le t \\le 10^4$) — 测试用例的数量。</p>{problem_data.get('input_spec_html', '')}",
        "translated_output_spec_html": f"<p><b>(模拟输出)</b> 对于每个测试用例，输出一行包含题目答案的字符串或数值。</p>{problem_data.get('output_spec_html', '')}",
        "translated_note_html": f"<p><b>(模拟提示)</b> 第一个样例的说明在这里。数学公式正常渲染示例：$O(n \\log n)$ 和 $a_i + b_i \\ge 0$。</p>{problem_data.get('note_html', '')}"
    }

def translate_problem(problem_data: dict, db: Session) -> dict:
    """
    Translates the parsed Codeforces problem by packing all fields into a single
    context-aware JSON request. This completely avoids API concurrency queue throttling,
    minimizes network handshakes from 5 to 1, and lets the LLM translate with full context.
    """
    system_config = db.query(SystemConfig).filter(SystemConfig.id == 1).first()
    system_prompt = system_config.system_prompt if system_config else ""

    # Fetch all active LLM configurations sorted by priority (1 is highest)
    active_configs = db.query(LLMConfig).filter(LLMConfig.is_active == True).order_by(LLMConfig.priority.asc()).all()
    
    error_logs = []
    
    # Pack fields into input JSON
    input_data = {
        "title": problem_data.get("title", ""),
        "description_html": problem_data.get("description_html", ""),
        "input_spec_html": problem_data.get("input_spec_html", ""),
        "output_spec_html": problem_data.get("output_spec_html", ""),
        "note_html": problem_data.get("note_html", "")
    }
    
    # Loop through configs
    for config in active_configs:
        # Check if the api_key is default/configured
        if not config.api_key or config.api_key.strip() in ("", "your_api_key_here"):
            logger.info(f"Skipping LLM Config '{config.name}' because API Key is not set.")
            continue
            
        try:
            logger.info(f"Initiating single-request translation with '{config.name}' ({config.model})...")
            start_total_t = time.time()
            
            client = OpenAI(
                api_key=config.api_key.strip(),
                base_url=config.base_url.strip() if config.base_url else "https://api.openai.com/v1"
            )
            
            system_instruction = (
                "You are an expert competitive programming translator. Your task is to translate competitive programming problems (Codeforces) from English to Chinese.\n"
                "You will receive a JSON object containing the fields of the problem: 'title', 'description_html', 'input_spec_html', 'output_spec_html', and 'note_html'.\n"
                "You MUST translate the values of these fields into professional, rigorous, and natural Chinese, and return a JSON object containing the exact same keys.\n"
                "\n"
                "CRITICAL RULES:\n"
                "1. Keep all HTML tags (like <p>, <ul>, <li>, <pre>, <code>, etc.) exactly as they are. Only translate the text inside them.\n"
                "2. Strictly preserve all LaTeX formulas (enclosed in $ or $$). Do NOT translate, modify, or strip curly braces in formulas! (e.g. keep commands like `\\color{red}` or `\\color{green}` exactly as `\\color{red}` and `\\color{green}` with all braces and backslashes intact).\n"
                "3. Use professional competitive programming terms (e.g. array -> 数组/序列, subsequence -> 子序列, query -> 查询/询问, tree -> 树, graph -> 图, node/vertex -> 节点/顶点, index -> 下标/索引, test case -> 测试点/测试数据).\n"
                "4. Return ONLY a valid JSON object. Do not include any explanations, markdown code blocks, or extra text. Ensure it is a pure JSON format response."
            )
            
            user_prompt = (
                f"Please translate the following problem fields into Chinese:\n\n"
                f"{json.dumps(input_data, ensure_ascii=False, indent=2)}\n\n"
                f"Output your translation as a single JSON object matching the input keys."
            )
            
            # Make a single standard call. Our prompt strictly enforces JSON output, 
            # which is 100% supported by all modern models without protocol-level JSON-Mode errors.
            response = client.chat.completions.create(
                model=config.model.strip(),
                messages=[
                    {"role": "system", "content": system_instruction + "\n\n" + system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                temperature=0.1,
                max_tokens=4000
            )
                
            res_content = response.choices[0].message.content.strip()
            
            # Clean up and extract JSON from LLM response
            def extract_and_parse_json(text: str) -> dict:
                text_str = text.strip()
                # Try direct parse first
                try:
                    return json.loads(text_str)
                except Exception:
                    pass
                
                # Strip markdown code blocks
                if text_str.startswith("```json"):
                    text_str = text_str[7:]
                elif text_str.startswith("```"):
                    text_str = text_str[3:]
                if text_str.endswith("```"):
                    text_str = text_str[:-3]
                text_str = text_str.strip()
                try:
                    return json.loads(text_str)
                except Exception:
                    pass
                    
                # Regex boundary search: extract from first { to last }
                first_brace = text_str.find("{")
                last_brace = text_str.rfind("}")
                if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
                    json_candidate = text_str[first_brace:last_brace+1]
                    try:
                        return json.loads(json_candidate)
                    except Exception:
                        pass
                raise Exception("LLM output did not contain a valid JSON translation block")
                
            try:
                translated_results = extract_and_parse_json(res_content)
            except Exception as parse_err:
                logger.error(f"Failed to parse LLM JSON response: {str(parse_err)}. Content: {res_content}")
                raise parse_err
                
            elapsed_time = time.time() - start_total_t
            logger.info(f"All fields translated as a single JSON request in {elapsed_time:.2f}s!")
            
            # Inject premium badge
            success_badge = (
                f"<div style='background: #eff6ff; color: #1e40af; border: 1px solid #bfdbfe; padding: 6px 12px; border-radius: 6px; margin-bottom: 12px; font-size: 13px; font-weight: 500; display: flex; align-items: center; gap: 6px;'>"
                f"<span>🚀</span> [智能加速翻译 v2] 本题已启用全新单次 JSON 上下文联合翻译优化，耗时 <b>{elapsed_time:.2f} 秒</b>，由大模型 <b>{config.name} ({config.model})</b> 翻译并进行格式保护"
                f"</div>"
            )
            
            desc_html = translated_results.get("description_html") or problem_data["description_html"]
            
            return {
                "is_mock": False,
                "translated_title": heal_latex_colors(translated_results.get("title") or f"[译] {problem_data['title']}"),
                "translated_description_html": heal_latex_colors(success_badge + desc_html),
                "translated_input_spec_html": heal_latex_colors(translated_results.get("input_spec_html") or problem_data["input_spec_html"]),
                "translated_output_spec_html": heal_latex_colors(translated_results.get("output_spec_html") or problem_data["output_spec_html"]),
                "translated_note_html": heal_latex_colors(translated_results.get("note_html") or problem_data["note_html"])
            }
            
        except Exception as e:
            logger.warning(f"LLM Config '{config.name}' translation failed: {str(e)}")
            error_logs.append((config.name, str(e)))
            continue
            
    # If all configured LLMs failed
    return get_mock_translation(problem_data, error_logs)


def test_llm_connection(api_key: str, base_url: str, model: str) -> str:
    """
    Validates connection parameters by sending a extremely lightweight prompt.
    Instructs the LLM to reply exactly with '收到' to verify connection and key authenticity.
    Returns the exact string replied by the LLM.
    """
    try:
        client = OpenAI(
            api_key=api_key.strip(),
            base_url=base_url.strip() if base_url else "https://api.openai.com/v1"
        )
        response = client.chat.completions.create(
            model=model.strip(),
            messages=[
                {"role": "user", "content": "你好，这是一个大模型连接测试。为了减少Token消耗并验证连接，请仅回复：【收到】"}
            ],
            max_tokens=20,
            temperature=0.0
        )
        reply = response.choices[0].message.content.strip()
        return reply
    except Exception as e:
        logger.error(f"LLM connection test failed: {str(e)}")
        raise e
