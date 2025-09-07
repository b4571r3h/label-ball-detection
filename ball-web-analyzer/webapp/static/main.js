/* Ball Web Analyzer - Main JavaScript */

(() => {
  // ---- Helper: Root-Pfad bestimmen ----
  function detectRoot() {
    const loc = window.location;
    let p = loc.pathname || "/";
    
    console.log("Current pathname:", p);
    
    const segments = p.split('/').filter(s => s.length > 0);
    console.log("Path segments:", segments);
    
    // Wenn der erste Segment "ball-analyzer" ist, verwende das
    if (segments.length > 0 && segments[0] === 'ball-analyzer') {
      return '/ball-analyzer';
    }
    
    // Fallback: Prüfe ob wir direkt unter /ball-analyzer/ sind
    if (p.startsWith('/ball-analyzer')) {
      return '/ball-analyzer';
    }
    
    // Lokale Entwicklung: kein Subpath
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
  const fileInput = document.getElementById("file-input");
  const btnUpload = document.getElementById("btn-upload");
  const ytUrl = document.getElementById("ytUrl");
  const ytBtn = document.getElementById("ytBtn");
  const uploadStatus = document.getElementById("uploadStatus");
  
  const calibrationCard = document.getElementById("calibrationCard");
  const calibrationImg = document.getElementById("calibrationImg");
  const calibrationArea = document.getElementById("calibrationArea");
  const calibrationStatus = document.getElementById("calibrationStatus");
  const resetCalibBtn = document.getElementById("resetCalibBtn");
  const saveCalibBtn = document.getElementById("saveCalibBtn");
  
  const analysisCard = document.getElementById("analysisCard");
  const confidenceSlider = document.getElementById("confidenceSlider");
  const confidenceValue = document.getElementById("confidenceValue");
  const analyzeBtn = document.getElementById("analyzeBtn");
  const analysisStatus = document.getElementById("analysisStatus");
  
  const resultsCard = document.getElementById("resultsCard");
  const analysesList = document.getElementById("analysesList");

  // ---- Globale Variablen ----
  let currentAnalysisId = null;
  let calibrationPoints = [];
  let maxCalibrationPoints = 4;
  let videoInfo = null;

  // ---- Hilfsfunktionen ----
  function setStatus(elementId, message, type = "") {
    const el = document.getElementById(elementId);
    if (el) {
      el.textContent = message;
      el.className = type ? `${type} muted` : "muted";
    }
  }

  function showCard(cardId) {
    document.getElementById(cardId).style.display = "block";
  }

  function hideCard(cardId) {
    document.getElementById(cardId).style.display = "none";
  }

  // ---- Upload-Funktionen ----
  async function uploadVideo() {
    const file = fileInput?.files?.[0];
    if (!file) {
      setStatus("uploadStatus", "Bitte zuerst eine Video-Datei auswählen.", "error");
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    try {
      setStatus("uploadStatus", "Lade Video hoch...");
      const resp = await fetch(API("/api/upload"), {
        method: "POST",
        body: formData,
      });

      if (!resp.ok) {
        const err = await resp.text();
        setStatus("uploadStatus", `Upload-Fehler (${resp.status}): ${err}`, "error");
        return;
      }

      const data = await resp.json();
      setStatus("uploadStatus", `✅ Video hochgeladen! Dauer: ${data.video_info.duration.toFixed(1)}s`, "success");
      
      currentAnalysisId = data.analysis_id;
      videoInfo = data.video_info;
      
      startCalibration();
      
    } catch (e) {
      console.error(e);
      setStatus("uploadStatus", "Unerwarteter Fehler beim Upload.", "error");
    }
  }

  async function loadYouTube() {
    const url = ytUrl?.value?.trim();
    if (!url) {
      setStatus("uploadStatus", "Bitte YouTube-URL eingeben.", "error");
      return;
    }

    const formData = new FormData();
    formData.append("url", url);

    try {
      setStatus("uploadStatus", "Lade YouTube-Video...");
      const resp = await fetch(API("/api/youtube"), {
        method: "POST",
        body: formData,
      });

      if (!resp.ok) {
        const err = await resp.text();
        setStatus("uploadStatus", `YouTube-Fehler (${resp.status}): ${err}`, "error");
        return;
      }

      const data = await resp.json();
      setStatus("uploadStatus", `✅ YouTube-Video geladen! Dauer: ${data.video_info.duration.toFixed(1)}s`, "success");
      
      currentAnalysisId = data.analysis_id;
      videoInfo = data.video_info;
      
      startCalibration();
      
    } catch (e) {
      console.error(e);
      setStatus("uploadStatus", "Unerwarteter Fehler beim YouTube-Load.", "error");
    }
  }

  // ---- Kalibrierungs-Funktionen ----
  async function startCalibration() {
    if (!currentAnalysisId) return;

    try {
      // Erstes Frame laden
      const frameUrl = API(`/api/analysis/${currentAnalysisId}/frame`);
      
      // Warten bis Bild geladen ist
      await new Promise((resolve, reject) => {
        calibrationImg.onload = () => {
          console.log("Calibration image loaded:", {
            naturalWidth: calibrationImg.naturalWidth,
            naturalHeight: calibrationImg.naturalHeight,
            displayWidth: calibrationImg.offsetWidth,
            displayHeight: calibrationImg.offsetHeight
          });
          resolve();
        };
        calibrationImg.onerror = reject;
        calibrationImg.src = frameUrl;
      });
      
      // Kalibrierung zurücksetzen
      resetCalibration();
      
      // Kalibrierungs-Card anzeigen
      showCard("calibrationCard");
      
      setStatus("calibrationStatus", "Klicke Punkt 1: Oben-Links");
      
    } catch (e) {
      console.error(e);
      setStatus("calibrationStatus", "Fehler beim Laden des Frames.", "error");
    }
  }

  function resetCalibration() {
    calibrationPoints = [];
    
    // Bestehende Punkte entfernen
    const existingPoints = calibrationArea.querySelectorAll('.calibPoint');
    existingPoints.forEach(p => p.remove());
    
    updateCalibrationStatus();
  }

  function updateCalibrationStatus() {
    const labels = ["Oben-Links", "Oben-Rechts", "Unten-Rechts", "Unten-Links"];
    
    if (calibrationPoints.length < maxCalibrationPoints) {
      const nextLabel = labels[calibrationPoints.length];
      setStatus("calibrationStatus", `Klicke Punkt ${calibrationPoints.length + 1}: ${nextLabel}`);
      saveCalibBtn.disabled = true;
    } else {
      setStatus("calibrationStatus", "✅ Alle 4 Punkte gesetzt! Kalibrierung speichern.", "success");
      saveCalibBtn.disabled = false;
    }
  }

  function addCalibrationPoint(browserX, browserY) {
    if (calibrationPoints.length >= maxCalibrationPoints) return;
    
    // Koordinaten von Browser-Bild zu Original-Bild umrechnen
    const rect = calibrationImg.getBoundingClientRect();
    const scaleX = calibrationImg.naturalWidth / rect.width;
    const scaleY = calibrationImg.naturalHeight / rect.height;
    
    // Original-Koordinaten berechnen
    const originalX = browserX * scaleX;
    const originalY = browserY * scaleY;
    
    console.log(`Calibration Point ${calibrationPoints.length + 1}:`, {
      browser: [browserX, browserY],
      original: [originalX, originalY],
      scale: [scaleX, scaleY],
      imageSize: [calibrationImg.naturalWidth, calibrationImg.naturalHeight],
      displaySize: [rect.width, rect.height]
    });
    
    // Original-Koordinaten zur Liste hinzufügen (für Backend)
    calibrationPoints.push([originalX, originalY]);
    
    // Visuellen Punkt an Browser-Position erstellen
    const point = document.createElement('div');
    point.className = 'calibPoint';
    point.style.left = `${browserX}px`;
    point.style.top = `${browserY}px`;
    
    // Punkt-Label hinzufügen
    const labels = ["TL", "TR", "BR", "BL"];
    point.textContent = labels[calibrationPoints.length - 1];
    point.style.fontSize = "10px";
    point.style.fontWeight = "bold";
    point.style.color = "white";
    point.style.textAlign = "center";
    point.style.lineHeight = "12px";
    
    // Aktiv-Animation für neuen Punkt
    point.classList.add('active');
    setTimeout(() => point.classList.remove('active'), 2000);
    
    calibrationArea.appendChild(point);
    
    updateCalibrationStatus();
  }

  async function saveCalibration() {
    if (calibrationPoints.length !== 4 || !currentAnalysisId) return;

    try {
      setStatus("calibrationStatus", "Speichere Kalibrierung...");
      
      const resp = await fetch(API(`/api/analysis/${currentAnalysisId}/calibrate`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: calibrationPoints }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        setStatus("calibrationStatus", `Kalibrierungs-Fehler: ${err}`, "error");
        return;
      }

      setStatus("calibrationStatus", "✅ Kalibrierung gespeichert!", "success");
      
      // Analyse-Card anzeigen
      showCard("analysisCard");
      
    } catch (e) {
      console.error(e);
      setStatus("calibrationStatus", "Fehler beim Speichern der Kalibrierung.", "error");
    }
  }

  // ---- Loading Screen Funktionen ----
  function showLoadingScreen() {
    document.getElementById("loadingOverlay").style.display = "flex";
    
    // Reset loading state
    document.getElementById("progressFill").style.width = "0%";
    document.getElementById("progressText").textContent = "0%";
    
    // Reset all steps
    for (let i = 1; i <= 5; i++) {
      const step = document.getElementById(`step${i}`);
      step.className = "step-icon step-pending";
    }
    
    // Start progress simulation
    simulateProgress();
  }

  function hideLoadingScreen() {
    document.getElementById("loadingOverlay").style.display = "none";
  }

  function updateProgress(percentage, stepNum = null) {
    document.getElementById("progressFill").style.width = `${percentage}%`;
    document.getElementById("progressText").textContent = `${Math.round(percentage)}%`;
    
    if (stepNum) {
      // Mark current step as active
      const currentStep = document.getElementById(`step${stepNum}`);
      currentStep.className = "step-icon step-active";
      
      // Mark previous steps as completed
      for (let i = 1; i < stepNum; i++) {
        const prevStep = document.getElementById(`step${i}`);
        prevStep.className = "step-icon step-completed";
        prevStep.textContent = "✓";
      }
    }
  }

  function simulateProgress() {
    // Simuliere realistischen Fortschritt
    const steps = [
      { delay: 1000, progress: 10, step: 1, title: "🔄 YOLO-Modell geladen..." },
      { delay: 5000, progress: 25, step: 2, title: "🎯 Ball-Detektion läuft..." },
      { delay: 15000, progress: 60, step: 3, title: "📊 Analysiere Bounces..." },
      { delay: 5000, progress: 80, step: 4, title: "🔥 Erstelle Heatmap..." },
      { delay: 3000, progress: 95, step: 5, title: "🎬 Generiere Preview..." }
    ];

    let totalDelay = 0;
    steps.forEach((step, index) => {
      totalDelay += step.delay;
      
      setTimeout(() => {
        updateProgress(step.progress, step.step);
        document.getElementById("loadingTitle").textContent = step.title;
      }, totalDelay);
    });
  }

  // ---- Analyse-Funktionen ----
  async function analyzeVideo() {
    if (!currentAnalysisId) return;

    const confidence = parseFloat(confidenceSlider.value);
    
    const formData = new FormData();
    formData.append("confidence", confidence.toString());

    try {
      // Loading Screen anzeigen
      showLoadingScreen();
      analyzeBtn.disabled = true;
      
      const resp = await fetch(API(`/api/analysis/${currentAnalysisId}/analyze`), {
        method: "POST",
        body: formData,
      });

      if (!resp.ok) {
        hideLoadingScreen();
        const err = await resp.text();
        setStatus("analysisStatus", `Analyse-Fehler: ${err}`, "error");
        return;
      }

      const result = await resp.json();
      
      // Finalize progress
      updateProgress(100, 5);
      document.getElementById("loadingTitle").textContent = "✅ Analyse abgeschlossen!";
      
      // Kurz warten, dann Loading Screen verstecken
      setTimeout(() => {
        hideLoadingScreen();
        setStatus("analysisStatus", "✅ Analyse abgeschlossen!", "success");
        
        // Ergebnisse anzeigen
        showResults();
      }, 1500);
      
    } catch (e) {
      console.error(e);
      hideLoadingScreen();
      setStatus("analysisStatus", "Fehler bei der Analyse.", "error");
    } finally {
      analyzeBtn.disabled = false;
    }
  }

  async function showResults() {
    if (!currentAnalysisId) return;

    showCard("resultsCard");

    // Heatmap laden
    const heatmapImg = document.getElementById("heatmapImg");
    const heatmapResult = document.getElementById("heatmapResult");
    const downloadHeatmap = document.getElementById("downloadHeatmap");
    
    const heatmapUrl = API(`/api/analysis/${currentAnalysisId}/heatmap`);
    heatmapImg.src = heatmapUrl;
    downloadHeatmap.href = heatmapUrl;
    heatmapResult.style.display = "block";

    // Preview-Video laden
    const previewVideo = document.getElementById("previewVideo");
    const previewResult = document.getElementById("previewResult");
    
    const previewUrl = API(`/api/analysis/${currentAnalysisId}/preview`);
    previewVideo.src = previewUrl;
    previewResult.style.display = "block";

    // CSV laden
    const csvResult = document.getElementById("csvResult");
    const downloadCsv = document.getElementById("downloadCsv");
    
    const csvUrl = API(`/api/analysis/${currentAnalysisId}/csv`);
    downloadCsv.href = csvUrl;
    csvResult.style.display = "block";
    
    // CSV-Preview laden (erste paar Zeilen)
    try {
      const csvResp = await fetch(csvUrl);
      if (csvResp.ok) {
        const csvText = await csvResp.text();
        const lines = csvText.split('\n').slice(0, 5);
        document.getElementById("csvPreview").textContent = 
          `${lines.length} Zeilen Preview:\n${lines.join('\n')}`;
      }
    } catch (e) {
      console.warn("Konnte CSV-Preview nicht laden:", e);
    }
  }

  // ---- Verlauf laden ----
  async function loadAnalysesHistory() {
    try {
      const resp = await fetch(API("/api/analyses"));
      if (!resp.ok) return;

      const data = await resp.json();
      const analyses = data.analyses || [];

      if (analyses.length === 0) {
        analysesList.textContent = "Noch keine Analysen vorhanden.";
        return;
      }

      analysesList.innerHTML = "";
      
      analyses.forEach(analysis => {
        const item = document.createElement("div");
        item.style.cssText = "padding:8px; border:1px solid #374151; border-radius:8px; margin-bottom:8px;";
        
        const created = new Date(analysis.created).toLocaleString('de-DE');
        const source = analysis.source === 'youtube' ? '📺 YouTube' : '📁 Upload';
        const duration = analysis.video_info ? `${analysis.video_info.duration.toFixed(1)}s` : 'N/A';
        
        item.innerHTML = `
          <div><strong>${source}</strong> - ${created}</div>
          <div class="muted">ID: ${analysis.analysis_id} | Dauer: ${duration}</div>
          <div style="margin-top:4px;">
            <a href="${API(`/api/analysis/${analysis.analysis_id}/heatmap`)}" class="btn" style="padding:4px 8px; font-size:12px;" target="_blank">Heatmap</a>
            <a href="${API(`/api/analysis/${analysis.analysis_id}/csv`)}" class="btn" style="padding:4px 8px; font-size:12px;" download>CSV</a>
          </div>
        `;
        
        analysesList.appendChild(item);
      });
      
    } catch (e) {
      console.error(e);
      analysesList.textContent = "Fehler beim Laden der Analysen.";
    }
  }

  // ---- Event-Listener ----
  if (btnUpload) btnUpload.addEventListener("click", uploadVideo);
  if (ytBtn) ytBtn.addEventListener("click", loadYouTube);
  if (resetCalibBtn) resetCalibBtn.addEventListener("click", resetCalibration);
  if (saveCalibBtn) saveCalibBtn.addEventListener("click", saveCalibration);
  if (analyzeBtn) analyzeBtn.addEventListener("click", analyzeVideo);

  // Konfidenz-Slider
  if (confidenceSlider && confidenceValue) {
    confidenceSlider.addEventListener("input", (e) => {
      confidenceValue.textContent = e.target.value;
    });
  }

  // Kalibrierung: Klick auf Bild
  if (calibrationImg) {
    calibrationImg.addEventListener("click", (e) => {
      const rect = e.target.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      addCalibrationPoint(x, y);
    });
  }

  // ---- Initialisierung ----
  loadAnalysesHistory();
  
  console.log("Ball Web Analyzer initialized!");
})();
