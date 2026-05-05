/* SpinEvo – Man-in-the-Middle Mobile Review */

(() => {
  // ---- Root ----
  function detectRoot() {
    if ((window.location.hostname || "") === "balls.spinevo.app") return "";
    const p = window.location.pathname || "/";
    if (p.startsWith("/ball-detection")) return "/ball-detection";
    return "";
  }
  const ROOT = detectRoot();
  const API  = (path) => ROOT + (path.startsWith("/") ? path : "/" + path);

  // ---- DOM ----
  const card        = document.getElementById("card");
  const canvas      = document.getElementById("frameCanvas");
  const ctx         = canvas.getContext("2d");
  const loadingMsg  = document.getElementById("loadingMsg");
  const confBadge   = document.getElementById("confBadge");
  const noBallBadge = document.getElementById("noBallBadge");
  const overlayL    = document.getElementById("overlayLeft");
  const overlayR    = document.getElementById("overlayRight");
  const counter     = document.getElementById("counter");
  const doneOverlay = document.getElementById("doneOverlay");

  // ---- State ----
  const BATCH        = 10;
  const SWIPE_THRESH = 70;
  const CANVAS_W     = 540;
  const CANVAS_H     = 960;

  let hasBallFilter = null;      // null | "true" | "false"
  let queue         = [];
  let fetchOffset   = 0;
  let totalPending  = 0;
  let current       = null;
  let currentImg    = null;
  let isFetching    = false;
  let isAnimating   = false;
  let imageCache    = new Map();

  // Touch state
  let touchStartX = 0;
  let touchStartY = 0;
  let touchDeltaX = 0;
  let touchActive = false;

  // ---- Init ----
  canvas.width  = CANVAS_W;
  canvas.height = CANVAS_H;
  fetchBatch().then(() => showNext());

  // ---- Fetch ----
  function buildReviewUrl(offset) {
    let url = `/api/man-in-middle/review?filter=pending&offset=${offset}&limit=${BATCH}`;
    if (hasBallFilter !== null) url += `&has_ball=${hasBallFilter}`;
    return API(url);
  }

  async function fetchBatch() {
    if (isFetching) return;
    isFetching = true;
    try {
      const r = await fetch(buildReviewUrl(fetchOffset));
      const d = await r.json();
      totalPending = d.total;
      queue.push(...d.frames);
      fetchOffset += d.frames.length;
      queue.slice(0, 3).forEach(preloadImage);
    } catch (e) {
      console.error("Fetch error", e);
    } finally {
      isFetching = false;
    }
  }

  function resetQueue() {
    queue        = [];
    fetchOffset  = 0;
    totalPending = 0;
    imageCache.clear();
  }

  function imageKey(frame) {
    return frame.task_id + "/" + frame.filename;
  }

  function preloadImage(frame) {
    const key = imageKey(frame);
    if (imageCache.has(key)) return;
    const img = new Image();
    img.src = API(`/api/eval/frame?source=labeler&task=${encodeURIComponent(frame.task_id)}&filename=${encodeURIComponent(frame.filename)}`);
    imageCache.set(key, img);
  }

  // ---- Show next frame ----
  async function showNext() {
    if (queue.length < 3 && !isFetching) fetchBatch();

    if (queue.length === 0) {
      if (totalPending === 0 || fetchOffset > 0) {
        showDone();
      } else {
        // Try one more time
        await fetchBatch();
        if (queue.length === 0) { showDone(); return; }
        showNext();
      }
      return;
    }

    current = queue.shift();
    preloadImage(current);  // ensure preloaded

    loadingMsg.style.display = "flex";
    confBadge.style.display  = "none";
    noBallBadge.style.display = "none";

    const key = imageKey(current);
    let img = imageCache.get(key);
    if (!img) {
      img = new Image();
      img.src = API(`/api/eval/frame?source=labeler&task=${encodeURIComponent(current.task_id)}&filename=${encodeURIComponent(current.filename)}`);
      imageCache.set(key, img);
    }

    const onReady = () => {
      currentImg = img;
      loadingMsg.style.display = "none";
      drawFrame(img, current.prediction);
      updateBadge(current.prediction);
      updateCounter();
      resetCardPosition();
    };

    if (img.complete && img.naturalWidth > 0) {
      onReady();
    } else {
      img.onload  = onReady;
      img.onerror = () => {
        loadingMsg.textContent = "Bild nicht ladbar";
      };
    }
  }

  // ---- Draw ----
  function drawFrame(img, prediction) {
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    if (!prediction) {
      // Kein Ball: ganzes Bild, letterboxed/pillarboxed
      const scale = Math.min(CANVAS_W / iw, CANVAS_H / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      ctx.drawImage(img, (CANVAS_W - dw) / 2, (CANVAS_H - dh) / 2, dw, dh);
      return;
    }

    // Ball erkannt: volle Bildhöhe, horizontal auf 9:16 zuschneiden
    const { x, y, w, h } = prediction;
    const ball_cx = x * iw;
    const ball_cy = y * ih;
    const ball_pw = w * iw;
    const ball_ph = h * ih;

    // Volle Höhe, Breite = Höhe * (9/16)
    const crop_h = ih;
    const crop_w = ih * (CANVAS_W / CANVAS_H);

    // Horizontal auf Ball zentrieren, geclampt
    let sx = Math.max(0, Math.min(ball_cx - crop_w / 2, iw - crop_w));
    let sy = 0;
    const sw = Math.min(crop_w, iw - sx);
    const sh = crop_h;

    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, CANVAS_W, CANVAS_H);

    // Bounding Box auf Canvas zeichnen
    const scaleX = CANVAS_W / sw;
    const scaleY = CANVAS_H / sh;
    const bb_x = (ball_cx - ball_pw / 2 - sx) * scaleX;
    const bb_y = (ball_cy - ball_ph / 2 - sy) * scaleY;
    const bb_w = ball_pw * scaleX;
    const bb_h = ball_ph * scaleY;

    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth   = 3;
    ctx.strokeRect(bb_x, bb_y, bb_w, bb_h);
  }

  function updateBadge(prediction) {
    if (prediction) {
      confBadge.textContent = (prediction.conf * 100).toFixed(0) + "% Ball";
      confBadge.style.display = "block";
      noBallBadge.style.display = "none";
    } else {
      confBadge.style.display = "none";
      noBallBadge.style.display = "block";
    }
  }

  function updateCounter() {
    const remaining = totalPending - fetchOffset + queue.length + 1;
    counter.textContent = `${Math.max(1, remaining)} ausstehend`;
  }

  // ---- Touch ----
  card.addEventListener("touchstart", onTouchStart, { passive: true });
  card.addEventListener("touchmove",  onTouchMove,  { passive: false });
  card.addEventListener("touchend",   onTouchEnd,   { passive: true });

  function onTouchStart(e) {
    if (isAnimating || !current) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchDeltaX = 0;
    touchActive = true;
    card.style.transition = "none";
  }

  function onTouchMove(e) {
    if (!touchActive) return;
    e.preventDefault();
    touchDeltaX = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;

    // Nur horizontale Swipes verfolgen
    if (Math.abs(touchDeltaX) < Math.abs(dy) * 0.5 && Math.abs(touchDeltaX) < 20) return;

    const rotate  = touchDeltaX * 0.04;
    card.style.transform = `translateX(${touchDeltaX}px) rotate(${rotate}deg)`;

    // Overlays einblenden proportional zur Swipe-Distanz
    const progress = Math.min(Math.abs(touchDeltaX) / SWIPE_THRESH, 1);
    if (touchDeltaX < 0) {
      overlayL.style.opacity = progress * 0.85;
      overlayR.style.opacity = 0;
    } else {
      overlayR.style.opacity = progress * 0.85;
      overlayL.style.opacity = 0;
    }
  }

  function onTouchEnd() {
    if (!touchActive) return;
    touchActive = false;
    overlayL.style.opacity = 0;
    overlayR.style.opacity = 0;

    if (Math.abs(touchDeltaX) >= SWIPE_THRESH) {
      if (touchDeltaX < 0) {
        triggerAction("approve");
      } else {
        triggerAction("skip");
      }
    } else {
      // Zurücksnappen
      card.style.transition = "transform 0.3s ease";
      card.style.transform  = "translateX(0) rotate(0deg)";
    }
  }

  // ---- Keyboard (Desktop-Test) ----
  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft"  || e.key === "h" || e.key === "H") triggerAction("approve");
    if (e.key === "ArrowRight" || e.key === "s" || e.key === "S") triggerAction("skip");
  });

  // ---- Action ----
  async function triggerAction(action) {
    if (isAnimating || !current) return;
    isAnimating = true;

    const toX = action === "approve" ? "-130vw" : "130vw";
    const rot  = action === "approve" ? "-20deg" : "20deg";
    card.style.transition = "transform 0.35s ease-out, opacity 0.3s ease";
    card.style.transform  = `translateX(${toX}) rotate(${rot})`;
    card.style.opacity    = "0";

    const frame    = current;
    const endpoint = action === "approve" ? "/api/man-in-middle/approve" : "/api/man-in-middle/skip";

    // Animation und Save parallel – warten bis beides fertig
    const savePromise = fetch(API(endpoint), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: frame.task_id, filename: frame.filename }),
    }).then(async r => {
      if (!r.ok) console.error("Save error", r.status, await r.json().catch(() => ({})));
    }).catch(e => console.error("Save error", e));

    await Promise.all([savePromise, new Promise(res => setTimeout(res, 370))]);

    if (action === "approve") totalPending = Math.max(0, totalPending - 1);

    isAnimating = false;
    card.style.transition = "none";
    card.style.transform  = "translateX(0) rotate(0deg)";
    card.style.opacity    = "1";
    showNext();
  }

  function resetCardPosition() {
    card.style.transition = "none";
    card.style.transform  = "translateX(0) rotate(0deg)";
    card.style.opacity    = "1";
  }

  function showDone() {
    doneOverlay.style.display = "flex";
    loadingMsg.style.display  = "none";
    counter.textContent = "Fertig";
  }

  // ---- Filter-Buttons ----
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-ball-filter]");
    if (!btn) return;
    hasBallFilter = btn.dataset.ballFilter === "all" ? null : btn.dataset.ballFilter;
    document.querySelectorAll("[data-ball-filter]").forEach(b =>
      b.classList.toggle("filter-active", b === btn)
    );
    resetQueue();
    current = null;
    doneOverlay.style.display = "none";
    loadingMsg.style.display  = "flex";
    loadingMsg.textContent    = "Wird geladen…";
    fetchBatch().then(() => showNext());
  });
})();
