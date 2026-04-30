(() => {
  function detectRoot() {
    if ((window.location.hostname || "") === "balls.spinevo.app") return "";
    const p = window.location.pathname || "/";
    if (p.startsWith("/ball-detection")) return "/ball-detection";
    return "";
  }
  const ROOT = detectRoot();
  const API = (path) => `${ROOT}${path.startsWith("/") ? path : "/" + path}`;

  // Farben pro Modell (bis zu 4)
  const MODEL_COLORS = ["#22d3ee", "#f97316", "#a78bfa", "#f43f5e"];

  // ---- DOM ----
  const modelList     = document.getElementById("modelList");
  const uploadZone    = document.getElementById("uploadZone");
  const fileInput     = document.getElementById("fileInput");
  const uploadStatus  = document.getElementById("uploadStatus");
  const chkLabeler    = document.getElementById("chkLabeler");
  const chkImport     = document.getElementById("chkImport");
  const confSlider    = document.getElementById("confSlider");
  const confVal       = document.getElementById("confVal");
  const btnRun        = document.getElementById("btnRun");
  const statusMsg     = document.getElementById("statusMsg");
  const progressWrap  = document.getElementById("progressWrap");
  const progressBar   = document.getElementById("progressBar");
  const progressLabel = document.getElementById("progressLabel");
  const resultsSection = document.getElementById("resultsSection");
  const statsSection  = document.getElementById("statsSection");
  const filterTabs    = document.querySelectorAll(".tab[data-filter]");
  const modelFilter   = document.getElementById("modelFilter");
  const resultsList   = document.getElementById("resultsList");
  const paginationWrap = document.getElementById("paginationWrap");
  const btnPrevPage   = document.getElementById("btnPrevPage");
  const btnNextPage   = document.getElementById("btnNextPage");
  const pageInfo      = document.getElementById("pageInfo");
  const totalInfo     = document.getElementById("totalInfo");
  const viewerWrap    = document.getElementById("viewerWrap");
  const viewerImg     = document.getElementById("viewerImg");
  const viewerCanvas  = document.getElementById("viewerCanvas");
  const viewerFilename = document.getElementById("viewerFilename");
  const viewerVerdicts = document.getElementById("viewerVerdicts");
  const viewerLegend  = document.getElementById("viewerLegend");
  const btnViewerPrev  = document.getElementById("btnViewerPrev");
  const btnViewerNext  = document.getElementById("btnViewerNext");
  const btnHq          = document.getElementById("btnHq");
  const jobList        = document.getElementById("jobList");
  const btnRefreshJobs = document.getElementById("btnRefreshJobs");

  // ---- State ----
  let availableModels  = [];    // alle .pt Namen auf dem Server
  let selectedModels   = [];    // max. 2 ausgewählt (Checkboxen)
  let allResults       = [];    // Roh-Ergebnisse vom Server
  let filteredResults  = [];    // nach aktuellem Filter
  let currentFilter    = "all";
  let currentModelKey  = "";    // welches Modell für Filterung maßgeblich
  let currentPage      = 0;
  const PAGE_SIZE      = 30;
  let selectedIndex    = -1;    // Index in filteredResults
  let pollTimer        = null;
  let currentHQ        = false;

  // ---- Konfidenz-Slider ----
  confSlider.addEventListener("input", () => {
    confVal.textContent = (parseInt(confSlider.value) / 100).toFixed(2);
  });

  // ---- Modell-Liste laden ----
  async function loadModels() {
    const r = await fetch(API("/api/eval/models"));
    if (!r.ok) return;
    const d = await r.json();
    availableModels = d.models || [];
    renderModelList();
  }

  function renderModelList() {
    modelList.innerHTML = "";
    if (availableModels.length === 0) {
      modelList.innerHTML = '<div class="muted" style="font-size:13px;">Noch keine Modelle. Bitte .pt-Datei hochladen.</div>';
      return;
    }
    availableModels.forEach((name, i) => {
      const color = MODEL_COLORS[i % MODEL_COLORS.length];
      const checked = selectedModels.includes(name);
      const div = document.createElement("div");
      div.className = "model-item";
      div.innerHTML = `
        <input type="checkbox" id="chk_${i}" value="${name}" ${checked ? "checked" : ""} />
        <div class="model-color" style="background:${color};"></div>
        <label class="model-name" for="chk_${i}">${name}</label>
        <button class="btn btn-danger btn-sm" data-del="${name}">✕</button>
      `;
      div.querySelector(`#chk_${i}`).addEventListener("change", onModelCheckChange);
      div.querySelector("[data-del]").addEventListener("click", async (e) => {
        const n = e.currentTarget.dataset.del;
        await fetch(API(`/api/eval/models/${encodeURIComponent(n)}`), { method: "DELETE" });
        selectedModels = selectedModels.filter(m => m !== n);
        await loadModels();
      });
      modelList.appendChild(div);
    });
    // Selektion aktualisieren
    selectedModels = selectedModels.filter(m => availableModels.includes(m));
    // Wenn noch keines ausgewählt, erste beiden vorauswählen
    if (selectedModels.length === 0) {
      selectedModels = availableModels.slice(0, 2);
      renderModelList();
    }
  }

  function onModelCheckChange() {
    selectedModels = Array.from(modelList.querySelectorAll("input[type=checkbox]:checked"))
      .map(c => c.value);
    if (selectedModels.length > 2) {
      // Älteste Auswahl entfernen: neueste behalten
      selectedModels = selectedModels.slice(-2);
      renderModelList();
    }
  }

  // ---- Upload ----
  uploadZone.addEventListener("click", () => fileInput.click());
  uploadZone.addEventListener("dragover", e => { e.preventDefault(); uploadZone.style.borderColor = "var(--accent)"; });
  uploadZone.addEventListener("dragleave", () => { uploadZone.style.borderColor = ""; });
  uploadZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    uploadZone.style.borderColor = "";
    const file = e.dataTransfer.files[0];
    if (file) await uploadFile(file);
  });
  fileInput.addEventListener("change", async () => {
    if (fileInput.files[0]) await uploadFile(fileInput.files[0]);
    fileInput.value = "";
  });

  async function uploadFile(file) {
    if (!file.name.endsWith(".pt")) { uploadStatus.textContent = "Nur .pt-Dateien erlaubt."; return; }
    uploadStatus.textContent = `Lade hoch: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)…`;
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch(API("/api/eval/models"), { method: "POST", body: fd });
    if (!r.ok) { uploadStatus.textContent = "Upload fehlgeschlagen."; return; }
    uploadStatus.textContent = `✓ ${file.name} hochgeladen.`;
    await loadModels();
  }

  // ---- Eval starten ----
  btnRun.addEventListener("click", async () => {
    if (selectedModels.length === 0) { statusMsg.textContent = "Bitte mindestens ein Modell wählen."; return; }
    if (!chkLabeler.checked && !chkImport.checked) { statusMsg.textContent = "Bitte mindestens einen Datensatz wählen."; return; }

    btnRun.disabled = true;
    statusMsg.textContent = "Starte Job…";
    progressWrap.style.display = "block";
    progressBar.value = 0;
    progressLabel.textContent = "";
    resultsSection.style.display = "none";

    const body = {
      models: selectedModels,
      conf: parseInt(confSlider.value) / 100,
      include_labeler: chkLabeler.checked,
      include_import: chkImport.checked,
    };

    const r = await fetch(API("/api/eval/run"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      statusMsg.textContent = `Fehler: ${err.detail || r.status}`;
      btnRun.disabled = false;
      return;
    }
    const { job_id } = await r.json();
    statusMsg.textContent = `Job läuft (${job_id})…`;
    pollJob(job_id);
  });

  function pollJob(job_id) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      const r = await fetch(API(`/api/eval/status/${job_id}`));
      if (!r.ok) return;
      const d = await r.json();

      if (d.total > 0) {
        const pct = Math.round(d.progress / d.total * 100);
        progressBar.value = pct;
        progressLabel.textContent = `${d.progress} / ${d.total} Frames (${pct} %)`;
      }

      if (d.status === "done") {
        clearInterval(pollTimer);
        statusMsg.textContent = "✓ Fertig.";
        btnRun.disabled = false;
        progressWrap.style.display = "none";
        await loadResults(job_id);
      } else if (d.status === "error") {
        clearInterval(pollTimer);
        statusMsg.textContent = `Fehler: ${d.error}`;
        btnRun.disabled = false;
        progressWrap.style.display = "none";
      }
    }, 1000);
  }

  // ---- Ergebnisse laden ----
  async function loadResults(job_id) {
    const r = await fetch(API(`/api/eval/results/${job_id}`));
    if (!r.ok) return;
    const d = await r.json();
    allResults = d.results || [];
    const models = d.models || [];

    // Modell-Filter-Dropdown
    modelFilter.innerHTML = "";
    models.forEach(name => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      modelFilter.appendChild(opt);
    });
    currentModelKey = models[0] || "";
    modelFilter.addEventListener("change", () => {
      currentModelKey = modelFilter.value;
      applyFilter();
      renderStats(models);
    });

    renderStats(models);
    applyFilter();
    resultsSection.style.display = "block";
  }

  // ---- Statistiken ----
  function calcStats(modelKey) {
    let tp = 0, tn = 0, fp = 0, fn = 0;
    allResults.forEach(r => {
      const m = r.models[modelKey];
      if (!m) return;
      if (m.verdict === "TP") tp++;
      else if (m.verdict === "TN") tn++;
      else if (m.verdict === "FP") fp++;
      else if (m.verdict === "FN") fn++;
    });
    const precision = tp + fp > 0 ? tp / (tp + fp) : null;
    const recall    = tp + fn > 0 ? tp / (tp + fn) : null;
    const f1        = precision !== null && recall !== null && (precision + recall) > 0
      ? 2 * precision * recall / (precision + recall) : null;
    return { tp, tn, fp, fn, precision, recall, f1 };
  }

  function fmt(v) { return v !== null ? (v * 100).toFixed(1) + "%" : "–"; }

  function renderStats(models) {
    statsSection.innerHTML = "";
    models.forEach((name, i) => {
      const color = MODEL_COLORS[i % MODEL_COLORS.length];
      const s = calcStats(name);
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <h2 style="color:${color}; margin-bottom:10px;">⬤ ${name}</h2>
        <div class="metric-grid">
          <div class="metric"><div class="metric-val col-tp">${s.tp}</div><div class="metric-lbl">True Positive ✓ Ball erkannt</div></div>
          <div class="metric"><div class="metric-val col-tn">${s.tn}</div><div class="metric-lbl">True Negative ✓ Kein Ball korrekt</div></div>
          <div class="metric"><div class="metric-val col-fp">${s.fp}</div><div class="metric-lbl">False Positive ✗ Ball falsch erkannt</div></div>
          <div class="metric"><div class="metric-val col-fn">${s.fn}</div><div class="metric-lbl">False Negative ✗ Ball nicht gefunden</div></div>
          <div class="metric"><div class="metric-val col-f1">${fmt(s.precision)}</div><div class="metric-lbl">Precision</div></div>
          <div class="metric"><div class="metric-val col-f1">${fmt(s.recall)}</div><div class="metric-lbl">Recall</div></div>
          <div class="metric"><div class="metric-val col-f1">${fmt(s.f1)}</div><div class="metric-lbl">F1-Score</div></div>
        </div>
      `;
      statsSection.appendChild(card);
    });
  }

  // ---- Filter ----
  filterTabs.forEach(tab => tab.addEventListener("click", () => {
    currentFilter = tab.dataset.filter;
    filterTabs.forEach(t => t.classList.toggle("active", t.dataset.filter === currentFilter));
    currentPage = 0;
    applyFilter();
  }));

  function applyFilter() {
    if (currentFilter === "all") {
      filteredResults = [...allResults];
    } else {
      filteredResults = allResults.filter(r => {
        const m = r.models[currentModelKey];
        return m && m.verdict === currentFilter;
      });
    }
    currentPage = 0;
    selectedIndex = -1;
    viewerWrap.style.display = "none";
    renderList();
  }

  // ---- Paginierte Liste ----
  function renderList() {
    const total = filteredResults.length;
    const pages = Math.ceil(total / PAGE_SIZE) || 1;
    currentPage = Math.max(0, Math.min(currentPage, pages - 1));

    pageInfo.textContent = `Seite ${currentPage + 1} / ${pages}`;
    totalInfo.textContent = `${total} Frames`;
    btnPrevPage.disabled = currentPage === 0;
    btnNextPage.disabled = currentPage >= pages - 1;
    paginationWrap.style.display = total > PAGE_SIZE ? "flex" : "none";

    const start = currentPage * PAGE_SIZE;
    const slice = filteredResults.slice(start, start + PAGE_SIZE);

    resultsList.innerHTML = "";
    if (slice.length === 0) {
      resultsList.innerHTML = '<div class="muted" style="padding:10px;">Keine Frames für diesen Filter.</div>';
      return;
    }

    slice.forEach((res, localIdx) => {
      const globalIdx = start + localIdx;
      const row = document.createElement("div");
      row.className = "result-row" + (globalIdx === selectedIndex ? " selected" : "");
      row.dataset.idx = globalIdx;

      // Verdict-Badges für alle Modelle
      let verdictHtml = "";
      Object.entries(res.models).forEach(([name, m]) => {
        verdictHtml += `<span class="vbadge vbadge-${m.verdict}">${m.verdict}</span>`;
      });

      const src = API(`/api/eval/frame?source=${encodeURIComponent(res.source)}&task=${encodeURIComponent(res.task)}&filename=${encodeURIComponent(res.filename)}`);

      row.innerHTML = `
        <img class="thumb" src="${src}" alt="" loading="lazy" />
        <div class="result-info">
          <div class="result-file">${res.filename}</div>
          <div class="result-meta">${res.source} · ${res.task} · GT: ${res.gt === "ball" ? "● Ball" : "○ kein Ball"}</div>
        </div>
        <div class="verdict-badges">${verdictHtml}</div>
      `;
      row.addEventListener("click", () => openViewer(globalIdx));
      resultsList.appendChild(row);
    });
  }

  btnPrevPage.addEventListener("click", () => { currentPage--; renderList(); });
  btnNextPage.addEventListener("click", () => { currentPage++; renderList(); });

  // ---- Frame-Viewer ----
  async function openViewer(idx) {
    selectedIndex = idx;
    // Ausgewählte Zeile markieren
    resultsList.querySelectorAll(".result-row").forEach(r => {
      r.classList.toggle("selected", parseInt(r.dataset.idx) === idx);
    });

    const res = filteredResults[idx];
    const src = API(`/api/eval/frame?source=${encodeURIComponent(res.source)}&task=${encodeURIComponent(res.task)}&filename=${encodeURIComponent(res.filename)}`);

    viewerImg.src = src;
    viewerFilename.textContent = `${res.source}/${res.task}/${res.filename}`;

    // Verdicts anzeigen
    let vhtml = "";
    Object.entries(res.models).forEach(([, m]) => {
      vhtml += `<span class="vbadge vbadge-${m.verdict}" style="font-size:13px;">${m.verdict}</span> `;
    });
    viewerVerdicts.innerHTML = vhtml;

    viewerWrap.style.display = "block";
    btnViewerPrev.disabled = idx <= 0;
    btnViewerNext.disabled = idx >= filteredResults.length - 1;

    await new Promise(resolve => { viewerImg.onload = resolve; viewerImg.onerror = resolve; });
    drawViewerBoxes(res);
    renderLegend(res);
    void loadHqStatus(res);
  }

  function drawViewerBoxes(res) {
    const W = viewerImg.clientWidth;
    const H = viewerImg.clientHeight;
    viewerCanvas.width  = W;
    viewerCanvas.height = H;
    const ctx = viewerCanvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);

    // GT-Boxen (grün, gestrichelt)
    if (res.gt_boxes && res.gt_boxes.length > 0) {
      ctx.strokeStyle = "#22c55e";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 3]);
      res.gt_boxes.forEach(b => drawBox(ctx, b, W, H));
      ctx.setLineDash([]);
    } else if (res.gt === "empty") {
      // Kein Ball laut GT – kein Kreis
    }

    // Modell-Boxen
    const modelNames = Object.keys(res.models);
    modelNames.forEach((name, i) => {
      const color = MODEL_COLORS[i % MODEL_COLORS.length];
      const boxes = res.models[name].boxes || [];
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      boxes.forEach(b => {
        drawBox(ctx, b, W, H);
        // Konfidenz-Label
        const x = (b.cx - b.w / 2) * W;
        const y = (b.cy - b.h / 2) * H;
        ctx.fillStyle = color;
        ctx.font = "bold 12px monospace";
        ctx.fillText(`${(b.conf * 100).toFixed(0)}%`, x + 2, y - 4);
      });
    });
  }

  function drawBox(ctx, b, W, H) {
    const x = (b.cx - b.w / 2) * W;
    const y = (b.cy - b.h / 2) * H;
    const w = b.w * W;
    const h = b.h * H;
    ctx.strokeRect(x, y, w, h);
    ctx.beginPath();
    ctx.arc(b.cx * W, b.cy * H, 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  function renderLegend(res) {
    const modelNames = Object.keys(res.models);
    let html = `<div class="legend-item"><div class="legend-dot" style="background:#22c55e; border: 1px dashed #22c55e;"></div><span>GT (Ground Truth)</span></div>`;
    modelNames.forEach((name, i) => {
      const color = MODEL_COLORS[i % MODEL_COLORS.length];
      html += `<div class="legend-item"><div class="legend-dot" style="background:${color};"></div><span>${name}</span></div>`;
    });
    viewerLegend.innerHTML = html;
  }

  // ---- HQ-Tag (Eval) ----
  function renderHqBtn(isHq) {
    currentHQ = isHq;
    btnHq.classList.toggle("hq-active", isHq);
    btnHq.title = isHq ? "HQ-Tag entfernen (H)" : "Als High-Quality markieren (H)";
  }

  async function loadHqStatus(res) {
    renderHqBtn(false);
    const source = res.source === "import" ? "import" : "labeler";
    const r = await fetch(API(`/api/frame-tag?source=${encodeURIComponent(source)}&task=${encodeURIComponent(res.task)}&filename=${encodeURIComponent(res.filename)}`));
    if (!r.ok) return;
    const d = await r.json();
    renderHqBtn(d.is_hq === true);
  }

  async function toggleHq() {
    if (selectedIndex < 0 || selectedIndex >= filteredResults.length) return;
    const res = filteredResults[selectedIndex];
    const source = res.source === "import" ? "import" : "labeler";
    const r = await fetch(API("/api/frame-tag"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, task: res.task, filename: res.filename, tag: "hq", action: "toggle" }),
    });
    if (!r.ok) return;
    const d = await r.json();
    renderHqBtn(d.is_hq === true);
  }

  btnHq.addEventListener("click", () => void toggleHq());

  btnViewerPrev.addEventListener("click", () => { if (selectedIndex > 0) openViewer(selectedIndex - 1); });
  btnViewerNext.addEventListener("click", () => { if (selectedIndex < filteredResults.length - 1) openViewer(selectedIndex + 1); });

  document.addEventListener("keydown", e => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (viewerWrap.style.display === "none") return;
    if (e.key === "ArrowLeft"  && selectedIndex > 0) { e.preventDefault(); openViewer(selectedIndex - 1); }
    if (e.key === "ArrowRight" && selectedIndex < filteredResults.length - 1) { e.preventDefault(); openViewer(selectedIndex + 1); }
    if (e.key === "h" || e.key === "H") { e.preventDefault(); void toggleHq(); }
  });

  // Viewer-Canvas bei Größenänderung neu zeichnen
  window.addEventListener("resize", () => {
    if (selectedIndex >= 0 && filteredResults[selectedIndex]) {
      drawViewerBoxes(filteredResults[selectedIndex]);
    }
  });

  // ---- Job-Historie ----
  async function loadJobHistory() {
    jobList.innerHTML = '<span class="muted">Lade…</span>';
    const r = await fetch(API("/api/eval/jobs"));
    if (!r.ok) { jobList.innerHTML = '<span class="muted">Fehler beim Laden.</span>'; return; }
    const d = await r.json();
    const jobs = d.jobs || [];
    if (jobs.length === 0) {
      jobList.innerHTML = '<span class="muted">Noch keine Evaluationen gespeichert.</span>';
      return;
    }
    jobList.innerHTML = "";
    jobs.forEach(job => {
      const row = document.createElement("div");
      row.className = "job-row";
      const statusCls = `job-status-${job.status}`;
      const statusLabel = job.status === "done" ? "✓ Fertig" : job.status === "error" ? "✗ Fehler" : "⏳ Läuft";
      const modelStr = (job.models || []).join(", ") || "–";
      const ts = job.finished_at ? new Date(job.finished_at).toLocaleString("de-DE") : (job.started_at ? new Date(job.started_at).toLocaleString("de-DE") : "–");
      const frames = job.total ? `${job.total.toLocaleString("de-DE")} Frames` : "";
      const conf = job.conf != null ? `conf=${job.conf}` : "";

      row.innerHTML = `
        <span class="${statusCls}" style="min-width:80px;">${statusLabel}</span>
        <span style="font-family:monospace; color:#94a3b8; font-size:12px; min-width:70px;">${job.job_id}</span>
        <span style="flex:1; min-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${modelStr}">${modelStr}</span>
        <span class="muted">${frames}</span>
        <span class="muted">${conf}</span>
        <span class="muted" style="font-size:12px;">${ts}</span>
        ${job.status === "done" ? `<button class="btn btn-sm btn-primary" data-load="${job.job_id}">Laden</button>` : ""}
        <button class="btn btn-sm btn-danger" data-del="${job.job_id}">✕</button>
      `;

      const loadBtn = row.querySelector("[data-load]");
      if (loadBtn) {
        loadBtn.addEventListener("click", async () => {
          loadBtn.disabled = true;
          loadBtn.textContent = "Lade…";
          statusMsg.textContent = `Lade Job ${job.job_id}…`;
          await loadResults(job.job_id);
          statusMsg.textContent = `✓ Job ${job.job_id} geladen.`;
        });
      }

      row.querySelector("[data-del]").addEventListener("click", async (e) => {
        const id = e.currentTarget.dataset.del;
        await fetch(API(`/api/eval/jobs/${id}`), { method: "DELETE" });
        await loadJobHistory();
      });

      jobList.appendChild(row);
    });
  }

  btnRefreshJobs.addEventListener("click", loadJobHistory);

  // ---- Start ----
  loadModels();
  loadJobHistory();
})();
