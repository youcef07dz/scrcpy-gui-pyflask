// ═══════════════════════════════════════════════════════════════
//  Scrcpy GUI - Flask Edition  (Vanilla JS)
// ═══════════════════════════════════════════════════════════════

const state = {
  config: {
    device: "",
    sessionMode: "mirror",
    bitrate: 8,
    fps: undefined,
    stayAwake: false,
    turnOff: false,
    audioEnabled: true,
    audioCodec: "auto",
    alwaysOnTop: false,
    fullscreen: false,
    borderless: false,
    record: false,
    recordPath: "",
    scrcpyPath: "",
    otgPure: false,
    cameraFacing: "",
    cameraId: "",
    codec: "h264",
    cameraAr: "0",
    cameraHighSpeed: false,
    vdWidth: 1920,
    vdHeight: 1080,
    vdDpi: 420,
    rotation: "0",
    res: "0",
    hidKeyboard: false,
    hidMouse: false,
    renderDriver: "auto",
    flexDisplay: false,
    cameraTorch: false,
    cameraZoom: 1.0,
    backgroundColor: "",
    keepActive: false,
  },
  devices: [],
  activeDevice: "",
  logs: [],
  runningDevices: [],
  scrcpyStatus: { found: false, message: "Loading..." },
  isDownloading: false,
  downloadProgress: 0,
  isRefreshing: false,
  isAutoConnect: true,
  historyDevices: [],
  detectedCameras: [],
  theme: "ultraviolet",
  colorMode: "dark",
  locale: "en",
  sessionId: null,
  renderDriverSupport: { hostOs: "unknown", supportsRenderDriver: false, supportedDrivers: [] },
  videoDir: "",
};

// ─── I18n ────────────────────────────────────────────────
const TRANSLATIONS = {};
let currentLocale = "en";

async function loadTranslations(locale) {
  try {
    const r = await fetch(`/static/lang/${locale}.json`);
    if (r.ok) {
      const data = await r.json();
      TRANSLATIONS[locale] = data;
      return data;
    }
  } catch (e) {}
  return null;
}

function t(key, vars) {
  const keys = key.split(".");
  let val = TRANSLATIONS[currentLocale];
  for (const k of keys) {
    if (val && val[k] !== undefined) val = val[k];
    else { val = key; break; }
  }
  if (typeof val !== "string") val = key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      val = val.replace(`{${k}}`, v);
    }
  }
  return val;
}

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    el.textContent = t(key);
  });
}

// ─── Persistence ─────────────────────────────────────────
function saveState() {
  try {
    localStorage.setItem("scrcpy_config", JSON.stringify(state.config));
    localStorage.setItem("scrcpy_theme", state.theme);
    localStorage.setItem("scrcpy_color_mode", state.colorMode);
    localStorage.setItem("scrcpy_auto_connect", state.isAutoConnect ? "true" : "false");
    localStorage.setItem("scrcpy_locale", currentLocale);
  } catch (e) {}
}

function loadState() {
  try {
    const cfg = localStorage.getItem("scrcpy_config");
    if (cfg) Object.assign(state.config, JSON.parse(cfg));
    const theme = localStorage.getItem("scrcpy_theme");
    if (theme) state.theme = theme;
    const cm = localStorage.getItem("scrcpy_color_mode");
    if (cm) state.colorMode = cm;
    const auto = localStorage.getItem("scrcpy_auto_connect");
    if (auto !== null) state.isAutoConnect = auto === "true";
    const loc = localStorage.getItem("scrcpy_locale");
    if (loc) currentLocale = loc;
    const hist = localStorage.getItem("scrcpy_history");
    if (hist) state.historyDevices = JSON.parse(hist);
  } catch (e) {}
}

// ─── Theme ────────────────────────────────────────────────
function applyTheme() {
  document.documentElement.setAttribute("data-theme", state.theme);
  document.querySelectorAll(".theme-swatch").forEach(el => {
    const isActive = el.getAttribute("data-theme") === state.theme;
    el.classList.toggle("ring-2", isActive);
    el.classList.toggle("ring-white", isActive);
    el.classList.toggle("ring-offset-2", isActive);
    el.classList.toggle("ring-offset-black", isActive);
    el.classList.toggle("scale-110", isActive);
    el.classList.toggle("opacity-50", !isActive);
    el.classList.toggle("hover:opacity-100", !isActive);
  });
  saveState();
}

function applyColorMode() {
  const mode = state.colorMode;
  if (mode === "system") {
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-mode", dark ? "dark" : "light");
  } else {
    document.documentElement.setAttribute("data-mode", mode);
  }

  document.querySelectorAll(".mode-btn").forEach(el => {
    const btnMode = el.getAttribute("data-mode");
    const isActive = btnMode === mode;
    el.classList.toggle("bg-primary", isActive);
    el.classList.toggle("text-on-primary", isActive);
    el.classList.toggle("shadow-sm", isActive);
    el.classList.toggle("text-zinc-400", !isActive);
    el.classList.toggle("hover:text-primary", !isActive);
    el.classList.toggle("hover:bg-zinc-800/60", !isActive);
  });
  saveState();
}

// ─── API Helpers ──────────────────────────────────────────
async function api(path, body) {
  try {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return await r.json();
  } catch (e) {
    return { error: true, message: e.message };
  }
}

async function apiGet(path) {
  try {
    const r = await fetch(path);
    return await r.json();
  } catch (e) {
    return { error: true, message: e.message };
  }
}

// ─── Core Functions ───────────────────────────────────────
async function checkScrcpy() {
  const res = await api("/api/check-scrcpy", { customPath: state.config.scrcpyPath });
  state.scrcpyStatus = res;
  updateEngineStatus();

  if (res.found) {
    document.getElementById("installCoreBtn").classList.add("hidden");
    document.getElementById("setupHelpBtn").classList.add("hidden");
    const rd = await api("/api/scrcpy/render-drivers", { customPath: state.config.scrcpyPath });
    state.renderDriverSupport = rd;
    buildRendererOptions();
  } else {
    document.getElementById("installCoreBtn").classList.remove("hidden");
    document.getElementById("setupHelpBtn").classList.remove("hidden");
  }
}

