(() => {
  function detectRoot() {
    if ((window.location.hostname || "") === "balls.spinevo.app") return "";
    const p = window.location.pathname || "/";
    if (p.startsWith("/ball-detection")) return "/ball-detection";
    return "";
  }
  const ROOT = detectRoot();
  const API = (path) => `${ROOT}${path.startsWith("/") ? path : "/" + path}`;

  const taskSelect = document.getElementById("taskSelect");
  const loadBtn = document.getElementById("loadBtn");
  const saveBtn = document.getElementById("saveBtn");
  const statusEl = document.getElementById("status");
  const frameInfo = document.getElementById("frameInfo");
  const prevBtn = document.getElementById("prevBtn");
  const nextBtn = document.getElementById("nextBtn");
  const startBtn = document.getElementById("startBtn");
  const endBtn = document.getElementById("endBtn");
  const deleteBtn = document.getElementById("deleteBtn");
  const scrub = document.getElementById("scrub");
  const timeline = document.getElementById("timeline");
  const frameImg = document.getElementById("frameImg");
  const overlay = document.getElementById("overlay");
  const ctx = overlay.getContext("2d");

  let taskId = "";
  let rows = [];
  let index = 0;
  let events = [];
  let byFrame = new Map();

  function setStatus(msg, isErr = false) {
    statusEl.textContent = msg;
    statusEl.style.color = isErr ? "#ef4444" : "#94a3b8";
  }

  async function jfetch(url, init) {
    const r = await fetch(url, init);
    if (!r.ok) {
      let t = "";
      try { t = await r.text(); } catch (_) {}
      throw new Error(t || `HTTP ${r.status}`);
    }
    return r.json();
  }

  function recalcByFrame() {
    byFrame = new Map();
    for (const e of events) {
      const arr = byFrame.get(e.frame) || [];
      arr.push(e.kind);
      byFrame.set(e.frame, arr);
    }
  }

  function timelinePct(frame) {
    if (rows.length <= 1) return 0;
    return (frame / (rows.length - 1)) * 100;
  }

  function renderTimeline() {
    timeline.innerHTML = "";
    const cur = document.createElement("div");
    cur.className = "cur";
    cur.style.left = `${timelinePct(index)}%`;
    timeline.appendChild(cur);
    for (const e of events) {
      const m = document.createElement("div");
      m.className = `marker ${e.kind === "start" ? "start" : "end"}`;
      m.style.left = `${timelinePct(e.frame)}%`;
      timeline.appendChild(m);
    }
  }

  function drawOverlay() {
    overlay.width = frameImg.clientWidth;
    overlay.height = frameImg.clientHeight;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const row = rows[index];
    if (!row || row.x == null || row.y == null || !row.width || !row.height) return;
    const px = (row.x / row.width) * overlay.width;
    const py = (row.y / row.height) * overlay.height;
    ctx.beginPath();
    ctx.arc(px, py, 10, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,220,60,0.95)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py, 3, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,180,40,0.95)";
    ctx.fill();
  }

  function renderFrame() {
    if (rows.length === 0) return;
    const row = rows[index];
    frameImg.src = API(`/api/task/${encodeURIComponent(taskId)}/frame/${encodeURIComponent(row.filename)}`);
    frameInfo.textContent = `Frame ${index + 1}/${rows.length} · ${row.filename}`;
    scrub.max = String(Math.max(0, rows.length - 1));
    scrub.value = String(index);
    renderTimeline();
    const ks = byFrame.get(index) || [];
    if (ks.length > 0) setStatus(`Events auf Frame: ${ks.join(", ")}`);
    else setStatus("Bereit");
  }

  function pushEvent(kind) {
    if (rows.length === 0) return;
    if (kind !== "start" && kind !== "end") return;
    events.push({ frame: index, kind });
    const uniq = new Map();
    for (const e of events) uniq.set(`${e.frame}:${e.kind}`, e);
    events = Array.from(uniq.values()).sort((a, b) => a.frame - b.frame || a.kind.localeCompare(b.kind));
    recalcByFrame();
    renderFrame();
  }

  function deleteAtFrame() {
    events = events.filter((e) => e.frame !== index);
    recalcByFrame();
    renderFrame();
  }

  async function loadTasks() {
    try {
      const data = await jfetch(API("/api/rally/tasks"));
      taskSelect.innerHTML = `<option value="">(Task wählen)</option>`;
      for (const t of data.tasks || []) {
        const o = document.createElement("option");
        o.value = t.task_id;
        o.textContent = `${t.task_id} (${t.frames_total} Frames${t.has_rally_labels ? " · Rally vorhanden" : ""})`;
        taskSelect.appendChild(o);
      }
    } catch (e) {
      setStatus(String(e), true);
    }
  }

  async function loadTask() {
    taskId = taskSelect.value;
    if (!taskId) return;
    setStatus("Lade Task...");
    try {
      const p = await jfetch(API(`/api/rally/task/${encodeURIComponent(taskId)}/points`));
      rows = p.rows || [];
      const l = await jfetch(API(`/api/rally/task/${encodeURIComponent(taskId)}/labels`));
      events = (l.events || []).filter((e) => (e.kind === "start" || e.kind === "end") && Number.isInteger(e.frame));
      recalcByFrame();
      index = 0;
      renderFrame();
      setStatus(`Task geladen: ${rows.length} Frames`);
    } catch (e) {
      setStatus(String(e), true);
    }
  }

  async function saveTask() {
    if (!taskId) return;
    try {
      const r = await jfetch(API(`/api/rally/task/${encodeURIComponent(taskId)}/labels`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events, sync_offset_frames: 0 }),
      });
      setStatus(`Gespeichert (${r.events_saved} Events)`);
    } catch (e) {
      setStatus(String(e), true);
    }
  }

  prevBtn.addEventListener("click", () => { index = Math.max(0, index - 1); renderFrame(); });
  nextBtn.addEventListener("click", () => { index = Math.min(rows.length - 1, index + 1); renderFrame(); });
  startBtn.addEventListener("click", () => pushEvent("start"));
  endBtn.addEventListener("click", () => pushEvent("end"));
  deleteBtn.addEventListener("click", deleteAtFrame);
  loadBtn.addEventListener("click", () => void loadTask());
  saveBtn.addEventListener("click", () => void saveTask());
  scrub.addEventListener("input", () => { index = Number(scrub.value) || 0; renderFrame(); });
  frameImg.addEventListener("load", drawOverlay);
  window.addEventListener("resize", drawOverlay);

  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); index = Math.max(0, index - 1); renderFrame(); }
    if (e.key === "ArrowRight") { e.preventDefault(); index = Math.min(rows.length - 1, index + 1); renderFrame(); }
    if (e.key.toLowerCase() === "s") pushEvent("start");
    if (e.key.toLowerCase() === "e") pushEvent("end");
    if (e.key.toLowerCase() === "d") deleteAtFrame();
  });

  void loadTasks();
})();
