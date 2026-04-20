"""
Auto-Label + Review Server für Ball Detection Trainingsdaten.
Läuft als Docker-Container unter balls.spinevo.app/auto-label

Umgebungsvariablen:
  MODEL_PATH       Pfad zum YOLOv8 Modell (default: /runs/detect/v2/weights/best.pt)
  DATA_DIR         Datenpfad im Container   (default: /data)
  REVIEW_PASSWORT  HTTP Basic Auth Passwort (default: spinevo123)
  CONF_AUTO        Konfidenz für Auto-Label (default: 0.75)
  CONF_REVIEW      Untere Konfidenz-Grenze  (default: 0.30)
  FPS_EXTRACT      Frames/Sek extrahieren   (default: 2)
  MAX_FRAMES       Max Frames pro Video     (default: 500)
"""

import os, json, uuid, threading, base64, time, secrets, subprocess
from pathlib import Path

import cv2
from fastapi import FastAPI, HTTPException, Depends
from fastapi.responses import HTMLResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials

# ─── Konfiguration ────────────────────────────────────────
MODEL_PATH  = os.environ.get('MODEL_PATH',  '/runs/detect/v2/weights/best.pt')
DATA_DIR    = Path(os.environ.get('DATA_DIR', '/data'))
PASSWORT    = os.environ.get('REVIEW_PASSWORT', 'spinevo123')
CONF_AUTO   = float(os.environ.get('CONF_AUTO',   '0.75'))
CONF_REVIEW = float(os.environ.get('CONF_REVIEW', '0.30'))
FPS_EXTRACT = float(os.environ.get('FPS_EXTRACT', '2'))
MAX_FRAMES  = int(os.environ.get('MAX_FRAMES', '500'))

for d in [DATA_DIR, DATA_DIR / 'batches']:
    d.mkdir(parents=True, exist_ok=True)

# ─── Modell (lazy, thread-safe) ───────────────────────────
_model = None
_model_lock = threading.Lock()

def get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from ultralytics import YOLO
                _model = YOLO(MODEL_PATH)
    return _model

# ─── Persistenz ───────────────────────────────────────────
JOBS_FILE  = DATA_DIR / 'jobs.json'
QUEUE_FILE = DATA_DIR / 'queue.json'
_jobs_lock = threading.Lock()
_queue_lock = threading.Lock()

def load_jobs() -> dict:
    try:
        return json.loads(JOBS_FILE.read_text()) if JOBS_FILE.exists() else {}
    except Exception:
        return {}

def save_jobs(jobs: dict):
    with _jobs_lock:
        JOBS_FILE.write_text(json.dumps(jobs, indent=2, ensure_ascii=False))

def load_queue() -> dict:
    try:
        return json.loads(QUEUE_FILE.read_text()) if QUEUE_FILE.exists() else {'frames': []}
    except Exception:
        return {'frames': []}

def save_queue(queue: dict):
    with _queue_lock:
        QUEUE_FILE.write_text(json.dumps(queue, indent=2, ensure_ascii=False))

jobs = load_jobs()

# ─── FastAPI + Auth ───────────────────────────────────────
app = FastAPI()
security = HTTPBasic()

def pruefe_auth(credentials: HTTPBasicCredentials = Depends(security)):
    if not secrets.compare_digest(credentials.password.encode(), PASSWORT.encode()):
        raise HTTPException(
            status_code=401,
            headers={'WWW-Authenticate': 'Basic realm="SpinEvo Auto-Label"'},
        )
    return credentials