async function refreshDevices(silent) {
  if (state.isRefreshing) return;
  state.isRefreshing = true;
  document.getElementById("refreshBtn").disabled = true;
  document.getElementById("refreshIcon").classList.add("animate-spin");

  const prevDevices = [...state.devices];
  const res = await api("/api/devices", { customPath: state.config.scrcpyPath });

  if (!res.error) {
    const newDevices = res.devices || [];
    const added = newDevices.filter(d => !prevDevices.includes(d));
    const removed = prevDevices.filter(d => !newDevices.includes(d));

    added.forEach(d => addLog(`[SYSTEM] New device discovered: ${d}`));
    removed.forEach(d => addLog(`[SYSTEM] Device disconnected: ${d}`));

    if (!silent && added.length === 0 && removed.length === 0) {
      addLog(`[SYSTEM] Discovery active: ${newDevices.length} device(s) found.`);
    }

    state.devices = newDevices;
    if (newDevices.length > 0 && !state.activeDevice) {
      state.activeDevice = newDevices[0];
    } else if (newDevices.length === 0) {
      state.activeDevice = "";
    }
    renderDevices();
  } else {
    addLog(`[SYSTEM] Discovery error: ${res.message || "Unknown"}`);
  }

  updateRunningStatus();
  state.isRefreshing = false;
  document.getElementById("refreshBtn").disabled = false;
  document.getElementById("refreshIcon").classList.remove("animate-spin");
}

function renderDevices() {
  const container = document.getElementById("deviceList");
  if (state.devices.length === 0) {
    container.innerHTML = `<div class="text-[10px] text-zinc-600 italic py-4 text-center border border-dashed border-zinc-800/50 rounded-lg bg-black/20">${t("sidebar.noDevicesDetected")}</div>`;
    return;
  }
  container.innerHTML = state.devices.map(d => {
    const isRunning = state.runningDevices.includes(d);
    const isSelected = state.activeDevice === d;
    const isWireless = d.includes(".");
    return `
      <button onclick="selectDevice('${d}')" class="device-btn flex items-center gap-2.5 p-2.5 rounded-lg border transition-all text-left group ${isSelected ? 'bg-primary/5 border-primary/30' : 'bg-black/20 border-zinc-800/50 hover:border-zinc-700'}">
        <div class="p-1.5 rounded-md transition-colors ${isSelected ? 'bg-primary text-on-primary' : 'bg-zinc-800 text-zinc-500 group-hover:text-zinc-300'}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18"/></svg>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-[11px] font-bold truncate tracking-tight ${isSelected ? 'text-white' : 'text-zinc-400 group-hover:text-zinc-200'}">${d}</p>
          <div class="flex items-center gap-2 mt-0.5">
            ${isRunning ? '<span class="flex items-center gap-1"><span class="w-1 h-1 rounded-full bg-emerald-500 shadow-[0_0_5px_rgba(16,185,129,0.5)] animate-pulse"></span><span class="text-[8px] font-black text-emerald-500 uppercase tracking-widest">LIVE</span></span>' : '<span class="text-[8px] font-black text-zinc-600 uppercase tracking-widest">READY</span>'}
            ${isWireless
              ? '<span class="flex items-center gap-1 bg-primary/10 px-1 py-0.5 rounded border border-primary/20"><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2"><path d="M5 13a10 10 0 0 1 14 0"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><line x1="12" y1="20" x2="12" y2="20"/></svg><span class="text-[7px] font-black text-primary uppercase tracking-tighter">Wi-Fi</span></span>'
              : '<span class="flex items-center gap-1 bg-zinc-800 px-1 py-0.5 rounded border border-zinc-700"><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 4h8v4a2 2 0 0 1-2 2v10a2 2 0 0 1-2 2H6"/><path d="M2 4h4"/><path d="M14 4h4"/><path d="M4 8h4"/><path d="M6 8v2"/><path d="M10 8v2"/></svg><span class="text-[7px] font-black text-zinc-400 uppercase tracking-tighter">USB</span></span>'}
          </div>
        </div>
      </button>`;
  }).join("");
}

function selectDevice(d) {
  state.activeDevice = d;
  state.config.device = d;
  renderDevices();
  saveState();
}

async function updateRunningStatus() {
  const res = await apiGet("/api/scrcpy/running");
  state.runningDevices = res || [];
  renderDevices();
  updateSessionStatus();
}

function updateSessionStatus() {
  const isRunning = state.runningDevices.includes(state.activeDevice);
  const statusEl = document.getElementById("sessionStatus");
  statusEl.textContent = isRunning ? t("controlPanel.active") : t("controlPanel.ready");
  statusEl.className = `text-[8px] font-bold uppercase px-1.5 py-0.5 rounded border ${isRunning ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-zinc-800/30 text-zinc-600 border-zinc-700/30'}`;

  document.getElementById("startBtn").classList.toggle("hidden", isRunning);
  document.getElementById("stopBtn").classList.toggle("hidden", !isRunning);
}

function updateEngineStatus() {
  const dot = document.getElementById("engineDot");
  const status = document.getElementById("engineStatus");
  const bar = document.getElementById("downloadProgressBar");

  if (state.isDownloading) {
    dot.className = "w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse";
    status.textContent = `Syncing Components ${state.downloadProgress}%`;
    bar.classList.remove("hidden");
    document.getElementById("downloadProgressFill").style.width = `${state.downloadProgress}%`;
    return;
  }

  bar.classList.add("hidden");
  if (state.scrcpyStatus.found) {
    dot.className = "w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]";
    status.textContent = t("header.scrcpyReady");
    status.className = "text-xs font-black uppercase tracking-tighter truncate max-w-[150px] text-emerald-400";
  } else {
    dot.className = "w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse";
    status.textContent = state.scrcpyStatus.message || t("common.loading");
    status.className = "text-xs font-black uppercase tracking-tighter truncate max-w-[150px] text-yellow-500";
  }
}

// ─── Logs ─────────────────────────────────────────────────
function addLog(msg) {
  state.logs.push(msg);
  if (state.logs.length > 200) state.logs = state.logs.slice(-200);
  renderLogs();
}

