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
    
    const rect = frameImg.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Ball-Labeling: Speichere Ball-Position
    saveBallLabel(x, y);
  });

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
      const response = await fetch(API("/api/upload"), {
        method: "POST",
        body: formData
      });

      const result = await response.json();
      
      if (result.success) {
        setStatus(`✅ Upload erfolgreich! Task: ${result.task_id}`);
        startLabeling(result.task_id);
      } else {
        setStatus(`❌ Upload fehlgeschlagen: ${result.error}`);
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
        const errorText = await response.text();
        setStatus(`❌ YouTube Download Fehler (${response.status}): ${errorText}`);
        return;
      }

      const result = await response.json();
      
      if (result.success) {
        setStatus(`✅ YouTube Download erfolgreich! Task: ${result.task_id}`);
        startLabeling(result.task_id);
      } else {
        setStatus(`❌ YouTube Download fehlgeschlagen: ${result.error}`);
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
      const result = await response.json();
      
      if (result.success) {
        frames = result.frames;
        totalFrames = frames.length;
        frameCountSpan.textContent = totalFrames;
        
        if (totalFrames > 0) {
          loadFrame(1);
        }
      } else {
        setStatus(`❌ Fehler beim Laden der Frames: ${result.error}`);
      }
    } catch (error) {
      setStatus(`❌ Fehler beim Laden der Frames: ${error.message}`);
    }
  }

  function loadFrame(frameId) {
    if (frameId < 1 || frameId > totalFrames) return;
    
    currentFrameId = frameId;
    const frame = frames[frameId - 1];
    
    frameImg.src = API(`/api/task/${currentTaskId}/frame/${frameId}`);
    frameImg.onload = () => {
      setLabelStatus(`Frame ${frameId}/${totalFrames}`);
    };
  }

  async function saveBallLabel(x, y) {
    if (!currentTaskId) return;
    
    const imgWidth = frameImg.naturalWidth;
    const imgHeight = frameImg.naturalHeight;
    
    if (imgWidth === 0 || imgHeight === 0) {
      setLabelStatus("Fehler: Bildgröße konnte nicht ermittelt werden");
      return;
    }
    
    // Normalisiere Koordinaten
    const normX = (x / frameImg.clientWidth) * (imgWidth / imgWidth);
    const normY = (y / frameImg.clientHeight) * (imgHeight / imgHeight);
    const normW = (boxSizeInput.value / frameImg.clientWidth) * (imgWidth / imgWidth);
    const normH = (boxSizeInput.value / frameImg.clientHeight) * (imgHeight / imgHeight);
    
    const yoloLabel = `0 ${normX.toFixed(6)} ${normY.toFixed(6)} ${normW.toFixed(6)} ${normH.toFixed(6)}`;
    
    try {
      const response = await fetch(API("/api/save-label"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_id: currentTaskId,
          frame_id: currentFrameId,
          label: yoloLabel
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        setLabelStatus(`✅ Ball-Label gespeichert! Frame ${currentFrameId}`);
        // Automatisch zum nächsten Frame
        setTimeout(() => nextFrame(), 500);
      } else {
        setLabelStatus(`❌ Fehler beim Speichern: ${result.error}`);
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
