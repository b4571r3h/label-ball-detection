/* static/main_simple.js – Nur Ball-Labeling, kein Table-Labeling */

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

  // ---- UI Elemente ----
  const fileInput = document.getElementById("file-input-local");
  const fpsInput  = document.getElementById("fps-local");
  const taskInput = document.getElementById("task-local");
  const uploadBtn = document.getElementById("btn-upload");
  const dropZone  = document.getElementById("dropZone");
  const statusDiv = document.getElementById("status");
  
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
  const prevBtn = document.getElementById("prevBtn");
  const skipBtn = document.getElementById("skipBtn");
  const nextBtn = document.getElementById("nextBtn");
  const labelStatusDiv = document.getElementById("labelStatus");

  // ---- State ----
  let currentTaskId = null;
  let currentFrameId = 1;
  let totalFrames = 0;
  let frames = [];

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
  skipBtn.addEventListener("click", skipFrame);
  nextBtn.addEventListener("click", nextFrame);
  exportBtn.addEventListener("click", exportZip);

  // ---- Keyboard Shortcuts ----
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    
    switch(e.key.toLowerCase()) {
      case 'a': prevFrame(); e.preventDefault(); break;
      case 'd': nextFrame(); e.preventDefault(); break;
      case 's': skipFrame(); e.preventDefault(); break;
    }
  });

  // ---- Frame Click Handler ----
  frameImg.addEventListener("click", (e) => {
    if (!currentTaskId) return;

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

  function startLabeling(taskId) {
    currentTaskId = taskId;
    taskIdSpan.textContent = taskId;
    
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
      } else {
        setStatus("❌ Keine Frames für diesen Task.");
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

  function skipFrame() {
    nextFrame();
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

  function setStatus(message) {
    statusDiv.textContent = message;
    console.log("Status:", message);
  }

  function setLabelStatus(message) {
    labelStatusDiv.textContent = message;
    console.log("Label Status:", message);
  }

})();