# ─── Auto-Label Hintergrund-Job ───────────────────────────
def run_auto_label(job_id: str, youtube_url: str):
    def log(msg: str):
        jobs[job_id]['log'].append(msg)
        save_jobs(jobs)

    batch_dir = DATA_DIR / 'batches' / job_id
    img_dir   = batch_dir / 'images'
    lbl_dir   = batch_dir / 'labels'
    img_dir.mkdir(parents=True, exist_ok=True)
    lbl_dir.mkdir(parents=True, exist_ok=True)

    try:
        # 1. Video herunterladen
        vid_path = batch_dir / 'video.mp4'
        log(f'⬇ Lade Video: {youtube_url}')
        result = subprocess.run(
            [
                'yt-dlp',
                '-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
                '--merge-output-format', 'mp4',
                '-o', str(vid_path),
                '--no-playlist',
                youtube_url,
            ],
            capture_output=True, text=True, timeout=600,
        )
        if result.returncode != 0 or not vid_path.exists():
            log(f'❌ Download fehlgeschlagen:\n{result.stderr[-400:]}')
            jobs[job_id]['status'] = 'fehler'
            save_jobs(jobs)
            return
        log('✓ Video geladen')

        # 2. Frames extrahieren
        log('📷 Extrahiere Frames...')
        cap      = cv2.VideoCapture(str(vid_path))
        vid_fps  = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total    = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        interval = max(1, int(vid_fps / FPS_EXTRACT))
        basis    = 'yt_' + job_id

        frame_list = []
        frame_idx = extracted = 0
        while cap.isOpened() and extracted < MAX_FRAMES:
            ret, frame = cap.read()
            if not ret:
                break
            if frame_idx % interval == 0:
                fid = f'{basis}_f{frame_idx:06d}'
                fp  = img_dir / f'{fid}.jpg'
                cv2.imwrite(str(fp), frame)
                frame_list.append((fid, str(fp)))
                extracted += 1
            frame_idx += 1
        cap.release()
        vid_path.unlink(missing_ok=True)  # Video löschen, spart Speicher

        jobs[job_id]['total_frames'] = extracted
        log(f'✓ {extracted} Frames extrahiert (von {total} gesamt, alle {interval}. Frame)')

        # 3. YOLO Inferenz
        log(f'🤖 Starte Inferenz auf {extracted} Frames (CPU)...')
        model = get_model()
        zaehler = {'auto': 0, 'review': 0, 'leer': 0}
        review_frames = []

        for i, (fid, fp) in enumerate(frame_list):
            if i > 0 and i % 100 == 0:
                log(f'   {i}/{extracted} verarbeitet...')

            img = cv2.imread(fp)
            if img is None:
                continue

            results = model(img, conf=CONF_REVIEW, imgsz=640, device='cpu', verbose=False)

            best_conf = 0.0
            best_bbox = None
            for box in results[0].boxes:
                c = float(box.conf[0])
                if c > best_conf:
                    best_conf = c
                    x1, y1, x2, y2 = box.xyxyn[0].tolist()
                    bw, bh = x2 - x1, y2 - y1
                    best_bbox = [x1 + bw / 2, y1 + bh / 2, bw, bh]

            lbl_path = str(lbl_dir / f'{fid}.txt')

            if best_conf >= CONF_AUTO:
                x, y, w, h = best_bbox
                Path(lbl_path).write_text(f'0 {x:.6f} {y:.6f} {w:.6f} {h:.6f}\n')
                zaehler['auto'] += 1
            elif best_conf >= CONF_REVIEW:
                review_frames.append({
                    'id':        fid,
                    'bild':      fp,
                    'label':     lbl_path,
                    'konfidenz': round(best_conf, 3),
                    'bbox':      best_bbox,
                    'status':    'offen',
                    'job_id':    job_id,
                })
                zaehler['review'] += 1
            else:
                Path(lbl_path).write_text('')
                zaehler['leer'] += 1

        # 4. Review-Queue befüllen
        queue = load_queue()
        queue['frames'].extend(review_frames)
        save_queue(queue)

        jobs[job_id]['status']  = 'fertig'
        jobs[job_id]['zaehler'] = zaehler
        log(
            f'✅ Fertig!\n'
            f'   Auto-gelabelt (conf ≥ {CONF_AUTO}):       {zaehler["auto"]}\n'
            f'   Zur Review (conf {CONF_REVIEW}–{CONF_AUTO}): {zaehler["review"]}\n'
            f'   Kein Ball (conf < {CONF_REVIEW}):          {zaehler["leer"]}'
        )
        save_jobs(jobs)

    except Exception as e:
        jobs[job_id]['status'] = 'fehler'
        jobs[job_id]['log'].append(f'❌ Fehler: {e}')
        save_jobs(jobs)