function renderLogs() {
  const container = document.getElementById("logContainer");
  const isLive = state.logs.length > 0;
  const dot = document.getElementById("logLiveDot");

  if (isLive) {
    dot.className = "w-1.5 h-1.5 rounded-full bg-primary transition-all duration-500";
  }

  if (state.logs.length === 0) {
    container.innerHTML = `<div class="h-full flex items-center justify-center"><span class="text-[10px] text-zinc-700 font-bold uppercase tracking-widest animate-pulse">${t("logPanel.waitingForSequence")}</span></div>`;
    return;
  }

  container.innerHTML = `<div class="space-y-1">${state.logs.map((log, i) => `
    <div class="group flex gap-3 text-[11px] leading-relaxed py-0.5 border-l border-zinc-900 hover:border-primary/30 transition-colors pl-3">
      <span class="text-zinc-500 font-bold shrink-0 tabular-nums opacity-60 group-hover:opacity-100 transition-opacity">${new Date().toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
      <span class="text-zinc-300 break-all">${escHtml(log)}</span>
    </div>`).join("")}</div>`;
  container.scrollTop = container.scrollHeight;
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ─── Render Driver Options ────────────────────────────────
function buildRendererOptions() {
  const containers = document.querySelectorAll('.custom-select-container[data-field="renderDriver"]');
  const options = state.renderDriverSupport.supportedDrivers || [];
  containers.forEach(container => {
    const dropdown = container.querySelector(".custom-select-dropdown");
    dropdown.innerHTML = `
      <div data-value="auto" class="px-2 py-1.5 text-[11px] cursor-pointer ${state.config.renderDriver === "auto" || !state.config.renderDriver ? "bg-primary/20 text-primary font-bold" : "text-zinc-400 hover:bg-primary hover:text-on-primary font-medium"}">${t("controlPanel.rendererAuto")}</div>
      ${options.map(o => `
        <div data-value="${o.id}" class="px-2 py-1.5 text-[11px] cursor-pointer ${state.config.renderDriver === o.id ? "bg-primary/20 text-primary font-bold" : "text-zinc-400 hover:bg-primary hover:text-on-primary font-medium"}">${o.label}</div>
      `).join("")}
    `;
  });
}

// ─── Custom Select ────────────────────────────────────────
document.addEventListener("click", function (e) {
  const sel = e.target.closest(".custom-select-container");
  if (sel) {
    const btn = sel.querySelector(".custom-select-btn");
    const dropdown = sel.querySelector(".custom-select-dropdown");
    if (btn && btn.contains(e.target)) {
      const isOpen = !dropdown.classList.contains("hidden");
      closeAllSelects();
      if (!isOpen) dropdown.classList.remove("hidden");
      return;
    }
    const opt = e.target.closest("[data-value]");
    if (opt && dropdown.contains(opt)) {
      const val = opt.getAttribute("data-value");
      const field = sel.getAttribute("data-field");
      const label = opt.textContent.trim();
      btn.querySelector("span").textContent = label;
      dropdown.querySelectorAll("[data-value]").forEach(o => {
        o.className = `px-2 py-1.5 text-[11px] cursor-pointer ${o.getAttribute("data-value") === val ? "bg-primary/20 text-primary font-bold" : "text-zinc-400 hover:bg-primary hover:text-on-primary font-medium"}`;
      });
      dropdown.classList.add("hidden");

      if (field === "vdPreset") {
        const [w, h] = val.split("x").map(Number);
        state.config.vdWidth = w || 1920;
        state.config.vdHeight = h || 1080;
        document.getElementById("vdWidthSlider").value = state.config.vdWidth;
        document.getElementById("vdHeightSlider").value = state.config.vdHeight;
        document.getElementById("vdWidthValue").textContent = `${state.config.vdWidth}px`;
        document.getElementById("vdHeightValue").textContent = `${state.config.vdHeight}px`;
        saveState();
        return;
      }

      if (field === "renderDriver") {
        state.config.renderDriver = val === "auto" ? undefined : val;
      } else if (field === "fps") {
        state.config.fps = parseInt(val) === 0 ? undefined : parseInt(val);
      } else if (field === "rotation") {
        state.config.rotation = val;
      } else if (field === "cameraAr") {
        state.config.cameraAr = val;
      } else if (field === "res") {
        state.config.res = val;
      } else {
        state.config[field] = val;
      }
      saveState();
      return;
    }
  }
  closeAllSelects();
});

function closeAllSelects() {
  document.querySelectorAll(".custom-select-dropdown").forEach(d => d.classList.add("hidden"));
}

// ─── Tab Switching ────────────────────────────────────────
document.querySelectorAll(".sidebar-tab").forEach(btn => {
  btn.addEventListener("click", function () {
    const tab = this.getAttribute("data-tab");
    document.querySelectorAll(".sidebar-tab").forEach(b => {
      b.className = `sidebar-tab flex-1 py-1.5 text-[9px] font-black uppercase tracking-widest flex items-center justify-center gap-2 rounded-md transition-all ${b === this ? "bg-primary text-on-primary shadow-lg" : "text-zinc-500 hover:text-zinc-300"}`;
    });
    document.getElementById("usbTab").classList.toggle("hidden", tab !== "usb");
    document.getElementById("wirelessTab").classList.toggle("hidden", tab !== "wireless");
  });
});

// ─── Session Mode Switching ──────────────────────────────
document.querySelectorAll(".session-mode-btn").forEach(btn => {
  btn.addEventListener("click", function () {
    const mode = this.getAttribute("data-mode");
    state.config.sessionMode = mode;
    document.querySelectorAll(".session-mode-btn").forEach(b => {
      const isActive = b.getAttribute("data-mode") === mode;
      if (isActive) {
        b.style.background = "var(--primary)";
        b.style.color = "var(--text-on-primary)";
        b.style.boxShadow = "0 0 15px color-mix(in srgb, var(--primary) 20%, transparent)";
      } else {
        b.style.background = "";
        b.style.color = "";
        b.style.boxShadow = "";
        b.className = "session-mode-btn flex flex-col items-center gap-1.5 py-2.5 rounded-lg transition-all text-zinc-500 hover:text-primary hover:bg-zinc-950";
      }
    });
    updateConfigPanels();
    updateStartBtn();
    saveState();
  });
});

function updateConfigPanels() {
  const mode = state.config.sessionMode;
  document.getElementById("mirrorConfig").classList.toggle("hidden", mode !== "mirror");
  document.getElementById("cameraConfig").classList.toggle("hidden", mode !== "camera");
  document.getElementById("desktopConfig").classList.toggle("hidden", mode !== "desktop");

  const otgBadge = document.getElementById("otgOnlyBadge");
  const hasHid = state.config.hidKeyboard || state.config.hidMouse;
  otgBadge.classList.toggle("hidden", !(hasHid && state.config.otgPure));
}

function updateStartBtn() {
  const mode = state.config.sessionMode;
  const label = document.getElementById("startBtnLabel");
  const hasHid = state.config.hidKeyboard || state.config.hidMouse;
  if (mode === "mirror" && hasHid && state.config.otgPure) {
    label.textContent = t("controlPanel.initializeOtg");
  } else if (mode === "mirror") {
    label.textContent = t("controlPanel.startMission");
  } else if (mode === "camera") {
    label.textContent = t("controlPanel.engageCamera");
  } else {
    label.textContent = t("controlPanel.ejectToDesktop");
  }
}

// ─── HID Toggles ──────────────────────────────────────────
document.querySelectorAll(".hid-toggle").forEach(el => {
  el.addEventListener("click", function () {
    const field = this.getAttribute("data-field");
    state.config[field] = !state.config[field];
    updateHidCheckboxes();
    document.getElementById("pureHidOption").classList.toggle("hidden", !(state.config.hidKeyboard || state.config.hidMouse));
    updateConfigPanels();
    updateStartBtn();
    saveState();
  });
});

function updateHidCheckboxes() {
  document.querySelectorAll(".hid-toggle").forEach(el => {
    const field = el.getAttribute("data-field");
    const cb = el.querySelector(".hid-checkbox");
    const isChecked = state.config[field];
    const isOtg = field === "otgPure";
    if (isChecked) {
      cb.className = `hid-checkbox mt-0.5 w-${isOtg ? "3" : "3.5"} h-${isOtg ? "3" : "3.5"} rounded border flex items-center justify-center transition-colors ${isOtg ? "bg-red-500 border-red-500" : "bg-primary border-primary"}`;
      cb.innerHTML = `<div class="w-${isOtg ? "1" : "1.5"} h-${isOtg ? "1" : "1.5"} ${isOtg ? "bg-white" : "bg-black"} rounded-[${isOtg ? "0.5" : "1"}px]"></div>`;
    } else {
      cb.className = `hid-checkbox mt-0.5 w-${isOtg ? "3" : "3.5"} h-${isOtg ? "3" : "3.5"} rounded border border-zinc-700 flex items-center justify-center transition-colors group-hover:border-primary`;
      cb.innerHTML = "";
    }
  });
}

// ─── Behavior Toggles ─────────────────────────────────────
document.querySelectorAll(".behavior-toggle").forEach(el => {
  el.addEventListener("click", function () {
    const field = this.getAttribute("data-field");
    state.config[field] = !state.config[field];
    updateBehaviorToggles();
    document.getElementById("audioCodecPicker").classList.toggle("hidden", !state.config.audioEnabled);
    saveState();
  });
});

function updateBehaviorToggles() {
  document.querySelectorAll(".behavior-toggle").forEach(el => {
    const field = el.getAttribute("data-field");
    const sw = el.querySelector(".behavior-switch");
    const icon = el.querySelector(".p-1");
    const isChecked = state.config[field];
    const isRecord = field === "record";
    if (isChecked) {
      sw.className = `behavior-switch w-6 h-3.5 shrink-0 rounded-full p-0.5 transition-all duration-300 ${isRecord ? "bg-red-600" : "bg-primary"}`;
      sw.innerHTML = `<div class="w-2.5 h-2.5 rounded-full shadow-sm transition-all duration-300 ${isRecord ? "bg-white translate-x-2.5" : "bg-[var(--text-on-primary)] translate-x-2.5"}"></div>`;
      if (icon) {
        icon.className = `p-1 rounded-md shrink-0 transition-colors ${isRecord ? "bg-red-500/10 text-red-500" : "bg-primary/10 text-primary"}`;
      }
    } else {
      sw.className = "behavior-switch w-6 h-3.5 shrink-0 rounded-full p-0.5 transition-all duration-300 bg-zinc-800";
      sw.innerHTML = `<div class="w-2.5 h-2.5 rounded-full shadow-sm transition-all duration-300 bg-white translate-x-0"></div>`;
      if (icon) {
        icon.className = "p-1 rounded-md shrink-0 bg-zinc-800/50 text-zinc-500 group-hover:text-zinc-300 transition-colors";
      }
    }
  });
}

// ─── Audio Codec Picker ───────────────────────────────────
document.getElementById("audioCodecBtn")?.addEventListener("click", function (e) {
  e.stopPropagation();
  document.getElementById("audioCodecDropdown").classList.toggle("hidden");
});

document.querySelectorAll("#audioCodecDropdown [data-value]").forEach(el => {
  el.addEventListener("click", function () {
    const val = this.getAttribute("data-value");
    state.config.audioCodec = val;
    document.getElementById("audioCodecBtn").querySelector("span").textContent = this.textContent.trim();
    document.querySelectorAll("#audioCodecDropdown [data-value]").forEach(o => {
      o.className = `px-2 py-1 text-[9px] uppercase tracking-wider font-bold cursor-pointer ${o.getAttribute("data-value") === val ? "bg-primary/20 text-primary" : "text-zinc-400 hover:bg-primary hover:text-on-primary"}`;
    });
    document.getElementById("audioCodecDropdown").classList.add("hidden");
    saveState();
  });
});

// ─── Bitrate Sliders ─────────────────────────────────────
["bitrateSlider", "camBitrateSlider", "deskBitrateSlider"].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("input", function () {
    const val = parseInt(this.value);
    const displayId = id === "bitrateSlider" ? "bitrateValue" : id === "camBitrateSlider" ? "camBitrateValue" : "deskBitrateValue";
    document.getElementById(displayId).textContent = `${val}M`;
    state.config.bitrate = val;
  });
  el.addEventListener("change", () => saveState());
});

