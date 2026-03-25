/* SpinEvo Ball Detection – Labeler Frontend (Kopie main_simple) */

(() => {
  // ---- Helper: Root-Pfad bestimmen ----
  function detectRoot() {
    const loc = window.location;
    let p = loc.pathname || "/";
    
    console.log("Current pathname:", p);
    
    const segments = p.split('/').filter(s => s.length > 0);
    console.log("Path segments:", segments);
    
    if (segments.length > 0 && segments[0] === 'ball-detection') {
      return '/ball-detection';
    }
    
    if (p.startsWith('/ball-detection')) {
      return '/ball-detection';
    }
    
    return '';
  }
  
  const ROOT = detectRoot(); 
  console.log("Detected ROOT:", ROOT, "from pathname:", window.location.pathname);
  
  const API = (path) => {
    const cleanPath = path.startsWith("/") ? path : "/" + path;
    const fullUrl = `${ROOT}${cleanPath}`;
    console.log("API URL:", fullUrl);
    return fullUrl;
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

  async function refreshGlobalLabeledTotal() {
    if (!globalLabeledCount) return;
    try {
      const r = await fetch(API("/api/stats/labeled-total"));
      if (!r.ok) return;
      const d = await r.json();
      globalLabeledCount.textContent = String(
        typeof d.labeled === "number" ? d.labeled : 0
      );
    } catch (_) {
      globalLabeledCount.textContent = "–";
    }
  }

  function getFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement;
  }

  function updateFsFrameInfo() {
    if (!fsFrameInfo) return;
    if (totalFrames > 0 && currentFrameId >= 1) {
      fsFrameInfo.textContent = `Frame ${currentFrameId}/${totalFrames}`;
    } else {
      fsFrameInfo.textContent = "";
    }
  }

  let isPseudoFullscreen = false;

  function setPseudoFullscreen(on) {
    isPseudoFullscreen = Boolean(on);
    if (labelFullscreenRoot) {
      labelFullscreenRoot.classList.toggle("pseudo-fullscreen", isPseudoFullscreen);
    }
    if (labelFsBar) labelFsBar.style.display = isPseudoFullscreen ? "flex" : "none";
    if (btnLabelFullscreen) btnLabelFullscreen.textContent = isPseudoFullscreen ? "Vollbild aktiv" : "Vollbild";
    if (isPseudoFullscreen) updateFsFrameInfo();
  }

  function onFullscreenChange() {
    const nativeOn = labelFullscreenRoot && getFullscreenElement() === labelFullscreenRoot;
    const on = nativeOn || isPseudoFullscreen;
    if (labelFsBar) labelFsBar.style.display = on ? "flex" : "none";
    if (btnLabelFullscreen) btnLabelFullscreen.textContent = on ? "Vollbild aktiv" : "Vollbild";
    if (on) updateFsFrameInfo();
  }

  async function enterLabelFullscreen() {
    if (!labelFullscreenRoot) return;
    try {
      // Native Fullscreen zuerst versuchen; falls es fehlschlägt (oft Mobile/iOS),
      // verwenden wir einen CSS-Fallback ("Pseudo-Vollbild").
      setPseudoFullscreen(false);

      if (labelFullscreenRoot.requestFullscreen) {
        await labelFullscreenRoot.requestFullscreen();
        return;
      }
      if (labelFullscreenRoot.webkitRequestFullscreen) {
        labelFullscreenRoot.webkitRequestFullscreen();
        return;
      }
    } catch (e) {
      // Fallback
    }

    setPseudoFullscreen(true);
    if (labelStatusDiv) {
      labelStatusDiv.textContent = "Vollbild aktiv (Fallback) – Tipp: Wisch/Buttons funktionieren weiter.";
    }
  }

  async function exitLabelFullscreen() {
    try {
      // Native fullscreen beenden (falls aktiv)
      if (getFullscreenElement()) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
      }
    } catch (_) {}

    // Immer Pseudo-Mode aus
    setPseudoFullscreen(false);
  }

  // ---- UI Elemente ----
  const fileInput = document.getElementById("file-input-local");
  const fpsInput  = document.getElementById("fps-local");
  const taskInput = document.getElementById("task-local");
  const uploadBtn = document.getElementById("btn-upload");
  const dropZone  = document.getElementById("dropZone");
  const statusDiv = document.getElementById("status");
  const btnDownloadImportZip = document.getElementById("btnDownloadImportZip");
  
  const ytUrlInput = document.getElementById("yt-url");
  const fpsYtInput = document.getElementById("fps-yt");
  const taskYtInput = document.getElementById("task-yt");
  const ytBtn = document.getElementById("btn-yt");
  
  const labelCard = document.getElementById("labelCard");
  const taskIdSpan = document.getElementById("taskId");
  const frameCountSpan = document.getElementById("frameCount");
  const imgBox = document.getElementById("imgBox");
  const frameImg = document.getElementById("frameImg");
  const crosshair = document.getElementById("crosshair");
  const boxSizeInput = document.getElementById("boxSize");
  const exportBtn = document.getElementById("exportBtn");
  const exportYoloSplitBtn = document.getElementById("exportYoloSplitBtn");
  const prevBtn = document.getElementById("prevBtn");
  const negativeBtn = document.getElementById("negativeBtn");
  const nextBtn = document.getElementById("nextBtn");
  const labelStatusDiv = document.getElementById("labelStatus");
  const labeledFraction = document.getElementById("labeledFraction");
  const labeledCountWrap = document.getElementById("labeledCountWrap");
  const globalLabeledCount = document.getElementById("globalLabeledCount");
  const labelFullscreenRoot = document.getElementById("labelFullscreenRoot");
  const btnLabelFullscreen = document.getElementById("btnLabelFullscreen");
  const labelFsBar = document.getElementById("labelFsBar");
  const fsExitBtn = document.getElementById("fsExitBtn");
  const fsPrevBtn = document.getElementById("fsPrevBtn");
  const fsNegBtn = document.getElementById("fsNegBtn");
  const fsNextBtn = document.getElementById("fsNextBtn");
  const fsFrameInfo = document.getElementById("fsFrameInfo");

  // ---- State ----
  let currentTaskId = null;
  let currentFrameId = 1;
  let totalFrames = 0;
  let frames = [];

  /** Nach Wisch-Geste „Kein Ball“: verhindert den künstlichen Klick aufs Bild (Mobile). */
  let ignoreImgClickUntil = 0;
  let swipeTouchStartX = null;
  let swipeTouchStartY = null;

  // ---- Event Listeners ----
  uploadBtn.addEventListener("click", handleUpload);
  ytBtn.addEventListener("click", handleYouTube);
  fileInput.addEventListener("change", (e) => {
    if (e.target.files.length > 0) {
      uploadBtn.textContent = `Upload ${e.target.files[0].name}`;
    }
  });

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.style.borderColor = "#22c55e";
  });

  dropZone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dropZone.style.borderColor = "#374151";
  });

  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.style.borderColor = "#374151";
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      fileInput.files = files;
      uploadBtn.textContent = `Upload ${files[0].name}`;
    }
  });

  // ---- Navigation ----
  prevBtn.addEventListener("click", prevFrame);
  if (negativeBtn) negativeBtn.addEventListener("click", saveNegativeAndNext);
  nextBtn.addEventListener("click", nextFrame);
  exportBtn.addEventListener("click", exportZip);
  if (exportYoloSplitBtn) exportYoloSplitBtn.addEventListener("click", exportYoloSplitZip);
  if (btnDownloadImportZip) btnDownloadImportZip.addEventListener("click", downloadImportYoloZip);

  if (btnLabelFullscreen) {
    btnLabelFullscreen.addEventListener("click", () => {
      if (getFullscreenElement() === labelFullscreenRoot || isPseudoFullscreen) exitLabelFullscreen();
      else enterLabelFullscreen();
    });
  }
  if (fsExitBtn) fsExitBtn.addEventListener("click", () => exitLabelFullscreen());
  if (fsPrevBtn) fsPrevBtn.addEventListener("click", () => prevFrame());
  if (fsNegBtn) fsNegBtn.addEventListener("click", () => saveNegativeAndNext());
  if (fsNextBtn) fsNextBtn.addEventListener("click", () => nextFrame());

  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);

  // ---- Keyboard Shortcuts ----
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    
    switch(e.key.toLowerCase()) {
      case 'a': prevFrame(); e.preventDefault(); break;
      case 'd': nextFrame(); e.preventDefault(); break;
      case 's': nextFrame(); e.preventDefault(); break;
      case 'n': saveNegativeAndNext(); e.preventDefault(); break;
    }
  });

  // ---- Smartphone: Wisch rechts → links = „Kein Ball“ (wie Button) ----
  const SWIPE_MIN_DX = 56;
  const SWIPE_MAX_VERTICAL_RATIO = 0.75;

  if (imgBox) {
    imgBox.addEventListener(
      "touchstart",
      (e) => {
        if (!currentTaskId || e.touches.length !== 1) return;
        swipeTouchStartX = e.touches[0].clientX;
        swipeTouchStartY = e.touches[0].clientY;
      },
      { passive: true }
    );

    imgBox.addEventListener(
      "touchend",
      (e) => {
        if (!currentTaskId || swipeTouchStartX == null) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - swipeTouchStartX;
        const dy = t.clientY - swipeTouchStartY;
        swipeTouchStartX = null;
        swipeTouchStartY = null;

        if (
          dx <= -SWIPE_MIN_DX &&
          Math.abs(dy) <= Math.abs(dx) * SWIPE_MAX_VERTICAL_RATIO
        ) {
          e.preventDefault();
          ignoreImgClickUntil = Date.now() + 450;
          saveNegativeAndNext();
        }
      },
      { passive: false }
    );

    imgBox.addEventListener("touchcancel", () => {
      swipeTouchStartX = null;
      swipeTouchStartY = null;
    });
  }

  // ---- Frame Click Handler ----
  frameImg.addEventListener("click", (e) => {
    if (!currentTaskId) return;
    if (Date.now() < ignoreImgClickUntil) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    showClickRing(e.clientX, e.clientY);

    const rect = frameImg.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    saveBallLabel(x, y);
  });

  function hideClickRing() {
    if (!crosshair) return;
    crosshair.classList.remove("ring-flash");
    crosshair.style.display = "none";
  }

  /** Grüner Kreis am Klick, Durchmesser orientiert an „Box (px)“. */
  function showClickRing(clientX, clientY) {
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
    crosshair.classList.remove("ring-flash");
    void crosshair.offsetWidth;
    crosshair.classList.add("ring-flash");
  }

  // ---- Functions ----
  async function handleUpload() {
    const file = fileInput.files[0];
    if (!file) {
      setStatus("Bitte wählen Sie eine Datei aus");
      return;
    }

    const formData = new FormData();
    formData.append("file", file);
    formData.append("fps", fpsInput.value);
    if (taskInput.value) formData.append("task_name", taskInput.value);

    setStatus("Uploading...");
    uploadBtn.disabled = true;

    try {
      const response = await fetch(API("/api/ingest/upload"), {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        setStatus(`❌ Upload fehlgeschlagen (${response.status}): ${await errorTextFromResponse(response)}`);
        return;
      }

      const result = await response.json();

      if (result.task_id) {
        let msg = `✅ Upload erfolgreich! ${result.frames} Frames extrahiert. Task: ${result.task_id}`;
        if (result.meta && result.meta.limited_to_2min) {
          msg += ` ⚠️ Video auf 2 Min begrenzt (Original: ${result.meta.video_duration_total}s).`;
        }
        setStatus(msg);
        startLabeling(result.task_id);
      } else {
        setStatus("❌ Unerwartete Server-Antwort (keine task_id).");
      }
    } catch (error) {
      setStatus(`❌ Upload Fehler: ${error.message}`);
    } finally {
      uploadBtn.disabled = false;
    }
  }

  async function handleYouTube() {
    const url = ytUrlInput.value.trim();
    if (!url) {
      setStatus("Bitte geben Sie eine YouTube-URL ein");
      return;
    }

    const formData = new FormData();
    formData.append("url", url);
    formData.append("fps", fpsYtInput.value);
    if (taskYtInput.value) formData.append("task_name", taskYtInput.value);

    setStatus("YouTube Download...");
    ytBtn.disabled = true;

    try {
      const response = await fetch(API("/api/ingest/youtube"), {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        setStatus(`❌ YouTube (${response.status}): ${await errorTextFromResponse(response)}`);
        return;
      }

      const result = await response.json();

      if (result.task_id) {
        let msg = `✅ YouTube: ${result.frames} Frames. Task: ${result.task_id}`;
        if (result.meta && result.meta.limited_to_2min) {
          msg += ` ⚠️ Auf 2 Min begrenzt (Original: ${result.meta.video_duration_total}s).`;
        }
        setStatus(msg);
        startLabeling(result.task_id);
      } else {
        setStatus("❌ Unerwartete Server-Antwort (keine task_id).");
      }
    } catch (error) {
      setStatus(`❌ YouTube Download Fehler: ${error.message}`);
    } finally {
      ytBtn.disabled = false;
    }
  }

  async function refreshLabeledCount() {
    if (!currentTaskId || !labeledFraction) return;
    try {
      const r = await fetch(API(`/api/task/${currentTaskId}/label-count`));
      if (!r.ok) return;
      const d = await r.json();
      const lab = typeof d.labeled === "number" ? d.labeled : 0;
      const tot = typeof d.total_frames === "number" ? d.total_frames : 0;
      labeledFraction.textContent = `${lab}/${tot}`;
      if (labeledCountWrap) labeledCountWrap.style.visibility = "visible";
    } catch (_) {
      if (labeledFraction) labeledFraction.textContent = "–";
    }
    void refreshGlobalLabeledTotal();
  }

  function startLabeling(taskId) {
    currentTaskId = taskId;
    taskIdSpan.textContent = taskId;
    if (labeledFraction) labeledFraction.textContent = "…";
    if (labeledCountWrap) labeledCountWrap.style.visibility = "visible";

    // Lade Frame-Liste
    loadFrames();
    
    // Zeige Labeling-Interface
    labelCard.style.display = "block";
    labelCard.scrollIntoView({ behavior: "smooth" });
  }

  async function loadFrames() {
    try {
      const response = await fetch(API(`/api/task/${currentTaskId}/frames`));
      if (!response.ok) {
        setStatus(`❌ Frames laden (${response.status}): ${await errorTextFromResponse(response)}`);
        return;
      }
      const result = await response.json();
      frames = Array.isArray(result.frames) ? result.frames : [];
      totalFrames = frames.length;
      frameCountSpan.textContent = totalFrames;

      if (totalFrames > 0) {
        loadFrame(1);
        await refreshLabeledCount();
      } else {
        setStatus("❌ Keine Frames für diesen Task.");
        if (labeledFraction) labeledFraction.textContent = "0/0";
      }
    } catch (error) {
      setStatus(`❌ Fehler beim Laden der Frames: ${error.message}`);
    }
  }

  function loadFrame(frameId) {
    if (frameId < 1 || frameId > totalFrames) return;

    currentFrameId = frameId;
    const filename = frames[frameId - 1];
    if (!filename) return;

    hideClickRing();

    frameImg.src = API(
      `/api/task/${currentTaskId}/frame/${encodeURIComponent(filename)}`
    );
    frameImg.onload = () => {
      setLabelStatus(`Frame ${frameId}/${totalFrames} (${filename})`);
      updateFsFrameInfo();
    };
  }

  async function saveBallLabel(x, y) {
    if (!currentTaskId) return;

    const filename = frames[currentFrameId - 1];
    if (!filename) {
      setLabelStatus("Kein Frame-Dateiname – bitte neu laden.");
      return;
    }

    const nw = frameImg.naturalWidth;
    const nh = frameImg.naturalHeight;
    const cw = frameImg.clientWidth;
    const ch = frameImg.clientHeight;

    if (nw === 0 || nh === 0 || cw === 0 || ch === 0) {
      setLabelStatus("Fehler: Bildgröße konnte nicht ermittelt werden");
      return;
    }

    const cx = (x / cw) * nw;
    const cy = (y / ch) * nh;
    const boxPx = Math.max(2, parseFloat(boxSizeInput.value) * (nw / cw));

    try {
      const response = await fetch(API(`/api/task/${currentTaskId}/label`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, cx, cy, box: boxPx })
      });

      let result = {};
      try {
        result = await response.json();
      } catch (_) {
        /* non-JSON body */
      }

      if (response.ok && result.ok) {
        setLabelStatus(`✅ Ball-Label gespeichert! Frame ${currentFrameId}`);
        refreshLabeledCount();
        setTimeout(() => nextFrame(), 500);
      } else {
        const err =
          result.detail ||
          result.error ||
          (typeof result === "string" ? result : JSON.stringify(result));
        setLabelStatus(`❌ Speichern fehlgeschlagen: ${err || response.status}`);
      }
    } catch (error) {
      setLabelStatus(`❌ Fehler beim Speichern: ${error.message}`);
    }
  }

  function prevFrame() {
    if (currentFrameId > 1) {
      loadFrame(currentFrameId - 1);
    }
  }

  function nextFrame() {
    if (currentFrameId < totalFrames) {
      loadFrame(currentFrameId + 1);
    }
  }

  async function saveNegativeAndNext() {
    if (!currentTaskId) return;

    const filename = frames[currentFrameId - 1];
    if (!filename) {
      setLabelStatus("Kein Frame – bitte neu laden.");
      return;
    }

    hideClickRing();

    if (negativeBtn) negativeBtn.disabled = true;

    try {
      const response = await fetch(API(`/api/task/${currentTaskId}/label/empty`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename })
      });

      let result = {};
      try {
        result = await response.json();
      } catch (_) {
        /* ignore */
      }

      if (response.ok && result.ok) {
        setLabelStatus(`Kein Ball gespeichert (leeres Label): Frame ${currentFrameId}`);
        refreshLabeledCount();
        setTimeout(() => nextFrame(), 250);
      } else {
        const err =
          result.detail ||
          result.error ||
          (typeof result === "string" ? result : JSON.stringify(result));
        setLabelStatus(`❌ Negativ speichern fehlgeschlagen: ${err || response.status}`);
      }
    } catch (error) {
      setLabelStatus(`❌ Negativ: ${error.message}`);
    } finally {
      if (negativeBtn) negativeBtn.disabled = false;
    }
  }

  async function exportZip() {
    if (!currentTaskId) return;
    
    setStatus("Exportiere ZIP...");
    exportBtn.disabled = true;
    
    try {
      const response = await fetch(API(`/api/task/${currentTaskId}/export`));
      
      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${currentTaskId}_labels.zip`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        
        setStatus("✅ ZIP erfolgreich heruntergeladen!");
      } else {
        setStatus("❌ Export fehlgeschlagen");
      }
    } catch (error) {
      setStatus(`❌ Export Fehler: ${error.message}`);
    } finally {
      exportBtn.disabled = false;
    }
  }

  async function exportYoloSplitZip() {
    if (!currentTaskId) return;

    setStatus("Exportiere YOLO Train/Val …");
    if (exportYoloSplitBtn) exportYoloSplitBtn.disabled = true;
    exportBtn.disabled = true;

    try {
      const q = new URLSearchParams({ val_fraction: "0.2", seed: "42" });
      const response = await fetch(
        API(`/api/task/${currentTaskId}/export-yolo-split?${q}`)
      );

      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `spinvo-yolo-${String(currentTaskId).replace(/\//g, "_")}.zip`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        setStatus("✅ YOLO Train/Val-ZIP geladen (images/train|val, labels/train|val).");
      } else {
        setStatus(
          `❌ YOLO-Export (${response.status}): ${await errorTextFromResponse(response)}`
        );
      }
    } catch (error) {
      setStatus(`❌ YOLO-Export: ${error.message}`);
    } finally {
      if (exportYoloSplitBtn) exportYoloSplitBtn.disabled = false;
      exportBtn.disabled = false;
    }
  }

  async function downloadImportYoloZip() {
    setStatus("Lade Import-YOLO-ZIP …");
    if (btnDownloadImportZip) btnDownloadImportZip.disabled = true;
    try {
      const response = await fetch(API("/api/export/import-yolo-zip"));
      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "spinvo-yolo-import.zip";
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        setStatus("✅ Import-ZIP geladen (images/train|val, labels/train|val).");
      } else {
        setStatus(
          `❌ Import-ZIP (${response.status}): ${await errorTextFromResponse(response)}`
        );
      }
    } catch (error) {
      setStatus(`❌ Import-ZIP: ${error.message}`);
    } finally {
      if (btnDownloadImportZip) btnDownloadImportZip.disabled = false;
    }
  }

  function setStatus(message) {
    statusDiv.textContent = message;
    console.log("Status:", message);
  }

  function setLabelStatus(message) {
    labelStatusDiv.textContent = message;
    console.log("Label Status:", message);
  }

  void refreshGlobalLabeledTotal();
})();
