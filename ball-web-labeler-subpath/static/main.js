// ----- Config / Helpers ------------------------------------------------------
const APP_ROOT =
  (window.__APP_ROOT && window.__APP_ROOT.replace(/\/$/, "")) ||
  (document.querySelector('meta[name="app-root"]')?.content || "").replace(/\/$/, "");

const API = (p) => `${APP_ROOT}/api${p}`;
const el = (q) => document.querySelector(q);
const on = (target, ev, fn, opts) => target.addEventListener(ev, fn, opts);

function toast(msg, type = "info") {
  const box = el("#toast") || (() => {
    const d = document.createElement("div");
    d.id = "toast";
    d.style.position = "fixed";
    d.style.left = "50%";
    d.style.transform = "translateX(-50%)";
    d.style.bottom = "20px";
    d.style.padding = "10px 14px";
    d.style.borderRadius = "10px";
    d.style.background = "#1f2937";
    d.style.color = "white";
    d.style.fontSize = "14px";
    d.style.zIndex = "9999";
    d.style.boxShadow = "0 6px 24px rgba(0,0,0,.25)";
    document.body.appendChild(d);
    return d;
  })();
  box.textContent = msg;
  box.style.background = type === "error" ? "#b91c1c" : (type === "ok" ? "#065f46" : "#1f2937");
  box.style.opacity = "1";
  setTimeout(() => box.style.opacity = "0", 2200);
}

