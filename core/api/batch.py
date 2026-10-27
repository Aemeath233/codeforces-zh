from flask import jsonify, request

from ..content import normalize_problem
from . import api_bp


def _normalize_batch_problems(raw_problems):
    if not isinstance(raw_problems, list):
        raise ValueError("批量翻译任务格式不正确")
    if len(raw_problems) > 500:
        raise ValueError("单次批量翻译最多支持 500 道题目")

    normalized = []
    seen = set()
    for pos, item in enumerate(raw_problems, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"第 {pos} 个题目格式不正确")
        try:
            contest_id = int(str(item.get("contest_id", "")).strip())
        except (TypeError, ValueError):
            raise ValueError(f"第 {pos} 个题目的比赛 ID 不正确")
        index = str(item.get("index", "")).strip().upper()
        contest_id, index = normalize_problem(contest_id, index)
        key = (contest_id, index)
        if key in seen:
            continue
        seen.add(key)
        normalized.append({"contest_id": contest_id, "index": index})

    if not normalized:
        raise ValueError("未选中任何有效题目进行预热")
    return normalized


@api_bp.route("/api/batch-translate/start", methods=["POST"])
def api_batch_translate_start():
    payload = request.json or {}
    try:
        problems = _normalize_batch_problems(payload.get("problems", []))
    except ValueError as e:
        return jsonify({"detail": str(e)}), 400

    from core.cf_sync import SessionLocal, start_batch_queue
    status, count = start_batch_queue(problems, SessionLocal)

    if status == "started":
        return jsonify({"status": "success", "message": f"已成功启动后台批量翻译队列，共 {count} 道题目"})
    elif status == "appended":
        return jsonify({"status": "success", "message": f"已成功将 {count} 道新题目追加到后台翻译队列"})
    elif status == "cancelling":
        return jsonify({"detail": "队列正在取消，请结束后重新添加"}), 409
    else: # no_change
        return jsonify({"status": "success", "message": "选中的题目已在队列或正在翻译，无需重复添加"})


@api_bp.route("/api/batch-translate/cancel", methods=["POST"])
def api_batch_translate_cancel():
    from core.cf_sync import cancel_batch_queue
    cancel_batch_queue()
    return jsonify({"status": "success", "message": "已发送取消指令，后台队列正在终止"})


@api_bp.route("/api/batch-translate/status", methods=["GET"])
def api_batch_translate_status():
    from core.cf_sync import get_batch_queue_status
    status = get_batch_queue_status()
    return jsonify(status)
