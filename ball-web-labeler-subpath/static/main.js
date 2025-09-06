/* static/main.js – robust upload + subpath aware + safe SW */

(() => {
  // ---- Helper: Root-Pfad bestimmen (z.B. /ball-detection) ----
  function detectRoot() {
    // Wir mounten die App unter APP_ROOT_PATH in FastAPI.
    // Der <base>-Tag in index.html sorgt oft schon für richtige URLs.
    // Fallback: nimm den ersten Path-Segment.
    const loc = window.location;
    let p = loc.pathname || "/";
    // alles nach dem ersten leeren Segment entfernen, damit /ball-detection bleibt
    // Beispiel: "/ball-detection/" -> "/ball-detection"
    if (p.endsWith("/")) p = p.slice(0, -1);
    if (!p) p = "/";
    return p === "" ? "/" : p;
  }
  const ROOT = detectRoot(); // z.B. "/ball-detection"
  const API = (path) => `${ROOT}${path.startsWith("/") ? path : "/" + path}`;

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
      setStatus(data.status === "ok" ? "Bereit." : JSON.stringify(data));
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
      setStatus(data.status === "ok" ? "Bereit." : JSON.stringify(data));
    } catch (e) {
      console.error(e);
      setStatus("Unerwarteter Fehler beim YouTube-Ingest. Siehe Konsole.");
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
