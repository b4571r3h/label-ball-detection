/* SpinEvo – Man-in-the-Middle Review */

(() => {
  // ---- Root-Pfad ----
  function detectRoot() {
    if ((window.location.hostname || "") === "balls.spinevo.app") return "";
    const p = window.location.pathname || "/";
    if (p.startsWith("/ball-detection")) return "/ball-detection";
    return "";
  }
  const ROOT = detectRoot();
  const API  = (path) => ROOT + (path.startsWith("/") ? path : "/" + path);

  // ---- DOM ----
  const weightsFile      = document.getElementById("weightsFile");
  const btnUploadWeights = document.getElementById("btnUploadWeights");
  const weightsStatus    = document.getElementById("weightsStatus");
  const nFramesInput     = document.getElementById("nFrames");
  const confSlider       = document.getElementById("confSlider");
  const confVal          = document.getElementById("confVal");
  const btnRun           = document.getElementById("btnRun");
  const btnReset         = document.getElementById("btnReset");
  const progressWrap     = document.getElementById("progressWrap");
  const progressBar      = document.getElementById("progressBar");
  const progressText     = document.getElementById("progressText");
  const statusMsg        = document.getElementById("statusMsg");
  const cardReview       = document.getElementById("cardReview");
  const statsRow         = document.getElementById("statsRow");
  const filterTabs       = document.getElementById("filterTabs");
  const frameGrid        = document.getElementById("frameGrid");
  const btnPrev          = document.getElementById("btnPrev");
  const btnNext          = document.getElementById("btnNext");
  const pageInfo         = document.getElementById("pageInfo");
  const linkBack         = document.getElementById("linkBack");
  const btnShareMobile   = document.getElementById("btnShareMobile");
  const shareStatus      = document.getElementById("shareStatus");

  linkBack.href = API("/");

  // ---- Share Mobile Link ----
  btnShareMobile.addEventListener("click", () => {
    const url = "https://balls.spinevo.app/man-in-middle/mobile";
    if (navigator.share) {
      navigator.share({ title: "MitM Review", url });
    } else {
      navigator.clipboard.writeText(url).then(() => {
        shareStatus.textContent = "Link kopiert: " + url;
        shareStatus.style.display = "inline";
        setTimeout(() => { shareStatus.style.display = "none"; }, 3000);
      });
    }
  });

  // ---- State ----
  let currentFilter = "pending";
  let currentOffset = 0;
  const PAGE_SIZE   = 20;
  let totalFrames   = 0;
  let focusedIdx    = 0;   // index within visible cards
  let visibleFrames = [];  // current page frames
  let pollTimer     = null;

  // ---- Conf Slider ----
  confSlider.addEventListener("input", () => {
    confVal.textContent = parseFloat(confSlider.value).toFixed(2);
  });

  // ---- Weights Upload ----
  btnUploadWeights.addEventListener("click", async () => {
    if (!weightsFile.files.length) { setStatus("Bitte eine .pt-Datei wählen."); return; }
    const fd = new FormData();
    fd.append("file", weightsFile.files[0]);
    btnUploadWeights.disabled = true;
    try {
      const r = await fetch(API("/api/man-in-middle/weights"), { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) { setStatus("Upload fehlgeschlagen: " + (d.detail || r.status)); return; }
      weightsStatus.textContent = `✓ ${d.filename} (${d.size_mb} MB)`;
      setStatus("");
    } catch (e) { setStatus("Fehler: " + e.message); }
    finally { btnUploadWeights.disabled = false; }
  });

  // ---- Run ----
  btnRun.addEventListener("click", async () => {
    btnRun.disabled = true;
    setStatus("Starte Job...");
    try {
      const r = await fetch(API("/api/man-in-middle/run"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n_frames: parseInt(nFramesInput.value), conf: parseFloat(confSlider.value) }),
      });
      const d = await r.json();
      if (!r.ok) { setStatus("Fehler: " + (d.detail || r.status)); btnRun.disabled = false; return; }
      startPolling();
    } catch (e) { setStatus("Fehler: " + e.message); btnRun.disabled = false; }
  });

  // ---- Reset ----
  btnReset.addEventListener("click", async () => {
    if (!confirm("Job-Ergebnisse löschen?")) return;
    await fetch(API("/api/man-in-middle/reset"), { method: "POST" });
    stopPolling();
    cardReview.style.display = "none";
    progressWrap.style.display = "none";
    btnReset.style.display = "none";
    btnRun.disabled = false;
    setStatus("Job zurückgesetzt.");
    loadStatus();
  });

  // ---- Polling ----
  function startPolling() {
    stopPolling();
    progressWrap.style.display = "block";
    pollTimer = setInterval(loadStatus, 1500);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function loadStatus() {
    try {
      const r = await fetch(API("/api/man-in-middle/status"));
      const d = await r.json();

      // Weights
      weightsStatus.textContent = d.weights
        ? `✓ Geladen (${d.weights_size_mb} MB)`
        : "Keine Gewichte hochgeladen";

      const status = d.job_status;

      if (status === "running") {
        progressWrap.style.display = "block";
        progressBar.max   = d.total || 1;
        progressBar.value = d.progress;
        progressText.textContent = `${d.progress} / ${d.total} Frames verarbeitet`;
        btnRun.disabled   = true;
        btnReset.style.display = "none";
        setStatus("Inference läuft...");
      } else if (status === "done") {
        stopPolling();
        progressBar.max   = d.total;
        progressBar.value = d.total;
        progressText.textContent = `${d.total} Frames fertig`;
        btnRun.disabled   = false;
        btnReset.style.display = "inline-block";
        setStatus(`Fertig. ${d.stats.total} Frames bereit zur Review.`);
        showReview(d.stats);
        loadReview();
      } else if (status === "error") {
        stopPolling();
        progressWrap.style.display = "none";
        btnRun.disabled   = false;
        btnReset.style.display = "inline-block";
        setStatus("Fehler: " + (d.error || "Unbekannt"));
      } else {
        // idle
        progressWrap.style.display = "none";
        if (d.stats && d.stats.total > 0) {
          btnReset.style.display = "inline-block";
          showReview(d.stats);
          loadReview();
        }
      }
    } catch (e) { /* silent */ }
  }

  // ---- Review ----
  function showReview(stats) {
    cardReview.style.display = "block";
    renderStats(stats);
  }

  function renderStats(stats) {
    statsRow.innerHTML = [
      ["Ausstehend", stats.pending,  "#94a3b8"],
      ["Freigegeben", stats.approved, "#22c55e"],
      ["Übersprungen", stats.skipped, "#64748b"],
      ["Gesamt", stats.total,         "#22d3ee"],
    ].map(([lbl, val, color]) => `
      <div class="metric">
        <div class="metric-val" style="color:${color}">${val}</div>
        <div class="metric-lbl">${lbl}</div>
      </div>`).join("");
  }

  filterTabs.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-filter]");
    if (!tab) return;
    currentFilter = tab.dataset.filter;
    currentOffset = 0;
    focusedIdx    = 0;
    filterTabs.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t === tab));
    loadReview();
  });

  btnPrev.addEventListener("click", () => {
    if (currentOffset > 0) { currentOffset -= PAGE_SIZE; focusedIdx = 0; loadReview(); }
  });
  btnNext.addEventListener("click", () => {
    if (currentOffset + PAGE_SIZE < totalFrames) { currentOffset += PAGE_SIZE; focusedIdx = 0; loadReview(); }
  });

  async function loadReview() {
    try {
      const url = API(`/api/man-in-middle/review?filter=${currentFilter}&offset=${currentOffset}&limit=${PAGE_SIZE}`);
      const r   = await fetch(url);
      const d   = await r.json();
      totalFrames   = d.total;
      visibleFrames = d.frames;
      renderStats(d.stats);
      renderGrid(d.frames);
      const page = Math.floor(currentOffset / PAGE_SIZE) + 1;
      const pages = Math.ceil(d.total / PAGE_SIZE) || 1;
      pageInfo.textContent = `Seite ${page} / ${pages} (${d.total} Frames)`;
      btnPrev.disabled = currentOffset === 0;
      btnNext.disabled = currentOffset + PAGE_SIZE >= d.total;
    } catch (e) { setStatus("Review-Ladefehler: " + e.message); }
  }

  function renderGrid(frames) {
    frameGrid.innerHTML = "";
    if (!frames.length) {
      frameGrid.innerHTML = '<div class="muted" style="padding:12px;">Keine Frames in dieser Ansicht.</div>';
      return;
    }
    frames.forEach((frame, i) => {
      const card = buildCard(frame, i);
      frameGrid.appendChild(card);
    });
    setFocus(focusedIdx);
  }

  function buildCard(frame, idx) {
    const card = document.createElement("div");
    card.className = "frame-card" + (frame.reviewed ? (frame.approved ? " reviewed-approved" : " reviewed-skipped") : "");
    card.dataset.idx = idx;

    // Canvas wrap
    const wrap = document.createElement("div");
    wrap.className = "frame-canvas-wrap";

    const canvas = document.createElement("canvas");
    canvas.className = "frame-canvas";
    wrap.appendChild(canvas);

    // Badges
    if (frame.prediction) {
      const b = document.createElement("div");
      b.className = "conf-badge";
      b.textContent = (frame.prediction.conf * 100).toFixed(0) + "% Ball";
      wrap.appendChild(b);
    } else {
      const b = document.createElement("div");
      b.className = "no-ball-badge";
      b.textContent = "Kein Ball";
      wrap.appendChild(b);
    }
    if (frame.approved) {
      const b = document.createElement("div");
      b.className = "approved-badge";
      b.textContent = "HQ2 ✓";
      wrap.appendChild(b);
    } else if (frame.reviewed) {
      const b = document.createElement("div");
      b.className = "skipped-badge";
      b.textContent = "Übersprungen";
      wrap.appendChild(b);
    }

    card.appendChild(wrap);

    // Info
    const info = document.createElement("div");
    info.className = "frame-info";
    info.title = `${frame.task_id} / ${frame.filename}`;
    info.textContent = `${frame.task_id.split("/").pop()} / ${frame.filename}`;
    card.appendChild(info);

    // Buttons
    const actions = document.createElement("div");
    actions.className = "frame-actions";

    const btnApprove = document.createElement("button");
    btnApprove.className = "btn btn-hq2";
    btnApprove.textContent = "H  Freigeben";
    btnApprove.disabled = frame.approved;
    btnApprove.addEventListener("click", () => approveFrame(frame, idx));

    const btnSkipCard = document.createElement("button");
    btnSkipCard.className = "btn";
    btnSkipCard.textContent = "S  Überspringen";
    btnSkipCard.disabled = frame.reviewed && !frame.approved;
    btnSkipCard.addEventListener("click", () => skipFrame(frame, idx));

    actions.appendChild(btnApprove);
    actions.appendChild(btnSkipCard);
    card.appendChild(actions);

    card.addEventListener("click", () => setFocus(idx));

    // Bild laden + zeichnen
    const imgSrc = API(`/api/eval/frame?source=labeler&task=${encodeURIComponent(frame.task_id)}&filename=${encodeURIComponent(frame.filename)}`);
    drawFrameCanvas(canvas, imgSrc, frame.prediction);

    return card;
  }

  function drawFrameCanvas(canvas, imgSrc, prediction) {
    const img = new Image();
    img.onload = () => {
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      if (prediction) {
        const { x, y, w, h } = prediction;
        const bx = (x - w / 2) * canvas.width;
        const by = (y - h / 2) * canvas.height;
        const bw = w * canvas.width;
        const bh = h * canvas.height;
        ctx.strokeStyle = "#22d3ee";
        ctx.lineWidth   = Math.max(2, canvas.width / 200);
        ctx.strokeRect(bx, by, bw, bh);
        // Conf label background
        const lbl = (prediction.conf * 100).toFixed(0) + "%";
        ctx.font = `bold ${Math.max(12, canvas.width / 30)}px monospace`;
        const tw = ctx.measureText(lbl).width;
        ctx.fillStyle = "#22d3ee";
        ctx.fillRect(bx, by - Math.max(16, canvas.width / 25) - 2, tw + 8, Math.max(16, canvas.width / 25) + 2);
        ctx.fillStyle = "#000";
        ctx.fillText(lbl, bx + 4, by - 4);
      }
    };
    img.src = imgSrc;
  }

  // ---- Approve / Skip ----
  async function approveFrame(frame, idx) {
    try {
      const r = await fetch(API("/api/man-in-middle/approve"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: frame.task_id, filename: frame.filename }),
      });
      if (!r.ok) { const d = await r.json(); setStatus("Fehler: " + (d.detail || r.status)); return; }
      frame.reviewed = true;
      frame.approved = true;
      advanceAfterAction(idx);
    } catch (e) { setStatus("Fehler: " + e.message); }
  }

  async function skipFrame(frame, idx) {
    try {
      const r = await fetch(API("/api/man-in-middle/skip"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: frame.task_id, filename: frame.filename }),
      });
      if (!r.ok) { const d = await r.json(); setStatus("Fehler: " + (d.detail || r.status)); return; }
      frame.reviewed = true;
      frame.approved = false;
      advanceAfterAction(idx);
    } catch (e) { setStatus("Fehler: " + e.message); }
  }

  function advanceAfterAction(idx) {
    // Im pending-Filter: Seite neu laden wenn alle auf Seite reviewed
    const remainingPending = visibleFrames.filter(f => !f.reviewed).length;
    if (currentFilter === "pending" && remainingPending === 0) {
      loadReview();
      return;
    }
    // Nächste Karte fokussieren
    const nextIdx = Math.min(idx + 1, visibleFrames.length - 1);
    loadReview().then(() => setFocus(nextIdx));
  }

  // ---- Focus + Keyboard ----
  function setFocus(idx) {
    focusedIdx = Math.max(0, Math.min(idx, visibleFrames.length - 1));
    frameGrid.querySelectorAll(".frame-card").forEach((c, i) => {
      c.classList.toggle("focused", i === focusedIdx);
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === "h" || e.key === "H") {
      e.preventDefault();
      const frame = visibleFrames[focusedIdx];
      if (frame && !frame.approved) approveFrame(frame, focusedIdx);
    } else if (e.key === "s" || e.key === "S") {
      e.preventDefault();
      const frame = visibleFrames[focusedIdx];
      if (frame && !(frame.reviewed && !frame.approved)) skipFrame(frame, focusedIdx);
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      if (focusedIdx < visibleFrames.length - 1) setFocus(focusedIdx + 1);
      else if (currentOffset + PAGE_SIZE < totalFrames) { currentOffset += PAGE_SIZE; focusedIdx = 0; loadReview(); }
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      if (focusedIdx > 0) setFocus(focusedIdx - 1);
      else if (currentOffset > 0) { currentOffset -= PAGE_SIZE; focusedIdx = PAGE_SIZE - 1; loadReview(); }
    }
  });

  // ---- Helpers ----
  function setStatus(msg) { statusMsg.textContent = msg; }

  // ---- Init ----
  loadStatus();
})();
