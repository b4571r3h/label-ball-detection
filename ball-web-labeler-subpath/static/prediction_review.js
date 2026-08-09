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
  // Pose-Konstanten + CSV-Parser (identisch zu rally_label.js)
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

  function parsePointsCsv(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length === 0) return [];
    const header = lines[0].split(",");
    const colIdx = buildColumnIndex(header);
    const fi = colIdx.get("frame");
    const xi = colIdx.get("x");
    const yi = colIdx.get("y");
    const ci = colIdx.get("confidence");
    const p1PoseIdx = buildPoseColumnIndex(colIdx, "p1");
    const p2PoseIdx = buildPoseColumnIndex(colIdx, "p2");

    const rows = [];
    for (let li = 1; li < lines.length; li++) {
      const cells = lines[li].split(",");
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
  // Peak-Detection (Port von spinevo predict.py: find_peaks + Start/Ende-Paarung)
  // ---------------------------------------------------------------------
  function findPeaks(arr, height, distance) {
    const cand = [];
    for (let i = 1; i < arr.length - 1; i++) {
      if (arr[i] >= height && arr[i] >= arr[i - 1] && arr[i] > arr[i + 1]) cand.push(i);
    }
    const byHeight = cand.slice().sort((a, b) => arr[b] - arr[a]);
    const kept = [];
    for (const p of byHeight) {
      if (kept.every((k) => Math.abs(k - p) >= distance)) kept.push(p);
    }
    return kept.sort((a, b) => a - b);
  }

  // ---------------------------------------------------------------------
  // Rally-State-Post-Processing (Port von spinevo predict_rally_state.py)
  // ---------------------------------------------------------------------
  function boxSmooth1d(x, window) {
    if (window <= 1) return x.slice();
    const w = window % 2 === 0 ? window + 1 : window;
    const pad = Math.floor(w / 2);
    const padded = [];
    for (let i = 0; i < pad; i++) padded.push(x[0] ?? 0);
    padded.push(...x);
    for (let i = 0; i < pad; i++) padded.push(x[x.length - 1] ?? 0);
    const out = [];
    for (let i = 0; i < x.length; i++) {
      let s = 0;
      for (let k = 0; k < w; k++) s += padded[i + k];
      out.push(s / w);
    }
    return out;
  }

  function hysteresisMask(prob, thrHigh, thrLow) {
    let state = 0;
    return prob.map((p) => {
      if (state === 0) { if (p >= thrHigh) state = 1; }
      else if (p <= thrLow) state = 0;
      return state;
    });
  }

  function removeShortRuns(binary, minLen, value) {
    if (minLen <= 1) return binary.slice();
    const b = binary.slice();
    let i = 0;
    while (i < b.length) {
      if (b[i] !== value) { i += 1; continue; }
      let j = i;
      while (j < b.length && b[j] === value) j += 1;
      if (j - i < minLen) for (let k = i; k < j; k++) b[k] = 1 - value;
      i = j;
    }
    return b;
  }

  function ralliesFromStateCurve(probRaw, smooth, thr, hysteresis, minRally, minGap) {
    const probS = boxSmooth1d(probRaw, Math.max(1, smooth));
    let binary;
    if (hysteresis > 0) {
      const half = hysteresis / 2;
      binary = hysteresisMask(probS, Math.min(1, thr + half), Math.max(0, thr - half));
    } else {
      binary = probS.map((p) => (p >= thr ? 1 : 0));
    }
    if (minRally > 1) binary = removeShortRuns(binary, minRally, 1);
    if (minGap > 1) binary = removeShortRuns(binary, minGap, 0);

    const rallies = [];
    let i = 0;
    while (i < binary.length) {
      while (i < binary.length && !binary[i]) i++;
      if (i >= binary.length) break;
      const s = i;
      while (i < binary.length && binary[i]) i++;
      const e = i - 1;
      rallies.push({
        start_frame: s, end_frame: e,
        start_conf: probS[s], end_conf: probS[e],
      });
    }
    return { rallies, probSmooth: probS };
  }

  function ralliesFromCurves(probStart, probEnd, thr, minGap) {
    const starts = findPeaks(probStart, thr, minGap);
    const ends = findPeaks(probEnd, thr, minGap);
    const usedEnds = new Set();
    const rallies = [];
    for (const s of starts) {
      let e = null;
      for (const c of ends) {
        if (c > s && !usedEnds.has(c)) { e = c; break; }
      }
      if (e != null) usedEnds.add(e);
      rallies.push({
        start_frame: s,
        end_frame: e,
        start_conf: probStart[s],
        end_conf: e != null ? probEnd[e] : null,
      });
    }
    return rallies;
  }

  // ---------------------------------------------------------------------
  // DOM / State
  // ---------------------------------------------------------------------
  const taskSelect = document.getElementById("taskSelect");
  const loadBtn = document.getElementById("loadBtn");
  const statusEl = document.getElementById("status");
  const frameInfo = document.getElementById("frameInfo");
  const prevBtn = document.getElementById("prevBtn");
  const nextBtn = document.getElementById("nextBtn");
  const playBtn = document.getElementById("playBtn");
  const scrub = document.getElementById("scrub");
  const stripsContainer = document.getElementById("stripsContainer");
  const setSelect = document.getElementById("setSelect");
  const setLabel = document.getElementById("setLabel");
  const frameImg = document.getElementById("frameImg");
  const frameVideo = document.getElementById("frameVideo");
  const mediaWrap = document.getElementById("mediaWrap");
  const mediaNote = document.getElementById("mediaNote");
  const overlay = document.getElementById("overlay");
  const ctx = overlay.getContext("2d");
  const curveCanvas = document.getElementById("curveCanvas");
  const curveLegend = document.getElementById("curveLegend");
  const thrInput = document.getElementById("thrInput");
  const gapInput = document.getElementById("gapInput");
  const hystInput = document.getElementById("hystInput");
  const smoothInput = document.getElementById("smoothInput");
  const minRallyInput = document.getElementById("minRallyInput");
  const hystLabel = document.getElementById("hystLabel");
  const smoothLabel = document.getElementById("smoothLabel");
  const minRallyLabel = document.getElementById("minRallyLabel");
  const applyBtn = document.getElementById("applyBtn");
  const resetBtn = document.getElementById("resetBtn");
  const matchInfo = document.getElementById("matchInfo");
  const rallyRows = document.getElementById("rallyRows");

  let taskId = "";
  let mode = "video";
  let hasMedia = false;     // Task hat Video bzw. Frames (sonst nur Kurven/Spuren)
  let sets = [];            // alle Prediction-Sets: [{tag, pred}]
  let activeSet = 0;        // Index des Sets, auf das sich Controls/Tabelle beziehen
  let pred = null;          // predictions-JSON des aktiven Sets
  let rallies = [];         // aktuell angezeigte Rallies (Upload-Stand oder neu berechnet)
  let rows = [];            // points.csv
  let frameFilenames = [];  // frames-Modus
  let gtSegments = [];      // Ground-Truth [start,end]-Frames
  let index = 0;
  let playing = false;
  let videoDuration = 0;
  let framesPlayTimer = null;
  let suppressVideoSeek = false;
  let stopAtTime = null;    // Segment-Playback: bei dieser Zeit pausieren
  let playingRow = -1;

  function totalFrames() {
    if (rows.length > 0) return rows.length;
    if (pred && Number.isFinite(pred.num_frames)) return pred.num_frames;
    return frameFilenames.length;
  }

  function fps() {
    if (pred && Number.isFinite(pred.fps) && pred.fps > 0) return pred.fps;
    const n = totalFrames();
    if (mode === "video" && videoDuration > 0 && n > 1) return (n - 1) / videoDuration;
    return 30;
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

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "-";
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, "0")}`;
  }

  function frameSec(f) {
    return f / fps();
  }

  // ---------------------------------------------------------------------
  // Overlay (Port von rally_label.js)
  // ---------------------------------------------------------------------
  function currentMediaEl() {
    return mode === "video" ? frameVideo : frameImg;
  }

  function sourceSize() {
    if (mode === "video") return { w: frameVideo.videoWidth || 1, h: frameVideo.videoHeight || 1 };
    return { w: frameImg.naturalWidth || 1, h: frameImg.naturalHeight || 1 };
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

  function drawOverlay() {
    const media = currentMediaEl();
    overlay.width = media.clientWidth || 1;
    overlay.height = media.clientHeight || 1;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (rows.length === 0) return;

    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!row) return;
    const { w: sw, h: sh } = sourceSize();
    const scale = Math.min(overlay.width / sw, overlay.height / sh);
    const ox = (overlay.width - sw * scale) / 2;
    const oy = (overlay.height - sh * scale) / 2;
    const project = (x, y) => ({ x: ox + x * scale, y: oy + y * scale });

    // Ball-Trail: letzte 12 Frames als verblassende Spur
    for (let k = 12; k >= 1; k--) {
      const r = rows[index - k];
      if (!r || r.x == null || r.y == null) continue;
      const p = project(r.x, r.y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,200,50,${0.08 + 0.5 * (1 - k / 12)})`;
      ctx.fill();
    }

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

    for (const [box, color] of [[row.p1Box, "rgba(34,197,94,0.7)"], [row.p2Box, "rgba(239,68,68,0.7)"]]) {
      if (!box) continue;
      const a = project(box.x1, box.y1);
      const b = project(box.x2, box.y2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    }

    for (const [pose, color] of [[row.p1Pose, "rgba(34,197,94,0.95)"], [row.p2Pose, "rgba(239,68,68,0.95)"]]) {
      if (!pose || Object.keys(pose).length === 0) continue;
      const projected = {};
      for (const [lm, pt] of Object.entries(pose)) projected[lm] = project(pt.x, pt.y);
      drawSkeleton(pose, projected, color);
    }
  }

  // ---------------------------------------------------------------------
  // Timeline-Strips (ein Strip pro Prediction-Set + Ground Truth)
  // ---------------------------------------------------------------------
  const SET_COLORS = ["34,211,238", "168,85,247", "249,115,22", "250,204,21", "244,114,182"];
  const GT_COLOR = "34,197,94";

  function setColor(i) {
    return SET_COLORS[i % SET_COLORS.length];
  }

  function pct(frame) {
    const n = totalFrames();
    if (n <= 1) return 0;
    return (frame / (n - 1)) * 100;
  }

  function renderStrip(el, segments, rgb) {
    el.innerHTML = "";
    for (const [s, e] of segments) {
      const seg = document.createElement("div");
      seg.className = "seg";
      seg.style.background = `rgba(${rgb},0.55)`;
      const left = pct(s);
      const right = pct(e != null ? e : Math.min(totalFrames() - 1, s + 1));
      seg.style.left = `${left}%`;
      seg.style.width = `${Math.max(0.4, right - left)}%`;
      el.appendChild(seg);
    }
    const cur = document.createElement("div");
    cur.className = "cur";
    cur.style.left = `${pct(index)}%`;
    el.appendChild(cur);
  }

  function predSegments() {
    return rallies.map((r) => [r.start_frame, r.end_frame]);
  }

  function setSegments(i) {
    if (i === activeSet) return predSegments();
    return ((sets[i] && sets[i].pred.rallies) || []).map((r) => [r.start_frame, r.end_frame]);
  }

  function renderStrips() {
    stripsContainer.innerHTML = "";
    const mkRow = (labelText, rgb, segments) => {
      const row = document.createElement("div");
      row.className = "row";
      row.style.gap = "0";
      row.style.marginBottom = "4px";
      const lab = document.createElement("div");
      lab.className = "stripLabel";
      lab.textContent = labelText;
      lab.title = labelText;
      lab.style.color = `rgb(${rgb})`;
      const strip = document.createElement("div");
      strip.className = "strip";
      row.appendChild(lab);
      row.appendChild(strip);
      stripsContainer.appendChild(row);
      renderStrip(strip, segments, rgb);
      strip.addEventListener("click", (e) => stripSeek(strip, e));
    };
    sets.forEach((s, i) => {
      const mark = sets.length > 1 && i === activeSet ? " ●" : "";
      mkRow(`${s.tag}${mark}`, setColor(i), setSegments(i));
    });
    if (gtSegments.length > 0) mkRow("GT", GT_COLOR, gtSegments);
  }

  function stripSeek(el, ev) {
    const rect = el.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    seekToFrame(Math.round(frac * (totalFrames() - 1)));
  }

  // ---------------------------------------------------------------------
  // Kurven-Canvas: prob_start / prob_end + Threshold-Linie + Rally-Streifen
  // ---------------------------------------------------------------------
  function isStateModel() {
    return !!(pred && Array.isArray(pred.prob_in_rally));
  }

  function drawCurves() {
    const c = curveCanvas.getContext("2d");
    const stateMode = isStateModel();
    const ps = stateMode
      ? pred.prob_in_rally
      : (pred && Array.isArray(pred.prob_start) ? pred.prob_start : null);
    const pe = stateMode ? null : (pred && Array.isArray(pred.prob_end) ? pred.prob_end : null);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = curveCanvas.getBoundingClientRect();
    const cssW = Math.max(280, rect.width || 640);
    const cssH = 200;
    curveCanvas.width = Math.floor(cssW * dpr);
    curveCanvas.height = Math.floor(cssH * dpr);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = "#0b1120";
    c.fillRect(0, 0, cssW, cssH);
    if (!ps && !pe) {
      c.fillStyle = "#94a3b8";
      c.font = "13px system-ui,sans-serif";
      c.fillText("Keine prob_start/prob_end-Kurven im Upload enthalten.", 12, 24);
      return;
    }

    const n = Math.max(ps ? ps.length : 0, pe ? pe.length : 0);
    const padL = 30, padR = 8, padT = 8, padB = 26;
    const plotW = cssW - padL - padR;
    const plotH = cssH - padT - padB;
    const xAt = (i) => padL + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
    const yAt = (p) => padT + (1 - Math.max(0, Math.min(1, p))) * plotH;

    // Rally-Streifen unten
    for (const [s, e] of predSegments()) {
      const x0 = xAt(s);
      const x1 = xAt(e != null ? e : s + 1);
      c.fillStyle = "rgba(34,211,238,0.18)";
      c.fillRect(x0, padT, Math.max(1, x1 - x0), plotH);
    }

    // Achsen + Threshold (im Rally-State-Modus als Hysterese-Band)
    c.strokeStyle = "#334155";
    c.lineWidth = 1;
    c.strokeRect(padL, padT, plotW, plotH);
    const thr = Number(thrInput.value) || 0;
    const hyst = stateMode ? (Number(hystInput.value) || 0) : 0;
    c.strokeStyle = "rgba(255,255,255,0.35)";
    c.setLineDash([4, 4]);
    for (const t of hyst > 0 ? [thr + hyst / 2, thr - hyst / 2] : [thr]) {
      c.beginPath();
      c.moveTo(padL, yAt(t));
      c.lineTo(padL + plotW, yAt(t));
      c.stroke();
    }
    c.setLineDash([]);

    const drawLine = (arr, color, width = 1.5) => {
      if (!arr) return;
      c.strokeStyle = color;
      c.lineWidth = width;
      c.beginPath();
      for (let i = 0; i < arr.length; i++) {
        const x = xAt(i), y = yAt(arr[i]);
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
    };
    // Nicht-aktive Sets: Kurve dünn in Set-Farbe (Vergleich auf einen Blick)
    sets.forEach((s, i) => {
      if (i === activeSet) return;
      const arr = Array.isArray(s.pred.prob_in_rally) ? s.pred.prob_in_rally : s.pred.prob_start;
      if (Array.isArray(arr)) drawLine(arr, `rgba(${setColor(i)},0.55)`, 1);
    });
    const ac = setColor(activeSet);
    if (stateMode) {
      // Roh dünn + geglättet fett
      drawLine(ps, `rgba(${ac},0.35)`, 1);
      drawLine(boxSmooth1d(ps, Math.max(1, Number(smoothInput.value) || 1)), `rgba(${ac},0.95)`, 2);
    } else {
      drawLine(ps, `rgba(${ac},0.9)`);
      drawLine(pe, "rgba(249,115,22,0.9)");
    }

    // aktuelle Position
    c.strokeStyle = "#fff";
    c.beginPath();
    c.moveTo(xAt(index), padT);
    c.lineTo(xAt(index), padT + plotH);
    c.stroke();

    c.fillStyle = "#64748b";
    c.font = "11px system-ui,sans-serif";
    c.fillText("1", 12, yAt(1) + 4);
    c.fillText("0", 12, yAt(0) + 4);
  }

  function curveSeek(ev) {
    const n = totalFrames();
    if (n < 2) return;
    const rect = curveCanvas.getBoundingClientRect();
    const padL = 30, padR = 8;
    const frac = (ev.clientX - rect.left - padL) / Math.max(1, rect.width - padL - padR);
    seekToFrame(Math.round(Math.max(0, Math.min(1, frac)) * (n - 1)));
  }

  // ---------------------------------------------------------------------
  // Rally-Liste + Segment-Playback
  // ---------------------------------------------------------------------
  function renderRallyList() {
    rallyRows.innerHTML = "";
    rallies.forEach((r, i) => {
      const tr = document.createElement("tr");
      if (i === playingRow) tr.classList.add("playing");
      const dur = r.end_frame != null ? frameSec(r.end_frame) - frameSec(r.start_frame) : null;
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td>${formatTime(frameSec(r.start_frame))} <span class="muted">(F${r.start_frame})</span></td>
        <td>${r.end_frame != null ? `${formatTime(frameSec(r.end_frame))} <span class="muted">(F${r.end_frame})</span>` : "–"}</td>
        <td>${dur != null ? dur.toFixed(2) + "s" : "–"}</td>
        <td>${r.start_conf != null ? Number(r.start_conf).toFixed(2) : "–"}</td>
        <td>${r.end_conf != null ? Number(r.end_conf).toFixed(2) : "–"}</td>`;
      tr.addEventListener("click", () => playSegment(i));
      rallyRows.appendChild(tr);
    });
  }

  function playSegment(i) {
    const r = rallies[i];
    if (!r) return;
    playingRow = i;
    renderRallyList();
    seekToFrame(r.start_frame);
    if (mode === "video" && videoDuration > 0) {
      stopAtTime = r.end_frame != null
        ? timeForFrameIndex(r.end_frame, videoDuration, totalFrames())
        : null;
      void frameVideo.play();
    }
  }

  // ---------------------------------------------------------------------
  // GT-Vergleich
  // ---------------------------------------------------------------------
  function segmentsFromEvents(events) {
    const sorted = events
      .filter((e) => Number.isInteger(e.frame) && (e.kind === "start" || e.kind === "end"))
      .sort((a, b) => a.frame - b.frame);
    const segs = [];
    let pending = null;
    for (const e of sorted) {
      if (e.kind === "start") pending = e.frame;
      else if (pending != null) { segs.push([pending, e.frame]); pending = null; }
    }
    if (pending != null) segs.push([pending, null]);
    return segs;
  }

  function meanStartDelta(rallyList) {
    const diffs = gtSegments.map(([gs]) => {
      let best = null;
      for (const r of rallyList) {
        const d = Math.abs(r.start_frame - gs);
        if (best == null || d < best) best = d;
      }
      return best;
    }).filter((d) => d != null);
    return diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : NaN;
  }

  function renderMatchInfo() {
    if (gtSegments.length === 0 && sets.length <= 1) {
      matchInfo.textContent = pred && pred.model
        ? `Modell: ${JSON.stringify(pred.model)}`
        : "";
      return;
    }
    const f = fps();
    const parts = [];
    if (gtSegments.length > 0) parts.push(`Ground Truth: ${gtSegments.length} Ballwechsel`);
    sets.forEach((s, i) => {
      const rl = i === activeSet ? rallies : (s.pred.rallies || []);
      let txt = `${s.tag}: ${rl.length}`;
      if (gtSegments.length > 0) {
        const mean = meanStartDelta(rl);
        if (Number.isFinite(mean)) txt += ` (|Δ Start| ${(mean / f).toFixed(2)}s)`;
      }
      parts.push(txt);
    });
    matchInfo.textContent = parts.join(" · ");
  }

  // ---------------------------------------------------------------------
  // Navigation / Rendering
  // ---------------------------------------------------------------------
  function renderFrame() {
    const n = totalFrames();
    if (n === 0) return;
    if (mode === "frames") {
      const fname = frameFilenames[index];
      if (fname) frameImg.src = API(`/api/task/${encodeURIComponent(taskId)}/frame/${encodeURIComponent(fname)}`);
      frameInfo.textContent = `Frame ${index + 1}/${n} · ${formatTime(frameSec(index))}`;
    } else {
      frameInfo.textContent = `Frame ${index + 1}/${n} · ${formatTime(frameSec(index))}`;
    }
    scrub.max = String(Math.max(0, n - 1));
    scrub.value = String(index);
    renderStrips();
    drawOverlay();
    drawCurves();
  }

  function clampFrame(f) {
    return Math.max(0, Math.min(totalFrames() - 1, f));
  }

  function seekToFrame(f) {
    if (totalFrames() === 0) return;
    index = clampFrame(f);
    stopAtTime = null;
    if (mode === "video" && videoDuration > 0) {
      suppressVideoSeek = true;
      frameVideo.pause();
      frameVideo.currentTime = timeForFrameIndex(index, videoDuration, totalFrames());
    }
    renderFrame();
  }

  function onVideoTimeSync() {
    if (mode !== "video" || !(videoDuration > 0)) return;
    if (suppressVideoSeek) { suppressVideoSeek = false; return; }
    if (stopAtTime != null && frameVideo.currentTime >= stopAtTime) {
      frameVideo.pause();
      stopAtTime = null;
      playingRow = -1;
      renderRallyList();
    }
    index = clampFrame(frameIndexFromTime(frameVideo.currentTime, videoDuration, totalFrames()));
    renderFrame();
  }

  function stopFramesPlayTimer() {
    if (framesPlayTimer) { clearInterval(framesPlayTimer); framesPlayTimer = null; }
  }

  function togglePlay() {
    if (totalFrames() === 0) return;
    if (mode === "video") {
      if (frameVideo.paused) void frameVideo.play(); else frameVideo.pause();
      return;
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
      }, Math.round(1000 / fps()));
    }
  }

  // ---------------------------------------------------------------------
  // Laden
  // ---------------------------------------------------------------------
  async function loadTasks() {
    try {
      const data = await jfetch(API("/api/predictions/tasks"));
      taskSelect.innerHTML = `<option value="">(Task wählen)</option>`;
      for (const t of data.tasks || []) {
        const o = document.createElement("option");
        o.value = t.task_id;
        const src = t.source_video ? ` · ${t.source_video}` : "";
        const gt = t.has_rally_labels ? " · GT vorhanden" : "";
        const ns = Array.isArray(t.sets) && t.sets.length > 1 ? ` · ${t.sets.length} Sets` : "";
        o.textContent = `${t.task_id}${src} (${t.n_rallies} Rallies${gt}${ns})`;
        taskSelect.appendChild(o);
      }
      if ((data.tasks || []).length === 0) setStatus("Noch keine Prediction-Uploads vorhanden.");
    } catch (e) {
      setStatus(String(e), true);
    }
  }

  function applyActiveSet() {
    pred = sets[activeSet].pred;
    rallies = (pred.rallies || []).slice();
    thrInput.value = String((pred.model && pred.model.threshold) || 0.35);
    gapInput.value = String((pred.model && pred.model.min_gap_frames) || 15);

    // Rally-State-Modus: eigene Post-Processing-Controls + Legende
    const stateMode = isStateModel();
    const pp = (pred.model && pred.model.postprocess) || {};
    hystLabel.style.display = stateMode ? "" : "none";
    smoothLabel.style.display = stateMode ? "" : "none";
    minRallyLabel.style.display = stateMode ? "" : "none";
    if (stateMode) {
      smoothInput.value = String(pp.smooth_frames ?? 7);
      hystInput.value = String(pp.hysteresis ?? 0.12);
      minRallyInput.value = String(pp.min_rally_frames ?? 6);
      gapInput.value = String(pp.min_gap_frames ?? 5);
      if (pp.thr_center != null) thrInput.value = String(pp.thr_center);
      else if (pp.threshold != null) thrInput.value = String(pp.threshold);
      curveLegend.textContent = "(P(in Rally): dünn = roh, fett = geglättet; gestrichelt = Hysterese-Band)";
    } else {
      curveLegend.textContent = "(cyan = Start, orange = Ende)";
    }
  }

  async function loadTask() {
    taskId = taskSelect.value;
    if (!taskId) return;
    setStatus("Lade Task...");
    try {
      const tl = await jfetch(API(`/api/predictions/tasks`));
      const meta = (tl.tasks || []).find((t) => t.task_id === taskId);

      // Alle Prediction-Sets laden (klassische predictions.json = "default")
      const setInfos = meta && Array.isArray(meta.sets) && meta.sets.length
        ? meta.sets
        : [{ tag: "default" }];
      sets = [];
      for (const si of setInfos) {
        const q = si.tag && si.tag !== "default" ? `?set=${encodeURIComponent(si.tag)}` : "";
        try {
          const p = await jfetch(API(`/api/predictions/task/${encodeURIComponent(taskId)}${q}`));
          sets.push({ tag: si.tag || "default", pred: p });
        } catch (_) { /* Set nicht ladbar → überspringen */ }
      }
      if (sets.length === 0) throw new Error("Keine Prediction-Sets ladbar.");

      // Aktiv = zuletzt hochgeladenes Set
      activeSet = 0;
      for (let i = 1; i < sets.length; i++) {
        if ((sets[i].pred.uploaded_at || "") > (sets[activeSet].pred.uploaded_at || "")) activeSet = i;
      }
      setLabel.style.display = sets.length > 1 ? "" : "none";
      setSelect.innerHTML = "";
      sets.forEach((s, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        const ck = s.pred.model && s.pred.model.tcn_checkpoint ? ` · ${s.pred.model.tcn_checkpoint}` : "";
        o.textContent = `${s.tag}${ck}`;
        setSelect.appendChild(o);
      });
      setSelect.value = String(activeSet);

      applyActiveSet();
      mode = (meta && meta.mode) || "video";

      // Media ist optional: manche Tasks (z. B. reine Prediction-Uploads auf
      // Export-CSVs) haben weder Frames noch Video – dann nur Kurven/Spuren.
      videoDuration = 0;
      frameFilenames = [];
      hasMedia = false;
      if (mode === "video") {
        try {
          await new Promise((resolve, reject) => {
            frameVideo.onloadedmetadata = () => { videoDuration = frameVideo.duration || 0; resolve(); };
            frameVideo.onerror = () => reject(new Error("Video konnte nicht geladen werden."));
            frameVideo.src = API(`/api/rally/task/${encodeURIComponent(taskId)}/video`);
          });
          hasMedia = videoDuration > 0;
        } catch (_) { /* ohne Video weiter */ }
      } else {
        try {
          const p = await jfetch(API(`/api/rally/task/${encodeURIComponent(taskId)}/points`));
          frameFilenames = (p.rows || []).map((r) => r.filename);
          hasMedia = frameFilenames.length > 0;
        } catch (_) { /* ohne Frames weiter */ }
      }
      frameVideo.style.display = hasMedia && mode === "video" ? "block" : "none";
      frameImg.style.display = hasMedia && mode !== "video" ? "block" : "none";
      mediaWrap.style.display = hasMedia ? "" : "none";
      mediaNote.style.display = hasMedia ? "none" : "";

      rows = [];
      try {
        const csvText = await jfetch(API(`/api/rally/task/${encodeURIComponent(taskId)}/points.csv`));
        rows = parsePointsCsv(csvText);
      } catch (_) { /* kein Overlay ohne points.csv */ }

      gtSegments = [];
      try {
        const l = await jfetch(API(`/api/rally/task/${encodeURIComponent(taskId)}/labels`));
        if (l && l.exists) gtSegments = segmentsFromEvents(l.events || []);
      } catch (_) {}

      playingRow = -1;
      renderRallyList();
      renderMatchInfo();
      seekToFrame(0);
      setStatus(`Geladen: ${totalFrames()} Frames, ${rallies.length} Rallies (Modus: ${mode}${hasMedia ? "" : ", ohne Video/Frames"})`);
    } catch (e) {
      setStatus(String(e), true);
    }
  }

  function recomputeFromCurves() {
    const thr = Number(thrInput.value) || 0.35;
    const gap = Math.max(1, Math.round(Number(gapInput.value) || 15));
    if (isStateModel()) {
      const smooth = Math.max(1, Math.round(Number(smoothInput.value) || 7));
      const hyst = Math.max(0, Number(hystInput.value) || 0);
      const minRally = Math.max(1, Math.round(Number(minRallyInput.value) || 6));
      rallies = ralliesFromStateCurve(pred.prob_in_rally, smooth, thr, hyst, minRally, gap).rallies;
      setStatus(`Neu berechnet: ${rallies.length} Rallies (thr=${thr}, hyst=${hyst}, glättung=${smooth})`);
    } else if (pred && Array.isArray(pred.prob_start) && Array.isArray(pred.prob_end)) {
      rallies = ralliesFromCurves(pred.prob_start, pred.prob_end, thr, gap);
      setStatus(`Neu berechnet: ${rallies.length} Rallies (thr=${thr}, min_gap=${gap})`);
    } else {
      setStatus("Keine Kurven im Upload – Neuberechnung nicht möglich.", true);
      return;
    }
    playingRow = -1;
    renderRallyList();
    renderMatchInfo();
    renderFrame();
  }

  function resetToUpload() {
    if (!pred) return;
    rallies = (pred.rallies || []).slice();
    playingRow = -1;
    renderRallyList();
    renderMatchInfo();
    renderFrame();
    setStatus(`Upload-Stand: ${rallies.length} Rallies`);
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  prevBtn.addEventListener("click", () => seekToFrame(index - 1));
  nextBtn.addEventListener("click", () => seekToFrame(index + 1));
  playBtn.addEventListener("click", togglePlay);
  loadBtn.addEventListener("click", () => void loadTask());
  applyBtn.addEventListener("click", recomputeFromCurves);
  resetBtn.addEventListener("click", resetToUpload);
  scrub.addEventListener("input", () => seekToFrame(Number(scrub.value) || 0));
  setSelect.addEventListener("change", () => {
    if (sets.length === 0) return;
    activeSet = Math.max(0, Math.min(sets.length - 1, Number(setSelect.value) || 0));
    applyActiveSet();
    playingRow = -1;
    renderRallyList();
    renderMatchInfo();
    renderFrame();
  });
  curveCanvas.addEventListener("click", curveSeek);
  frameImg.addEventListener("load", drawOverlay);
  frameVideo.addEventListener("timeupdate", onVideoTimeSync);
  frameVideo.addEventListener("seeked", onVideoTimeSync);
  frameVideo.addEventListener("loadeddata", drawOverlay);
  frameVideo.addEventListener("play", () => { playing = true; playBtn.classList.toggle("active", true); });
  frameVideo.addEventListener("pause", () => { playing = false; playBtn.classList.toggle("active", false); });
  window.addEventListener("resize", () => { drawOverlay(); drawCurves(); });
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const k = e.key.toLowerCase();
    if (e.key === "ArrowLeft" || k === "[") { e.preventDefault(); seekToFrame(index - 1); }
    if (e.key === "ArrowRight" || k === "]") { e.preventDefault(); seekToFrame(index + 1); }
    if (k === "n") seekToFrame(index - 10);
    if (k === "m") seekToFrame(index + 10);
    if (k === "p") togglePlay();
  });

  void loadTasks();
})();
