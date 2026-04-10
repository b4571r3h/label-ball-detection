(() => {
  function detectRoot() {
    if ((window.location.hostname || "") === "balls.spinevo.app") return "";
    const p = window.location.pathname || "/";
    if (p.startsWith("/ball-detection")) return "/ball-detection";
    return "";
  }
  const ROOT = detectRoot();
  const API = (path) => `${ROOT}${path.startsWith("/") ? path : "/" + path}`;

  // ---- DOM ----
  const statsWrap    = document.getElementById("statsWrap");
  const loadingMsg   = document.getElementById("loadingMsg");
  const reviewCard   = document.getElementById("reviewCard");
  const sBall        = document.getElementById("sBall");
  const sEmpty       = document.getElementById("sEmpty");
  const sNone        = document.getElementById("sNone");
  const sTotal       = document.getElementById("sTotal");
  const navInfo      = document.getElementById("navInfo");
  const btnPrev      = document.getElementById("btnPrev");
  const btnNext      = document.getElementById("btnNext");
  const btnRandom    = document.getElementById("btnRandom");
  const jumpInput    = document.getElementById("jumpInput");
  const btnJump      = document.getElementById("btnJump");
  const frameImg     = document.getElementById("frameImg");
  const labelCanvas  = document.getElementById("labelCanvas");
  const crosshair    = document.getElementById("crosshair");
  const labelBadge   = document.getElementById("labelBadge");
  const filenameInfo = document.getElementById("filenameInfo");
  const boxSizeInput = document.getElementById("boxSize");
  const btnOk          = document.getElementById("btnOk");
  const btnNoball      = document.getElementById("btnNoball");
  const btnResetEmpty  = document.getElementById("btnResetEmpty");
  const statusMsg    = document.getElementById("statusMsg");
  const filterTabs   = document.querySelectorAll(".tab[data-filter]");
  const splitBtns    = document.querySelectorAll(".split-btn[data-split]");

  // ---- State ----
  let currentSplit   = "train";
  let currentFilter  = "all";
  let allFrames      = [];
  let filteredFrames = [];
  let currentIndex   = 0;
  let statsCache     = {};
  let busy           = false;

  function setStatus(msg, isError = false) {
    statusMsg.textContent = msg;
    statusMsg.style.color = isError ? "#ef4444" : "#94a3b8";
  }

  function updateNav() {
    const total = filteredFrames.length;
    navInfo.textContent = total > 0 ? `${currentIndex + 1} / ${total}` : "0 / 0";
    btnPrev.disabled = currentIndex <= 0;
    btnNext.disabled = currentIndex >= total - 1;
  }

  function showStats(split) {
    const s = statsCache[split];
    if (!s) return;
    sBall.textContent  = (s.ball  || 0).toLocaleString("de-DE");
    sEmpty.textContent = (s.empty || 0).toLocaleString("de-DE");
    sNone.textContent  = (s.none  || 0).toLocaleString("de-DE");
    sTotal.textContent = `Gesamt: ${(s.total || 0).toLocaleString("de-DE")} Frames`;
    statsWrap.style.display = "flex";
  }

  async function loadStats() {
    loadingMsg.style.display = "inline";
    const r = await fetch(API("/api/import-yolo/stats"));
    loadingMsg.style.display = "none";
    if (!r.ok) { setStatus("Fehler beim Laden der Statistik."); return; }
    const d = await r.json();
    if (!d.enabled) { setStatus("IMPORT_YOLO_BALL_DIR ist nicht konfiguriert."); return; }
    statsCache = d.splits || {};
    showStats(currentSplit);
  }

  async function loadFrameList() {
    loadingMsg.style.display = "inline";
    reviewCard.style.display = "none";
    const r = await fetch(API(`/api/import-yolo/frames?split=${currentSplit}&filter=all`));
    loadingMsg.style.display = "none";
    if (!r.ok) { setStatus("Fehler beim Laden der Frames."); return; }
    const d = await r.json();
    allFrames = d.frames || [];
    applyFilter(currentFilter);
    reviewCard.style.display = allFrames.length > 0 ? "block" : "none";
    if (allFrames.length === 0) setStatus("Keine Frames gefunden.");
  }

  function applyFilter(filter) {
    currentFilter = filter;
    filterTabs.forEach(t => t.classList.toggle("active", t.dataset.filter === filter));
    filteredFrames = filter === "all" ? [...allFrames] : allFrames.filter(f => f.status === filter);
    currentIndex = 0;
    if (filteredFrames.length > 0) {
      void loadFrame(0);
    } else {
      frameImg.src = "";
      clearCanvas();
      crosshair.style.display = "none";
      updateNav();
      setStatus("Keine Frames für diesen Filter.");
    }
  }

  // ---- Canvas ----
  function clearCanvas() {
    const ctx = labelCanvas.getContext("2d");
    ctx.clearRect(0, 0, labelCanvas.width, labelCanvas.height);
  }

  function drawBoxes(boxes) {
    const W = frameImg.clientWidth;
    const H = frameImg.clientHeight;
    labelCanvas.width  = W;
    labelCanvas.height = H;
    const ctx = labelCanvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);
    for (const b of boxes) {
      const x = (b.cx - b.w / 2) * W;
      const y = (b.cy - b.h / 2) * H;
      const w = b.w * W;
      const h = b.h * H;
      ctx.strokeStyle = "rgba(34,197,94,0.9)";
      ctx.lineWidth = 2.5;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = "rgba(34,197,94,0.7)";
      ctx.beginPath();
      ctx.arc(b.cx * W, b.cy * H, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- Frame laden ----
  async function loadFrame(index) {
    if (index < 0 || index >= filteredFrames.length) return;
    currentIndex = index;
    updateNav();
    clearCanvas();
    crosshair.style.display = "none";

    const { filename, split } = filteredFrames[currentIndex];
    filenameInfo.textContent = `${split}/${filename}`;
    labelBadge.textContent = "Lade…";
    labelBadge.className   = "badge badge-none";

    frameImg.src = API(`/api/import-yolo/frame/${split}/${encodeURIComponent(filename)}`);
    await new Promise(res => { frameImg.onload = res; frameImg.onerror = res; });

    await refreshLabel(filename, split);
  }

  async function refreshLabel(filename, split) {
    const lr = await fetch(API(`/api/import-yolo/label?split=${split}&filename=${encodeURIComponent(filename)}`));
    if (!lr.ok) return;
    const ld = await lr.json();

    crosshair.style.display = "none";
    if (ld.status === "ball") {
      drawBoxes(ld.boxes);
      labelBadge.textContent = `● ${ld.boxes.length} Ball${ld.boxes.length !== 1 ? "s" : ""}`;
      labelBadge.className   = "badge badge-ball";
      // allFrames-Status aktualisieren
      const entry = allFrames.find(f => f.filename === filename && f.split === split);
      if (entry) entry.status = "ball";
    } else if (ld.status === "empty") {
      clearCanvas();
      labelBadge.textContent = "○ Kein Ball (leere Label-Datei)";
      labelBadge.className   = "badge badge-empty";
    } else {
      clearCanvas();
      labelBadge.textContent = "? Keine Label-Datei";
      labelBadge.className   = "badge badge-none";
    }
    setStatus("");
  }

  function advance() {
    if (currentIndex < filteredFrames.length - 1) {
      void loadFrame(currentIndex + 1);
    } else {
      setStatus("Ende der Liste. ✓");
    }
  }

  // ---- Klick auf Bild → Ball markieren ----
  frameImg.addEventListener("click", e => {
    if (busy || filteredFrames.length === 0) return;
    const nw = frameImg.naturalWidth, nh = frameImg.naturalHeight;
    const cw = frameImg.clientWidth,  ch = frameImg.clientHeight;
    if (!nw || !nh || !cw || !ch) return;
    const rect = frameImg.getBoundingClientRect();
    const px = (e.clientX - rect.left) / cw * nw;  // Pixel in naturalWidth-Raum
    const py = (e.clientY - rect.top)  / ch * nh;

    // Crosshair anzeigen
    const boxPx = parseFloat(boxSizeInput.value) || 24;
    crosshair.style.width  = `${boxPx * (cw / nw)}px`;
    crosshair.style.height = `${boxPx * (cw / nw)}px`;
    crosshair.style.left   = `${(px / nw) * cw}px`;
    crosshair.style.top    = `${(py / nh) * ch}px`;
    crosshair.style.display = "block";

    void saveLabel(px, py);
  });

  async function saveLabel(px, py) {
    if (busy || filteredFrames.length === 0) return;
    busy = true;
    const { filename, split } = filteredFrames[currentIndex];
    const boxPx = parseFloat(boxSizeInput.value) || 24;
    setStatus("Speichere…");
    try {
      const r = await fetch(API("/api/import-yolo/label"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ split, filename, cx: px, cy: py, box: boxPx }),
      });
      if (!r.ok) { setStatus("Fehler beim Speichern.", true); return; }
      setStatus("✅ Gespeichert. Enter = weiter.");
      await refreshLabel(filename, split);
    } finally { busy = false; }
  }

  async function actionNoball() {
    if (busy || filteredFrames.length === 0) return;
    busy = true;
    const { filename, split } = filteredFrames[currentIndex];
    setStatus("Speichere 'Kein Ball'…");
    try {
      const r = await fetch(
        API(`/api/import-yolo/label?split=${split}&filename=${encodeURIComponent(filename)}`),
        { method: "DELETE" }
      );
      if (!r.ok) { setStatus("Fehler.", true); return; }
      crosshair.style.display = "none";
      const entry = allFrames.find(f => f.filename === filename && f.split === split);
      if (entry) entry.status = "empty";
      setStatus("○ Als 'Kein Ball' gesetzt.");
      await refreshLabel(filename, split);
      advance();
    } finally { busy = false; }
  }

  // ---- Events ----
  splitBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      currentSplit = btn.dataset.split;
      splitBtns.forEach(b => b.classList.toggle("active", b.dataset.split === currentSplit));
      showStats(currentSplit);
      void loadFrameList();
    });
  });

  filterTabs.forEach(tab => {
    tab.addEventListener("click", () => applyFilter(tab.dataset.filter));
  });

  btnPrev.addEventListener("click",   () => { if (currentIndex > 0) void loadFrame(currentIndex - 1); });
  btnNext.addEventListener("click",   () => { if (currentIndex < filteredFrames.length - 1) void loadFrame(currentIndex + 1); });
  btnRandom.addEventListener("click", () => { if (filteredFrames.length) void loadFrame(Math.floor(Math.random() * filteredFrames.length)); });
  btnJump.addEventListener("click",   () => {
    const n = parseInt(jumpInput.value, 10);
    if (!Number.isFinite(n) || n < 1) return;
    void loadFrame(Math.min(filteredFrames.length - 1, n - 1));
    jumpInput.value = "";
  });
  jumpInput.addEventListener("keydown", e => { if (e.key === "Enter") btnJump.click(); });

  btnOk.addEventListener("click",     () => advance());
  btnNoball.addEventListener("click", () => void actionNoball());

  btnResetEmpty?.addEventListener("click", async () => {
    if (!confirm("Alle leeren .txt-Dateien löschen?\n\nFrames wechseln von 'Kein Ball (leer)' zu 'kein Label'.\nNur leere Dateien werden gelöscht – Ball-Labels bleiben erhalten.")) return;
    const r = await fetch(API("/api/import-yolo/reset-empty-labels"), { method: "POST" });
    if (!r.ok) { setStatus("Fehler beim Zurücksetzen.", true); return; }
    const d = await r.json();
    setStatus(`✓ ${d.deleted} leere Label-Dateien gelöscht. Liste wird neu geladen…`);
    await loadStats();
    await loadFrameList();
  });

  document.addEventListener("keydown", e => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    switch (e.key) {
      case "ArrowLeft":  e.preventDefault(); if (currentIndex > 0) void loadFrame(currentIndex - 1); break;
      case "ArrowRight": e.preventDefault(); if (currentIndex < filteredFrames.length - 1) void loadFrame(currentIndex + 1); break;
      case "Enter":      e.preventDefault(); advance(); break;
      case "n": case "N": e.preventDefault(); void actionNoball(); break;
    }
  });

  // ---- Start ----
  void loadStats();
  void loadFrameList();
})();
