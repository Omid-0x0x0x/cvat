"use strict";

// End-to-end check of SAM 2 tracking against a running native CVAT runtime:
//   create a task from synthetic frames -> draw a polygon -> track_sam2.py (real SAM 2.1 tiny)
//   -> verify that a track with one shape per frame was saved and the original shape was replaced.
// Used by CI with PyTorch installed into a temporary directory. Needs network for PyTorch and the model.

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

const FRAMES = 8;

async function api(base, token, method, route, { json, form, headers: extraHeaders } = {}) {
  const headers = { Authorization: "Token " + token, Accept: "application/vnd.cvat+json", ...extraHeaders };
  let body;
  if (json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
  if (form) body = form;
  const response = await fetch(base + route, { method, headers, body });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(method + " " + route + " -> HTTP " + response.status + " (" + (response.headers.get("content-type") || "no content type") +
      "): " + (text.slice(0, 600) || "<empty body>"));
  }
  return text ? JSON.parse(text) : null;
}

async function waitFor(check, what, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for " + what);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function runSam2E2E({ info, scriptPath, sourceDir, workDir }) {
  const base = "http://127.0.0.1:" + info.ports.backend;
  const packagesDir = path.join(workDir, "packages");
  const modelsDir = path.join(workDir, "models");
  const framesDir = path.join(workDir, "frames");
  fs.mkdirSync(framesDir, { recursive: true });
  const env = { ...info.env, PYTHONUNBUFFERED: "1", PYTORCH_ENABLE_MPS_FALLBACK: "1" };

  console.log("[sam2-e2e] installing PyTorch into a temporary directory…");
  await execFileAsync(info.python, [
    "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--only-binary=:all:",
    "--target", packagesDir, "torch>=2.5.1", "torchvision>=0.20.1",
  ], { env, maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000 });

  console.log("[sam2-e2e] downloading and verifying the tiny model…");
  const download = await execFileAsync(info.python, [
    scriptPath, "download-model", "--model", "tiny", "--models-dir", modelsDir,
  ], { env, maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000 });
  if (!/"event": "done"/.test(download.stdout)) throw new Error("Model download did not finish: " + download.stdout.slice(-400));

  console.log("[sam2-e2e] SAM 2 self-test on synthetic frames…");
  const selftest = await execFileAsync(info.python, [
    scriptPath, "selftest", "--model", "tiny", "--models-dir", modelsDir,
    "--packages-dir", packagesDir, "--sam2-src", sourceDir, "--device", "cpu",
  ], { env, maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000 });
  const selftestDone = selftest.stdout.trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.event === "done");
  if (!selftestDone) throw new Error("SAM 2 self-test produced no result: " + selftest.stdout.slice(-400));
  console.log("[sam2-e2e] self-test:", JSON.stringify(selftestDone));

  // A token for the API, exactly like the app does.
  const tokenCode = [
    "from django.contrib.auth import get_user_model",
    "from rest_framework.authtoken.models import Token",
    "user = get_user_model().objects.filter(is_superuser=True).order_by('id').first()",
    "print('CVAT_SAM2_TOKEN=' + Token.objects.get_or_create(user=user)[0].key)",
  ].join("; ");
  const tokenResult = await execFileAsync(info.python, ["manage.py", "shell", "-c", tokenCode], {
    cwd: info.backendDir, env, maxBuffer: 4 * 1024 * 1024,
  });
  const token = /CVAT_SAM2_TOKEN=([0-9a-f]+)/.exec(tokenResult.stdout)[1];

  // Synthetic frames: a white disc moving to the right.
  await execFileAsync(info.python, ["-c", [
    "import sys; sys.path.insert(0, sys.argv[1])",
    "import track_sam2; track_sam2.synthetic_frames(sys.argv[2], count=int(sys.argv[3]))",
  ].join("; "), path.dirname(scriptPath), framesDir, String(FRAMES)], { env });

  const task = await api(base, token, "POST", "/api/tasks", {
    json: { name: "sam2-e2e", labels: [{ name: "ball", attributes: [] }] },
  });
  // Same three-step upload the CVAT SDK uses: Upload-Start, Upload-Multiple (files), Upload-Finish (parameters).
  await api(base, token, "POST", "/api/tasks/" + task.id + "/data", { headers: { "Upload-Start": "true" } });
  const files = new FormData();
  for (let index = 0; index < FRAMES; index += 1) {
    const name = String(index).padStart(5, "0") + ".jpg";
    files.append("client_files[" + index + "]", new Blob([fs.readFileSync(path.join(framesDir, name))], { type: "image/jpeg" }), name);
  }
  await api(base, token, "POST", "/api/tasks/" + task.id + "/data", { form: files, headers: { "Upload-Multiple": "true" } });
  const finish = new FormData();
  finish.append("image_quality", "95");
  await api(base, token, "POST", "/api/tasks/" + task.id + "/data", { form: finish, headers: { "Upload-Finish": "true" } });
  const job = await waitFor(async () => {
    const jobs = await api(base, token, "GET", "/api/jobs?task_id=" + task.id);
    return jobs.results && jobs.results.length ? jobs.results[0] : null;
  }, "the task data to be processed");
  const labels = await api(base, token, "GET", "/api/labels?job_id=" + job.id);
  const labelId = labels.results[0].id;

  await api(base, token, "PATCH", "/api/jobs/" + job.id + "/annotations?action=create", {
    json: {
      version: 0, tags: [], tracks: [],
      shapes: [{
        type: "polygon", frame: 0, label_id: labelId, group: 0, source: "manual", occluded: false,
        outside: false, z_order: 0, rotation: 0, attributes: [], points: [32, 100, 88, 100, 88, 156, 32, 156],
      }],
    },
  });
  const before = await api(base, token, "GET", "/api/jobs/" + job.id + "/annotations");
  const shapeId = before.shapes[0].id;

  console.log("[sam2-e2e] tracking through the CVAT API with SAM 2…");
  const common = ["--server", base, "--job", String(job.id), "--frame", "0"];
  const listed = await execFileAsync(info.python, [scriptPath, "list", ...common], { env: { ...env, CVAT_SAM2_TOKEN: token } });
  const objects = JSON.parse(listed.stdout.trim().split("\n").pop()).objects;
  if (objects.length !== 1 || objects[0].kind !== "shape" || !objects[0].supported) throw new Error("Unexpected object list: " + listed.stdout);

  const tracked = await execFileAsync(info.python, [
    scriptPath, "track", ...common, "--kind", "shape", "--object-id", String(shapeId),
    "--count", String(FRAMES - 1), "--direction", "forward", "--model", "tiny", "--device", "cpu", "--replace",
    "--models-dir", modelsDir, "--packages-dir", packagesDir, "--sam2-src", sourceDir,
  ], { env: { ...env, CVAT_SAM2_TOKEN: token }, maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000 });
  const done = tracked.stdout.trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.event === "done");
  if (!done) throw new Error("Tracking produced no result: " + tracked.stdout.slice(-600));

  const after = await api(base, token, "GET", "/api/jobs/" + job.id + "/annotations");
  if (after.shapes.length !== 0) throw new Error("The original shape was not replaced");
  if (after.tracks.length !== 1) throw new Error("Expected exactly one track, found " + after.tracks.length);
  const frames = after.tracks[0].shapes.filter((shape) => !shape.outside).map((shape) => shape.frame);
  if (frames.length !== FRAMES || frames.some((frame, index) => frame !== index)) {
    throw new Error("Unexpected tracked frames: " + JSON.stringify(frames));
  }
  console.log("[sam2-e2e] OK: track saved with", frames.length, "keyframes; result:", JSON.stringify(done));
}

module.exports = { runSam2E2E };