# ─── Hilfsfunktion: Bild mit BBox als Base64 ──────────────
def bild_mit_bbox(pfad: str, bbox: list, konfidenz: float) -> str:
    img = cv2.imread(pfad)
    if img is None:
        return ''
    h, w = img.shape[:2]
    if bbox:
        x, y, bw, bh = bbox
        x1 = int((x - bw / 2) * w)
        y1 = int((y - bh / 2) * h)
        x2 = int((x + bw / 2) * w)
        y2 = int((y + bh / 2) * h)
        cv2.rectangle(img, (x1, y1), (x2, y2), (57, 255, 20), 3)
        cv2.putText(img, f'{konfidenz:.0%}',
                    (x1, max(y1 - 10, 20)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.9, (57, 255, 20), 2)
    if w > 900:
        scale = 900 / w
        img = cv2.resize(img, (900, int(h * scale)))
    _, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return base64.b64encode(buf).decode()

# ─── API Endpunkte ────────────────────────────────────────

@app.get('/api/health')
def health():
    return {'status': 'ok'}

@app.post('/api/job/start')
def start_job(body: dict, _=Depends(pruefe_auth)):
    youtube_url = body.get('youtube_url', '').strip()
    if not youtube_url:
        raise HTTPException(400, 'youtube_url fehlt')

    job_id = str(uuid.uuid4())[:8]
    jobs[job_id] = {
        'id':           job_id,
        'status':       'läuft',
        'log':          [],
        'erstellt':     time.time(),
        'total_frames': 0,
        'zaehler':      {},
        'youtube_url':  youtube_url,
    }
    save_jobs(jobs)

    threading.Thread(
        target=run_auto_label,
        kwargs={'job_id': job_id, 'youtube_url': youtube_url},
        daemon=True,
    ).start()

    return {'job_id': job_id}

@app.get('/api/job/{job_id}')
def get_job(job_id: str, _=Depends(pruefe_auth)):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, 'Job nicht gefunden')
    return job

@app.get('/api/queue/stats')
def queue_stats(_=Depends(pruefe_auth)):
    queue = load_queue()
    frames = queue['frames']
    return {
        'offen':         sum(1 for f in frames if f['status'] == 'offen'),
        'bestaetigt':    sum(1 for f in frames if f['status'] == 'bestaetigt'),
        'abgelehnt':     sum(1 for f in frames if f['status'] == 'abgelehnt'),
        'uebersprungen': sum(1 for f in frames if f['status'] == 'uebersprungen'),
        'gesamt':        len(frames),
    }

@app.get('/api/frame/next')
def next_frame(_=Depends(pruefe_auth)):
    queue = load_queue()
    offen = sum(1 for f in queue['frames'] if f['status'] == 'offen')
    for frame in queue['frames']:
        if frame['status'] == 'offen':
            return {
                'id':        frame['id'],
                'bild':      bild_mit_bbox(frame['bild'], frame.get('bbox'), frame['konfidenz']),
                'konfidenz': frame['konfidenz'],
                'offen':     offen,
            }
    return {'id': None, 'offen': 0}

@app.post('/api/frame/{frame_id}/entscheide')
def entscheide(frame_id: str, body: dict, _=Depends(pruefe_auth)):
    aktion = body.get('aktion')
    if aktion not in ('richtig', 'falsch', 'skip'):
        raise HTTPException(400, 'Ungültige Aktion')

    queue = load_queue()
    for frame in queue['frames']:
        if frame['id'] == frame_id:
            if aktion == 'richtig':
                frame['status'] = 'bestaetigt'
                if frame.get('bbox'):
                    x, y, w, h = frame['bbox']
                    Path(frame['label']).parent.mkdir(parents=True, exist_ok=True)
                    Path(frame['label']).write_text(f'0 {x:.6f} {y:.6f} {w:.6f} {h:.6f}\n')
            elif aktion == 'falsch':
                frame['status'] = 'abgelehnt'
                Path(frame['label']).parent.mkdir(parents=True, exist_ok=True)
                Path(frame['label']).write_text('')
            else:
                frame['status'] = 'uebersprungen'
            break

    save_queue(queue)
    return {'ok': True}