// ─── Virtual Display Sliders ─────────────────────────────
["vdWidthSlider", "vdHeightSlider", "vdDpiSlider"].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("input", function () {
    const val = parseInt(this.value);
    const field = id === "vdWidthSlider" ? "vdWidth" : id === "vdHeightSlider" ? "vdHeight" : "vdDpi";
    const unit = field === "vdDpi" ? " DPI" : "px";
    state.config[field] = val;
    document.getElementById(id.replace("Slider", "Value")).textContent = `${val}${unit}`;

    if (id === "vdWidthSlider" && state.config.aspectRatioLock) {
      const ratio = state.config.vdHeight / 1920;
      state.config.vdHeight = Math.round(val * ratio);
      document.getElementById("vdHeightSlider").value = state.config.vdHeight;
      document.getElementById("vdHeightValue").textContent = `${state.config.vdHeight}px`;
    }
    if (id === "vdHeightSlider" && state.config.aspectRatioLock) {
      const ratio = state.config.vdWidth / 1080;
      state.config.vdWidth = Math.round(val * ratio);
      document.getElementById("vdWidthSlider").value = state.config.vdWidth;
      document.getElementById("vdWidthValue").textContent = `${state.config.vdWidth}px`;
    }
  });
  el.addEventListener("change", () => saveState());
});

// ─── Camera Zoom ──────────────────────────────────────────
document.getElementById("zoomSlider")?.addEventListener("input", function () {
  const val = parseInt(this.value) / 10;
  state.config.cameraZoom = val;
  document.getElementById("zoomValue").textContent = `${val.toFixed(1)}x`;
});
document.getElementById("zoomSlider")?.addEventListener("change", () => saveState());

