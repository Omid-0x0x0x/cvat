"use strict";

const $ = (id) => document.getElementById(id);
const els = {
  setup: $("setup"), track: $("track"), setupModel: $("setupModel"), install: $("install"),
  job: $("job"), frame: $("frame"), load: $("load"), object: $("object"), count: $("count"),
  direction: $("direction"), model: $("model"), device: $("device"), replace: $("replace"),
  run: $("run"), cancel: $("cancel"), reload: $("reload"), bar: $("bar"), log: $("log"), message: $("message"),
};
let objects = [];
let state = null;

function setMessage(text, kind) {
  els.message.textContent = text || "";
  els.message.className = kind || "";
}

function appendLog(text) {
  els.log.textContent += text + "\n";
  els.log.scrollTop = els.log.scrollHeight;
}

function busy(isBusy) {
  for (const el of [els.install, els.load, els.run, els.job, els.frame, els.count, els.direction, els.model, els.device, els.replace, els.object]) {
    el.disabled = isBusy || (el === els.run && objects.length === 0) || (el === els.object && objects.length === 0);
  }
  els.cancel.hidden = !isBusy;
  els.bar.hidden = !isBusy;
}

window.sam2.onEvent((event) => {
  if (event.event !== "progress") return;
  appendLog(event.message);
  if (typeof event.fraction === "number") { els.bar.removeAttribute("indeterminate"); els.bar.value = event.fraction; }
  else els.bar.removeAttribute("value");
});

function ready() {
  return state.codeAvailable && state.torchInstalled && Object.values(state.models).some(Boolean);
}

function fillModels(select, onlyInstalled) {
  select.textContent = "";
  for (const [name, info] of Object.entries(state.modelInfo)) {
    if (onlyInstalled && !state.models[name]) continue;
    const option = document.createElement("option");
    option.value = name;
    option.textContent = info.label + " (" + info.sizeMb + " MB)" + (state.models[name] ? " ✓" : "");
    select.appendChild(option);
  }
}

async function refresh() {
  state = await window.sam2.status();
  if (state.event === "error") { setMessage(state.message, "error"); return; }
  if (!state.codeAvailable) {
    els.setup.hidden = true; els.track.hidden = true;
    setMessage("This build of CVAT Desktop does not include the SAM 2 code.", "error");
    return;
  }
  els.setup.hidden = ready();
  els.track.hidden = !ready();
  fillModels(els.setupModel, false);
  fillModels(els.model, true);
}

els.install.addEventListener("click", async () => {
  setMessage("");
  els.log.textContent = "";
  busy(true);
  const result = await window.sam2.install(els.setupModel.value);
  busy(false);
  if (result.event === "error") setMessage(result.message, "error");
  else setMessage("SAM 2 is ready.", "ok");
  await refresh();
});

els.load.addEventListener("click", async () => {
  setMessage("");
  objects = [];
  els.object.textContent = "";
  busy(true);
  const result = await window.sam2.listObjects(Number(els.job.value), Number(els.frame.value));
  if (result.event === "error") {
    busy(false);
    setMessage(result.message, "error");
    return;
  }
  objects = result.objects.filter((item) => item.supported);
  for (const item of objects) {
    const option = document.createElement("option");
    option.value = item.kind + ":" + item.id;
    option.textContent = item.label + " · " + item.type + " · " + (item.kind === "track" ? "track" : "shape") + " #" + item.id;
    els.object.appendChild(option);
  }
  busy(false);
  const skipped = result.objects.length - objects.length;
  if (objects.length === 0) {
    const placeholder = document.createElement("option");
    placeholder.textContent = "No polygon, mask or rectangle on this frame";
    els.object.appendChild(placeholder);
    setMessage("No trackable objects found on frame " + els.frame.value + ". Make sure the work is saved and the frame number is right." +
      (skipped ? " (" + skipped + " object(s) of other shape types were skipped.)" : ""), "error");
  } else if (skipped) {
    setMessage(skipped + " object(s) of other shape types were skipped (only polygons, masks and rectangles can be tracked).");
  }
  busy(false);
});

els.run.addEventListener("click", async () => {
  const selected = els.object.value.split(":");
  setMessage("");
  els.log.textContent = "";
  els.reload.hidden = true;
  busy(true);
  const result = await window.sam2.track({
    job: Number(els.job.value), frame: Number(els.frame.value),
    kind: selected[0], objectId: Number(selected[1]),
    count: Number(els.count.value), direction: els.direction.value,
    model: els.model.value, device: els.device.value, replace: els.replace.checked,
  });
  busy(false);
  if (result.event === "error") { setMessage(result.message, "error"); return; }
  setMessage("Done. Tracked " + result.frames_tracked + " frame(s); the object was found in " + result.frames_with_object +
    " of them. Reload the job to see the new track." + (result.replaced ? " The original shape was replaced." : ""), "ok");
  els.reload.hidden = false;
});

els.cancel.addEventListener("click", () => window.sam2.cancel());
els.reload.addEventListener("click", async () => { await window.sam2.reloadMain(); els.reload.hidden = true; });

(async () => {
  await refresh();
  const context = await window.sam2.context();
  if (context && context.job) els.job.value = context.job;
  if (context && Number.isFinite(context.frame)) els.frame.value = context.frame;
  else els.frame.value = 0;
  busy(false);
})();