# ─── Haupt-UI ─────────────────────────────────────────────

@app.get('/', response_class=HTMLResponse)
def index(_=Depends(pruefe_auth)):
    return HTML


HTML = '''<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SpinEvo Auto-Label</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: #0a0a14;
  color: #e5e7eb;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

/* ── Tab-Bar ── */
.tabs {
  display: flex;
  background: #111122;
  border-bottom: 1px solid #1e1e3a;
  padding: 0 16px;
  gap: 4px;
  flex-shrink: 0;
}
.tab {
  padding: 14px 20px;
  font-size: 14px;
  font-weight: 600;
  color: #6b7280;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  background: none;
  border-top: none;
  border-left: none;
  border-right: none;
  transition: color 0.15s, border-color 0.15s;
  white-space: nowrap;
}
.tab.aktiv { color: #f97316; border-bottom-color: #f97316; }
.tab:hover:not(.aktiv) { color: #d1d5db; }

.badge {
  background: #f97316;
  color: white;
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 11px;
  margin-left: 6px;
  vertical-align: middle;
}

/* ── Seiten ── */
.seite { display: none; flex: 1; flex-direction: column; }
.seite.aktiv { display: flex; }

/* ── Neues Video ── */
.video-seite {
  padding: 24px 20px;
  max-width: 640px;
  width: 100%;
  margin: 0 auto;
}
.video-seite h2 { font-size: 18px; font-weight: 700; margin-bottom: 20px; }

.eingabe-gruppe { margin-bottom: 16px; }
.eingabe-gruppe label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: #9ca3af;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
}
.eingabe-gruppe input {
  width: 100%;
  background: #111122;
  border: 1px solid #1e1e3a;
  border-radius: 10px;
  padding: 12px 14px;
  color: #e5e7eb;
  font-size: 15px;
}
.eingabe-gruppe input:focus {
  outline: none;
  border-color: #f97316;
}
.eingabe-gruppe input::placeholder { color: #4b5563; }

.btn-start {
  width: 100%;
  padding: 14px;
  background: #f97316;
  color: white;
  border: none;
  border-radius: 10px;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.15s;
  margin-bottom: 20px;
}
.btn-start:hover:not(:disabled) { background: #ea6b0e; }
.btn-start:disabled { background: #374151; color: #6b7280; cursor: not-allowed; }

.job-log {
  background: #111122;
  border: 1px solid #1e1e3a;
  border-radius: 10px;
  padding: 14px;
  font-family: 'SF Mono', 'Consolas', monospace;
  font-size: 12px;
  line-height: 1.6;
  color: #9ca3af;
  max-height: 280px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
.job-log.fertig { color: #4ade80; }
.job-log.fehler { color: #f87171; }

.info-box {
  background: #111122;
  border: 1px solid #1e1e3a;
  border-radius: 10px;
  padding: 16px;
  font-size: 13px;
  line-height: 1.7;
  color: #6b7280;
  margin-top: 20px;
}
.info-box strong { color: #9ca3af; }

/* ── Review ── */
.review-seite {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px;
  gap: 12px;
  max-width: 720px;
  width: 100%;
  margin: 0 auto;
}

/* Fortschritt */
.fortschritt-leiste {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  color: #6b7280;
}
.stats-zeile { display: flex; gap: 16px; }
.stat { display: flex; align-items: center; gap: 5px; font-size: 13px; }
.stat-zahl { font-weight: 700; }
.stat.ok    .stat-zahl { color: #4ade80; }
.stat.nein  .stat-zahl { color: #f87171; }
.stat.skip  .stat-zahl { color: #6b7280; }

/* Karte */
.karten-container {
  width: 100%;
  position: relative;
  flex: 1;
  min-height: 0;
}
.karte {
  width: 100%;
  height: 100%;
  background: #111122;
  border-radius: 16px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: absolute;
  top: 0; left: 0;
  transition: transform 0.28s ease, opacity 0.28s ease;
}
.karte.swipe-links {
  transform: translateX(-120%) rotate(-12deg);
  opacity: 0;
}
.karte.swipe-rechts {
  transform: translateX(120%) rotate(12deg);
  opacity: 0;
}
.karte img {
  width: 100%;
  flex: 1;
  min-height: 0;
  object-fit: contain;
  background: #0a0a14;
  display: block;
}
.karte-info {
  padding: 10px 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
}
.konf-badge {
  background: #f97316;
  color: white;
  font-size: 12px;
  font-weight: 700;
  padding: 3px 9px;
  border-radius: 999px;
}
.frame-id { font-size: 11px; color: #4b5563; font-family: monospace; }

/* Leer-Zustand */
.karte-leer {
  width: 100%;
  height: 100%;
  background: #111122;
  border-radius: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #4b5563;
  position: absolute;
  top: 0; left: 0;
}
.karte-leer .icon { font-size: 48px; }
.karte-leer p { font-size: 15px; }
.karte-leer .sub { font-size: 13px; }

/* Buttons */
.buttons {
  width: 100%;
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 10px;
  flex-shrink: 0;
}
.vote-btn {
  padding: 16px 8px;
  border: none;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  transition: transform 0.1s, background 0.15s;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.vote-btn:active { transform: scale(0.94); }
.vote-btn .sub { font-size: 11px; font-weight: 400; opacity: 0.7; }

.btn-falsch  { background: #3d1515; color: #f87171; border: 2px solid #7f1d1d; }
.btn-falsch:hover  { background: #5a1c1c; }
.btn-skip    { background: #1a1a2e; color: #6b7280; border: 2px solid #374151; }
.btn-skip:hover    { background: #252538; }
.btn-richtig { background: #0f2d0a; color: #4ade80; border: 2px solid #166534; }
.btn-richtig:hover { background: #183d11; }

/* Shortcuts */
.shortcuts-hint {
  font-size: 11px;
  color: #374151;
  text-align: center;
  flex-shrink: 0;
}
</style>
</head>
<body>

<!-- Tab-Bar -->
<nav class="tabs">
  <button class="tab aktiv" onclick="zeigeTab('video')">🎬 Neues Video</button>
  <button class="tab" id="tab-review-btn" onclick="zeigeTab('review')">
    🃏 Review <span class="badge" id="offen-badge">0</span>
  </button>
</nav>

<!-- ═══ Tab: Neues Video ═══ -->
<div class="seite aktiv" id="seite-video">
<div class="video-seite">
  <h2>Neues Video auto-labeln</h2>

  <div class="eingabe-gruppe">
    <label>YouTube URL</label>
    <input type="text" id="yt-url"
           placeholder="https://youtube.com/watch?v=..."
           onkeydown="if(event.key==='Enter') starteJob()">
  </div>

  <button class="btn-start" id="btn-start" onclick="starteJob()">
    ▶ Auto-Label starten
  </button>

  <div class="job-log" id="job-log" style="display:none"></div>

  <div class="info-box">
    <strong>Wie es funktioniert:</strong><br>
    1. YouTube-URL eingeben → Frames werden extrahiert<br>
    2. YOLOv8 Modell läuft automatisch über alle Frames<br>
    3. Sichere Erkennungen (conf ≥ 75%) → direkt gelabelt<br>
    4. Unsichere Erkennungen (30–75%) → Review-Queue<br>
    5. Kein Ball erkannt (&lt; 30%) → leeres Label<br><br>
    <strong>Dauer:</strong> ~10–20 Min pro Video (CPU)
  </div>
</div>
</div>

<!-- ═══ Tab: Review ═══ -->
<div class="seite" id="seite-review">
<div class="review-seite">

  <!-- Fortschritt + Stats -->
  <div class="fortschritt-leiste">
    <span id="offen-text">0 offen</span>
    <div class="stats-zeile">
      <div class="stat ok">   ✅ <span class="stat-zahl" id="s-ok">0</span></div>
      <div class="stat nein"> ❌ <span class="stat-zahl" id="s-nein">0</span></div>
      <div class="stat skip"> ⏭ <span class="stat-zahl" id="s-skip">0</span></div>
    </div>
  </div>

  <!-- Karten-Bereich -->
  <div class="karten-container" id="karten-container">
    <div class="karte-leer" id="karte-leer">
      <div class="icon">🏓</div>
      <p>Keine Frames zur Review</p>
      <div class="sub">Zuerst ein Video auto-labeln</div>
    </div>
  </div>

  <!-- Buttons -->
  <div class="buttons">
    <button class="vote-btn btn-falsch" onclick="entscheide('falsch')">
      ❌ Falsch
      <span class="sub">Label löschen</span>
    </button>
    <button class="vote-btn btn-skip" onclick="entscheide('skip')">
      ⏭ Skip
      <span class="sub">Später</span>
    </button>
    <button class="vote-btn btn-richtig" onclick="entscheide('richtig')">
      ✅ Richtig
      <span class="sub">Label behalten</span>
    </button>
  </div>

  <div class="shortcuts-hint">
    Tastatur: &larr; / A = Falsch &nbsp;|&nbsp; Space = Skip &nbsp;|&nbsp; &rarr; / D = Richtig
  </div>

</div>
</div>

<script>
// ── Zustand ──────────────────────────────────────────────
let aktuellerFrameId = null;
let jobPollTimer = null;
let sitzung = { ok: 0, nein: 0, skip: 0 };
let aktuelleKarte = null;

// ── Tabs ─────────────────────────────────────────────────
function zeigeTab(name) {
  document.querySelectorAll('.seite').forEach(s => s.classList.remove('aktiv'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('aktiv'));
  document.getElementById('seite-' + name).classList.add('aktiv');
  const btns = document.querySelectorAll('.tab');
  btns[name === 'video' ? 0 : 1].classList.add('aktiv');

  if (name === 'review') ladeNaechstenFrame();
}

// ── Auto-Label Job ────────────────────────────────────────
async function starteJob() {
  const url = document.getElementById('yt-url').value.trim();
  if (!url) { alert('Bitte YouTube-URL eingeben.'); return; }

  const btn = document.getElementById('btn-start');
  const log = document.getElementById('job-log');
  btn.disabled = true;
  btn.textContent = '⏳ Läuft...';
  log.style.display = 'block';
  log.className = 'job-log';
  log.textContent = 'Starte Job...';

  let jobId;
  try {
    const res = await fetch('api/job/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ youtube_url: url }),
    });
    const data = await res.json();
    jobId = data.job_id;
  } catch(e) {
    log.className = 'job-log fehler';
    log.textContent = 'Fehler: ' + e;
    btn.disabled = false;
    btn.textContent = '▶ Auto-Label starten';
    return;
  }

  // Fortschritt pollen
  clearInterval(jobPollTimer);
  jobPollTimer = setInterval(async () => {
    try {
      const res = await fetch('api/job/' + jobId);
      const data = await res.json();
      log.textContent = data.log.join('\\n');
      log.scrollTop = log.scrollHeight;

      if (data.status === 'fertig') {
        clearInterval(jobPollTimer);
        log.className = 'job-log fertig';
        btn.disabled = false;
        btn.textContent = '▶ Weiteres Video starten';
        aktualisiereStats();
        setTimeout(() => zeigeTab('review'), 1500);
      } else if (data.status === 'fehler') {
        clearInterval(jobPollTimer);
        log.className = 'job-log fehler';
        btn.disabled = false;
        btn.textContent = '▶ Erneut versuchen';
      }
    } catch(e) { /* kurze Netzwerkunterbrechung ignorieren */ }
  }, 2500);
}

// ── Review ────────────────────────────────────────────────
async function ladeNaechstenFrame() {
  try {
    const res  = await fetch('api/frame/next');
    const data = await res.json();

    const container = document.getElementById('karten-container');

    if (!data.id) {
      aktuellerFrameId = null;
      container.innerHTML = `
        <div class="karte-leer" id="karte-leer">
          <div class="icon">✅</div>
          <p>Alle Frames geprüft!</p>
          <div class="sub">Sitzung: ✅${sitzung.ok} ❌${sitzung.nein} ⏭${sitzung.skip}</div>
        </div>`;
      document.getElementById('offen-text').textContent = '0 offen';
      document.getElementById('offen-badge').textContent = '0';
      return;
    }

    aktuellerFrameId = data.id;
    document.getElementById('offen-text').textContent = data.offen + ' offen';
    document.getElementById('offen-badge').textContent = data.offen;

    // Neue Karte bauen
    const karte = document.createElement('div');
    karte.className = 'karte';
    karte.innerHTML = `
      <img src="data:image/jpeg;base64,${data.bild}" alt="Frame" draggable="false">
      <div class="karte-info">
        <span class="frame-id">${data.id}</span>
        <span class="konf-badge">${(data.konfidenz * 100).toFixed(0)}%</span>
      </div>`;

    // Touch-Swipe
    let touchStartX = 0;
    karte.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
    karte.addEventListener('touchend', e => {
      const delta = e.changedTouches[0].clientX - touchStartX;
      if (delta < -80) entscheide('falsch');
      else if (delta > 80) entscheide('richtig');
    });

    // Alte Karte entfernen, neue einfügen
    container.innerHTML = '';
    container.appendChild(karte);
    aktuelleKarte = karte;

  } catch(e) {
    console.error('Fehler beim Laden:', e);
  }
}

async function entscheide(aktion) {
  if (!aktuellerFrameId) return;
  const frameId = aktuellerFrameId;
  aktuellerFrameId = null; // Doppelklick verhindern

  // Swipe-Animation
  if (aktuelleKarte) {
    aktuelleKarte.classList.add(aktion === 'falsch' ? 'swipe-links' : aktion === 'richtig' ? 'swipe-rechts' : '');
  }

  // Sitzungs-Statistik
  if (aktion === 'richtig') sitzung.ok++;
  else if (aktion === 'falsch') sitzung.nein++;
  else sitzung.skip++;
  document.getElementById('s-ok').textContent   = sitzung.ok;
  document.getElementById('s-nein').textContent = sitzung.nein;
  document.getElementById('s-skip').textContent = sitzung.skip;

  try {
    await fetch(`api/frame/${frameId}/entscheide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aktion }),
    });
  } catch(e) { console.error(e); }

  // Nächsten Frame nach Animations-Ende laden
  setTimeout(ladeNaechstenFrame, 300);
}

async function aktualisiereStats() {
  try {
    const res  = await fetch('api/queue/stats');
    const data = await res.json();
    document.getElementById('offen-badge').textContent = data.offen;
  } catch(e) {}
}

// ── Tastatur-Shortcuts ────────────────────────────────────
document.addEventListener('keydown', e => {
  if (!aktuellerFrameId) return;
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  if (e.key === 'ArrowLeft'  || e.key === 'a') entscheide('falsch');
  else if (e.key === 'ArrowRight' || e.key === 'd') entscheide('richtig');
  else if (e.key === ' ' || e.key === 'ArrowUp') {
    e.preventDefault();
    entscheide('skip');
  }
});

// ── Start ─────────────────────────────────────────────────
aktualisiereStats();
setInterval(aktualisiereStats, 10000);
</script>
</body>
</html>
'''