// ─── BG Color ─────────────────────────────────────────────
document.getElementById("bgColorInput")?.addEventListener("input", function () {
  state.config.backgroundColor = this.value;
  document.getElementById("bgColorPreview").style.backgroundColor = this.value || "#222222";
  document.getElementById("bgColorClear").classList.toggle("hidden", !this.value);
});
document.getElementById("bgColorClear")?.addEventListener("click", function () {
  state.config.backgroundColor = "";
  document.getElementById("bgColorInput").value = "";
  document.getElementById("bgColorPreview").style.backgroundColor = "#222222";
  this.classList.add("hidden");
  saveState();
});

// ─── Flex Display / Ratio Lock ├──────────────────────────
document.getElementById("flexDisplayToggle")?.addEventListener("click", function () {
  state.config.flexDisplay = !state.config.flexDisplay;
  this.querySelector("span").className = `text-[8px] font-black uppercase tracking-tighter px-1 py-0.5 rounded border transition-colors ${state.config.flexDisplay ? "bg-primary/10 border-primary/40 text-primary" : "border-zinc-700 text-zinc-600"}`;
  saveState();
});

document.getElementById("ratioLockToggle")?.addEventListener("click", function () {
  state.config.aspectRatioLock = !state.config.aspectRatioLock;
  const isLocked = state.config.aspectRatioLock;
  this.querySelector("svg").outerHTML = isLocked
    ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
    : '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
  this.classList.toggle("text-primary", isLocked);
  this.classList.toggle("text-zinc-600", !isLocked);
  saveState();
});

// ─── Sidebar Actions ──────────────────────────────────────
// Kill ADB
document.getElementById("killAdbBtn")?.addEventListener("click", async function () {
  const res = await api("/api/adb/kill", { customPath: state.config.scrcpyPath });
  addLog(`[SYSTEM] ADB Stack Terminated.`);
  setTimeout(() => refreshDevices(true), 500);
});

// Refresh
document.getElementById("refreshBtn")?.addEventListener("click", () => refreshDevices(false));

// Connect
document.getElementById("connectBtn")?.addEventListener("click", async function () {
  const ip = document.getElementById("connectIpInput").value.trim();
  if (!ip) return;
  this.textContent = "...";
  this.disabled = true;
  const res = await api("/api/adb/connect", { ip, customPath: state.config.scrcpyPath });
  if (res.success) {
    addLog(`[SYSTEM] CONNECTED TO ${ip} SUCCESSFULLY.`);
    addToHistory(ip);
    setTimeout(() => refreshDevices(true), 1000);
  } else {
    addLog(`[SYSTEM] Connection failed: ${res.message}`);
    if (res.message && (res.message.includes("failed") || res.message.includes("cannot connect"))) {
      const killRes = await api("/api/adb/kill", { customPath: state.config.scrcpyPath });
      await new Promise(r => setTimeout(r, 500));
      const res2 = await api("/api/adb/connect", { ip, customPath: state.config.scrcpyPath });
      if (res2.success) {
        addLog(`[SYSTEM] CONNECTED TO ${ip} SUCCESSFULLY.`);
        addToHistory(ip);
        setTimeout(() => refreshDevices(true), 1000);
      } else {
        addLog(`[TIP] Port might be stale. Try "Kill ADB" to refresh discovery.`);
      }
    }
  }
  this.textContent = t("sidebar.connect");
  this.disabled = false;
});

// Pair
document.getElementById("pairBtn")?.addEventListener("click", async function () {
  const ip = document.getElementById("pairIpInput").value.trim();
  const code = document.getElementById("pairCodeInput").value.trim();
  if (!ip || !code) return;
  this.textContent = "Synchronizing...";
  this.disabled = true;
  const res = await api("/api/adb/pair", { ip, code, customPath: state.config.scrcpyPath });
  if (res.success) {
    addLog(`[SYSTEM] Successfully paired with ${ip}`);
    document.getElementById("pairCodeInput").value = "";
    const ipOnly = ip.split(":")[0];
    const connectTarget = `${ipOnly}:5555`;
    document.getElementById("connectIpInput").value = connectTarget;
    setTimeout(async () => {
      const cres = await api("/api/adb/connect", { ip: connectTarget, customPath: state.config.scrcpyPath });
      if (cres.success) {
        addLog(`[SYSTEM] CONNECTED TO ${connectTarget} SUCCESSFULLY.`);
        addToHistory(connectTarget);
        setTimeout(() => refreshDevices(true), 1000);
      }
    }, 500);
  } else {
    addLog(`[SYSTEM] Pairing failed: ${res.message}`);
    if (res.message && res.message.includes("protocol fault")) {
      addLog(`[TIP] Protocol fault usually means the ADB server is stuck. Try "Kill ADB" in the sidebar.`);
    }
  }
  this.textContent = t("sidebar.startPairing");
  this.disabled = false;
});

// Auto Connect Toggle
document.getElementById("autoConnectToggle")?.addEventListener("click", function () {
  state.isAutoConnect = !state.isAutoConnect;
  const cb = document.getElementById("autoCheckbox");
  if (state.isAutoConnect) {
    cb.className = "w-3 h-3 rounded-[2px] border flex items-center justify-center transition-colors bg-primary border-primary";
    cb.innerHTML = '<div class="w-1.5 h-1.5 bg-black rounded-[0.5px]"></div>';
  } else {
    cb.className = "w-3 h-3 rounded-[2px] border border-zinc-700 flex items-center justify-center transition-colors";
    cb.innerHTML = "";
  }
  saveState();
});

// Recent Devices
function addToHistory(ip) {
  if (!ip.includes(":")) return;
  state.historyDevices = [ip, ...state.historyDevices.filter(d => d !== ip)].slice(0, 10);
  localStorage.setItem("scrcpy_history", JSON.stringify(state.historyDevices));
  renderHistory();
}

function renderHistory() {
  const container = document.getElementById("historyList");
  const section = document.getElementById("recentDevices");
  if (state.historyDevices.length === 0) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");
  container.innerHTML = state.historyDevices.map(ip => `
    <button onclick="quickConnect('${ip}')" class="w-full flex items-center justify-between p-2 rounded-lg bg-zinc-800/20 border border-zinc-800/50 hover:bg-zinc-800/50 hover:border-zinc-700 transition-all group">
      <div class="flex items-center gap-2">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-zinc-500 group-hover:text-zinc-300"><path d="M5 13a10 10 0 0 1 14 0"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><line x1="12" y1="20" x2="12" y2="20"/></svg>
        <span class="text-[10px] font-bold text-zinc-400 group-hover:text-zinc-200">${ip}</span>
      </div>
      <div class="text-[8px] text-primary opacity-0 group-hover:opacity-100 uppercase font-black tracking-tighter">${t("sidebar.connect")}</div>
    </button>`).join("");
}

