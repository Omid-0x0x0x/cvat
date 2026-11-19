"use strict";

// SAM 2 tracking for CVAT Desktop: menu window, optional component install, and the bridge to
// desktop/macos/sam2/track_sam2.py. Everything runs locally; the only network use is the
// one-time download of PyTorch and the model checkpoint, which the user confirms in the window.

const path = require("node:path");
const fs = require("node:fs");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { BrowserWindow, ipcMain } = require("electron");

const execFileAsync = promisify(execFile);

const MODELS = {
  tiny: { label: "Tiny", sizeMb: 156, file: "sam2.1_hiera_tiny.pt" },
  small: { label: "Small", sizeMb: 184, file: "sam2.1_hiera_small.pt" },
  base_plus: { label: "Base+", sizeMb: 324, file: "sam2.1_hiera_base_plus.pt" },
};
const DIRECTIONS = ["forward", "backward"];
const DEVICES = ["auto", "mps", "cpu"];
const KINDS = ["shape", "track"];

function createSam2Service({ getMainWindow, getRuntimeInfo, resourcesDir, userDataDir }) {
  const sam2Dir = path.join(userDataDir, "sam2");
  const packagesDir = path.join(sam2Dir, "packages");
  const modelsDir = path.join(sam2Dir, "models");
  const scriptPath = path.join(resourcesDir, "sam2", "track_sam2.py");
  const sourceDir = path.join(resourcesDir, "vendor", "sam2");
  let window = null;
  let child = null;
  let token = null;

  function integer(value, name, min, max) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw new Error("Invalid " + name + ".");
    return number;
  }
  function oneOf(value, allowed, name) {
    if (!allowed.includes(value)) throw new Error("Invalid " + name + ".");
    return value;
  }

  function runtime() {
    const info = getRuntimeInfo();
    if (!info) throw new Error("CVAT is still starting. Try again in a moment.");
    return info;
  }

  function scriptEnv(extra = {}) {
    return { ...runtime().env, PYTHONUNBUFFERED: "1", PYTORCH_ENABLE_MPS_FALLBACK: "1", ...extra };
  }

  function status() {
    const models = {};
    for (const [name, info] of Object.entries(MODELS)) {
      const file = path.join(modelsDir, info.file);
      models[name] = fs.existsSync(file) && fs.statSync(file).size > 1_000_000;
    }
    return {
      codeAvailable: fs.existsSync(path.join(sourceDir, "sam2", "build_sam.py")) && fs.existsSync(scriptPath),
      torchInstalled: fs.existsSync(path.join(packagesDir, "torch", "__init__.py")),
      models,
      modelInfo: MODELS,
    };
  }

  async function readContext() {
    const main = getMainWindow();
    if (!main || main.isDestroyed()) return { job: null, frame: null };
    const match = /\/jobs\/(\d+)/.exec(main.webContents.getURL());
    let frame = null;
    try {
      frame = await main.webContents.executeJavaScript(
        "(() => { const el = document.querySelector('.cvat-player-frame-selector input'); return el ? Number(el.value) : null; })()",
      );
    } catch { /* the page may not be a job page */ }
    return { job: match ? Number(match[1]) : null, frame: Number.isFinite(frame) ? frame : null };
  }

  async function apiToken() {
    if (token) return token;
    const info = runtime();
    const code = [
      "from django.contrib.auth import get_user_model",
      "from rest_framework.authtoken.models import Token",
      "user = get_user_model().objects.filter(is_superuser=True).order_by('id').first()",
      "print('CVAT_SAM2_TOKEN=' + Token.objects.get_or_create(user=user)[0].key)",
    ].join("; ");
    const result = await execFileAsync(info.python, ["manage.py", "shell", "-c", code], {
      cwd: info.backendDir, env: scriptEnv(), maxBuffer: 4 * 1024 * 1024, timeout: 120000,
    });
    const match = /CVAT_SAM2_TOKEN=([0-9a-f]+)/.exec(result.stdout);
    if (!match) throw new Error("Could not prepare access to the local CVAT API.");
    token = match[1];
    return token;
  }

  function emit(event) {
    if (window && !window.isDestroyed()) window.webContents.send("sam2:event", event);
  }

  // Runs a command, forwarding JSON lines on stdout as events. Resolves with the last
  // "done" / "error" event, plus the tail of stderr for diagnosis.
  function run(command, args, { env, forward = true, plainLines = false } = {}) {
    return new Promise((resolve, reject) => {
      if (child) { reject(new Error("Another SAM 2 task is already running.")); return; }
      child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      let buffer = "";
      let result = null;
      let stderrTail = "";
      const handleLine = (line) => {
        if (!line.trim()) return;
        if (plainLines) { if (forward) emit({ event: "progress", message: line.trim(), fraction: null }); return; }
        try {
          const event = JSON.parse(line);
          if (event.event === "done" || event.event === "error" || event.event === "objects") result = event;
          else if (forward) emit(event);
        } catch { /* not JSON: ignore noise such as library warnings */ }
      };
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) { handleLine(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
      });
      child.stderr.on("data", (chunk) => { stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000); });
      child.on("error", (error) => { child = null; reject(error); });
      child.on("close", (code, signal) => {
        if (buffer) handleLine(buffer);
        child = null;
        resolve({ code, signal, result, stderrTail });
      });
    });
  }

  function failure(outcome, fallback) {
    if (outcome.signal) return { event: "error", message: "Cancelled." };
    if (outcome.result && outcome.result.event === "error") return outcome.result;
    return { event: "error", message: fallback + (outcome.stderrTail ? "\n\n" + outcome.stderrTail.split("\n").slice(-6).join("\n") : "") };
  }

  async function install(model) {
    oneOf(model, Object.keys(MODELS), "model");
    const info = runtime();
    fs.mkdirSync(packagesDir, { recursive: true });
    fs.mkdirSync(modelsDir, { recursive: true });
    if (!status().torchInstalled) {
      emit({ event: "progress", message: "Downloading PyTorch (this can take several minutes)…", fraction: null });
      const outcome = await run(info.python, [
        "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--only-binary=:all:",
        "--upgrade", "--target", packagesDir, "torch>=2.5.1", "torchvision>=0.20.1",
      ], { env: scriptEnv(), plainLines: true });
      if (outcome.code !== 0) return failure(outcome, "Installing PyTorch failed. Check your internet connection.");
    }
    const outcome = await run(info.python, [
      scriptPath, "download-model", "--model", model, "--models-dir", modelsDir,
    ], { env: scriptEnv() });
    if (outcome.code !== 0) return failure(outcome, "Downloading the model failed.");
    return { event: "done" };
  }

  function commonArgs(params) {
    return [
      "--server", "http://127.0.0.1:" + runtime().ports.backend,
      "--job", String(integer(params.job, "job", 1, 1e9)),
      "--frame", String(integer(params.frame, "frame", 0, 1e9)),
    ];
  }

  async function listObjects(params) {
    const env = scriptEnv({ CVAT_SAM2_TOKEN: await apiToken() });
    const outcome = await run(runtime().python, [scriptPath, "list", ...commonArgs(params)], { env, forward: false });
    if (outcome.result && outcome.result.event === "objects") return outcome.result;
    return failure(outcome, "Could not read the objects of this frame.");
  }

  async function track(params) {
    const model = oneOf(params.model, Object.keys(MODELS), "model");
    const args = [
      scriptPath, "track", ...commonArgs(params),
      "--kind", oneOf(params.kind, KINDS, "object kind"),
      "--object-id", String(integer(params.objectId, "object", 0, 1e12)),
      "--count", String(integer(params.count, "number of frames", 1, 5000)),
      "--direction", oneOf(params.direction, DIRECTIONS, "direction"),
      "--model", model,
      "--device", oneOf(params.device, DEVICES, "device"),
      "--models-dir", modelsDir,
      "--packages-dir", packagesDir,
      "--sam2-src", sourceDir,
    ];
    if (params.replace) args.push("--replace");
    const env = scriptEnv({ CVAT_SAM2_TOKEN: await apiToken() });
    const outcome = await run(runtime().python, args, { env });
    if (outcome.result && outcome.result.event === "done") return outcome.result;
    return failure(outcome, "Tracking failed.");
  }

  function wrap(handler) {
    return async (_event, params) => {
      try { return await handler(params || {}); } catch (error) { return { event: "error", message: String(error.message || error) }; }
    };
  }

  ipcMain.handle("sam2:context", wrap(readContext));
  ipcMain.handle("sam2:status", wrap(async () => status()));
  ipcMain.handle("sam2:install", wrap((params) => install(params.model)));
  ipcMain.handle("sam2:list", wrap(listObjects));
  ipcMain.handle("sam2:track", wrap(track));
  ipcMain.handle("sam2:cancel", wrap(async () => { if (child) child.kill("SIGTERM"); return { event: "done" }; }));
  ipcMain.handle("sam2:reload-main", wrap(async () => {
    const main = getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.reload();
    return { event: "done" };
  }));

  function openWindow() {
    if (window && !window.isDestroyed()) { window.focus(); return; }
    window = new BrowserWindow({
      width: 600,
      height: 760,
      minWidth: 520,
      minHeight: 560,
      title: "SAM 2 tracking",
      backgroundColor: "#17191e",
      parent: getMainWindow() || undefined,
      webPreferences: {
        preload: path.join(__dirname, "sam2-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.loadFile(path.join(__dirname, "sam2.html"));
    window.on("closed", () => { window = null; if (child) child.kill("SIGTERM"); });
  }

  function dispose() { if (child) child.kill("SIGTERM"); }

  return { openWindow, dispose };
}

module.exports = { createSam2Service };
