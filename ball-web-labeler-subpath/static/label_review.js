(() => {
  // ---- Helper: Root-Pfad bestimmen ----
  function detectRoot() {
    // Auf `balls.spinevo.app` steckt Caddy per `rewrite * /ball-detection{uri}` den Subpfad automatisch rein.
    // Darum muss unser Frontend auf dieser Domain *immer* ROOT="" verwenden.
    if ((window.location.hostname || "") === "balls.spinevo.app") return "";
    const p = window.location.pathname || "/";
    const segments = p.split("/").filter((s) => s.length > 0);
    if (segments.length > 0 && segments[0] === "ball-detection") return "/ball-detection";
    if (p.startsWith("/ball-detection")) return "/ball-detection";
    return "";
  }
  const ROOT = detectRoot();

  const API = (path) => {
    const cleanPath = path.startsWith("/") ? path : "/" + path;
    return `${ROOT}${cleanPath}`;
  };

  async function errorTextFromResponse(response) {
    const text = await response.text();
    try {
      const j = JSON.parse(text);
      if (j.detail !== undefined) {
        return typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
      }
    } catch (_) {
      /* ignore */
    }
    return text || `HTTP ${response.status}`;
  }

  // ---- DOM ----
  const taskSelect = document.getElementById("taskSelect");
  const taskMeta = document.getElementById("taskMeta");
  const reviewCard = document.getElementById("reviewCard");
  const reviewFrameInfo = document.getElementById("frameInfo");
  const labelInfo = document.getElementById("labelInfo");
  const statusDiv = document.getElementById("status");

  const boxSizeInput = document.getElementById("boxSize");
  const btnPrev = document.getElementById("btnPrev");
  const btnNext = document.getElementById("btnNext");
  const btnOk = document.getElementById("btnOk");

  const frameImg = document.getElementById("frameImg");
  const labelOverlay = document.getElementById("labelOverlay");
  const crosshair = document.getElementById("crosshair");
  const imgBox = document.getElementById("imgBox");

  // ---- State ----
  let currentTaskId = null;
  let frames = [];
  let totalFrames = 0;
  let currentFrameId = 1;
  let pendingClick = null; // { filename, cx_px, cy_px } in natural image coordinate space
  let currentBoxes = []; // last loaded boxes

  function setStatus(msg) {
    statusDiv.textContent = msg;
    console.log("Status:", msg);
  }

  function hideCrosshair() {
    if (!crosshair) return;
    crosshair.style.display = "none";
  }

  function showCrosshair(clientX, clientY) {
    if (!crosshair || !imgBox) return;
    const br = imgBox.getBoundingClientRect();
    const left = clientX - br.left + imgBox.scrollLeft;
    const top = clientY - br.top + imgBox.scrollTop;
    const raw = parseFloat(boxSizeInput.value);
    const dia = Math.max(14, Math.min(120, Number.isFinite(raw) ? raw : 24));
    crosshair.style.width = `${dia}px`;
    crosshair.style.height = `${dia}px`;
    crosshair.style.left = `${left}px`;
    crosshair.style.top = `${top}px`;
    crosshair.style.display = "block";
  }

  function clearOverlay() {
    if (!labelOverlay) return;
    labelOverlay.innerHTML = "";
  }

  function renderBoxes(boxes) {
    clearOverlay();
    currentBoxes = boxes || [];
    if (!labelOverlay || !frameImg) return;
    if (!frameImg.naturalWidth || !frameImg.naturalHeight) return;

    const displayW = frameImg.clientWidth;
    const displayH = frameImg.clientHeight;

    // Die Kreise sollen auf die angezeigte Größe passen.
    for (const b of currentBoxes) {
      const cx = b.cx * displayW;
      const cy = b.cy * displayH;
      const w = b.w * displayW;
      const h = b.h * displayH;
      const dia = Math.max(w, h);

      const el = document.createElement("div");
      el.className = "label-circle";
      el.style.left = `${cx}px`;
      el.style.top = `${cy}px`;
      el.style.width = `${dia}px`;
      el.style.height = `${dia}px`;
      labelOverlay.appendChild(el);
    }

    labelInfo.textContent = currentBoxes.length > 0 ? `${currentBoxes.length} Boxen` : "Kein Ball (leer)";
  }

  async function loadTasks() {
    setStatus("Lade Tasks…");
    const r = await fetch(API("/api/tasks"));
    if (!r.ok) {
      setStatus(`❌ Tasks laden fehlgeschlagen: ${await errorTextFromResponse(r)}`);
      return;
    }
    const d = await r.json();
    const tasks = Array.isArray(d.tasks) ? d.tasks : [];

    taskSelect.innerHTML = "";
    const optEmpty = document.createElement("option");
    optEmpty.value = "";
    optEmpty.textContent = "(Tasks laden…)";
    taskSelect.appendChild(optEmpty);

    for (const t of tasks) {
      const opt = document.createElement("option");
      opt.value = t.id;
      const framesCount = typeof t.frames === "number" ? t.frames : 0;
      opt.textContent = `${t.id} (${framesCount} Frames)`;
      taskSelect.appendChild(opt);
    }

    setStatus("Bereit.");
  }

  async function loadFrames() {
    if (!currentTaskId) return;
    setStatus("Lade Frames…");
    const r = await fetch(API(`/api/task/${encodeURIComponent(currentTaskId)}/frames`));
    if (!r.ok) {
      setStatus(`❌ Frames laden fehlgeschlagen: ${await errorTextFromResponse(r)}`);
      return;
    }
    const d = await r.json();
    frames = Array.isArray(d.frames) ? d.frames : [];
    totalFrames = frames.length;
    currentFrameId = 1;
    reviewFrameInfo.textContent = totalFrames > 0 ? `1/${totalFrames}` : `0/0`;
    pendingClick = null;
    hideCrosshair();
    reviewCard.style.display = totalFrames > 0 ? "block" : "none";
    if (totalFrames > 0) await loadFrame(1);
  }

  async function loadLabelForCurrentFrame(filename) {
    const r = await fetch(
      API(`/api/task/${encodeURIComponent(currentTaskId)}/label?filename=${encodeURIComponent(filename)}`)
    );
    if (!r.ok) {
      // Wenn Label-Endpunkt nicht vorhanden ist oder Frame fehlt: als leer behandeln.
      renderBoxes([]);
      return;
    }
    const d = await r.json();
    const boxes = Array.isArray(d.boxes) ? d.boxes : [];
    renderBoxes(boxes);
  }

  async function loadFrame(frameId) {
    if (frameId < 1 || frameId > totalFrames) return;
    currentFrameId = frameId;
    const filename = frames[frameId - 1];
    if (!filename) return;

    pendingClick = null;
    hideCrosshair();
    reviewFrameInfo.textContent = `${currentFrameId}/${totalFrames}`;
    labelInfo.textContent = "Lade Labels…";

    frameImg.src = API(`/api/task/${encodeURIComponent(currentTaskId)}/frame/${encodeURIComponent(filename)}`);
    await new Promise((resolve) => {
      frameImg.onload = () => resolve();
      frameImg.onerror = () => resolve();
    });

    const displayOk = frameImg && frameImg.naturalWidth > 0;
    if (!displayOk) {
      labelInfo.textContent = "Frame konnte nicht geladen werden";
      return;
    }

    await loadLabelForCurrentFrame(filename);
  }

  function clientPxToNaturalPx(clientX, clientY) {
    const nw = frameImg.naturalWidth;
    const nh = frameImg.naturalHeight;
    const cw = frameImg.clientWidth;
    const ch = frameImg.clientHeight;
    if (!nw || !nh || !cw || !ch) return null;

    const rect = frameImg.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const cx = (x / cw) * nw;
    const cy = (y / ch) * nh;
    return { cx, cy };
  }

  async function saveSingleBoxFromPendingClick() {
    if (!currentTaskId || !pendingClick) return;
    const { filename, cx, cy } = pendingClick;

    const nw = frameImg.naturalWidth;
    const cw = frameImg.clientWidth;
    if (!nw || !cw) return;

    // server erwartet boxPx in Pixeln bezogen auf das originale Bild.
    const boxPx = Math.max(2, parseFloat(boxSizeInput.value) * (nw / cw));

    setStatus("Speichere (1 Box)…");
    const response = await fetch(API(`/api/task/${encodeURIComponent(currentTaskId)}/label`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, cx, cy, box: boxPx }),
    });

    let result = {};
    try {
      result = await response.json();
    } catch (_) {}

    if (response.ok && result.ok) {
      setStatus("✅ Gespeichert. Labels geladen.");
      pendingClick = null;
      hideCrosshair();
      await loadLabelForCurrentFrame(filename);
    } else {
      setStatus(`❌ Speichern fehlgeschlagen: ${result.detail || response.status}`);
    }
  }

  async function okAction() {
    if (!currentTaskId) return;
    if (pendingClick) {
      await saveSingleBoxFromPendingClick();
    }
    if (currentFrameId < totalFrames) await loadFrame(currentFrameId + 1);
  }

  // ---- Events ----
  btnPrev.addEventListener("click", () => {
    if (currentFrameId > 1) void loadFrame(currentFrameId - 1);
  });
  btnNext.addEventListener("click", () => {
    if (currentFrameId < totalFrames) void loadFrame(currentFrameId + 1);
  });
  btnOk.addEventListener("click", () => void okAction());

  frameImg.addEventListener("click", (e) => {
    if (!currentTaskId) return;
    const filename = frames[currentFrameId - 1];
    if (!filename) return;

    const xy = clientPxToNaturalPx(e.clientX, e.clientY);
    if (!xy) return;
    pendingClick = { filename, cx: xy.cx, cy: xy.cy };
    showCrosshair(e.clientX, e.clientY);
    setStatus("Korrigieren-Klick gesetzt. OK übernimmt.");
  });

  taskSelect.addEventListener("change", () => {
    const v = taskSelect.value;
    if (!v) return;
    currentTaskId = v;
    taskMeta.textContent = v;
    void loadFrames();
  });

  // ---- Start ----
  void loadTasks();
  reviewCard.style.display = "none";
  hideCrosshair();
})();