async function quickConnect(ip) {
  document.getElementById("connectIpInput").value = ip;
  document.getElementById("connectBtn").click();
}

document.getElementById("clearHistoryBtn")?.addEventListener("click", function () {
  state.historyDevices = [];
  localStorage.removeItem("scrcpy_history");
  renderHistory();
});

// ─── File Push ────────────────────────────────────────────
document.getElementById("filePushZone")?.addEventListener("click", function () {
  document.getElementById("fileInput").click();
});

document.getElementById("fileInput")?.addEventListener("change", async function () {
  if (!state.activeDevice) {
    showAlert(t("alerts.noDeviceSelectedTitle"), t("alerts.noDeviceSelectedMessage"), "warning");
    return;
  }
  for (const file of this.files) {
    if (file.name.endsWith(".apk")) {
      const res = await api("/api/file/install-apk", { device: state.activeDevice, filePath: file.name, customPath: state.config.scrcpyPath });
      addLog(res.message || `[ADB] Install result`);
    } else {
      const res = await api("/api/file/push", { device: state.activeDevice, filePath: file.name, customPath: state.config.scrcpyPath });
      addLog(res.message || `[ADB] Push result`);
    }
  }
  this.value = "";
});

// Drag and drop
document.getElementById("filePushZone")?.addEventListener("dragover", function (e) {
  e.preventDefault();
  this.style.borderColor = "var(--primary)";
});

document.getElementById("filePushZone")?.addEventListener("dragleave", function (e) {
  e.preventDefault();
  this.style.borderColor = "";
});

document.getElementById("filePushZone")?.addEventListener("drop", async function (e) {
  e.preventDefault();
  this.style.borderColor = "";
  if (!state.activeDevice) {
    showAlert(t("alerts.noDeviceSelectedTitle"), t("alerts.noDeviceSelectedMessage"), "warning");
    return;
  }
  for (const file of e.dataTransfer.files) {
    const isApk = file.name.endsWith(".apk");
    if (isApk) {
      const res = await api("/api/file/install-apk", { device: state.activeDevice, filePath: file.name, customPath: state.config.scrcpyPath });
      addLog(res.message || `[ADB] APK Install result`);
    } else {
      const res = await api("/api/file/push", { device: state.activeDevice, filePath: file.name, customPath: state.config.scrcpyPath });
      addLog(res.message || `[ADB] Push result`);
    }
  }
});

// ─── Start / Stop ─────────────────────────────────────────
document.getElementById("startBtn")?.addEventListener("click", async function () {
  if (!state.activeDevice) {
    showAlert(t("alerts.noDeviceSelectedTitle"), t("alerts.noDeviceSelectedMessage"), "warning");
    return;
  }
  const config = { ...state.config, device: state.activeDevice };
  const res = await api("/api/scrcpy/start", { config });
  if (res.success) {
    state.sessionId = res.sessionId;
    addLog(`[SYSTEM] Initializing scrcpy session for ${state.activeDevice}...`);
    startLogPolling();
  } else {
    addLog(`[ERROR] Failed to start scrcpy: ${res.message}`);
  }
  updateRunningStatus();
});

document.getElementById("stopBtn")?.addEventListener("click", async function () {
  if (!state.activeDevice) return;
  await api("/api/scrcpy/stop", { device: state.activeDevice });
  addLog(`[SYSTEM] Stopped scrcpy session for ${state.activeDevice}`);
  updateRunningStatus();
});

function startLogPolling() {
  if (!state.sessionId) return;
  const interval = setInterval(async () => {
    const logs = await apiGet(`/api/scrcpy/logs/${state.sessionId}`);
    if (logs && logs.length > 0) {
      logs.forEach(l => addLog(l));
    }
    const running = await apiGet("/api/scrcpy/running");
    state.runningDevices = running || [];
    renderDevices();
    updateSessionStatus();
    if (!state.runningDevices.includes(state.activeDevice)) {
      clearInterval(interval);
    }
  }, 500);
}

// ─── Header Actions ───────────────────────────────────────
// Theme swatches
document.querySelectorAll(".theme-swatch").forEach(el => {
  el.addEventListener("click", function () {
    state.theme = this.getAttribute("data-theme");
    applyTheme();
  });
});

// Color mode
document.querySelectorAll(".mode-btn").forEach(el => {
  el.addEventListener("click", function () {
    state.colorMode = this.getAttribute("data-mode");
    applyColorMode();
  });
});

// Language
document.getElementById("langMenuBtn")?.addEventListener("click", function (e) {
  e.stopPropagation();
  const dd = document.getElementById("langDropdown");
  dd.classList.toggle("hidden");
  this.querySelector(".chevron-down").classList.toggle("rotate-180", !dd.classList.contains("hidden"));
});

async function buildLangMenu() {
  const dd = document.getElementById("langDropdown");
  const locales = ["en", "fr", "pt-BR", "zh-CN", "zh-TW", "ru"];
  const labels = { en: "English", fr: "Français", "pt-BR": "Português (Brasil)", "zh-CN": "中文 (简体)", "zh-TW": "中文 (繁體)", ru: "Русский" };
  dd.innerHTML = locales.map(loc => `
    <button data-locale="${loc}" class="block w-full text-left px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${loc === currentLocale ? "bg-primary/20 text-primary" : "text-zinc-400 hover:bg-primary hover:text-on-primary"}">${labels[loc]}</button>
  `).join("");

  dd.querySelectorAll("[data-locale]").forEach(btn => {
    btn.addEventListener("click", async function () {
      currentLocale = this.getAttribute("data-locale");
      await loadTranslations(currentLocale);
      applyI18n();
      document.getElementById("currentLangLabel").textContent = labels[currentLocale];
      dd.classList.add("hidden");
      saveState();
    });
  });
}

document.addEventListener("click", function () {
  const dd = document.getElementById("langDropdown");
  if (dd) dd.classList.add("hidden");
});

// Set path
document.getElementById("setPathBtn")?.addEventListener("click", async function () {
  const path = prompt("Enter the path to scrcpy folder:");
  if (path) {
    state.config.scrcpyPath = path;
    addLog(`[SYSTEM] Custom scrcpy path set to: ${path}`);
    saveState();
    setTimeout(() => checkScrcpy(), 100);
  }
});

