import os
import sys
import json
import time
import shutil
import signal
import platform
import subprocess
import threading
import re
import tempfile
import zipfile
import tarfile
from pathlib import Path
from datetime import datetime
from queue import Queue

AUDIO_FALLBACK_CHAIN = ["aac", "flac", "raw"]


def get_binary_path(binary_name, custom_folder=None):
    exe_ext = ".exe" if platform.system() == "Windows" else ""
    binary_filename = f"{binary_name}{exe_ext}"

    if custom_folder and custom_folder.strip():
        full_path = Path(custom_folder) / binary_filename
        if full_path.exists() and full_path.is_file():
            return str(full_path)

    same_dir = Path(__file__).parent / binary_filename
    if same_dir.exists() and same_dir.is_file():
        return str(same_dir)

    scrcpy_dir = Path(__file__).parent / "scrcpy" / binary_filename
    if scrcpy_dir.exists() and scrcpy_dir.is_file():
        return str(scrcpy_dir)

    local_bin = Path("scrcpy-bin") / binary_filename
    if local_bin.exists() and local_bin.is_file():
        return str(local_bin)

    return binary_name


def detect_host_os():
    system = platform.system().lower()
    if system == "windows":
        return "windows"
    elif system == "darwin":
        return "macos"
    elif system == "linux":
        return "linux"
    return "unknown"


def render_driver_label(driver):
    labels = {
        "direct3d": "D3D11 (Direct3D)",
        "opengl": "OpenGL",
        "opengles2": "OpenGL ES 2",
        "opengles": "OpenGL ES",
        "metal": "Metal",
        "software": "Software",
        "vulkan": "Vulkan",
    }
    return labels.get(driver, "Custom")


def is_driver_allowed_on_os(driver, host_os):
    if host_os == "windows":
        return driver != "metal"
    elif host_os == "macos":
        return driver != "direct3d"
    elif host_os == "linux":
        return driver not in ("direct3d", "metal")
    return True


def is_audio_codec_error(text):
    lower = text.lower()
    if "could not create default audio encoder" in lower or "failed to initialize audio" in lower:
        return True
    mentions_codec = "audio encoder" in lower or "audio codec" in lower
    mentions_failure = any(x in lower for x in ("fail", "error", "could not", "not available", "not supported"))
    return mentions_codec and mentions_failure


def split_args(s):
    args = []
    current = []
    in_quotes = False
    for c in s:
        if c == '"':
            in_quotes = not in_quotes
        elif c.isspace() and not in_quotes:
            if current:
                args.append("".join(current))
                current = []
        else:
            current.append(c)
    if current:
        args.append("".join(current))
    if in_quotes:
        raise ValueError("Unclosed quotes")
    return args


