(() => {
  // ---- Root-Pfad ----
  function detectRoot() {
    if ((window.location.hostname || "") === "balls.spinevo.app") return "";
    const p = window.location.pathname || "/";
    if (p.startsWith("/ball-detection")) return "/ball-detection";
    return "";
  }
  const ROOT = detectRoot();
  const API = (path) => `${ROOT}${path.startsWith("/") ? path : "/" + path}`;

  async function errorText(r) {
    const text = await r.text().catch(() => "");
    try {
      const j = JSON.parse(text);
      if (j.detail) return typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch (_) {}
    return text || `HTTP ${r.status}`;
  }

  // ---- DOM ----
  const gStatBall        = document.getElementById("gStatBall");
  const gStatEmpty       = document.getElementById("gStatEmpty");
  const gStatNone        = document.getElementById("gStatNone");
  const gStatTotal       = document.getElementById("gStatTotal");
  const importStatsWrap  = document.getElementById("importStatsWrap");
  const gStatImportBall  = document.getElementById("gStatImportBall");
  const gStatImportEmpty = document.getElementById("gStatImportEmpty");
  const gStatImportTotal = document.getElementById("gStatImportTotal");
  const gStatCombBall    = document.getElementById("gStatCombBall");
  const gStatCombEmpty   = document.getElementById("gStatCombEmpty");
  const gStatCombTotal   = document.getElementById("gStatCombTotal");
  const btnRefreshGlobal = document.getElementById("btnRefreshGlobal");
  const taskSelect   = document.getElementById("taskSelect");
  const loadingTask  = document.getElementById("loadingTask");
  const statsCard    = document.getElementById("statsCard");
  const reviewCard   = document.getElementById("reviewCard");
  const statBall     = document.getElementById("statBall");
  const statEmpty    = document.getElementById("statEmpty");
  const statNone     = document.getElementById("statNone");
  const statTotal    = document.getElementById("statTotal");
  const navInfo      = document.getElementById("navInfo");
  const btnPrev      = document.getElementById("btnPrev");
  const btnNext      = document.getElementById("btnNext");
  const btnRandom    = document.getElementById("btnRandom");
  const jumpInput    = document.getElementById("jumpInput");
  const btnJump      = document.getElementById("btnJump");
  const frameImg     = document.getElementById("frameImg");
  const labelOverlay = document.getElementById("labelOverlay");
  const crosshair    = document.getElementById("crosshair");
  const imgBox       = document.getElementById("imgBox");
  const labelBadge   = document.getElementById("labelBadge");
  const boxSizeInput = document.getElementById("boxSize");
  const btnOk        = document.getElementById("btnOk");
  const btnNoball    = document.getElementById("btnNoball");
  const btnDelete    = document.getElementById("btnDelete");
  const statusMsg    = document.getElementById("statusMsg");
  const filterTabs   = document.querySelectorAll(".tab[data-filter]");

  // ---- State ----
  let currentTaskId   = null;
  let allFrames       = []; // [{filename, status}]  status: "ball"|"empty"|"none"
  let filteredFrames  = [];
  let currentFilter   = "all";
  let currentIndex    = 0;
  let busy            = false; // verhindert parallele API-Calls

  // ---- Status-Anzeige ----
  function setStatus(msg, isError = false) {
    statusMsg.textContent = msg;
    statusMsg.style.color = isError ? "#ef4444" : "#94a3b8";
  }

  // ---- Statistik ----
  function updateStats() {
    let ball = 0, empty = 0, none = 0;
    for (const f of allFrames) {
      if (f.status === "ball") ball++;
      else if (f.status === "empty") empty++;
      else none++;
    }
    statBall.textContent  = ball.toLocaleString("de-DE");
    statEmpty.textContent = empty.toLocaleString("de-DE");
    statNone.textContent  = none.toLocaleString("de-DE");
    statTotal.textContent = `Gesamt: ${allFrames.length.toLocaleString("de-DE")} Frames`;
  }

  // ---- Filter ----
  function applyFilter(filter) {
    currentFilter = filter;
    filterTabs.forEach(t => t.classList.toggle("active", t.dataset.filter === filter));
    filteredFrames = filter === "all" ? [...allFrames] : allFrames.filter(f => f.status === filter);
    currentIndex = 0;
    if (filteredFrames.length > 0) {
      void loadFrame(0);
    } else {
      frameImg.src = "";
      labelOverlay.innerHTML = "";
      crosshair.style.display = "none";
      updateNav();
      setStatus(`Keine Frames für diesen Filter.`);
    }
  }

  // ---- Navigation ----
  function updateNav() {
    const total = filteredFrames.length;
    navInfo.textContent = total > 0 ? `${currentIndex + 1} / ${total}` : "0 / 0";
    btnPrev.disabled = currentIndex <= 0;
    btnNext.disabled = currentIndex >= total - 1;
  }

  function advance() {
    if (currentIndex < filteredFrames.length - 1) {
      void loadFrame(currentIndex + 1);
    } else {
      setStatus("Ende der Liste. ✓");
    }
  }

  // ---- Frame laden ----
  async function loadFrame(index) {
    if (index < 0 || index >= filteredFrames.length) return;
    currentIndex = index;
    pendingClick = null;
    crosshair.style.display = "none";
    labelOverlay.innerHTML = "";
    updateNav();

    const { filename } = filteredFrames[currentIndex];
    labelBadge.textContent = "Lade…";
    labelBadge.className = "badge badge-none";

    frameImg.src = API(`/api/task/${encodeURIComponent(currentTaskId)}/frame/${encodeURIComponent(filename)}`);
    await new Promise(res => { frameImg.onload = res; frameImg.onerror = res; });

    await refreshLabel(filename);
  }

  async function refreshLabel(filename) {
    const r = await fetch(API(`/api/task/${encodeURIComponent(currentTaskId)}/label?filename=${encodeURIComponent(filename)}`));
    if (!r.ok) { renderState([], "none"); return; }
    const d = await r.json();
    const boxes = Array.isArray(d.boxes) ? d.boxes : [];
    const status = d.label_missing ? "none" : (boxes.length > 0 ? "ball" : "empty");

    // allFrames-Eintrag aktualisieren
    const entry = allFrames.find(f => f.filename === filename);
    if (entry && entry.status !== status) {
      entry.status = status;
      updateStats();
    }

    renderState(boxes, status);
  }

  function renderState(boxes, status) {
    labelOverlay.innerHTML = "";
    const displayW = frameImg.clientWidth;
    const displayH = frameImg.clientHeight;

    for (const b of boxes) {
      const cx = b.cx * displayW;
      const cy = b.cy * displayH;
      const bw = b.w * displayW;
      const bh = b.h * displayH;
      const el = document.createElement("div");
      el.className  = "label-circle";
      el.style.left = `${cx}px`;
      el.style.top  = `${cy}px`;
      el.style.width  = `${bw}px`;
      el.style.height = `${bh}px`;
      labelOverlay.appendChild(el);
    }

    if (status === "ball") {
      labelBadge.textContent = `● ${boxes.length} Ball${boxes.length !== 1 ? "s" : ""}`;
      labelBadge.className   = "badge badge-ball";
    } else if (status === "empty") {
      labelBadge.textContent = "○ Kein Ball (leer)";
      labelBadge.className   = "badge badge-empty";
    } else {
      labelBadge.textContent = "? Nicht gelabelt";
      labelBadge.className   = "badge badge-none";
    }
    setStatus("");
  }

  // ---- Crosshair ----
  // ---- Aktionen ----
  async function actionOk() {
    if (busy || !currentTaskId || filteredFrames.length === 0) return;
    advance();
  }

  async function actionNoball() {
    if (busy || !currentTaskId || filteredFrames.length === 0) return;
    busy = true;
    const filename = filteredFrames[currentIndex].filename;
    setStatus("Speichere 'Kein Ball'…");
    try {
      const r = await fetch(API(`/api/task/${encodeURIComponent(currentTaskId)}/label/empty`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });
      if (!r.ok) { setStatus(`Fehler: ${await errorText(r)}`, true); return; }

      const entry = allFrames.find(f => f.filename === filename);
      if (entry) entry.status = "empty";
      updateStats();
      setStatus("○ Als 'Kein Ball' gespeichert.");

      // Wenn Filter nur "ball" oder "none" zeigt: Frame verschwindet aus Ansicht
      if (currentFilter === "ball" || currentFilter === "none") {
        filteredFrames = allFrames.filter(f => f.status === currentFilter);
        currentIndex = Math.min(currentIndex, filteredFrames.length - 1);
        updateNav();
        if (filteredFrames.length > 0) await loadFrame(currentIndex);
        else { frameImg.src = ""; labelOverlay.innerHTML = ""; }
      } else {
        await refreshLabel(filename);
        advance();
      }
    } finally { busy = false; }
  }

  async function actionDelete() {
    if (busy || !currentTaskId || filteredFrames.length === 0) return;
    busy = true;
    const filename = filteredFrames[currentIndex].filename;
    setStatus("Lösche Label…");
    try {
      const r = await fetch(
        API(`/api/task/${encodeURIComponent(currentTaskId)}/label?filename=${encodeURIComponent(filename)}`),
        { method: "DELETE" }
      );
      if (!r.ok) { setStatus(`Fehler: ${await errorText(r)}`, true); return; }

      const entry = allFrames.find(f => f.filename === filename);
      if (entry) entry.status = "none";
      updateStats();
      setStatus("🗑 Label gelöscht.");

      if (currentFilter === "ball" || currentFilter === "empty") {
        filteredFrames = allFrames.filter(f => f.status === currentFilter);
        currentIndex = Math.min(currentIndex, filteredFrames.length - 1);
        updateNav();
        if (filteredFrames.length > 0) await loadFrame(currentIndex);
        else { frameImg.src = ""; labelOverlay.innerHTML = ""; }
      } else {
        await refreshLabel(filename);
        advance();
      }
    } finally { busy = false; }
  }

  async function saveClickAt(filename, cx, cy) {
    if (busy) return;
    busy = true;
    const nw    = frameImg.naturalWidth;
    const cw    = frameImg.clientWidth;
    const boxPx = Math.max(2, (parseFloat(boxSizeInput.value) || 24) * (nw / cw));
    setStatus("Speichere…");
    try {
      const r = await fetch(API(`/api/task/${encodeURIComponent(currentTaskId)}/label`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, cx, cy, box: boxPx }),
      });
      if (!r.ok) { setStatus(`Fehler: ${await errorText(r)}`, true); return; }
      const entry = allFrames.find(f => f.filename === filename);
      if (entry) entry.status = "ball";
      updateStats();
      setStatus("✅ Gespeichert. Enter = weiter.");
      await refreshLabel(filename);
    } finally { busy = false; }
  }

  // ---- Globale Statistik ----
  async function loadGlobalStats() {
    gStatBall.textContent = "…";
    gStatEmpty.textContent = "…";
    gStatNone.textContent = "…";
    gStatTotal.textContent = "";
    const r = await fetch(API("/api/stats/frames-overview"));
    if (!r.ok) { gStatBall.textContent = gStatEmpty.textContent = gStatNone.textContent = "–"; return; }
    const d = await r.json();

    // App-Daten
    gStatBall.textContent  = (d.ball  ?? 0).toLocaleString("de-DE");
    gStatEmpty.textContent = (d.empty ?? 0).toLocaleString("de-DE");
    gStatNone.textContent  = (d.none  ?? 0).toLocaleString("de-DE");
    const appLabeled = (d.ball ?? 0) + (d.empty ?? 0);
    gStatTotal.textContent = `${appLabeled.toLocaleString("de-DE")} gelabelt · ${(d.total ?? 0).toLocaleString("de-DE")} gesamt`;

    // Import
    if ((d.import_total ?? 0) > 0) {
      importStatsWrap.style.display = "block";
      gStatImportBall.textContent  = (d.import_ball  ?? 0).toLocaleString("de-DE");
      gStatImportEmpty.textContent = (d.import_empty ?? 0).toLocaleString("de-DE");
      gStatImportTotal.textContent = `${(d.import_total ?? 0).toLocaleString("de-DE")} gesamt`;
      gStatCombBall.textContent    = (d.combined_ball   ?? 0).toLocaleString("de-DE");
      gStatCombEmpty.textContent   = (d.combined_empty  ?? 0).toLocaleString("de-DE");
      gStatCombTotal.textContent   = `${(d.combined_labeled ?? 0).toLocaleString("de-DE")} gelabelt`;
    } else {
      importStatsWrap.style.display = "none";
    }
  }

  // ---- Task laden ----
  async function loadTasks() {
    const r = await fetch(API("/api/tasks"));
    if (!r.ok) { setStatus("Tasks konnten nicht geladen werden.", true); return; }
    const d = await r.json();
    const tasks = Array.isArray(d.tasks) ? d.tasks : [];
    taskSelect.innerHTML = '<option value="">(Task wählen…)</option>';
    for (const t of tasks) {
      const opt = document.createElement("option");
      opt.value = t.id;
      const frames    = (t.frames    || 0).toLocaleString("de-DE");
      const unlabeled = (t.unlabeled || 0).toLocaleString("de-DE");
      opt.textContent = `${t.id}  (${frames} Frames, ${unlabeled} offen)`;
      taskSelect.appendChild(opt);
    }
  }

  async function loadTaskFrames(taskId) {
    loadingTask.style.display = "block";
    statsCard.style.display = "none";
    reviewCard.style.display = "none";
    setStatus("Lade Frame-Status…");

    const r = await fetch(API(`/api/task/${encodeURIComponent(taskId)}/frames-status`));
    loadingTask.style.display = "none";

    if (!r.ok) { setStatus(`Fehler: ${await errorText(r)}`, true); return; }
    const d = await r.json();
    allFrames = Array.isArray(d.frames) ? d.frames : [];

    if (allFrames.length === 0) { setStatus("Keine Frames in diesem Task."); return; }

    updateStats();
    statsCard.style.display = "block";
    reviewCard.style.display = "block";

    // Filter zurücksetzen & laden
    currentFilter = "all";
    filterTabs.forEach(t => t.classList.toggle("active", t.dataset.filter === "all"));
    applyFilter("all");
  }

  // ---- Event Listener ----
  taskSelect.addEventListener("change", () => {
    const v = taskSelect.value;
    if (!v) return;
    currentTaskId = v;
    void loadTaskFrames(v);
  });

  filterTabs.forEach(tab => {
    tab.addEventListener("click", () => applyFilter(tab.dataset.filter));
  });

  btnPrev.addEventListener("click", () => {
    if (currentIndex > 0) void loadFrame(currentIndex - 1);
  });
  btnNext.addEventListener("click", () => {
    if (currentIndex < filteredFrames.length - 1) void loadFrame(currentIndex + 1);
  });
  btnRandom.addEventListener("click", () => {
    if (filteredFrames.length === 0) return;
    void loadFrame(Math.floor(Math.random() * filteredFrames.length));
  });
  btnJump.addEventListener("click", () => {
    const n = parseInt(jumpInput.value, 10);
    if (!Number.isFinite(n) || n < 1) return;
    void loadFrame(Math.min(filteredFrames.length - 1, n - 1));
    jumpInput.value = "";
  });
  jumpInput.addEventListener("keydown", e => { if (e.key === "Enter") btnJump.click(); });

  btnOk.addEventListener("click",     () => void actionOk());
  btnNoball.addEventListener("click", () => void actionNoball());
  btnDelete.addEventListener("click", () => void actionDelete());

  // Klick auf Bild → sofort speichern und grünen Kreis zeigen
  frameImg.addEventListener("click", e => {
    if (!currentTaskId || filteredFrames.length === 0 || busy) return;
    const filename = filteredFrames[currentIndex]?.filename;
    if (!filename) return;
    const nw = frameImg.naturalWidth, nh = frameImg.naturalHeight;
    const cw = frameImg.clientWidth,  ch = frameImg.clientHeight;
    if (!nw || !nh || !cw || !ch) return;
    const rect = frameImg.getBoundingClientRect();
    const cx = ((e.clientX - rect.left) / cw) * nw;
    const cy = ((e.clientY - rect.top)  / ch) * nh;
    void saveClickAt(filename, cx, cy);
  });

  // Keyboard-Shortcuts
  document.addEventListener("keydown", e => {
    // Nicht auslösen wenn in Input/Select getippt wird
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        if (currentIndex > 0) void loadFrame(currentIndex - 1);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (currentIndex < filteredFrames.length - 1) void loadFrame(currentIndex + 1);
        break;
      case "Enter":
        e.preventDefault();
        void actionOk();
        break;
      case "n":
      case "N":
        e.preventDefault();
        void actionNoball();
        break;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        void actionDelete();
        break;
    }
  });

  btnRefreshGlobal.addEventListener("click", () => void loadGlobalStats());

  // ---- Start ----
  void loadGlobalStats();
  void loadTasks();
})();