function fmtErr(e) {
  if (!e) return "Unbekannter Fehler";
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

function qsv(obj) { // query string
  return Object.entries(obj)
    .filter(([,v]) => v !== undefined && v !== null && v !== "")
    .map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

// ----- UI Elements -----------------------------------------------------------
const $fileInput = el("#fileInput");
const $fpsInput = el("#fpsInput");
const $taskInput = el("#taskInput");
const $uploadBtn = el("#uploadBtn");

const $ytUrl = el("#ytUrl");
const $ytFps = el("#ytFps");
const $ytTask = el("#ytTask");
const $ingestBtn = el("#ingestBtn");

const $img = el("#frameImg");
const $boxPx = el("#boxPx");
const $prev = el("#prevBtn");
const $skip = el("#skipBtn");
const $next = el("#nextBtn");
const $export = el("#exportBtn");
const $status = el("#status");

const $drop = el("#dropArea");

// ----- State -----------------------------------------------------------------
let state = {
  task: "",
  idx: 0,
  total: 0,
  saving: false
};

// ----- Frame Handling --------------------------------------------------------
async function loadTaskInfo(task) {
  // Backend liefert Frames-Anzahl unter /api/tasks?task=...
  const r = await fetch(API(`/tasks?${qsv({ task })}`));
  if (!r.ok) throw new Error("Konnte Task-Info nicht laden");
  const data = await r.json();
  // Erwartet: { task:"...", frames: N }  – fallback falls anderes Format:
  state.task = data.task || task;
  state.total = data.frames ?? (data.count ?? 0);
  state.idx = 0;
  renderStatus();
}

async function showFrame() {
  if (!state.task) return;
  // Cache-Busting via Zeitstempel
  const src = API(`/frame?${qsv({ task: state.task, idx: state.idx })}`) + `&t=${Date.now()}`;
  $img.src = src;
  renderStatus();
}

function renderStatus() {
  if (!state.task) {
    $status.textContent = "–";
  } else {
    $status.textContent = `Task: ${state.task} | Frame ${state.idx + 1} / ${state.total}`;
  }
}

async function goto(delta) {
  if (!state.task || state.total <= 0) return;
  state.idx = Math.max(0, Math.min(state.total - 1, state.idx + delta));
  await showFrame();
}

// ----- Save Annotation -------------------------------------------------------
async function savePoint(px, py) {
  if (state.saving || !state.task) return;
  state.saving = true;
  try {
    const body = {
      task: state.task,
      idx: state.idx,
      x: px,
      y: py,
      box: parseInt($boxPx.value || "24", 10)
    };
    const r = await fetch(API("/save"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(fmtErr(err.detail || err || r.statusText));
    }
    toast("Gespeichert ✓", "ok");
    // automatisch zum nächsten Frame
    await goto(+1);
  } catch (e) {
    toast(`Speichern fehlgeschlagen: ${fmtErr(e)}`, "error");
  } finally {
    state.saving = false;
  }
}

// Klick / Touch → (x, y) im Bildkoords
function imagePointFromEvent(ev) {
  const rect = $img.getBoundingClientRect();
  let clientX, clientY;
  if (ev.touches && ev.touches[0]) {
    clientX = ev.touches[0].clientX; clientY = ev.touches[0].clientY;
  } else {
    clientX = ev.clientX; clientY = ev.clientY;
  }
  const x = Math.round((clientX - rect.left) * ($img.naturalWidth / rect.width));
  const y = Math.round((clientY - rect.top)  * ($img.naturalHeight / rect.height));
  return { x, y };
}

on($img, "click", (e) => {
  if (!state.task) return;
  const { x, y } = imagePointFromEvent(e);
  savePoint(x, y);
});

on($img, "touchstart", (e) => {
  if (!state.task) return;
  const { x, y } = imagePointFromEvent(e);
  e.preventDefault();
  savePoint(x, y);
}, { passive: false });

// ----- Upload: Datei ---------------------------------------------------------
async function doUpload(file, fps, task) {
  if (!file) throw new Error("Bitte eine Videodatei wählen.");
  const fd = new FormData();
  // Feldname MUSS 'file' heißen (Server erwartet das so)
  fd.append("file", file);
  if (fps) fd.append("fps", String(fps));
  if (task) fd.append("task", String(task));

  const r = await fetch(API("/ingest/upload"), { method: "POST", body: fd });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(fmtErr(err.detail || err || r.statusText));
  }
  const data = await r.json();
  // Erwartet: { ok:true, task, frames }
  await loadTaskInfo(data.task);
  await showFrame();
  toast(`Upload & Extract OK: ${data.task} (${state.total} Frames)`, "ok");
}

on($uploadBtn, "click", async () => {
  try {
    const fps = parseInt($fpsInput.value || "0", 10) || undefined;
    const task = ($taskInput.value || "").trim() || undefined;
    await doUpload($fileInput.files?.[0], fps, task);
  } catch (e) {
    toast(`Fehler beim Upload: ${fmtErr(e)}`, "error");
  }
});

// Drag & Drop
;["dragenter","dragover"].forEach(ev =>
  on($drop, ev, (e) => { e.preventDefault(); $drop.classList.add("drag"); })
);
;["dragleave","drop"].forEach(ev =>
  on($drop, ev, (e) => { e.preventDefault(); $drop.classList.remove("drag"); })
);
on($drop, "drop", async (e) => {
  try {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const fps = parseInt($fpsInput.value || "0", 10) || undefined;
    const task = ($taskInput.value || "").trim() || undefined;
    await doUpload(file, fps, task);
  } catch (err) {
    toast(`Fehler beim Upload: ${fmtErr(err)}`, "error");
  }
});

// ----- Upload: YouTube -------------------------------------------------------
on($ingestBtn, "click", async () => {
  try {
    const url = ($ytUrl.value || "").trim();
    if (!url) throw new Error("Bitte YouTube-URL eingeben.");
    const fps = parseInt($ytFps.value || "0", 10) || undefined;
    const task = ($ytTask.value || "").trim() || undefined;

    const r = await fetch(API("/ingest/youtube"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, fps, task })
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(fmtErr(err.detail || err || r.statusText));
    }
    const data = await r.json();
    await loadTaskInfo(data.task);
    await showFrame();
    toast(`YouTube ingest OK: ${data.task} (${state.total} Frames)`, "ok");
  } catch (e) {
    toast(`Fehler bei YouTube-Ingest: ${fmtErr(e)}`, "error");
  }
});

// ----- Navigation / Export ---------------------------------------------------
on($prev, "click", () => goto(-1));
on($next, "click", () => goto(+1));
on($skip, "click", () => goto(+1));
on($export, "click", () => {
  if (!state.task) return toast("Kein Task aktiv.", "error");
  // Direktes Herunterladen (der Browser lädt das ZIP)
  const url = API(`/export?${qsv({ task: state.task })}`) + `&t=${Date.now()}`;
  window.location.href = url;
});

// Keyboard: A / S / D
on(window, "keydown", (e) => {
  if (!state.task) return;
  const k = e.key.toLowerCase();
  if (k === "a") goto(-1);
  if (k === "s") goto(+1);
  if (k === "d") { // D = Klick simulieren (Mitte)
    // Markiert Mitte des Bildes – praktisch am Desktop
    const x = Math.round(($img.naturalWidth || $img.width) / 2);
    const y = Math.round(($img.naturalHeight || $img.height) / 2);
    savePoint(x, y);
  }
});

// ----- Initial ---------------------------------------------------------------
(async function init() {
  // Optional: Task aus URL übernehmen ?task=XYZ
  const url = new URL(location.href);
  const t = url.searchParams.get("task");
  if (t) {
    try {
      await loadTaskInfo(t);
      await showFrame();
    } catch {
      // ignorieren
    }
  }
  renderStatus();
})();