def build_scrcpy_args(config, video_dir_fallback=None, audio_codec_override=None):
    args = []
    device = config.get("device", "")
    if device:
        args.extend(["-s", device])

    codec = config.get("codec", "h264") or "h264"
    args.append(f"--video-codec={codec}")

    otg_pure = config.get("otgPure", False)
    hid_keyboard = config.get("hidKeyboard", False)
    hid_mouse = config.get("hidMouse", False)
    session_mode = config.get("sessionMode", "mirror")

    if session_mode == "mirror" and (hid_keyboard or hid_mouse) and otg_pure:
        if "." in device or ":" in device:
            args.extend(["--no-video", "--no-audio", "--keyboard=uhid", "--mouse=uhid"])
        else:
            args.append("--otg")
    else:
        if hid_keyboard:
            args.append("--keyboard=uhid")
        if hid_mouse:
            args.append("--mouse=uhid")

        render_driver = config.get("renderDriver")
        if render_driver and render_driver not in ("", "auto"):
            args.extend(["--render-driver", render_driver])

        bitrate = config.get("bitrate")
        if bitrate:
            args.extend(["--video-bit-rate", f"{bitrate}M"])

        audio_enabled = config.get("audioEnabled", True)
        if not audio_enabled:
            args.append("--no-audio")
        elif audio_enabled:
            codec_override = audio_codec_override or config.get("audioCodec", "auto")
            if codec_override not in ("", "auto"):
                args.append(f"--audio-codec={codec_override}")

        if config.get("alwaysOnTop"):
            args.append("--always-on-top")
        if config.get("fullscreen"):
            args.append("--fullscreen")
        if config.get("borderless"):
            args.append("--window-borderless")

        rotation = config.get("rotation", "0")
        if rotation != "0":
            args.extend(["--orientation", rotation])

        can_control = session_mode != "camera"
        if can_control:
            if config.get("stayAwake"):
                args.append("--stay-awake")
            if config.get("keepActive"):
                args.append("--keep-active")
            if config.get("turnOff"):
                args.extend(["--turn-screen-off", "--no-power-on"])

        if session_mode == "camera":
            args.append("--video-source=camera")
            camera_id = config.get("cameraId", "")
            camera_facing = config.get("cameraFacing", "")
            if camera_id:
                args.append(f"--camera-id={camera_id}")
            elif camera_facing:
                args.append(f"--camera-facing={camera_facing}")

            res = config.get("res", "0")
            camera_size_map = {
                "3840": "3840x2160", "2560": "2560x1440", "1920": "1920x1080",
                "1600": "1600x900", "1280": "1280x720", "1024": "1024x576", "800": "800x480",
            }
            if res != "0":
                args.append(f"--camera-size={camera_size_map.get(res, '1920x1080')}")
            else:
                args.append("--camera-size=1920x1080")

            camera_ar = config.get("cameraAr", "0")
            if camera_ar != "0":
                args.append(f"--camera-ar={camera_ar}")
            if config.get("cameraHighSpeed"):
                args.append("--camera-high-speed")
            if config.get("cameraTorch"):
                args.append("--camera-torch")
            zoom = config.get("cameraZoom", 1.0)
            if zoom and zoom > 1.005:
                args.append(f"--camera-zoom={zoom:.1f}")

        elif session_mode == "desktop":
            w = config.get("vdWidth", 1920)
            h = config.get("vdHeight", 1080)
            dpi = config.get("vdDpi", 420)
            args.append(f"--new-display={w}x{h}/{dpi}")
            args.append("--video-buffer=100")
            if config.get("flexDisplay"):
                args.append("--flex-display")

        fps = config.get("fps")
        if fps and fps > 0:
            if session_mode == "camera":
                args.append("--camera-fps")
            else:
                args.append("--max-fps")
            args.append(str(fps))
        elif session_mode == "camera" and config.get("cameraHighSpeed"):
            args.extend(["--camera-fps", "60"])

        if session_mode != "camera":
            res = config.get("res", "0")
            if res != "0":
                args.extend(["--max-size", res])

        if config.get("record"):
            path = config.get("recordPath", "").strip() or video_dir_fallback or "."
            filename = f"scrcpy_{device.replace(':', '-')}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.mkv"
            args.append(f"--record={Path(path) / filename}")

        bg_color = config.get("backgroundColor", "")
        if bg_color and bg_color.strip():
            args.append(f"--background-color={bg_color.strip()}")

    return args


