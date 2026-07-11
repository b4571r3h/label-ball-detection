(() => {
  // ---- Root detection (gleich wie rally_label.js) ----
  function detectRoot() {
    if ((window.location.hostname || "") === "balls.spinevo.app") return "";
    const p = window.location.pathname || "/";
    if (p.startsWith("/ball-detection")) return "/ball-detection";
    return "";
  }
  const ROOT = detectRoot();
  const API = (path) => `${ROOT}${path.startsWith("/") ? path : "/" + path}`;
  const VARIANT = "v2";

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const taskSelect = $("taskSelect");
  const statusEl = $("status");
  const taskPill = $("taskPill");
  const frameInfo = $("frameInfo");
  const frameImg = $("frameImg");
  const overlay = $("overlay");
  const ctx = overlay.getContext("2d");
  const scrub = $("scrub");
  const diffList = $("diffList");
  const commentEl = $("comment");

  // ---- Zustand ----
  let taskId = "";
  let filenames = [];        // sortierte Frame-Dateinamen
  let rowsOld = [];          // pro Frame: {p1:{box,pose}, p2:{...}} aus points.csv
  let rowsNew = [];          // dito aus points.csv?variant=v2
  let diffs = [];            // [{frame, d}] absteigend nach Abweichung
  let index = 0;
  let playing = false;
  let playTimer = null;
  let verdict = null;
  let promoted = false;

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

  // ---- CSV-Parsing (Schema frame,x,y,confidence,p1_*,p2_*,p{1,2}_lm<idx>_{x,y}) ----
  const LM_IDS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
  const BONES = [[11,12],[11,13],[13,15],[12,14],[14,16],[23,24],[11,23],[12,24],[23,25],[25,27],[24,26],[26,28]];

  function parsePoints(text) {
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    if (lines.length < 1) return [];
    const header = lines[0].split(",");
    const col = {};
    header.forEach((h, i) => { col[h.trim()] = i; });
    const num = (cells, name) => {
      const i = col[name];
      if (i === undefined) return null;
      const v = parseFloat(cells[i]);
      return Number.isFinite(v) ? v : null;
    };
    const out = [];
    for (const line of lines.slice(1)) {
      const cells = line.split(",");
      const row = {};
      for (const px of ["p1", "p2"]) {
        const box = ["x1", "y1", "x2", "y2"].map((s) => num(cells, `${px}_${s}`));
        const pose = {};
        for (const lm of LM_IDS) {
          const x = num(cells, `${px}_lm${lm}_x`);
          const y = num(cells, `${px}_lm${lm}_y`);
          if (x != null && y != null) pose[lm] = { x, y };
        }
        row[px] = {
          box: box.every((v) => v != null) ? box : null,
          pose,
        };
      }
      out.push(row);
    }
    return out;
  }

  // ---- Abweichung pro Frame: max. Hüft-/Box-Distanz ALT↔NEU über p1/p2 ----
  function hip(entry) {
    if (!entry) return null;
    const a = entry.pose[23], b = entry.pose[24];
    if (a && b) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (entry.box) return { x: (entry.box[0] + entry.box[2]) / 2, y: (entry.box[1] + entry.box[3]) / 2 };
    return null;
  }

  function frameDiff(i) {
    let d = 0;
    for (const px of ["p1", "p2"]) {
      const ho = hip(rowsOld[i] && rowsOld[i][px]);
      const hn = hip(rowsNew[i] && rowsNew[i][px]);
      if (ho && hn) d = Math.max(d, Math.hypot(ho.x - hn.x, ho.y - hn.y));
      else if (!!ho !== !!hn) d = Math.max(d, 40); // einer fehlt → sichtbare Abweichung
    }
    return d;
  }

  function computeDiffs() {
    const n = Math.min(rowsOld.length, rowsNew.length) || Math.max(rowsOld.length, rowsNew.length);
    diffs = [];
    for (let i = 0; i < n; i++) diffs.push({ frame: i, d: frameDiff(i) });
    diffs.sort((a, b) => b.d - a.d);
    diffList.innerHTML = "";
    for (const { frame, d } of diffs.slice(0, 12)) {
      if (d <= 0) break;
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = `#${frame} (${Math.round(d)}px)`;
      b.addEventListener("click", () => seek(frame));
      diffList.appendChild(b);
    }
    if (!diffList.children.length) diffList.innerHTML = '<span class="muted">keine</span>';
  }

  // ---- Zeichnen ----
  function project() {
    const sw = frameImg.naturalWidth || 1;
    const sh = frameImg.naturalHeight || 1;
    overlay.width = frameImg.clientWidth || 1;
    overlay.height = frameImg.clientHeight || 1;
    const scale = Math.min(overlay.width / sw, overlay.height / sh);
    const ox = (overlay.width - sw * scale) / 2;
    const oy = (overlay.height - sh * scale) / 2;
    return (x, y) => ({ x: ox + x * scale, y: oy + y * scale });
  }

  function drawEntry(entry, proj, color) {
    if (!entry) return;
    if (entry.box) {
      const a = proj(entry.box[0], entry.box[1]);
      const b = proj(entry.box[2], entry.box[3]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (const [s, e] of BONES) {
      const ps = entry.pose[s], pe = entry.pose[e];
      if (!ps || !pe) continue;
      const a = proj(ps.x, ps.y), b = proj(pe.x, pe.y);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.fillStyle = color;
    for (const lm of Object.values(entry.pose)) {
      const p = proj(lm.x, lm.y);
      ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  function draw() {
    const proj = project();
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if ($("showOld").checked && rowsOld[index]) {
      drawEntry(rowsOld[index].p1, proj, "rgba(248,113,113,0.95)");
      drawEntry(rowsOld[index].p2, proj, "rgba(248,113,113,0.75)");
    }
    if ($("showNew").checked && rowsNew[index]) {
      drawEntry(rowsNew[index].p1, proj, "rgba(74,222,128,0.95)");
      drawEntry(rowsNew[index].p2, proj, "rgba(74,222,128,0.75)");
    }
  }

  function render() {
    if (!filenames.length) return;
    frameImg.src = API(`/api/task/${encodeURIComponent(taskId)}/frame/${encodeURIComponent(filenames[index])}`);
    const d = Math.round(frameDiff(index));
    frameInfo.textContent = `Frame ${index + 1}/${filenames.length} · ${filenames[index]} · Abweichung ${d}px`;
    scrub.max = String(Math.max(0, filenames.length - 1));
    scrub.value = String(index);
    // draw() läuft über frameImg.onload
  }

  function seek(i) {
    index = Math.max(0, Math.min(filenames.length - 1, i));
    render();
  }

  function nextDiff() {
    if (!diffs.length) return;
    // nächste Abweichung NACH dem aktuellen Frame (nach Frame-Nummer sortierte Top-Diffs)
    const top = diffs.filter((x) => x.d > 20).map((x) => x.frame).sort((a, b) => a - b);
    if (!top.length) return;
    const nxt = top.find((f) => f > index);
    seek(nxt !== undefined ? nxt : top[0]);
  }

  function togglePlay() {
    playing = !playing;
    $("playBtn").classList.toggle("active", playing);
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    if (playing) {
      playTimer = setInterval(() => {
        if (index >= filenames.length - 1) { togglePlay(); return; }
        seek(index + 1);
      }, 120);
    }
  }

  // ---- Verdikt / Promote ----
  function setVerdict(v) {
    verdict = v;
    $("vBesser").classList.toggle("active", v === "besser");
    $("vGleich").classList.toggle("active", v === "gleich");
    $("vSchlechter").classList.toggle("active", v === "schlechter");
    $("promoteBtn").disabled = !(verdict && !promoted);
  }

  async function saveReview() {
    if (!taskId || !verdict) { setStatus("Erst ein Urteil wählen.", true); return; }
    try {
      await jfetch(API(`/api/rally/task/${encodeURIComponent(taskId)}/pose-review`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdict, comment: commentEl.value.trim(), variant: VARIANT }),
      });
      setStatus(`Urteil gespeichert: ${verdict}`);
      void loadTasks(taskId);
    } catch (e) { setStatus(String(e), true); }
  }

  async function promote() {
    if (!taskId || !verdict) return;
    if (!window.confirm(`Variante ${VARIANT} als Hauptstand übernehmen?\n(person_pose wird gesichert, rally_timeseries neu gebaut)`)) return;
    try {
      const r = await jfetch(API(`/api/rally/task/${encodeURIComponent(taskId)}/person-pose/promote?variant=${VARIANT}`), { method: "POST" });
      promoted = true;
      $("promoteBtn").disabled = true;
      setStatus(`Promoted ✓ (Backup: ${r.backup || "–"}, timeseries ${r.timeseries_rebuilt ? "neu gebaut" : "nicht gebaut"})`);
      void loadTasks(taskId);
    } catch (e) { setStatus(String(e), true); }
  }

  // ---- Laden ----
  async function loadTasks(keepSelection = "") {
    try {
      const data = await jfetch(API(`/api/pose-review/summary?variant=${VARIANT}`));
      const tasks = (data.tasks || []).filter((t) => t.frames_variant > 0 || t.promoted_at);
      taskSelect.innerHTML = `<option value="">(Task wählen)</option>`;
      for (const t of tasks) {
        const o = document.createElement("option");
        o.value = t.task_id;
        const state = t.promoted_at ? "✓ promotet" : (t.verdict ? `Urteil: ${t.verdict}` : "unbewertet");
        o.textContent = `${t.task_id} (${t.frames_variant} v2-Frames · ${state})`;
        taskSelect.appendChild(o);
      }
      if (keepSelection) taskSelect.value = keepSelection;
      const c = data.counts || {};
      setStatus(`Tasks: ${tasks.length} · besser ${c.besser || 0} · gleich ${c.gleich || 0} · schlechter ${c.schlechter || 0} · unbewertet ${c.unbewertet || 0}`);
    } catch (e) { setStatus(String(e), true); }
  }

  async function loadTask() {
    taskId = taskSelect.value;
    if (!taskId) return;
    setStatus("Lade Task …");
    try {
      const fr = await jfetch(API(`/api/task/${encodeURIComponent(taskId)}/frames`));
      filenames = (fr.frames || []).slice().sort();
      const [oldCsv, newCsv, review] = await Promise.all([
        jfetch(API(`/api/rally/task/${encodeURIComponent(taskId)}/points.csv`)),
        jfetch(API(`/api/rally/task/${encodeURIComponent(taskId)}/points.csv?variant=${VARIANT}`)),
        jfetch(API(`/api/rally/task/${encodeURIComponent(taskId)}/pose-review`)),
      ]);
      rowsOld = parsePoints(oldCsv);
      rowsNew = parsePoints(newCsv);
      promoted = Boolean(review.promoted_at);
      commentEl.value = review.comment || "";
      setVerdict(review.verdict || null);
      taskPill.textContent = promoted ? "✓ promotet" : (review.verdict ? `Urteil: ${review.verdict}` : "unbewertet");
      taskPill.className = "pill " + (promoted ? "ok" : review.verdict ? "" : "warn");
      computeDiffs();
      seek(diffs.length && diffs[0].d > 20 ? diffs[0].frame : 0);
      setStatus(`Geladen: ${filenames.length} Frames (alt: ${rowsOld.length}, neu: ${rowsNew.length} Zeilen)`);
    } catch (e) { setStatus(String(e), true); }
  }

  // ---- Wiring ----
  $("loadBtn").addEventListener("click", () => void loadTask());
  $("prevBtn").addEventListener("click", () => seek(index - 1));
  $("nextBtn").addEventListener("click", () => seek(index + 1));
  $("playBtn").addEventListener("click", togglePlay);
  $("diffBtn").addEventListener("click", nextDiff);
  $("showOld").addEventListener("change", draw);
  $("showNew").addEventListener("change", draw);
  scrub.addEventListener("input", () => seek(Number(scrub.value) || 0));
  frameImg.addEventListener("load", draw);
  window.addEventListener("resize", draw);
  $("vBesser").addEventListener("click", () => setVerdict("besser"));
  $("vGleich").addEventListener("click", () => setVerdict("gleich"));
  $("vSchlechter").addEventListener("click", () => setVerdict("schlechter"));
  $("saveReviewBtn").addEventListener("click", () => void saveReview());
  $("promoteBtn").addEventListener("click", () => void promote());
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
    const k = e.key.toLowerCase();
    if (e.key === "ArrowLeft") { e.preventDefault(); seek(index - 1); }
    if (e.key === "ArrowRight") { e.preventDefault(); seek(index + 1); }
    if (k === "n") seek(index - 10);
    if (k === "m") seek(index + 10);
    if (k === "d") nextDiff();
    if (k === "p") togglePlay();
  });

  void loadTasks();
})();
