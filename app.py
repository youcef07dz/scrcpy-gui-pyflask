import os
import json
import uuid
import webbrowser
import threading
from flask import (
    Flask, render_template, request, jsonify, Response,
    stream_with_context, send_from_directory
)
from flask_cors import CORS
from scrcpy_service import service
from pathlib import Path

app = Flask(__name__)
CORS(app)

VIDEO_DIR = str(Path.home() / "Videos")
LOG_BUFFERS = {}
LOG_BUFFER_LOCKS = {}

def get_log_buffer(session_id):
    if session_id not in LOG_BUFFERS:
        LOG_BUFFERS[session_id] = []
        LOG_BUFFER_LOCKS[session_id] = threading.Lock()
    return LOG_BUFFERS[session_id], LOG_BUFFER_LOCKS[session_id]


@app.route("/")
def index():
    return render_template("index.html", version="4.0.0")


@app.route("/api/version")
def api_version():
    return jsonify({"version": "4.0.0"})


@app.route("/api/check-scrcpy", methods=["POST"])
def api_check_scrcpy():
    data = request.get_json(silent=True) or {}
    custom_path = data.get("customPath")
    result = service.check_scrcpy(custom_path)
    return jsonify(result)


@app.route("/api/devices", methods=["POST"])
def api_get_devices():
    data = request.get_json(silent=True) or {}
    custom_path = data.get("customPath")
    result = service.get_devices(custom_path)
    return jsonify(result)


@app.route("/api/adb/connect", methods=["POST"])
def api_adb_connect():
    data = request.get_json(silent=True) or {}
    ip = data.get("ip", "")
    custom_path = data.get("customPath")
    result = service.adb_connect(ip, custom_path)
    return jsonify(result)


@app.route("/api/adb/pair", methods=["POST"])
def api_adb_pair():
    data = request.get_json(silent=True) or {}
    ip = data.get("ip", "")
    code = data.get("code", "")
    custom_path = data.get("customPath")
    result = service.adb_pair(ip, code, custom_path)
    return jsonify(result)


@app.route("/api/adb/kill", methods=["POST"])
def api_adb_kill():
    data = request.get_json(silent=True) or {}
    custom_path = data.get("customPath")
    result = service.adb_kill(custom_path)
    return jsonify(result)


@app.route("/api/scrcpy/start", methods=["POST"])
def api_scrcpy_start():
    data = request.get_json(silent=True) or {}
    config = data.get("config", {})
    session_id = str(uuid.uuid4())

    def on_log(msg):
        buf, lock = get_log_buffer(session_id)
        with lock:
            buf.append(msg)
        print(msg)

    def on_status(status):
        pass

    try:
        result = service.run_scrcpy(config, on_log=on_log, on_status=on_status, video_dir=VIDEO_DIR)
        result["sessionId"] = session_id
        return jsonify(result)
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 400


@app.route("/api/scrcpy/stop", methods=["POST"])
def api_scrcpy_stop():
    data = request.get_json(silent=True) or {}
    device = data.get("device", "")
    result = service.stop_scrcpy(device)
    return jsonify(result)


@app.route("/api/scrcpy/logs/<session_id>")
def api_scrcpy_logs(session_id):
    buf, lock = get_log_buffer(session_id)
    with lock:
        logs = list(buf)
        buf.clear()
    return jsonify(logs)


@app.route("/api/scrcpy/options", methods=["POST"])
def api_scrcpy_options():
    data = request.get_json(silent=True) or {}
    device = data.get("device", "")
    arg = data.get("arg", "")
    custom_path = data.get("customPath")
    result = service.list_scrcpy_options(device, arg, custom_path)
    return jsonify(result)


@app.route("/api/scrcpy/render-drivers", methods=["POST"])
def api_render_drivers():
    data = request.get_json(silent=True) or {}
    custom_path = data.get("customPath")
    result = service.get_render_drivers(custom_path)
    return jsonify(result)


@app.route("/api/scrcpy/download", methods=["POST"])
def api_scrcpy_download():
    def generate():
        def on_log(msg):
            yield f"data: {json.dumps({'type': 'log', 'message': msg})}\n\n"

        try:
            for _ in range(3):
                yield f"data: {json.dumps({'type': 'progress', 'percent': 0})}\n\n"
            result = service.download_scrcpy(on_log=on_log)
            yield f"data: {json.dumps({'type': 'complete', 'message': 'Download complete'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/api/file/push", methods=["POST"])
def api_push_file():
    data = request.get_json(silent=True) or {}
    device = data.get("device", "")
    file_path = data.get("filePath", "")
    custom_path = data.get("customPath")
    result = service.push_file(device, file_path, custom_path)
    return jsonify(result)


@app.route("/api/file/install-apk", methods=["POST"])
def api_install_apk():
    data = request.get_json(silent=True) or {}
    device = data.get("device", "")
    file_path = data.get("filePath", "")
    custom_path = data.get("customPath")
    result = service.install_apk(device, file_path, custom_path)
    return jsonify(result)


@app.route("/api/terminal/run", methods=["POST"])
def api_terminal_run():
    data = request.get_json(silent=True) or {}
    cmd = data.get("cmd", "")
    device = data.get("device")
    custom_path = data.get("customPath")
    result = service.run_terminal_command(cmd, device, custom_path)
    return jsonify(result)


@app.route("/api/scrcpy/running", methods=["GET"])
def api_running_devices():
    return jsonify(service.get_running_devices())


if __name__ == "__main__":
    print("=" * 60)
    print("  Scrcpy GUI - Flask Edition")
    print("  Opening http://127.0.0.1:5000 in your browser...")
    print("=" * 60)
    threading.Timer(1.5, lambda: webbrowser.open("http://127.0.0.1:5000")).start()
    app.run(host="127.0.0.1", port=5000, debug=True, threaded=True)
