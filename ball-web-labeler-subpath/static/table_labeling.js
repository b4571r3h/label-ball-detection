(() => {
  // ---- Root detection (gleich wie ball labeler) ----
  function detectRoot() {
    if ((window.location.hostname || "") === "balls.spinevo.app") return "";
    const p = window.location.pathname || "/";
    if (p.startsWith("/ball-detection")) return "/ball-detection";
    return "";
  }
  const ROOT = detectRoot();
  const API = (path) => `${ROOT}${path.startsWith("/") ? path : "/" + path}`;

  async function errorText(r) {
    const t = await r.text().catch(() => "");
    try { const j = JSON.parse(t); if (j.detail) return typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch (_) {}
    return t || `HTTP ${r.status}`;
  }

  // ---- Keypoint-Definitionen ----
  const KP_DEFS = [
    { name: "1", long: "Nahe linke Tischkante (unten links)",     color: "#22c55e", group: "table" },
    { name: "2", long: "Nahe rechte Tischecke (unten rechts)",    color: "#22c55e", group: "table" },
    { name: "3", long: "Entfernte rechte Tischecke (oben rechts)",color: "#22c55e", group: "table" },
    { name: "4", long: "Entfernte linke Tischecke (oben links)",  color: "#22c55e", group: "table" },
    { name: "Netz L", long: "Netz Links",  color: "#22d3ee", group: "net"   },
    { name: "Netz R", long: "Netz Rechts", color: "#22d3ee", group: "net"   },
  ];

  // ---- DOM ----
  const taskSelect  = document.getElementById("taskSelect");
  const taskStats   = document.getElementById("taskStats");
  const sLabeled    = document.getElementById("sLabeled");
  const sNoTable    = document.getElementById("sNoTable");
  const sNone       = document.getElementById("sNone");
  const sTotal      = document.getElementById("sTotal");
  const reviewCard  = document.getElementById("reviewCard");
  const navInfo     = document.getElementById("navInfo");
  const btnPrev     = document.getElementById("btnPrev");
  const btnNext     = document.getElementById("btnNext");
  const btnRandom   = document.getElementById("btnRandom");
  const jumpInput   = document.getElementById("jumpInput");
  const btnJump     = document.getElementById("btnJump");
  const imgContainer = document.getElementById("imgContainer");
  const frameImg    = document.getElementById("frameImg");
  const kpCanvas    = document.getElementById("kpCanvas");
  const ctx         = kpCanvas.getContext("2d");
  const kpListTable = document.getElementById("kpListTable");
  const kpListNet   = document.getElementById("kpListNet");
  const btnSave     = document.getElementById("btnSave");
  const btnNoTable  = document.getElementById("btnNoTable");
  const btnDelete   = document.getElementById("btnDelete");
  const btnExport   = document.getElementById("btnExport");
  const statusMsg   = document.getElementById("statusMsg");

  // ---- State ----
  let currentTaskId   = null;
  let allFrames       = [];  // [{filename, status}]
  let filteredFrames  = [];
  let currentFilter   = "all";
  let currentIndex    = 0;

  // Keypoints: null = not yet touched, {x,y,v} = set (v=0 means "not in frame")
  let keypoints = Array(6).fill(null);
  let activeKp  = 0;   // 0–5: which keypoint next click will set
  let mouseNorm = null; // {x,y} in normalized coords, for cursor guide
  let busy = false;

  function setStatus(msg, isErr = false) {
    statusMsg.textContent = msg;
    statusMsg.style.color = isErr ? "#ef4444" : "#94a3b8";
  }

  // ---- Canvas sync ----
  function syncCanvas() {
    kpCanvas.width  = frameImg.clientWidth;
    kpCanvas.height = frameImg.clientHeight;
    render();
  }
  const ro = new ResizeObserver(syncCanvas);
  ro.observe(frameImg);

  // ---- Canvas rendering ----
  function normToCanvas(x, y) {
    return [x * kpCanvas.width, y * kpCanvas.height];
  }

  function render() {
    const W = kpCanvas.width, H = kpCanvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!W || !H) return;

    // --- Table outline (kp 0-3) ---
    const tableKps = keypoints.slice(0, 4);
    const tableVisible = tableKps.map(kp => kp && kp.v >= 1 ? kp : null);
    if (tableVisible.filter(Boolean).length >= 2) {
      ctx.beginPath();
      let first = true;
      // Draw polygon: 0→1→2→3→0
      const order = [0, 1, 2, 3];
      for (const i of order) {
        const kp = tableVisible[i];
        if (!kp) continue;
        const [cx, cy] = normToCanvas(kp.x, kp.y);
        if (first) { ctx.moveTo(cx, cy); first = false; }
        else ctx.lineTo(cx, cy);
      }
      ctx.closePath();
      ctx.strokeStyle = "rgba(34,197,94,0.5)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.stroke();
    }

    // --- Net line (kp 4-5) ---
    const netL = keypoints[4], netR = keypoints[5];
    if (netL && netL.v >= 1 && netR && netR.v >= 1) {
      const [x1, y1] = normToCanvas(netL.x, netL.y);
      const [x2, y2] = normToCanvas(netR.x, netR.y);
      ctx.beginPath();
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.strokeStyle = "rgba(34,211,238,0.5)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // --- Keypoint circles ---
    for (let i = 0; i < 6; i++) {
      const kp = keypoints[i];
      if (!kp || kp.v === 0) continue;  // v=0 = not in frame, skip
      const [cx, cy] = normToCanvas(kp.x, kp.y);
      const color = KP_DEFS[i].color;
      const r = 14;
      const isActive = i === activeKp;

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);

      if (kp.v === 2) {
        // Solid fill
        ctx.fillStyle = color + "33";
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = isActive ? 2.5 : 1.8;
        ctx.setLineDash([]);
      } else {
        // v=1: dashed (occluded)
        ctx.fillStyle = color + "15";
        ctx.fill();
        ctx.strokeStyle = color + "99";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Active highlight ring
      if (isActive) {
        ctx.beginPath();
        ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = color + "66";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Number label
      ctx.fillStyle = "#fff";
      ctx.font = `bold 11px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), cx, cy);
    }

    // --- Mouse cursor guide for active keypoint ---
    if (mouseNorm && !keypoints[activeKp]) {
      const [cx, cy] = normToCanvas(mouseNorm.x, mouseNorm.y);
      const color = KP_DEFS[activeKp].color;
      ctx.beginPath();
      ctx.arc(cx, cy, 12, 0, Math.PI * 2);
      ctx.strokeStyle = color + "99";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color + "66";
      ctx.font = `bold 10px ui-sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(activeKp + 1), cx, cy);
    }
  }

  // ---- Keypoint panel ----
  function buildKpPanel() {
    kpListTable.innerHTML = "";
    kpListNet.innerHTML   = "";
    for (let i = 0; i < 6; i++) {
      const def  = KP_DEFS[i];
      const kp   = keypoints[i];
      const item = document.createElement("div");
      item.className = "kp-item" + (i === activeKp ? " active" : "");
      item.dataset.kp = i;

      // Number badge
      const num = document.createElement("span");
      num.className = `kp-num ${def.group === "table" ? "table-kp" : "net-kp"}`;
      num.textContent = String(i + 1);

      // Name
      const name = document.createElement("span");
      name.className = "kp-name";
      name.textContent = def.name;

      // Visibility badge
      const vis = document.createElement("span");
      vis.className = "kp-vis-badge";
      if (kp === null) {
        vis.textContent = "– offen";
        vis.className += " vis-na";
      } else if (kp.v === 0) {
        vis.textContent = "✕ n.i.B.";
        vis.className += " vis-0";
      } else if (kp.v === 1) {
        vis.textContent = "~ verdeckt";
        vis.className += " vis-1";
      } else {
        vis.textContent = "● sichtbar";
        vis.className += " vis-2";
      }

      // "Nicht im Bild" button (only if not already v=0)
      const btnNa = document.createElement("button");
      btnNa.className = "kp-btn-na";
      btnNa.textContent = "n.i.B.";
      btnNa.title = "Nicht im Bild (v=0)";
      btnNa.addEventListener("click", (e) => {
        e.stopPropagation();
        keypoints[i] = { x: 0, y: 0, v: 0 };
        advanceActive();
        buildKpPanel();
        render();
      });

      // Clear button
      const btnClear = document.createElement("button");
      btnClear.className = "kp-btn-clear";
      btnClear.textContent = "×";
      btnClear.title = "Keypoint löschen";
      btnClear.style.display = kp !== null ? "block" : "none";
      btnClear.addEventListener("click", (e) => {
        e.stopPropagation();
        keypoints[i] = null;
        buildKpPanel();
        render();
      });

      item.appendChild(num);
      item.appendChild(name);
      item.appendChild(vis);
      if (kp === null || kp.v > 0) item.appendChild(btnNa);
      item.appendChild(btnClear);

      // Click row → select as active keypoint
      item.addEventListener("click", () => {
        activeKp = i;
        buildKpPanel();
        render();
      });

      (def.group === "table" ? kpListTable : kpListNet).appendChild(item);
    }
  }

  // Advance activeKp to next unset keypoint (null)
  function advanceActive() {
    for (let offset = 1; offset <= 6; offset++) {
      const next = (activeKp + offset) % 6;
      if (keypoints[next] === null) { activeKp = next; return; }
    }
    // All set: stay at current or go to 0
  }

  // ---- Stats ----
  function updateStats() {
    const labeled  = allFrames.filter(f => f.status === "labeled").length;
    const notable  = allFrames.filter(f => f.status === "no_table").length;
    const none     = allFrames.filter(f => f.status === "none").length;
    sLabeled.textContent = labeled.toLocaleString("de-DE");
    sNoTable.textContent = notable.toLocaleString("de-DE");
    sNone.textContent    = none.toLocaleString("de-DE");
    sTotal.textContent   = `Gesamt: ${allFrames.length.toLocaleString("de-DE")}`;
  }

  // ---- Filter ----
  function applyFilter(filter) {
    currentFilter = filter;
    document.querySelectorAll(".tab[data-filter]").forEach(t =>
      t.classList.toggle("active", t.dataset.filter === filter)
    );
    filteredFrames = filter === "all" ? [...allFrames] : allFrames.filter(f => f.status === filter);
    currentIndex = 0;
    if (filteredFrames.length > 0) loadFrame(0);
    else { frameImg.src = ""; ctx.clearRect(0,0,kpCanvas.width,kpCanvas.height); updateNav(); }
  }

  function updateNav() {
    const total = filteredFrames.length;
    navInfo.textContent = total > 0 ? `${currentIndex + 1} / ${total}` : "0 / 0";
    btnPrev.disabled = currentIndex <= 0;
    btnNext.disabled = currentIndex >= total - 1;
  }

  function advance() {
    if (currentIndex < filteredFrames.length - 1) loadFrame(currentIndex + 1);
    else setStatus("Ende der Liste. ✓");
  }

  // ---- Frame loading ----
  async function loadFrame(index) {
    if (index < 0 || index >= filteredFrames.length) return;
    currentIndex = index;
    keypoints = Array(6).fill(null);
    activeKp  = 0;
    mouseNorm = null;
    updateNav();
    buildKpPanel();

    const { filename } = filteredFrames[currentIndex];
    frameImg.src = API(`/api/task/${encodeURIComponent(currentTaskId)}/frame/${encodeURIComponent(filename)}`);
    await new Promise(res => { frameImg.onload = res; frameImg.onerror = res; });
    syncCanvas();
    await loadLabel(filename);
  }

  async function loadLabel(filename) {
    const r = await fetch(API(`/api/task/${encodeURIComponent(currentTaskId)}/table-label?filename=${encodeURIComponent(filename)}`));
    if (!r.ok) { buildKpPanel(); render(); return; }
    const d = await r.json();
    if (d.keypoints && Array.isArray(d.keypoints)) {
      for (let i = 0; i < 6 && i < d.keypoints.length; i++) {
        const kp = d.keypoints[i];
        // Treat v=0 with x=0,y=0 as "not in frame" vs "unset"
        // If the label exists and v=0 → explicitly marked as not in frame
        keypoints[i] = { x: kp.x, y: kp.y, v: kp.v };
      }
      // Set activeKp to first null/v=0 that hasn't been explicitly set… actually
      // if we loaded an existing label, all 6 are set → find first v=0 to re-set
      activeKp = keypoints.findIndex(kp => kp && kp.v >= 1) >= 0
        ? 0
        : 0;
    }
    // Update frame status in allFrames
    const entry = allFrames.find(f => f.filename === filename);
    if (entry) {
      const newStatus = d.label_missing
        ? "none"
        : d.no_table
          ? "no_table"
          : "labeled";
      if (entry.status !== newStatus) {
        entry.status = newStatus;
        updateStats();
      }
    }
    buildKpPanel();
    render();
    setStatus("");
  }

  // ---- Click handling ----
  function clientToNorm(clientX, clientY) {
    const rect = frameImg.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left)  / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top)   / rect.height)),
    };
  }

  // Find nearest set keypoint within threshold (in normalized coords)
  function nearestKp(normX, normY, threshold = 0.04) {
    let best = -1, bestDist = Infinity;
    for (let i = 0; i < 6; i++) {
      const kp = keypoints[i];
      if (!kp || kp.v === 0) continue;
      const dist = Math.hypot(kp.x - normX, kp.y - normY);
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    return bestDist < threshold ? best : -1;
  }

  kpCanvas.addEventListener("click", (e) => {
    if (!currentTaskId || filteredFrames.length === 0) return;
    e.preventDefault();
    const norm = clientToNorm(e.clientX, e.clientY);
    keypoints[activeKp] = { x: norm.x, y: norm.y, v: 2 };
    advanceActive();
    buildKpPanel();
    render();
    setStatus(`Punkt ${activeKp > 0 ? activeKp : 6} gesetzt. Nächster: ${activeKp + 1} ${KP_DEFS[activeKp].name}`);
  });

  kpCanvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!currentTaskId || filteredFrames.length === 0) return;
    const norm = clientToNorm(e.clientX, e.clientY);
    const idx  = nearestKp(norm.x, norm.y);
    if (idx < 0) return;
    const kp = keypoints[idx];
    if (kp.v === 2) {
      keypoints[idx] = { ...kp, v: 1 };
      setStatus(`Punkt ${idx + 1} → verdeckt (v=1)`);
    } else if (kp.v === 1) {
      keypoints[idx] = null;  // remove
      setStatus(`Punkt ${idx + 1} entfernt`);
    }
    buildKpPanel();
    render();
  });

  kpCanvas.addEventListener("mousemove", (e) => {
    mouseNorm = clientToNorm(e.clientX, e.clientY);
    render();
  });
  kpCanvas.addEventListener("mouseleave", () => {
    mouseNorm = null;
    render();
  });

  // ---- Actions ----
  async function actionSave() {
    if (busy || !currentTaskId || filteredFrames.length === 0) return;
    busy = true;
    const filename = filteredFrames[currentIndex].filename;
    const payload  = {
      filename,
      keypoints: keypoints.map(kp => kp ? { x: kp.x, y: kp.y, v: kp.v } : { x: 0, y: 0, v: 0 }),
    };
    setStatus("Speichere…");
    try {
      const r = await fetch(API(`/api/task/${encodeURIComponent(currentTaskId)}/table-label`), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      if (!r.ok) { setStatus(`Fehler: ${await errorText(r)}`, true); return; }
      const d = await r.json();
      // Update allFrames status
      const hasAny = keypoints.some(kp => kp && kp.v >= 1);
      const entry  = allFrames.find(f => f.filename === filename);
      if (entry) { entry.status = hasAny ? "labeled" : "no_table"; updateStats(); }
      setStatus(d.no_table ? "○ Kein Tisch gespeichert." : "✅ Gespeichert.");
      // If filtered and frame no longer matches → recompute
      if (currentFilter !== "all") {
        filteredFrames = allFrames.filter(f => f.status === currentFilter);
        currentIndex = Math.min(currentIndex, filteredFrames.length - 1);
        updateNav();
        if (filteredFrames.length > 0) { await loadFrame(currentIndex); return; }
      } else {
        advance();
      }
    } finally { busy = false; }
  }

  async function actionNoTable() {
    if (busy || !currentTaskId || filteredFrames.length === 0) return;
    busy = true;
    const filename = filteredFrames[currentIndex].filename;
    const payload  = { filename, keypoints: Array(6).fill({ x: 0, y: 0, v: 0 }) };
    setStatus("Speichere 'Kein Tisch'…");
    try {
      const r = await fetch(API(`/api/task/${encodeURIComponent(currentTaskId)}/table-label`), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      if (!r.ok) { setStatus(`Fehler: ${await errorText(r)}`, true); return; }
      const entry = allFrames.find(f => f.filename === filename);
      if (entry) { entry.status = "no_table"; updateStats(); }
      setStatus("○ Kein Tisch gespeichert.");
      if (currentFilter === "none" || currentFilter === "labeled") {
        filteredFrames = allFrames.filter(f => f.status === currentFilter);
        currentIndex = Math.min(currentIndex, filteredFrames.length - 1);
        updateNav();
        if (filteredFrames.length > 0) await loadFrame(currentIndex);
      } else { advance(); }
    } finally { busy = false; }
  }

  async function actionDelete() {
    if (busy || !currentTaskId || filteredFrames.length === 0) return;
    busy = true;
    const filename = filteredFrames[currentIndex].filename;
    setStatus("Lösche Label…");
    try {
      const r = await fetch(
        API(`/api/task/${encodeURIComponent(currentTaskId)}/table-label?filename=${encodeURIComponent(filename)}`),
        { method: "DELETE" }
      );
      if (!r.ok) { setStatus(`Fehler: ${await errorText(r)}`, true); return; }
      const entry = allFrames.find(f => f.filename === filename);
      if (entry) { entry.status = "none"; updateStats(); }
      keypoints = Array(6).fill(null);
      activeKp  = 0;
      setStatus("🗑 Label gelöscht.");
      if (currentFilter === "labeled" || currentFilter === "no_table") {
        filteredFrames = allFrames.filter(f => f.status === currentFilter);
        currentIndex = Math.min(currentIndex, filteredFrames.length - 1);
        updateNav();
        if (filteredFrames.length > 0) await loadFrame(currentIndex);
        else { ctx.clearRect(0,0,kpCanvas.width,kpCanvas.height); buildKpPanel(); }
      } else {
        buildKpPanel(); render(); advance();
      }
    } finally { busy = false; }
  }

  function actionExport() {
    if (!currentTaskId) return;
    const url = API(`/api/task/${encodeURIComponent(currentTaskId)}/export-table-yolo`);
    window.open(url, "_blank");
  }

  // ---- Load tasks ----
  async function loadTasks() {
    const r = await fetch(API("/api/tasks"));
    if (!r.ok) return;
    const d = await r.json();
    const tasks = Array.isArray(d.tasks) ? d.tasks : [];
    taskSelect.innerHTML = '<option value="">(Task wählen…)</option>';
    for (const t of tasks) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = `${t.id}  (${(t.frames || 0).toLocaleString("de-DE")} Frames)`;
      taskSelect.appendChild(opt);
    }
  }

  async function loadTaskFrames(taskId) {
    taskStats.style.display = "none";
    reviewCard.style.display = "none";
    setStatus("Lade…");
    const r = await fetch(API(`/api/task/${encodeURIComponent(taskId)}/table-frames-status`));
    if (!r.ok) { setStatus(`Fehler: ${await errorText(r)}`, true); return; }
    const d = await r.json();
    allFrames = Array.isArray(d.frames) ? d.frames : [];
    if (allFrames.length === 0) { setStatus("Keine Frames."); return; }
    updateStats();
    taskStats.style.display = "flex";
    reviewCard.style.display = "block";
    currentFilter = "all";
    document.querySelectorAll(".tab[data-filter]").forEach(t =>
      t.classList.toggle("active", t.dataset.filter === "all")
    );
    applyFilter("all");
    setStatus("");
  }

  // ---- Events ----
  taskSelect.addEventListener("change", () => {
    const v = taskSelect.value;
    if (!v) return;
    currentTaskId = v;
    void loadTaskFrames(v);
  });

  document.querySelectorAll(".tab[data-filter]").forEach(tab =>
    tab.addEventListener("click", () => applyFilter(tab.dataset.filter))
  );

  btnPrev.addEventListener("click",   () => { if (currentIndex > 0) loadFrame(currentIndex - 1); });
  btnNext.addEventListener("click",   () => { if (currentIndex < filteredFrames.length - 1) loadFrame(currentIndex + 1); });
  btnRandom.addEventListener("click", () => { if (filteredFrames.length) loadFrame(Math.floor(Math.random() * filteredFrames.length)); });
  btnJump.addEventListener("click",   () => {
    const n = parseInt(jumpInput.value, 10);
    if (!Number.isFinite(n) || n < 1) return;
    loadFrame(Math.min(filteredFrames.length - 1, n - 1));
    jumpInput.value = "";
  });
  jumpInput.addEventListener("keydown", e => { if (e.key === "Enter") btnJump.click(); });

  btnSave.addEventListener("click",    () => void actionSave());
  btnNoTable.addEventListener("click", () => void actionNoTable());
  btnDelete.addEventListener("click",  () => void actionDelete());
  btnExport.addEventListener("click",  () => actionExport());

  // Keyboard shortcuts
  document.addEventListener("keydown", e => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    switch (e.key) {
      case "ArrowLeft":  e.preventDefault(); if (currentIndex > 0) loadFrame(currentIndex - 1); break;
      case "ArrowRight": e.preventDefault(); if (currentIndex < filteredFrames.length - 1) loadFrame(currentIndex + 1); break;
      case "Enter":      e.preventDefault(); void actionSave(); break;
      case "n": case "N": e.preventDefault(); void actionNoTable(); break;
      case "Delete": case "Backspace": e.preventDefault(); void actionDelete(); break;
      case "1": case "2": case "3": case "4": case "5": case "6":
        e.preventDefault();
        activeKp = parseInt(e.key, 10) - 1;
        buildKpPanel(); render();
        break;
      case "0":
        e.preventDefault();
        keypoints[activeKp] = { x: 0, y: 0, v: 0 };
        advanceActive(); buildKpPanel(); render();
        setStatus(`Punkt ${activeKp + 1} als 'nicht im Bild' markiert`);
        break;
    }
  });

  // ---- Init ----
  void loadTasks();
})();