class ScrcpyService:
    def __init__(self):
        self.processes = {}
        self.log_queues = {}
        self._lock = threading.Lock()
        self.download_path = Path("downloads")
        self.download_path.mkdir(exist_ok=True)

    def log_callback(self, device_id, message):
        with self._lock:
            if device_id not in self.log_queues:
                self.log_queues[device_id] = Queue()
            self.log_queues[device_id].put(message)

    def get_logs(self, device_id):
        with self._lock:
            queue = self.log_queues.get(device_id)
            if queue is None:
                return []
            logs = []
            while not queue.empty():
                logs.append(queue.get_nowait())
            return logs

    def _run_cmd(self, cmd, timeout=30, custom_path=None):
        binary = cmd[0]
        cmd[0] = get_binary_path(binary, custom_path)
        startupinfo = None
        if platform.system() == "Windows":
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=timeout,
                startupinfo=startupinfo
            )
            return result
        except subprocess.TimeoutExpired:
            return None

    def check_scrcpy(self, custom_path=None):
        exe_path = get_binary_path("scrcpy", custom_path)
        try:
            result = self._run_cmd([exe_path, "--version"], custom_path=custom_path)
            if result and result.returncode == 0:
                return {"found": True, "message": "Scrcpy Ready"}
            return {"found": False, "message": "Failed to start scrcpy"}
        except FileNotFoundError:
            return {"found": False, "message": "Scrcpy not found"}

    def get_devices(self, custom_path=None):
        result = self._run_cmd(["adb", "devices"], custom_path=custom_path)
        if result and result.returncode == 0:
            devices = []
            for line in result.stdout.splitlines():
                if "\tdevice" in line:
                    d = line.split("\t")[0].strip()
                    if d and "._tcp" not in d and "._udp" not in d:
                        devices.append(d)
            return {"error": False, "devices": devices}
        return {"error": True, "message": "ADB returned error"}

    def adb_connect(self, ip, custom_path=None):
        result = self._run_cmd(["adb", "connect", ip], timeout=10, custom_path=custom_path)
        if result:
            out = result.stdout.strip()
            err = result.stderr.strip()
            success = result.returncode == 0 and "cannot connect" not in out and "failed" not in out
            return {"success": success, "message": out or err}
        return {"success": False, "message": "Connection timed out"}

    def adb_pair(self, ip, code, custom_path=None):
        result = self._run_cmd(["adb", "pair", ip, code], timeout=10, custom_path=custom_path)
        if result:
            out = result.stdout.strip()
            err = result.stderr.strip()
            success = result.returncode == 0 and ("Successfully paired" in out or "Successfully paired" in err)
            return {"success": success, "message": out or err}
        return {"success": False, "message": "Pairing failed"}

    def adb_kill(self, custom_path=None):
        self._run_cmd(["adb", "kill-server"], custom_path=custom_path)
        if platform.system() == "Windows":
            self._run_cmd(["taskkill", "/F", "/IM", "adb.exe", "/T"])
        else:
            self._run_cmd(["pkill", "adb"])
        return {"success": True, "message": "ADB Stack Terminated"}

    def push_file(self, device, file_path, custom_path=None):
        result = self._run_cmd(
            ["adb", "-s", device, "push", file_path, "/sdcard/Download/"],
            timeout=120, custom_path=custom_path
        )
        if result and result.returncode == 0:
            return {"success": True, "message": "File pushed to Downloads"}
        return {"success": False, "message": "Transfer failed"}

    def install_apk(self, device, file_path, custom_path=None):
        result = self._run_cmd(
            ["adb", "-s", device, "install", file_path],
            timeout=120, custom_path=custom_path
        )
        if result:
            if result.returncode == 0:
                return {"success": True, "message": result.stdout.strip()}
            return {"success": False, "message": result.stderr.strip()}
        return {"success": False, "message": "Install failed"}

    def list_scrcpy_options(self, device, arg, custom_path=None):
        exe_path = get_binary_path("scrcpy", custom_path)
        result = self._run_cmd(
            [exe_path, "-s", device, arg],
            timeout=15, custom_path=custom_path
        )
        if result:
            combined = result.stdout + result.stderr
            return {"success": result.returncode == 0, "output": combined}
        return {"success": False, "message": "Failed to list options"}

    def get_render_drivers(self, custom_path=None):
        host_os = detect_host_os()
        exe_path = get_binary_path("scrcpy", custom_path)
        try:
            result = self._run_cmd([exe_path, "--help"], custom_path=custom_path)
            if result and result.returncode == 0:
                combined = result.stdout + result.stderr
                lower = combined.lower()
                supports = "--render-driver" in lower
                if not supports:
                    return {
                        "hostOs": host_os, "supportsRenderDriver": False,
                        "supportedDrivers": []
                    }
                known = ["direct3d", "opengl", "opengles2", "opengles", "metal", "software", "vulkan"]
                detected = []
                if "--render-driver" in lower:
                    idx = lower.find("--render-driver")
                    context = lower[idx:idx + 1600]
                    for d in known:
                        if d in context:
                            detected.append(d)
                supported = [
                    {"id": d, "label": render_driver_label(d)}
                    for d in detected if is_driver_allowed_on_os(d, host_os)
                ]
                return {"hostOs": host_os, "supportsRenderDriver": True, "supportedDrivers": supported}
        except Exception:
            pass
        return {"hostOs": host_os, "supportsRenderDriver": False, "supportedDrivers": []}

    def run_terminal_command(self, cmd, device=None, custom_path=None):
        parts = split_args(cmd)
        if not parts:
            return {"success": False, "message": "No command provided"}

        first = parts[0].lower()
        is_scrcpy = first == "scrcpy"
        is_adb = first == "adb"

        binary = "scrcpy" if is_scrcpy else "adb"
        exe_path = get_binary_path(binary, custom_path)

        if is_adb or is_scrcpy:
            parts = parts[1:]

        args = list(parts)
        has_serial = "-s" in args or "--serial" in args
        if not has_serial and device:
            is_global = binary == "adb" and args and args[0] in ("devices", "connect", "pair")
            if not is_global:
                args = ["-s", device] + args

        startupinfo = None
        if platform.system() == "Windows":
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW

        try:
            result = subprocess.run(
                [exe_path] + args, capture_output=True, text=True,
                timeout=60, startupinfo=startupinfo
            )
            return {
                "success": result.returncode == 0,
                "binary": binary,
                "stdout": result.stdout,
                "stderr": result.stderr,
            }
        except subprocess.TimeoutExpired:
            return {"success": False, "message": "Command timed out"}
        except Exception as e:
            return {"success": False, "message": str(e)}

    def download_scrcpy(self, on_log=None):
        import requests as req
        host_os = detect_host_os()
        arch = platform.machine().lower()

        if host_os == "windows":
            arch_tag = "win64" if "64" in arch else "win32"
            ext = ".zip"
        elif host_os == "linux":
            arch_tag = "linux-x86_64"
            ext = ".tar.gz"
        elif host_os == "macos":
            arch_tag = "macos-aarch64" if "aarch64" in arch else "macos-x86_64"
            ext = ".tar.gz"
        else:
            raise RuntimeError("Unsupported OS")

        if on_log:
            on_log(f"[SYSTEM] Detecting platform: {host_os} ({arch_tag})")

        api_url = "https://api.github.com/repos/Genymobile/scrcpy/releases/latest"
        headers = {"User-Agent": "ScrcpyGui-Downloader"}
        resp = req.get(api_url, headers=headers)

        download_url = None
        filename = None

        if resp.status_code == 200:
            data = resp.json()
            for asset in data.get("assets", []):
                name = asset["name"]
                if arch_tag in name and name.endswith(ext):
                    download_url = asset["browser_download_url"]
                    filename = name
                    break

        if not download_url:
            if on_log:
                on_log("[SYSTEM] API fallback, scraping redirect...")
            redirect_resp = req.get("https://github.com/Genymobile/scrcpy/releases/latest",
                                    headers=headers, allow_redirects=True)
            final_url = str(redirect_resp.url)
            tag = final_url.rstrip("/").split("/")[-1]
            if tag.startswith("v"):
                filename = f"scrcpy-{arch_tag}-{tag}{ext}"
                download_url = f"https://github.com/Genymobile/scrcpy/releases/download/{tag}/{filename}"
                if on_log:
                    on_log(f"[SYSTEM] Discovered latest tag: {tag}")

        if not download_url:
            raise RuntimeError(f"Could not find {arch_tag} binary")

        if on_log:
            on_log(f"[SYSTEM] Downloading {filename}...")

        dest = self.download_path / filename
        stream = req.get(download_url, stream=True)
        total = int(stream.headers.get("content-length", 0))
        downloaded = 0

        with open(dest, "wb") as f:
            for chunk in stream.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total and on_log:
                        pct = int(downloaded * 100 / total)
                        on_log(f"[DOWNLOAD] {pct}%")

        if on_log:
            on_log("[SYSTEM] Extracting...")

        extract_to = Path("scrcpy-bin")
        extract_to.mkdir(exist_ok=True)

        if ext == ".zip":
            with zipfile.ZipFile(dest, "r") as zf:
                zf.extractall(extract_to)
        else:
            with tarfile.open(dest, "r:gz") as tf:
                tf.extractall(extract_to)

        bin_dir = list(extract_to.iterdir())[0]
        for item in bin_dir.iterdir():
            shutil.move(str(item), str(extract_to / item.name))

        if on_log:
            on_log("[SYSTEM] Download and extraction complete!")

        return {"success": True, "message": "Download complete"}

    def run_scrcpy(self, config, on_log=None, on_status=None, video_dir=None):
        device = config.get("device", "")
        if not device:
            raise ValueError("No device specified")

        session_mode = config.get("sessionMode", "mirror")
        mode_labels = {"camera": "Camera Mode", "desktop": "Desktop Mode"}
        mode_label = mode_labels.get(session_mode, "Screen Mirroring")

        res = config.get("res", "Original")
        if res == "0":
            res = "Original"
        bitrate = f"{config.get('bitrate', 8)}Mbps"
        fps = f"{config.get('fps', 60)}fps"

        if on_log:
            on_log(f"[SYSTEM] Starting {mode_label} session...")
            on_log(f"[SYSTEM] Target: {device} | Config: {res} @ {bitrate}, {fps}")
            if config.get("record"):
                rp = config.get("recordPath", "Videos") or "Videos"
                on_log(f"[SYSTEM] Recording enabled -> output to {rp}")

        exe_path = get_binary_path("scrcpy", config.get("scrcpyPath"))
        adb_exe_path = get_binary_path("adb", config.get("scrcpyPath"))

        if on_log:
            on_log(f"[SYSTEM] Using scrcpy: {exe_path}")
            on_log(f"[SYSTEM] Using adb: {adb_exe_path}")

        args = build_scrcpy_args(config, video_dir, None)
        if on_log:
            on_log(f"> scrcpy {' '.join(args)}")

        startupinfo = None
        if platform.system() == "Windows":
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW

        env = os.environ.copy()
        env["ADB"] = adb_exe_path

        process = subprocess.Popen(
            [exe_path] + args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            startupinfo=startupinfo,
            text=True,
        )

        with self._lock:
            self.processes[device] = process

        if on_status:
            on_status({"device": device, "running": True})

        def stream_reader(stream, is_error=False):
            for line in iter(stream.readline, ""):
                line = line.rstrip("\n\r")
                if line:
                    if is_error:
                        line = f"[SCREEN] {line}"
                    if on_log:
                        on_log(line)

        t1 = threading.Thread(target=stream_reader, args=(process.stdout, False), daemon=True)
        t2 = threading.Thread(target=stream_reader, args=(process.stderr, True), daemon=True)
        t1.start()
        t2.start()

        def monitor():
            process.wait()
            if on_status:
                on_status({"device": device, "running": False})

        t3 = threading.Thread(target=monitor, daemon=True)
        t3.start()

        return {"success": True, "message": "Session started"}

    def stop_scrcpy(self, device):
        with self._lock:
            process = self.processes.pop(device, None)
        if process:
            if platform.system() == "Windows":
                subprocess.run(["taskkill", "/PID", str(process.pid)], capture_output=True)
            else:
                os.kill(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
        return {"success": True}

    def get_running_devices(self):
        with self._lock:
            return list(self.processes.keys())

    def is_running(self, device):
        with self._lock:
            return device in self.processes


service = ScrcpyService()
