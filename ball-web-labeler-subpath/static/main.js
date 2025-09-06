const qs = (s)=>document.querySelector(s);
const dropZone = qs('#dropZone');
const fileInput = qs('#fileInput');
const uploadBtn = qs('#uploadBtn');
const fpsInput = qs('#fpsInput');
const nameInput = qs('#nameInput');
const ytUrl = qs('#ytUrl');
const fpsYT = qs('#fpsYT');
const nameYT = qs('#nameYT');
const ytBtn = qs('#ytBtn');
const ingestStatus = qs('#ingestStatus');

const labelCard = qs('#labelCard');
const taskIdEl = qs('#taskId');
const frameCountEl = qs('#frameCount');
const frameImg = qs('#frameImg');
const cross = qs('#crosshair');
const boxSize = qs('#boxSize');
const prevBtn = qs('#prevBtn');
const nextBtn = qs('#nextBtn');
const skipBtn = qs('#skipBtn');
const labelStatus = qs('#labelStatus');
const exportBtn = qs('#exportBtn');

let TASK_ID = null;
let FRAMES = [];
let IDX = 0;

function setStatus(el, msg) { el.textContent = msg; }

async function ingestUpload() {
  const f = fileInput.files?.[0];
  if (!f) { alert('Bitte eine Videodatei wählen.'); return; }
  const fd = new FormData();
  fd.append('video', f);
  fd.append('fps', fpsInput.value || '5');
  if (nameInput.value) fd.append('task_name', nameInput.value);
  setStatus(ingestStatus, 'Upload & Extrahiere Frames ...');
  const res = await fetch('api/ingest/upload', { method:'POST', body:fd });
  const text = await res.text();
  if (!res.ok) { setStatus(ingestStatus, `Fehler beim Upload: ${text}`); return; }
  const js = JSON.parse(text);
  TASK_ID = js.task_id; await loadFrames();
}

async function ingestYT() {
  const url = ytUrl.value.trim();
  if (!url) { alert('Bitte YouTube-URL eintragen.'); return; }
  setStatus(ingestStatus, 'Lade YouTube-Video & extrahiere Frames ...');
  const payload = { youtube_url: url, fps: Number(fpsYT.value||5) };
  if (nameYT.value) payload.task_name = nameYT.value;
  const res = await fetch('api/ingest/youtube', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  const text = await res.text();
  if (!res.ok) { setStatus(ingestStatus, `Fehler bei YouTube-Ingest: ${text}`); return; }
  const js = JSON.parse(text);
  TASK_ID = js.task_id; await loadFrames();
}

async function loadFrames() {
  const res = await fetch(`api/task/${encodeURIComponent(TASK_ID)}/frames?split=train`);
  const js = await res.json();
  FRAMES = js.frames || [];
  frameCountEl.textContent = FRAMES.length;
  taskIdEl.textContent = TASK_ID;
  labelCard.style.display = 'block';
  setStatus(ingestStatus, `Task: ${TASK_ID} – ${FRAMES.length} Frames`);
  IDX = 0; showFrame();
}

function showFrame() {
  if (!FRAMES.length) return;
  const fname = FRAMES[IDX];
  frameImg.src = `api/task/${encodeURIComponent(TASK_ID)}/frame/${encodeURIComponent(fname)}?split=train`;
  cross.style.display = 'none';
  labelStatus.textContent = `Frame ${IDX+1} / ${FRAMES.length}`;
}

function imgPointToPixelFromClient(clientX, clientY) {
  const rect = frameImg.getBoundingClientRect();
  const x = clientX - rect.left; const y = clientY - rect.top;
  const scaleX = frameImg.naturalWidth / rect.width;
  const scaleY = frameImg.naturalHeight / rect.height;
  return { x: x * scaleX, y: y * scaleY, sx: x, sy: y };
}

function saveLabelFromPoint(px) {
  if (!FRAMES.length) return;
  cross.style.left = `${px.sx}px`; cross.style.top = `${px.sy}px`; cross.style.display = 'block';
  const fname = FRAMES[IDX];
  const body = { image: fname, cx: px.x, cy: px.y, box_px: Number(boxSize.value||24), split: 'train' };
  fetch(`api/task/${encodeURIComponent(TASK_ID)}/label`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) })
    .then(async (r) => {
      if (r.ok) {
        labelStatus.textContent = `Gespeichert: ${fname}`;
        nextFrame();
      } else {
        const t = await r.text();
        labelStatus.textContent = `Fehler beim Speichern: ${t}`;
      }
    });
}

// Desktop click
frameImg.addEventListener('click', (ev)=>{
  const p = imgPointToPixelFromClient(ev.clientX, ev.clientY);
  saveLabelFromPoint(p);
});

// Mobile touch
frameImg.addEventListener('touchstart', (ev)=>{
  if (!ev.changedTouches || !ev.changedTouches[0]) return;
  const t = ev.changedTouches[0];
  const p = imgPointToPixelFromClient(t.clientX, t.clientY);
  saveLabelFromPoint(p);
  ev.preventDefault();
}, {passive:false});

async function skipFrame() {
  if (!FRAMES.length) return;
  const fname = FRAMES[IDX];
  const res = await fetch(`api/task/${encodeURIComponent(TASK_ID)}/skip`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ image: fname, split:'train' }) });
  if (res.ok) { labelStatus.textContent = `Skipped: ${fname}`; nextFrame(); }
  else { labelStatus.textContent = 'Skip fehlgeschlagen'; }
}

function prevFrame(){ if (IDX>0){ IDX--; showFrame(); } }
function nextFrame(){ if (IDX<FRAMES.length-1){ IDX++; showFrame(); } }

uploadBtn.addEventListener('click', ingestUpload);
ytBtn.addEventListener('click', ingestYT);
prevBtn.addEventListener('click', prevFrame);
nextBtn.addEventListener('click', nextFrame);
skipBtn.addEventListener('click', skipFrame);

window.addEventListener('keydown', (e)=>{
  if (!labelCard.style.display || labelCard.style.display==='none') return;
  if (e.key==='a' || e.key==='A') prevFrame();
  if (e.key==='d' || e.key==='D') nextFrame();
  if (e.key==='s' || e.key==='S') skipFrame();
});

['dragenter','dragover','dragleave','drop'].forEach(ev=>{
  dropZone.addEventListener(ev, e=>{ e.preventDefault(); e.stopPropagation(); });
});
dropZone.addEventListener('drop', (e)=>{
  const dt = e.dataTransfer; if (!dt?.files?.length) return;
  fileInput.files = dt.files; ingestStatus.textContent = `${dt.files[0].name} gewählt.`;
});

exportBtn.addEventListener('click', ()=>{
  if (!TASK_ID) return;
  window.location.href = `api/task/${encodeURIComponent(TASK_ID)}/export`;
});
