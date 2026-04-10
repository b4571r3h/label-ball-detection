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

  // ---- DOM ----
  const statsWrap   = document.getElementById("statsWrap");
  const loadingMsg  = document.getElementById("loadingMsg");
  const reviewCard  = document.getElementById("reviewCard");
  const sBall       = document.getElementById("sBall");
  const sEmpty      = document.getElementById("sEmpty");
  const sNone       = document.getElementById("sNone");
  const sTotal      = document.getElementById("sTotal");
  const navInfo     = document.getElementById("navInfo");
  const btnPrev     = document.getElementById("btnPrev");
  const btnNext     = document.getElementById("btnNext");
  const btnRandom   = document.getElementById("btnRandom");
  const jumpInput   = document.getElementById("jumpInput");
  const btnJump     = document.getElementById("btnJump");
  const frameImg    = document.getElementById("frameImg");
  const labelCanvas = document.getElementById("labelCanvas");
  const labelBadge  = document.getElementById("labelBadge");
  const filenameInfo = document.getElementById("filenameInfo");
  const statusMsg   = document.getElementById("statusMsg");
  const filterTabs  = document.querySelectorAll(".tab[data-filter]");
  const splitBtns   = document.querySelectorAll(".split-btn[data-split]");

  // ---- State ----
  let currentSplit  = "train";
  let currentFilter = "all";
  let allFrames     = [];
  let filteredFrames = [];
  let currentIndex  = 0;
  let statsCache    = {};

  // ---- Helpers ----
  function setStatus(msg) { statusMsg.textContent = msg; }

  function updateNav() {
    const total = filteredFrames.length;
    navInfo.textContent = total > 0 ? `${currentIndex + 1} / ${total}` : "0 / 0";
    btnPrev.disabled = currentIndex <= 0;
    btnNext.disabled = currentIndex >= total - 1;
  }

  // ---- Stats anzeigen ----
  function showStats(split) {
    const s = statsCache[split];
    if (!s) return;
    sBall.textContent  = (s.ball  || 0).toLocaleString("de-DE");
    sEmpty.textContent = (s.empty || 0).toLocaleString("de-DE");
    sNone.textContent  = (s.none  || 0).toLocaleString("de-DE");
    sTotal.textContent = `Gesamt: ${(s.total || 0).toLocaleString("de-DE")} Frames`;
    statsWrap.style.display = "flex";
  }

  // ---- Globale Stats laden ----
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

  // ---- Frame-Liste laden ----
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
      clearCanvas();
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
      // Kleiner Mittelpunkt
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

    const { filename, split, status } = filteredFrames[currentIndex];
    filenameInfo.textContent = `${split}/${filename}`;
    labelBadge.textContent = "Lade…";
    labelBadge.className   = "badge badge-none";

    frameImg.src = API(`/api/import-yolo/frame/${split}/${encodeURIComponent(filename)}`);
    await new Promise(res => { frameImg.onload = res; frameImg.onerror = res; });

    // Label laden
    const lr = await fetch(API(`/api/import-yolo/label?split=${split}&filename=${encodeURIComponent(filename)}`));
    if (!lr.ok) return;
    const ld = await lr.json();

    if (ld.status === "ball") {
      drawBoxes(ld.boxes);
      labelBadge.textContent = `● ${ld.boxes.length} Ball${ld.boxes.length !== 1 ? "s" : ""}`;
      labelBadge.className   = "badge badge-ball";
    } else if (ld.status === "empty") {
      labelBadge.textContent = "○ Kein Ball (leere Label-Datei)";
      labelBadge.className   = "badge badge-empty";
    } else {
      labelBadge.textContent = "? Keine Label-Datei";
      labelBadge.className   = "badge badge-none";
    }
    setStatus("");
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

  document.addEventListener("keydown", e => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.key === "ArrowLeft")  { e.preventDefault(); if (currentIndex > 0) void loadFrame(currentIndex - 1); }
    if (e.key === "ArrowRight") { e.preventDefault(); if (currentIndex < filteredFrames.length - 1) void loadFrame(currentIndex + 1); }
  });

  // ---- Start ----
  void loadStats();
  void loadFrameList();
})();