// Reset path
document.getElementById("resetPathBtn")?.addEventListener("click", function () {
  state.config.scrcpyPath = "";
  addLog(`[SYSTEM] Custom scrcpy path cleared. Using system default.`);
  saveState();
  setTimeout(() => checkScrcpy(), 100);
});

// Install Core
document.getElementById("installCoreBtn")?.addEventListener("click", async function () {
  state.isDownloading = true;
  state.downloadProgress = 0;
  updateEngineStatus();

  const es = new EventSource("/api/scrcpy/download");
  es.onmessage = function (e) {
    try {
      const data = JSON.parse(e.data);
      if (data.type === "progress") {
        state.downloadProgress = data.percent || 0;
        updateEngineStatus();
      } else if (data.type === "complete") {
        state.isDownloading = false;
        es.close();
        checkScrcpy();
        refreshDevices(true);
        updateEngineStatus();
      } else if (data.type === "error") {
        addLog(`[ERROR] ${data.message}`);
        state.isDownloading = false;
        es.close();
        updateEngineStatus();
      } else if (data.type === "log") {
        addLog(data.message);
      }
    } catch (e) {}
  };
});

// Setup Help
document.getElementById("setupHelpBtn")?.addEventListener("click", () => {
  document.getElementById("setupHelpModal").classList.remove("hidden");
});
document.getElementById("closeHelpBtn")?.addEventListener("click", () => {
  document.getElementById("setupHelpModal").classList.add("hidden");
});
document.getElementById("closeHelpBtn2")?.addEventListener("click", () => {
  document.getElementById("setupHelpModal").classList.add("hidden");
});

// ─── Terminal ─────────────────────────────────────────────
document.getElementById("terminalInput")?.addEventListener("keydown", async function (e) {
  if (e.key === "Enter" && this.value.trim()) {
    const cmd = this.value.trim();
    const lower = cmd.toLowerCase();
    const prefix = (lower.startsWith("scrcpy") || lower.startsWith("adb")) ? "" : "adb ";
    addLog(`> ${prefix}${cmd}`);
    this.value = "";

    const res = await api("/api/terminal/run", { cmd, device: state.activeDevice, customPath: state.config.scrcpyPath });
    if (res.stdout) {
      res.stdout.trim().split("\n").forEach(l => addLog(l));
    }
    if (res.stderr) {
      res.stderr.trim().split("\n").forEach(l => addLog(`[${(res.binary || "ERR").toUpperCase()}] ${l}`));
    }
  }
});

// ─── Log Clear/Export ─────────────────────────────────────
document.getElementById("clearLogsBtn")?.addEventListener("click", function () {
  state.logs = [];
  renderLogs();
  document.getElementById("logLiveDot").className = "w-1.5 h-1.5 rounded-full bg-zinc-700 transition-all duration-500";
});

