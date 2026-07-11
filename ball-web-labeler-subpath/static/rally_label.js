(() => {
  function detectRoot() {
    if ((window.location.hostname || "") === "balls.spinevo.app") return "";
    const p = window.location.pathname || "/";
    if (p.startsWith("/ball-detection")) return "/ball-detection";
    return "";
  }
  const ROOT = detectRoot();
  const API = (path) => `${ROOT}${path.startsWith("/") ? path : "/" + path}`;

  // ---------------------------------------------------------------------
  // Pose-Konstanten (Port von spinevo rallyTypes.ts)
  // ---------------------------------------------------------------------
  const POSE_LANDMARK_INDICES = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
  const POSE_BONES = [
    [0, 11], [0, 12],
    [11, 12],
    [11, 13], [13, 15],
    [12, 14], [14, 16],
    [11, 23], [12, 24],
    [23, 24],
    [23, 25], [25, 27],
    [24, 26], [26, 28],
  ];

  // ---------------------------------------------------------------------
  // Gemeinsamer CSV-Parser (Port von parseBallPointsCsv/_buildPoseColumnIndex/_readPose)
  // Versteht frame,x,y,confidence + optionale p1/p2-Boxen + optionale Pose-Spalten.
  // Fehlende Spalten/Werte sind kein Fehler -> Overlay zeichnet dann einfach nichts.
  // ---------------------------------------------------------------------
  function parseCsvLine(line) {
    return line.split(",");
  }

  function toFiniteOrNull(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function buildColumnIndex(header) {
    const idx = new Map();
    header.forEach((name, i) => idx.set(name.trim(), i));
    return idx;
  }

  function buildPoseColumnIndex(colIdx, prefix) {
    // Liefert { [landmarkIndex]: { xi, yi } } nur fuer Landmarks, deren beide Spalten existieren.
    const out = {};
    for (const lm of POSE_LANDMARK_INDICES) {
      const xi = colIdx.get(`${prefix}_lm${lm}_x`);
      const yi = colIdx.get(`${prefix}_lm${lm}_y`);
      if (xi !== undefined && yi !== undefined) out[lm] = { xi, yi };
    }
    return out;
  }

  function readPose(cells, poseColIdx) {
    const pose = {};
    for (const lmStr of Object.keys(poseColIdx)) {
      const { xi, yi } = poseColIdx[lmStr];
      const x = toFiniteOrNull(cells[xi]);
      const y = toFiniteOrNull(cells[yi]);
      if (x != null && y != null) pose[Number(lmStr)] = { x, y };
    }
    return pose;
  }

  function readBox(cells, colIdx, prefix) {
    const keys = ["x1", "y1", "x2", "y2", "conf"];
    const idxs = keys.map((k) => colIdx.get(`${prefix}_${k}`));
    if (idxs.some((i) => i === undefined)) return null;
    const vals = idxs.map((i) => toFiniteOrNull(cells[i]));
    if (vals[0] == null || vals[1] == null || vals[2] == null || vals[3] == null) return null;
    return { x1: vals[0], y1: vals[1], x2: vals[2], y2: vals[3], conf: vals[4] };
  }

  /**
   * @returns {Array<{frame:number,x:number|null,y:number|null,confidence:number|null,p1Box:object|null,p2Box:object|null,p1Pose:object,p2Pose:object}>}
   */
  function parsePointsCsv(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length === 0) return [];
    const header = parseCsvLine(lines[0]);
    const colIdx = buildColumnIndex(header);
    const fi = colIdx.get("frame");
    const xi = colIdx.get("x");
    const yi = colIdx.get("y");
    const ci = colIdx.get("confidence");
    const p1PoseIdx = buildPoseColumnIndex(colIdx, "p1");
    const p2PoseIdx = buildPoseColumnIndex(colIdx, "p2");

    const rows = [];
    for (let li = 1; li < lines.length; li++) {
      const cells = parseCsvLine(lines[li]);
      const frame = fi !== undefined ? Number(cells[fi]) : li - 1;
      rows.push({
        frame: Number.isFinite(frame) ? frame : li - 1,
        x: xi !== undefined ? toFiniteOrNull(cells[xi]) : null,
        y: yi !== undefined ? toFiniteOrNull(cells[yi]) : null,
        confidence: ci !== undefined ? toFiniteOrNull(cells[ci]) : null,
        p1Box: readBox(cells, colIdx, "p1"),
        p2Box: readBox(cells, colIdx, "p2"),
        p1Pose: readPose(cells, p1PoseIdx),
        p2Pose: readPose(cells, p2PoseIdx),
      });
    }
    return rows;
  }

  // ---------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------
  const taskSelect = document.getElementById("taskSelect");
  const loadBtn = document.getElementById("loadBtn");
  const saveBtn = document.getElementById("saveBtn");
  const statusEl = document.getElementById("status");
  const frameInfo = document.getElementById("frameInfo");
  const prevBtn = document.getElementById("prevBtn");
  const nextBtn = document.getElementById("nextBtn");
  const playBtn = document.getElementById("playBtn");
  const startBtn = document.getElementById("startBtn");
  const endBtn = document.getElementById("endBtn");
  const deleteBtn = document.getElementById("deleteBtn");
  const undoBtn = document.getElementById("undoBtn");
  const scrub = document.getElementById("scrub");
  const timeline = document.getElementById("timeline");
  const frameImg = document.getElementById("frameImg");
  const frameVideo = document.getElementById("frameVideo");
  const overlay = document.getElementById("overlay");
  const ctx = overlay.getContext("2d");
  const tableBtn = document.getElementById("tableBtn");
  const tableSaveBtn = document.getElementById("tableSaveBtn");
  const tableCancelBtn = document.getElementById("tableCancelBtn");
  const tableDeleteBtn = document.getElementById("tableDeleteBtn");
  const tableShowChk = document.getElementById("tableShowChk");
  const tableStatus = document.getElementById("tableStatus");
  const tableHint = document.getElementById("tableHint");

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  let taskId = "";
  let mode = "frames"; // "frames" | "video"
  let frameFilenames = []; // nur frames-Modus: Liste der Frame-Dateinamen
  let rows = []; // Punkte-CSV (gemeinsame Quelle für frames- und video-Modus)
  let index = 0; // angezeigter Frame-Index (treibt Bild/Video + Event-Zuordnung)
  let events = [];
  let history = []; // Undo-Stack: zuletzt hinzugefügte Events
  let byFrame = new Map();
  let playing = false;
  let videoDuration = 0;
  let framesPlayTimer = null; // Play-Loop für frames-Modus (kein <video>, daher Timer-basiert)

  // Statische Tisch/Netz-Kalibrierung (ein Punktesatz pro Task, Quell-Pixel)
  const TABLE_POINT_NAMES = [
    "Nahe linke Tischecke", "Nahe rechte Tischecke",
    "Ferne rechte Tischecke", "Ferne linke Tischecke",
    "Netz links (Oberkante)", "Netz rechts (Oberkante)",
  ];
  let tableCalib = null;    // { table:[[x,y]×4], net:[[x,y]×2]|null } (gespeicherter Stand)
  let tableCapture = null;  // Array der bisher geklickten Punkte, null = kein Aufnahme-Modus
  let suppressVideoSeek = false; // verhindert Rück-Feedback waehrend programmatischem Seek

  function totalFrames() {
    return mode === "frames" ? frameFilenames.length : rows.length;
  }

  function pointRowForDisplayIndex(i) {
    if (rows.length === 0) return null;
    const csvIdx = Math.max(0, Math.min(rows.length - 1, i));
    return rows[csvIdx] || null;
  }

  // ---------------------------------------------------------------------
  // Frame<->Zeit-Mapping für den video-Modus (Port von RallyLabelTool.tsx:30-45).
  // Rein proportional zur Videodauer, keine FPS-Annahme nötig.
  // ---------------------------------------------------------------------
  function timeForFrameIndex(frame, durationSec, totalN) {
    const n = Math.max(1, totalN);
    const f = Math.max(0, Math.min(frame, n - 1));
    return (f / (n - 1 || 1)) * durationSec;
  }

  function frameIndexFromTime(t, durationSec, totalN) {
    const n = Math.max(1, totalN);
    if (!(durationSec > 0)) return 0;
    const f = Math.round((t / durationSec) * (n - 1));
    return Math.max(0, Math.min(n - 1, f));
  }

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
    const ct = r.headers.get("content-type") || "";
    return ct.includes("application/json") ? r.json() : r.text();
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
    const n = totalFrames();
    if (n <= 1) return 0;
    return (frame / (n - 1)) * 100;
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

  // ---------------------------------------------------------------------
  // Overlay-Rendering: Ball-Punkt + optionale P1/P2-Boxen + optionales Skeleton.
  // Letterbox-aware Skalierung wie in spinevo RallyLabelTool.tsx (scale = min(w/sw, h/sh)).
  // ---------------------------------------------------------------------
  function currentMediaEl() {
    return mode === "video" ? frameVideo : frameImg;
  }

  function sourceSize() {
    if (mode === "video") {
      return { w: frameVideo.videoWidth || 1, h: frameVideo.videoHeight || 1 };
    }
    return { w: frameImg.naturalWidth || 1, h: frameImg.naturalHeight || 1 };
  }

  function drawBox(box, color) {
    if (!box) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(box.px1, box.py1, box.px2 - box.px1, box.py2 - box.py1);
  }

  function drawSkeleton(pose, projected, color) {
    const present = new Set(Object.keys(pose).map(Number));
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    for (const [a, b] of POSE_BONES) {
      if (!present.has(a) || !present.has(b)) continue;
      const pa = projected[a];
      const pb = projected[b];
      if (!pa || !pb) continue;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    ctx.fillStyle = color;
    for (const lm of present) {
      const p = projected[lm];
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // Projektion Quell-Pixel -> Canvas (gleiche Logik wie bisher in drawOverlay)
  function projection() {
    const { w: sw, h: sh } = sourceSize();
    const scale = Math.min(overlay.width / sw, overlay.height / sh);
    const ox = (overlay.width - sw * scale) / 2;
    const oy = (overlay.height - sh * scale) / 2;
    return { sw, sh, scale, ox, oy, project: (x, y) => ({ x: ox + x * scale, y: oy + y * scale }) };
  }

  function drawTableOverlay(project) {
    const saved = tableCalib && tableShowChk.checked;
    const pts = tableCapture !== null ? tableCapture : (saved ? tableCalib.table.concat(tableCalib.net || []) : null);
    if (!pts || pts.length === 0) return;

    const tablePts = pts.slice(0, 4).map(([x, y]) => project(x, y));
    const netPts = pts.slice(4, 6).map(([x, y]) => project(x, y));

    // Tischfläche (Polygon; während der Aufnahme als offener Linienzug)
    if (tablePts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(tablePts[0].x, tablePts[0].y);
      for (const p of tablePts.slice(1)) ctx.lineTo(p.x, p.y);
      if (tablePts.length === 4) {
        ctx.closePath();
        ctx.fillStyle = "rgba(34,197,94,0.12)";
        ctx.fill();
      }
      ctx.strokeStyle = "rgba(34,197,94,0.9)";
      ctx.lineWidth = 2;
      ctx.setLineDash(tableCapture !== null ? [6, 4] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Netzlinie: gelabelt, oder abgeleitet als Verbindung der Kantenmitten
    // von naher (P1-P2) und ferner (P4-P3) Tischkante - das Netz trennt die
    // beiden Spielerhälften
    let netLine = netPts.length === 2 ? netPts : null;
    if (!netLine && tablePts.length === 4 && tableCapture === null) {
      netLine = [
        { x: (tablePts[0].x + tablePts[1].x) / 2, y: (tablePts[0].y + tablePts[1].y) / 2 },
        { x: (tablePts[3].x + tablePts[2].x) / 2, y: (tablePts[3].y + tablePts[2].y) / 2 },
      ];
    }
    if (netLine) {
      ctx.beginPath();
      ctx.moveTo(netLine[0].x, netLine[0].y);
      ctx.lineTo(netLine[1].x, netLine[1].y);
      ctx.strokeStyle = "rgba(34,211,238,0.9)";
      ctx.lineWidth = 2;
      ctx.setLineDash(netPts.length === 2 ? [] : [4, 4]); // gestrichelt = abgeleitet
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Punkte mit Nummern
    pts.forEach(([x, y], i) => {
      const p = project(x, y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = i < 4 ? "rgba(34,197,94,0.95)" : "rgba(34,211,238,0.95)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 11px ui-sans-serif, system-ui";
      ctx.fillText(String(i + 1), p.x + 7, p.y - 5);
    });
  }

  function drawOverlay() {
    const media = currentMediaEl();
    overlay.width = media.clientWidth || 1;
    overlay.height = media.clientHeight || 1;
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const { project } = projection();
    drawTableOverlay(project);

    const row = pointRowForDisplayIndex(index);
    if (!row) return;

    if (row.x != null && row.y != null) {
      const p = project(row.x, row.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,220,60,0.95)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,180,40,0.95)";
      ctx.fill();
    }

    if (row.p1Box) {
      const a = project(row.p1Box.x1, row.p1Box.y1);
      const b = project(row.p1Box.x2, row.p1Box.y2);
      drawBox({ px1: a.x, py1: a.y, px2: b.x, py2: b.y }, "rgba(34,197,94,0.7)");
    }
    if (row.p2Box) {
      const a = project(row.p2Box.x1, row.p2Box.y1);
      const b = project(row.p2Box.x2, row.p2Box.y2);
      drawBox({ px1: a.x, py1: a.y, px2: b.x, py2: b.y }, "rgba(239,68,68,0.7)");
    }

    if (row.p1Pose && Object.keys(row.p1Pose).length > 0) {
      const projected = {};
      for (const [lm, pt] of Object.entries(row.p1Pose)) projected[lm] = project(pt.x, pt.y);
      drawSkeleton(row.p1Pose, projected, "rgba(34,197,94,0.95)");
    }
    if (row.p2Pose && Object.keys(row.p2Pose).length > 0) {
      const projected = {};
      for (const [lm, pt] of Object.entries(row.p2Pose)) projected[lm] = project(pt.x, pt.y);
      drawSkeleton(row.p2Pose, projected, "rgba(239,68,68,0.95)");
    }
  }

  function renderFrame() {
    // Setzt NIE frameVideo.currentTime (das macht ausschließlich seekToFrame) -
    // damit z.B. pushEvent/undo nur das Overlay/Timeline aktualisieren, ohne den
    // Wiedergabekopf zu bewegen (Verhalten wie RallyLabelTool.tsx).
    const n = totalFrames();
    if (n === 0) return;
    if (mode === "frames") {
      const fname = frameFilenames[index];
      frameImg.src = API(`/api/task/${encodeURIComponent(taskId)}/frame/${encodeURIComponent(fname)}`);
      frameInfo.textContent = `Frame ${index + 1}/${n} · ${fname}`;
    } else {
      frameInfo.textContent = `Frame ${index + 1}/${n}`;
    }
    scrub.max = String(Math.max(0, n - 1));
    scrub.value = String(index);
    renderTimeline();
    drawOverlay();
    const ks = byFrame.get(index) || [];
    if (ks.length > 0) setStatus(`Events auf Frame: ${ks.join(", ")}`);
    else setStatus("Bereit");
  }

  function clampFrame(f) {
    return Math.max(0, Math.min(totalFrames() - 1, f));
  }

  function seekToFrame(f) {
    if (totalFrames() === 0) return;
    index = clampFrame(f);
    if (mode === "video" && videoDuration > 0) {
      suppressVideoSeek = true;
      frameVideo.pause();
      playing = false;
      playBtn.classList.toggle("active", false);
      frameVideo.currentTime = timeForFrameIndex(index, videoDuration, totalFrames());
    }
    renderFrame();
  }

  // Wird bei timeupdate/seeked des <video>-Elements aufgerufen: übersetzt die
  // aktuelle Abspielposition zurück in einen CSV-Frame, ohne (wie seekToFrame)
  // erneut currentTime zu setzen -> keine Rückkopplung.
  function onVideoTimeSync() {
    if (mode !== "video" || !(videoDuration > 0)) return;
    if (suppressVideoSeek) { suppressVideoSeek = false; return; }
    index = clampFrame(frameIndexFromTime(frameVideo.currentTime, videoDuration, totalFrames()));
    renderFrame();
  }

  // ---------------------------------------------------------------------
  // Events / Undo (Port von pushEvent/undo/deleteAtFrame aus RallyLabelTool.tsx)
  // ---------------------------------------------------------------------
  function pushEvent(kind) {
    if (totalFrames() === 0) return;
    if (kind !== "start" && kind !== "end") return;
    const ev = { frame: index, kind };
    events = [...events, ev];
    history = [...history, ev];
    recalcByFrame();
    renderFrame();
  }

  function undo() {
    if (history.length === 0) return;
    const last = history[history.length - 1];
    history = history.slice(0, -1);
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].frame === last.frame && events[i].kind === last.kind) {
        events = [...events.slice(0, i), ...events.slice(i + 1)];
        break;
      }
    }
    recalcByFrame();
    renderFrame();
  }

  function deleteAtFrame() {
    events = events.filter((e) => e.frame !== index);
    recalcByFrame();
    renderFrame();
  }

  // ---------------------------------------------------------------------
  // Laden / Speichern
  // ---------------------------------------------------------------------
  async function loadTasks() {
    try {
      const data = await jfetch(API("/api/rally/tasks"));
      taskSelect.innerHTML = `<option value="">(Task wählen)</option>`;
      for (const t of data.tasks || []) {
        const o = document.createElement("option");
        o.value = t.task_id;
        o.textContent = `${t.task_id} (${t.frames_total} Frames${t.has_rally_labels ? " · Rally vorhanden" : ""}${t.has_table_calib ? " · Tisch" : ""})`;
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
      const data = await jfetch(API(`/api/rally/tasks`));
      const meta = (data.tasks || []).find((t) => t.task_id === taskId);
      mode = (meta && meta.mode) || "frames";
      frameVideo.style.display = mode === "video" ? "block" : "none";
      frameImg.style.display = mode === "video" ? "none" : "block";

      videoDuration = 0;
      if (mode === "frames") {
        const p = await jfetch(API(`/api/rally/task/${encodeURIComponent(taskId)}/points`));
        frameFilenames = (p.rows || []).map((r) => r.filename);
      } else {
        frameFilenames = [];
        await new Promise((resolve, reject) => {
          frameVideo.onloadedmetadata = () => { videoDuration = frameVideo.duration || 0; resolve(); };
          frameVideo.onerror = () => reject(new Error("Video konnte nicht geladen werden."));
          frameVideo.src = API(`/api/rally/task/${encodeURIComponent(taskId)}/video`);
        });
      }

      const csvText = await jfetch(API(`/api/rally/task/${encodeURIComponent(taskId)}/points.csv`));
      rows = parsePointsCsv(csvText);

      const l = await jfetch(API(`/api/rally/task/${encodeURIComponent(taskId)}/labels`));
      events = (l.events || []).filter((e) => (e.kind === "start" || e.kind === "end") && Number.isInteger(e.frame));
      history = [];
      recalcByFrame();
      await loadTableCalib();
      seekToFrame(0);
      setStatus(`Task geladen: ${totalFrames()} Frames (Modus: ${mode})`
        + (tableCalib ? "" : " - Tipp: T = Tisch markieren"));
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
        body: JSON.stringify({ events }),
      });
      setStatus(`Gespeichert (${r.events_saved} Events)`);
    } catch (e) {
      setStatus(String(e), true);
    }
  }

  // ---------------------------------------------------------------------
  // Tisch/Netz-Kalibrierung: 4 Ecken + optional 2 Netzpunkte, statisch pro
  // Task (Kamera fest). Punkte in Quell-Pixeln, gleiche Achsen wie points.csv.
  // ---------------------------------------------------------------------
  function tableCalibUrl() {
    return API(`/api/rally/task/${encodeURIComponent(taskId)}/table-calib`);
  }

  function updateTableUi() {
    const capturing = tableCapture !== null;
    tableBtn.style.display = capturing ? "none" : "";
    tableSaveBtn.style.display = capturing && tableCapture.length >= 4 ? "" : "none";
    tableCancelBtn.style.display = capturing ? "" : "none";
    overlay.classList.toggle("capture", capturing);
    tableHint.textContent = capturing && tableCapture.length < 6
      ? `Klick ${tableCapture.length + 1}/6: ${TABLE_POINT_NAMES[tableCapture.length]} (U = Punkt zurück)`
      : "";
    if (tableCalib) {
      tableStatus.textContent = tableCalib.net ? "Tisch + Netz gesetzt" : "Tisch gesetzt (Netz abgeleitet)";
      tableStatus.classList.add("ok");
      tableStatus.classList.remove("off");
    } else {
      tableStatus.textContent = "kein Label";
      tableStatus.classList.remove("ok");
      tableStatus.classList.add("off");
    }
  }

  async function loadTableCalib() {
    tableCalib = null;
    tableCapture = null;
    try {
      const c = await jfetch(tableCalibUrl());
      if (c.exists && Array.isArray(c.table)) {
        tableCalib = { table: c.table, net: Array.isArray(c.net) ? c.net : null };
      }
    } catch (_) {
      // Kalibrierung ist optional - Laden des Tasks nicht daran scheitern lassen
    }
    updateTableUi();
  }

  function startTableCapture() {
    if (!taskId || totalFrames() === 0) {
      setStatus("Erst einen Task laden.", true);
      return;
    }
    tableCapture = [];
    updateTableUi();
    drawOverlay();
    setStatus("Tisch markieren: 4 Ecken klicken, danach optional 2 Netzpunkte.");
  }

  function cancelTableCapture() {
    tableCapture = null;
    updateTableUi();
    drawOverlay();
    setStatus("Tisch-Markierung abgebrochen.");
  }

  function undoTablePoint() {
    if (tableCapture === null || tableCapture.length === 0) return;
    tableCapture.pop();
    updateTableUi();
    drawOverlay();
  }

  async function saveTableCalib() {
    if (tableCapture === null || tableCapture.length < 4) return;
    const { sw, sh } = projection();
    const body = {
      table: tableCapture.slice(0, 4),
      net: tableCapture.length >= 6 ? tableCapture.slice(4, 6) : null,
      frame_width: sw,
      frame_height: sh,
    };
    try {
      await jfetch(tableCalibUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      tableCalib = { table: body.table, net: body.net };
      tableCapture = null;
      updateTableUi();
      drawOverlay();
      setStatus(`Tisch-Kalibrierung gespeichert${body.net ? " (mit Netz)" : " (Netz wird aus dem Tisch abgeleitet)"}.`);
    } catch (e) {
      setStatus(String(e), true);
    }
  }

  async function deleteTableCalib() {
    if (!taskId || !tableCalib) return;
    if (!window.confirm("Tisch/Netz-Kalibrierung dieses Tasks löschen?")) return;
    try {
      await jfetch(tableCalibUrl(), { method: "DELETE" });
      tableCalib = null;
      tableCapture = null;
      updateTableUi();
      drawOverlay();
      setStatus("Tisch-Kalibrierung gelöscht.");
    } catch (e) {
      setStatus(String(e), true);
    }
  }

  function onOverlayClick(e) {
    if (tableCapture === null || tableCapture.length >= 6) return;
    const rect = overlay.getBoundingClientRect();
    const { sw, sh, scale, ox, oy } = projection();
    const x = (e.clientX - rect.left - ox) / scale;
    const y = (e.clientY - rect.top - oy) / scale;
    if (x < 0 || y < 0 || x > sw || y > sh) return; // Klick im Letterbox-Rand
    tableCapture.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    if (tableCapture.length === 6) {
      void saveTableCalib(); // alle 6 Punkte gesetzt -> direkt speichern
      return;
    }
    updateTableUi();
    drawOverlay();
  }

  // ---------------------------------------------------------------------
  // Play/Pause: im video-Modus echte <video>-Wiedergabe, im frames-Modus
  // ein Timer-basiertes Auto-Advance (es gibt dort keine Medien-Zeitachse).
  // ---------------------------------------------------------------------
  function stopFramesPlayTimer() {
    if (framesPlayTimer) { clearInterval(framesPlayTimer); framesPlayTimer = null; }
  }

  function togglePlay() {
    if (totalFrames() === 0) return;
    if (mode === "video") {
      if (frameVideo.paused) void frameVideo.play(); else frameVideo.pause();
      return; // playing/Button-Status wird über play/pause-Events synchronisiert
    }
    playing = !playing;
    playBtn.classList.toggle("active", playing);
    stopFramesPlayTimer();
    if (playing) {
      framesPlayTimer = setInterval(() => {
        if (index >= totalFrames() - 1) {
          playing = false;
          playBtn.classList.toggle("active", false);
          stopFramesPlayTimer();
          return;
        }
        seekToFrame(index + 1);
      }, 80);
    }
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  prevBtn.addEventListener("click", () => seekToFrame(index - 1));
  nextBtn.addEventListener("click", () => seekToFrame(index + 1));
  playBtn.addEventListener("click", togglePlay);
  startBtn.addEventListener("click", () => pushEvent("start"));
  endBtn.addEventListener("click", () => pushEvent("end"));
  deleteBtn.addEventListener("click", deleteAtFrame);
  undoBtn.addEventListener("click", undo);
  loadBtn.addEventListener("click", () => void loadTask());
  saveBtn.addEventListener("click", () => void saveTask());
  tableBtn.addEventListener("click", startTableCapture);
  tableSaveBtn.addEventListener("click", () => void saveTableCalib());
  tableCancelBtn.addEventListener("click", cancelTableCapture);
  tableDeleteBtn.addEventListener("click", () => void deleteTableCalib());
  tableShowChk.addEventListener("change", drawOverlay);
  overlay.addEventListener("click", onOverlayClick);
  scrub.addEventListener("input", () => seekToFrame(Number(scrub.value) || 0));
  frameImg.addEventListener("load", drawOverlay);
  frameVideo.addEventListener("timeupdate", onVideoTimeSync);
  frameVideo.addEventListener("seeked", onVideoTimeSync);
  frameVideo.addEventListener("loadeddata", drawOverlay);
  frameVideo.addEventListener("play", () => { playing = true; playBtn.classList.toggle("active", true); });
  frameVideo.addEventListener("pause", () => { playing = false; playBtn.classList.toggle("active", false); });
  window.addEventListener("resize", drawOverlay);
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const k = e.key.toLowerCase();
    if (e.key === "Escape" && tableCapture !== null) { cancelTableCapture(); return; }
    if (k === "u" && tableCapture !== null) { undoTablePoint(); return; } // U im Aufnahme-Modus: Punkt zurück
    if (e.key === "ArrowLeft" || k === "[") { e.preventDefault(); seekToFrame(index - 1); }
    if (e.key === "ArrowRight" || k === "]") { e.preventDefault(); seekToFrame(index + 1); }
    if (k === "n") seekToFrame(index - 10);
    if (k === "m") seekToFrame(index + 10);
    if (k === "s") pushEvent("start");
    if (k === "e") pushEvent("end");
    if (k === "d") deleteAtFrame();
    if (k === "u") undo();
    if (k === "t") startTableCapture();
    if (k === "p") togglePlay();
  });

  void loadTasks();
})();
