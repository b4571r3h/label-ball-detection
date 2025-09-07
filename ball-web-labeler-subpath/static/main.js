/* static/main.js – robust upload + subpath aware + safe SW */

(() => {
  // ---- Helper: Root-Pfad bestimmen (z.B. /ball-detection) ----
  function detectRoot() {
    // Wir mounten die App unter APP_ROOT_PATH in FastAPI.
    const loc = window.location;
    let p = loc.pathname || "/";
    
    console.log("Current pathname:", p);
    
    // Wenn wir uns in einem Subpath befinden, extrahiere den ersten Pfad-Teil
    // z.B. "/ball-detection/" -> "/ball-detection"
    // z.B. "/ball-detection/static/index.html" -> "/ball-detection"  
    const segments = p.split('/').filter(s => s.length > 0);
    
    console.log("Path segments:", segments);
    
    // Wenn der erste Segment "ball-detection" ist, verwende das
    if (segments.length > 0 && segments[0] === 'ball-detection') {
      return '/ball-detection';
    }
    
    // Fallback: Prüfe ob wir direkt unter /ball-detection/ sind
    if (p.startsWith('/ball-detection')) {
      return '/ball-detection';
    }
    
    // Lokale Entwicklung: kein Subpath
    return '';
  }
  
  const ROOT = detectRoot(); 
  console.log("Detected ROOT:", ROOT, "from pathname:", window.location.pathname);
  
  // TEMPORÄRER FIX: Falls Auto-Detection nicht funktioniert
  // const ROOT = ""; // Für lokale Entwicklung
  // const ROOT = "/ball-detection"; // Für Docker-Deployment
  
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
  const btnUpload = document.getElementById("btn-upload");

  const ytUrl     = document.getElementById("yt-url");
  const ytFps     = document.getElementById("fps-yt");
  const ytTask    = document.getElementById("task-yt");
  const btnYt     = document.getElementById("btn-yt");

  const statusEl  = document.getElementById("status");

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg ?? "";
  }

  // ---- Labeling Interface aktivieren ----
  function startLabeling(taskId, frameCount) {
    // Ingest-Card verstecken, Label-Card anzeigen
    const ingestCard = document.getElementById("ingestCard");
    const labelCard = document.getElementById("labelCard");
    const taskIdEl = document.getElementById("taskId");
    const frameCountEl = document.getElementById("frameCount");
    
    if (ingestCard) ingestCard.style.display = "none";
    if (labelCard) labelCard.style.display = "block";
    if (taskIdEl) taskIdEl.textContent = taskId;
    if (frameCountEl) frameCountEl.textContent = frameCount;
    
    // Labeling-Logik initialisieren
    initLabeling(taskId);
  }

  // ---- Labeling-Logik ----
  let currentTask = null;
  let currentFrames = [];
  let currentFrameIndex = 0;

  async function initLabeling(taskId) {
    try {
      currentTask = taskId;
      
      // Frame-Liste vom Backend holen
      const resp = await fetch(API(`/api/task/${taskId}/frames`));
      if (!resp.ok) {
        setStatus(`Fehler beim Laden der Frames: ${resp.status}`);
        return;
      }
      
      const data = await resp.json();
      currentFrames = data.frames || [];
      currentFrameIndex = 0;
      
      console.log("Frames geladen:", {taskId, frameCount: currentFrames.length, frames: currentFrames.slice(0, 5)});
      
      if (currentFrames.length === 0) {
        setStatus("Keine Frames gefunden.");
        return;
      }
      
      // Erstes Frame laden
      setStatus("Lade erstes Frame...");
      loadCurrentFrame();
      updateLabelStatus();
      
    } catch (e) {
      console.error("Fehler beim Initialisieren des Labelings:", e);
      setStatus("Fehler beim Laden der Frames.");
    }
  }

  function loadCurrentFrame() {
    if (!currentTask || !currentFrames[currentFrameIndex]) {
      console.log("loadCurrentFrame: Missing task or frame", {currentTask, currentFrameIndex, framesLength: currentFrames.length});
      return;
    }
    
    const frameImg = document.getElementById("frameImg");
    const filename = currentFrames[currentFrameIndex];
    const frameUrl = API(`/api/task/${currentTask}/frame/${filename}`);
    
    console.log("Loading frame:", {filename, frameUrl, currentTask, currentFrameIndex});
    
    if (frameImg) {
      frameImg.src = frameUrl;
      frameImg.alt = `Frame ${currentFrameIndex + 1} / ${currentFrames.length}`;
      
      // Debug: Event-Listener für Lade-Erfolg/Fehler
      frameImg.onload = () => {
        console.log("Frame erfolgreich geladen:", frameUrl);
        setStatus(`Frame ${currentFrameIndex + 1} / ${currentFrames.length} - Klicke auf den Ball!`);
        setupImageInteraction();
      };
      
      frameImg.onerror = () => {
        console.error("Fehler beim Laden des Frames:", frameUrl);
        setStatus(`Fehler beim Laden von Frame ${currentFrameIndex + 1}`);
      };
    } else {
      console.error("frameImg Element nicht gefunden!");
    }
  }

  // ---- Ball-Markierungen anzeigen ----
  function setupImageInteraction() {
    const frameImg = document.getElementById("frameImg");
    
    if (!frameImg) return;
    
    // Cursor-Style für bessere UX
    frameImg.style.cursor = "crosshair";
    
    // Bestehende Ball-Markierung für aktuelles Frame laden (falls vorhanden)
    loadExistingLabel();
  }

  function showBallMarker(relX, relY) {
    const frameImg = document.getElementById("frameImg");
    const crosshair = document.getElementById("crosshair");
    
    if (!frameImg || !crosshair) return;
    
    // Absolute Koordinaten berechnen
    const rect = frameImg.getBoundingClientRect();
    const x = relX * frameImg.offsetWidth;
    const y = relY * frameImg.offsetHeight;
    
    // Crosshair positionieren und anzeigen
    crosshair.style.left = `${x}px`;
    crosshair.style.top = `${y}px`;
    crosshair.style.display = "block";
  }

  function hideBallMarker() {
    const crosshair = document.getElementById("crosshair");
    if (crosshair) {
      crosshair.style.display = "none";
    }
  }

  // TODO: Bestehende Labels laden (für bereits markierte Frames)
  function loadExistingLabel() {
    // Hier könnten wir später prüfen, ob das aktuelle Frame bereits markiert ist
    // und die Markierung anzeigen
    hideBallMarker();
  }

  function updateLabelStatus() {
    const labelStatus = document.getElementById("labelStatus");
    if (labelStatus) {
      labelStatus.textContent = `Frame ${currentFrameIndex + 1} / ${currentFrames.length}`;
    }
  }

  // ---- Upload lokaler Datei ----
  async function uploadLocal() {
    try {
      const f = fileInput?.files?.[0];
      if (!f) {
        setStatus("Bitte zuerst eine Videodatei auswählen.");
        return;
      }
      const fps = parseInt(fpsInput?.value || "0", 10) || 0;
      const task = (taskInput?.value || "").trim();

      const fd = new FormData();
      fd.append("file", f);         // MUSS 'file' heißen (Backend erwartet das)
      if (fps > 0)  fd.append("fps", String(fps));
      if (task)     fd.append("task", task);

      setStatus("Lade hoch & extrahiere Frames …");
      const resp = await fetch(API("/api/ingest/upload"), {
        method: "POST",
        body: fd, // KEIN Content-Type setzen, Browser macht multipart/form-data
      });

      if (!resp.ok) {
        // Fehlermeldung des Backends anzeigen
        let err = "";
        try { err = await resp.text(); } catch {}
        setStatus(`Fehler beim Upload (${resp.status}): ${err}`);
        return;
      }

      const data = await resp.json().catch(() => ({}));
      if (data.task_id && data.frames) {
        // Erfolgreicher Upload - zum Labeling wechseln
        setStatus(`✅ Upload erfolgreich! ${data.frames} Frames extrahiert.`);
        startLabeling(data.task_id, data.frames);
      } else {
        setStatus(data.status === "ok" ? "Bereit." : JSON.stringify(data));
      }
    } catch (e) {
      console.error(e);
      setStatus("Unerwarteter Fehler beim Upload. Siehe Konsole.");
    }
  }

  // ---- YouTube-Ingest ----
  async function ingestYouTube() {
    try {
      const url = (ytUrl?.value || "").trim();
      if (!url) {
        setStatus("Bitte eine YouTube-URL einfügen.");
        return;
      }
      const fps = parseInt(ytFps?.value || "0", 10) || 0;
      const task = (ytTask?.value || "").trim();

      const body = { url };
      if (fps > 0) body.fps = fps;
      if (task) body.task = task;

      setStatus("YouTube-Video wird geladen & Frames werden extrahiert …");
      const resp = await fetch(API("/api/ingest/youtube"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        let err = "";
        try { err = await resp.text(); } catch {}
        setStatus(`Fehler beim YouTube-Ingest (${resp.status}): ${err}`);
        return;
      }
      const data = await resp.json().catch(() => ({}));
      if (data.task_id && data.frames) {
        // Erfolgreicher YouTube-Ingest - zum Labeling wechseln
        setStatus(`✅ YouTube-Ingest erfolgreich! ${data.frames} Frames extrahiert.`);
        startLabeling(data.task_id, data.frames);
      } else {
        setStatus(data.status === "ok" ? "Bereit." : JSON.stringify(data));
      }
    } catch (e) {
      console.error(e);
      setStatus("Unerwarteter Fehler beim YouTube-Ingest. Siehe Konsole.");
    }
  }

  // ---- Navigation-Funktionen ----
  function prevFrame() {
    if (currentFrameIndex > 0) {
      currentFrameIndex--;
      loadCurrentFrame();
      updateLabelStatus();
    }
  }

  function nextFrame() {
    if (currentFrameIndex < currentFrames.length - 1) {
      currentFrameIndex++;
      loadCurrentFrame();
      updateLabelStatus();
    }
  }

  function skipFrame() {
    // Wie nextFrame(), aber könnte später für Skip-Logik erweitert werden
    nextFrame();
  }

  // ---- Ball-Labeling ----
  async function labelBall(x, y) {
    if (!currentTask || !currentFrames[currentFrameIndex]) return;
    
    const frameImg = document.getElementById("frameImg");
    const boxSize = parseInt(document.getElementById("boxSize")?.value || "24");
    
    if (!frameImg) return;
    
    // Relative Koordinaten berechnen (0-1)
    const rect = frameImg.getBoundingClientRect();
    const relX = (x - rect.left) / rect.width;
    const relY = (y - rect.top) / rect.height;
    
    const filename = currentFrames[currentFrameIndex];
    
    try {
      // Backend erwartet absolute Pixel-Koordinaten
      const rect = frameImg.getBoundingClientRect();
      const absX = relX * frameImg.naturalWidth;
      const absY = relY * frameImg.naturalHeight;
      
      const resp = await fetch(API(`/api/task/${currentTask}/label`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: filename,
          cx: absX,
          cy: absY,
          box: boxSize
        }),
      });
      
      if (!resp.ok) {
        setStatus(`Fehler beim Speichern: ${resp.status}`);
        return;
      }
      
      const data = await resp.json();
      setStatus(`✅ Ball markiert in ${filename} - Frame ${currentFrameIndex + 1}/${currentFrames.length}`);
      
      // Ball-Markierung anzeigen
      showBallMarker(relX, relY);
      
      // Automatisch zum nächsten Frame
      setTimeout(() => {
        nextFrame();
      }, 800);
      
    } catch (e) {
      console.error("Fehler beim Ball-Labeling:", e);
      setStatus("Fehler beim Speichern der Ball-Position.");
    }
  }

  // ---- Events binden ----
  if (btnUpload) btnUpload.addEventListener("click", (e) => {
    e.preventDefault();
    uploadLocal();
  });
  if (btnYt) btnYt.addEventListener("click", (e) => {
    e.preventDefault();
    ingestYouTube();
  });

  // Navigation-Buttons
  const prevBtn = document.getElementById("prevBtn");
  const nextBtn = document.getElementById("nextBtn");
  const skipBtn = document.getElementById("skipBtn");

  if (prevBtn) prevBtn.addEventListener("click", prevFrame);
  if (nextBtn) nextBtn.addEventListener("click", nextFrame);
  if (skipBtn) skipBtn.addEventListener("click", skipFrame);

  // Ball-Labeling: Klick auf Bild
  document.addEventListener("click", (e) => {
    if (currentTask && e.target && e.target.id === "frameImg") {
      e.preventDefault();
      labelBall(e.clientX, e.clientY);
    }
  });

  // Ball-Labeling: Touch für Smartphones
  document.addEventListener("touchstart", (e) => {
    if (currentTask && e.target && e.target.id === "frameImg") {
      e.preventDefault();
      if (e.touches.length > 0) {
        const touch = e.touches[0];
        labelBall(touch.clientX, touch.clientY);
      }
    }
  });

  // Tastatur-Shortcuts
  document.addEventListener("keydown", (e) => {
    if (currentTask) { // Nur aktiv wenn Labeling läuft
      switch(e.key.toLowerCase()) {
        case 'a': prevFrame(); e.preventDefault(); break;
        case 'd': nextFrame(); e.preventDefault(); break;
        case 's': skipFrame(); e.preventDefault(); break;
      }
    }
  });

  // ---- Service Worker nur, wenn erlaubt (https/secure) ----
  try {
    if ("serviceWorker" in navigator && window.isSecureContext) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register(`${ROOT}/sw.js`).catch(() => {});
      });
    }
  } catch {
    // ignorieren – nicht kritisch
  }

  // Init
  setStatus("Bereit.");
})();