document.getElementById("exportLogsBtn")?.addEventListener("click", function () {
  const data = {
    timestamp: new Date().toISOString(),
    logs: state.logs,
    config: state.config,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `scrcpy-gui-logs-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  addLog(`[SYSTEM] Diagnostic report exported.`);
});

// ─── Camera Lens Refresh ──────────────────────────────────
document.getElementById("refreshLensesBtn")?.addEventListener("click", async function () {
  if (!state.activeDevice) return;
  const res = await api("/api/scrcpy/options", { device: state.activeDevice, arg: "--list-cameras", customPath: state.config.scrcpyPath });
  if (res.output) {
    const lines = res.output.split("\n");
    lines.forEach(l => addLog(l));
    const cameras = [];
    lines.forEach(line => {
      const newMatch = line.match(/--camera-id=(\w+)\s*\((.*?)\)/);
      const oldMatch = line.match(/^(?:-\s*)?\[(\w+)\]\s*\((.*?)\)\s*(.*)/);
      if (newMatch) cameras.push({ id: newMatch[1], name: `${newMatch[1]}: ${newMatch[2]}` });
      else if (oldMatch) cameras.push({ id: oldMatch[1], name: `${oldMatch[1]}: ${(oldMatch[3] || "Camera").trim()} (${oldMatch[2]})` });
    });
    state.detectedCameras = cameras;
    if (cameras.length > 0) {
      const container = document.querySelector('.custom-select-container[data-field="cameraId"] .custom-select-dropdown');
      if (container) {
        container.innerHTML = `
          <div data-value="" class="px-2 py-1.5 text-[11px] cursor-pointer ${!state.config.cameraId ? "bg-primary/20 text-primary font-bold" : "text-zinc-400 hover:bg-primary hover:text-on-primary font-medium"}">Auto Select</div>
          ${cameras.map(c => `
            <div data-value="${c.id}" class="px-2 py-1.5 text-[11px] cursor-pointer ${state.config.cameraId === c.id ? "bg-primary/20 text-primary font-bold" : "text-zinc-400 hover:bg-primary hover:text-on-primary font-medium"}">${c.name}</div>
          `).join("")}`;
      }
    } else {
      addLog(`[SYSTEM] No cameras parsed from output.`);
    }
  }
});

// ─── Pick Folder ──────────────────────────────────────────
document.getElementById("pickFolderBtn")?.addEventListener("click", function () {
  const path = prompt("Enter the recording folder path:");
  if (path) {
    state.config.recordPath = path;
    document.getElementById("recordPathDisplay").textContent = path;
    localStorage.setItem("scrcpy_record_path", path);
    saveState();
  }
});

// ─── Alert System ─────────────────────────────────────────
let alertResolve = null;

function showAlert(title, message, kind = "info", actionLabel = "OK", onAction, showCancel = false, cancelLabel = "Cancel", onCancel) {
  const modal = document.getElementById("alertModal");
  modal.classList.remove("hidden");
  document.getElementById("alertTitle").textContent = title;
  document.getElementById("alertMessage").textContent = message;

  const icon = document.getElementById("alertIcon");
  const configs = {
    warning: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    error: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    success: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  };
  icon.innerHTML = configs[kind] || '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';

  const actionBtn = document.getElementById("alertActionBtn");
  actionBtn.textContent = actionLabel;
  actionBtn.onclick = () => {
    modal.classList.add("hidden");
    if (onAction) onAction();
  };

  const cancelBtn = document.getElementById("alertCancelBtn");
  if (showCancel) {
    cancelBtn.classList.remove("hidden");
    cancelBtn.textContent = cancelLabel;
    cancelBtn.onclick = () => {
      modal.classList.add("hidden");
      if (onCancel) onCancel();
    };
  } else {
    cancelBtn.classList.add("hidden");
  }
}

// ─── Onboarding Modal (Simple) ────────────────────────────
let onboardingDone = false;

function checkOnboarding() {
  try {
    onboardingDone = localStorage.getItem("scrcpy_onboarding_done") === "true";
  } catch (e) {}
  if (!onboardingDone && !state.scrcpyStatus.found) {
    showOnboarding();
  }
}

function showOnboarding() {
  const modal = document.createElement("div");
  modal.id = "onboardingModal";
  modal.className = "fixed inset-0 z-[200] flex items-center justify-center p-4 sm:p-6";
  modal.innerHTML = `
    <div class="fixed inset-0 bg-black/80 backdrop-blur-xl"></div>
    <div class="relative w-full max-w-2xl bg-zinc-950 border border-zinc-800 rounded-3xl shadow-2xl overflow-hidden">
      <div class="flex flex-col md:flex-row">
        <div class="hidden md:flex md:w-1/3 bg-primary/10 border-r border-zinc-800 p-8 flex-col justify-between relative overflow-hidden">
          <div class="absolute top-[-10%] left-[-10%] w-[120%] h-[120%]" style="background:radial-gradient(circle at center, var(--primary), transparent);opacity:0.2"></div>
          <div class="relative z-10">
            <h2 class="text-3xl font-black italic tracking-tighter uppercase">scrcpy <span class="text-primary not-italic">GUI</span></h2>
            <p class="text-[10px] uppercase font-black tracking-widest text-primary mt-2">Core Initialization</p>
          </div>
          <div class="relative z-10 space-y-4">
            <div class="p-4 rounded-2xl bg-black/40 border border-white/5 backdrop-blur-sm">
              <p class="text-[10px] text-zinc-400 leading-relaxed font-medium">"Scrcpy and ADB binaries are required to communicate with your device. Let's get these installed."</p>
            </div>
          </div>
        </div>
        <div class="flex-1 p-8 sm:p-12">
          <div class="mb-10">
            <h3 class="text-2xl font-black tracking-tight text-white mb-2 uppercase italic">Setup Core Components</h3>
            <p class="text-zinc-500 text-sm font-medium">Automatic or manual installation required.</p>
          </div>
          <div class="space-y-8">
            <div class="flex gap-4">
              <div class="flex flex-col items-center">
                <div class="w-10 h-10 rounded-2xl flex items-center justify-center border bg-zinc-900 border-zinc-800">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-zinc-500"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2"/><path d="M9 2v2"/></svg>
                </div>
              </div>
              <div class="flex-1 pt-1">
                <h4 class="text-sm font-black uppercase tracking-widest text-zinc-400">Binaries & Drivers</h4>
                <p class="text-xs text-zinc-500 leading-relaxed font-medium mb-4">We need to download the Scrcpy engine to mirror your screen.</p>
                <div class="space-y-4">
                  <button id="onboardingDownloadBtn" class="inline-flex items-center gap-2 px-6 py-3 text-black rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95" style="background:var(--primary)">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    Download Core Binaries
                  </button>
                  <div class="w-full max-w-sm hidden" id="onboardingProgress">
                    <div class="h-2 bg-zinc-900 rounded-full overflow-hidden border border-zinc-800">
                      <div class="h-full transition-all duration-300 shadow-[0_0_10px_rgba(139,92,246,0.5)]" style="background:var(--primary);width:0%" id="onboardingProgressFill"></div>
                    </div>
                  </div>
                  <div class="pt-6 border-t border-zinc-900">
                    <p class="text-[10px] text-zinc-600 mb-3 leading-loose">If auto-download fails, try running as <span class="text-zinc-400 font-bold">Administrator</span>. Alternatively, download manually and set the path via the folder icon.</p>
                    <a href="https://github.com/Genymobile/scrcpy/releases/latest" target="_blank" class="inline-flex items-center gap-1.5 text-[9px] font-black uppercase text-primary hover:underline tracking-widest">GitHub Releases <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></a>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="mt-12 pt-8 border-t border-zinc-900 flex justify-end items-center">
            <button id="onboardingContinueBtn" class="group flex items-center gap-3 px-8 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all bg-zinc-900 text-zinc-600 border border-zinc-800">
              Continue to App
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Wire up onboarding
  document.getElementById("onboardingDownloadBtn").addEventListener("click", function () {
    document.getElementById("onboardingProgress").classList.remove("hidden");
    document.getElementById("installCoreBtn").click();
    const checkInterval = setInterval(() => {
      if (state.scrcpyStatus.found) {
        clearInterval(checkInterval);
        const statusDiv = document.querySelector("#onboardingModal .flex.gap-4 .flex-col.items-center div");
        if (statusDiv) {
          statusDiv.className = "w-10 h-10 rounded-2xl flex items-center justify-center border bg-emerald-500/10 border-emerald-500/50";
          statusDiv.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
        }
        document.querySelector("#onboardingModal h4").className = "text-sm font-black uppercase tracking-widest text-white";
        document.querySelector("#onboardingModal .text-emerald-500").classList.remove("hidden");
        document.getElementById("onboardingContinueBtn").className = "group flex items-center gap-3 px-8 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-95" + " shadow-[0_10px_20px_rgba(139,92,246,0.2)]";
        document.getElementById("onboardingContinueBtn").style.background = "var(--primary)";
        document.getElementById("onboardingContinueBtn").style.color = "var(--text-on-primary)";
      }
    }, 1000);
  });

  document.getElementById("onboardingContinueBtn").addEventListener("click", function () {
    localStorage.setItem("scrcpy_onboarding_done", "true");
    modal.remove();
  });
}

// ─── Init ─────────────────────────────────────────────────
async function init() {
  loadState();

  // Load translation
  await loadTranslations(currentLocale);
  await buildLangMenu();
  applyI18n();
  document.getElementById("currentLangLabel").textContent = document.querySelector(`[data-locale="${currentLocale}"]`)?.textContent || "English";

  // Theme
  applyTheme();
  applyColorMode();

  // Set version
  const verRes = await apiGet("/api/version");
  document.getElementById("appVersion").textContent = `V${verRes.version || "4.0.0"}`;

  // Check scrcpy
  await checkScrcpy();

  // Refresh devices
  await refreshDevices(true);

  // Set initial config panel
  updateConfigPanels();
  updateHidCheckboxes();
  updateBehaviorToggles();
  updateStartBtn();
  renderHistory();

  // Update start button label on mode change
  updateStartBtn();

  // Check onboarding
  checkOnboarding();

  // Periodic running status check
  setInterval(updateRunningStatus, 2000);

  console.log("Scrcpy GUI - Flask Edition initialized");
}

document.addEventListener("DOMContentLoaded", init);
