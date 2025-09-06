#!/usr/bin/env python3
import os
import io
import json
import uuid
import shutil
import zipfile
import tempfile
import subprocess
from pathlib import Path
from typing import List, Optional

from fastapi import (
    FastAPI, UploadFile, File, Form, Request,
    HTTPException, Depends
)
from fastapi.responses import FileResponse, JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from PIL import Image

# --------------------------------------------------------------------------------------
# Settings / Paths
# --------------------------------------------------------------------------------------

DATA_ROOT = Path(os.environ.get("LABEL_DATA_DIR", "/data")).resolve()
DATA_ROOT.mkdir(parents=True, exist_ok=True)

ROOT_PATH = os.environ.get("APP_ROOT_PATH", "")  # z.B. "/ball-detection"
app = FastAPI(title="TT Ball Labeler API", root_path=ROOT_PATH)

# Statische Dateien (Frontend)
app.mount("/static", StaticFiles(directory="static"), name="static")


# --------------------------------------------------------------------------------------
# Utils
# --------------------------------------------------------------------------------------

def ensure_ffmpeg():
    if shutil.which("ffmpeg") is None:
        raise HTTPException(500, "ffmpeg not installed in the image")

def safe_task_id(name: str) -> str:
    name = (name or "").strip()
    if not name:
        return uuid.uuid4().hex[:8]
    # sehr einfache Sanitization
    name = name.replace("/", "_").replace("\\", "_").replace("..", "_")
    return name

def img_size(path: Path):
    with Image.open(path) as im:
        return im.width, im.height

def to_yolo_line(cx_px: float, cy_px: float, box_px: float, w: int, h: int, cls: int = 0) -> str:
    bw = box_px
    bh = box_px
    x = cx_px / max(w, 1)
    y = cy_px / max(h, 1)
    ww = bw / max(w, 1)
    hh = bh / max(h, 1)
    # clamp
    x = min(max(x, 0.0), 1.0)
    y = min(max(y, 0.0), 1.0)
    ww = min(max(ww, 0.0), 1.0)
    hh = min(max(hh, 0.0), 1.0)
    return f"{cls} {x:.6f} {y:.6f} {ww:.6f} {hh:.6f}\n"

def frame_url(request: Request, task: str, fname: str) -> str:
    # subpath-sicher
    return str(request.url_for("get_frame", task=task, fname=fname))

def label_path(task_dir: Path, frame_fname: str) -> Path:
    # YOLO-Label-Datei hat denselben Basenamen mit .txt
    return task_dir / "labels" / (Path(frame_fname).stem + ".txt")

def list_jpgs(folder: Path) -> List[Path]:
    return sorted(p for p in folder.glob("*.jpg") if p.is_file())


# --------------------------------------------------------------------------------------
# Ingest / Extraction
# --------------------------------------------------------------------------------------

def ffmpeg_extract_frames(video_path: Path, out_dir: Path, fps: int):
    ensure_ffmpeg()
    out_dir.mkdir(parents=True, exist_ok=True)
    # Immer .jpg, fortlaufend 6-stellig
    cmd = [
        "ffmpeg", "-y",
        "-i", str(video_path),
        "-vf", f"fps={fps}",
        "-q:v", "2",
        str(out_dir / "%06d.jpg"),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

@app.post("/api/ingest/upload")
async def ingest_upload(
    request: Request,
    file: UploadFile = File(...),
    fps: int = Form(5),
    task_name: str = Form("")
):
    task_id = safe_task_id(task_name)
    task_dir = DATA_ROOT / task_id
    frames_dir = task_dir / "frames"
    labels_dir = task_dir / "labels"
    labels_dir.mkdir(parents=True, exist_ok=True)
    task_dir.mkdir(parents=True, exist_ok=True)

    tmp_video = task_dir / file.filename
    with tmp_video.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    ffmpeg_extract_frames(tmp_video, frames_dir, fps=fps)
    # Optional: Quelldatei behalten; wenn nicht gewünscht, löschen:
    # tmp_video.unlink(missing_ok=True)

    return await task_detail(request, task_id)

@app.post("/api/ingest/youtube")
async def ingest_youtube(
    request: Request,
    url: str = Form(...),
    fps: int = Form(5),
    task_name: str = Form("")
):
    try:
        import yt_dlp  # type: ignore
    except Exception:
        raise HTTPException(400, "yt-dlp not installed in the image")

    task_id = safe_task_id(task_name)
    task_dir = DATA_ROOT / task_id
    frames_dir = task_dir / "frames"
    labels_dir = task_dir / "labels"
    labels_dir.mkdir(parents=True, exist_ok=True)
    task_dir.mkdir(parents=True, exist_ok=True)

    tmp_dir = task_dir / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    ydl_opts = {
        "outtmpl": str(tmp_dir / "%(title).200s.%(ext)s"),
        "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        video_path = Path(ydl.prepare_filename(info))

    ffmpeg_extract_frames(video_path, frames_dir, fps=fps)
    shutil.rmtree(tmp_dir, ignore_errors=True)

    return await task_detail(request, task_id)


# --------------------------------------------------------------------------------------
# API: Tasks / Frames / Labels
# --------------------------------------------------------------------------------------

@app.get("/api/health")
def health():
    return {"status": "ok"}

@app.get("/api/tasks")
async def list_tasks(request: Request):
    tasks = []
    for tdir in sorted(DATA_ROOT.iterdir()):
        if not tdir.is_dir():
            continue
        frames_dir = tdir / "frames"
        labels_dir = tdir / "labels"
        frames = list_jpgs(frames_dir) if frames_dir.exists() else []
        labels = sorted(labels_dir.glob("*.txt")) if labels_dir.exists() else []
        preview = frame_url(request, tdir.name, frames[0].name) if frames else None
        tasks.append({
            "task": tdir.name,
            "frames": len(frames),
            "labels": len(labels),
            "preview": preview
        })
    return {"tasks": tasks}

@app.get("/api/tasks/{task}")
async def task_detail(request: Request, task: str):
    tdir = DATA_ROOT / task
    frames_dir = tdir / "frames"
    labels_dir = tdir / "labels"
    if not tdir.exists():
        raise HTTPException(404, "task not found")

    frames = list_jpgs(frames_dir) if frames_dir.exists() else []
    items = []
    for f in frames:
        lbl_path = label_path(tdir, f.name)
        items.append({
            "file": f.name,
            "url": frame_url(request, task, f.name),
            "has_label": lbl_path.exists()
        })
    return {
        "task": task,
        "frames": len(frames),
        "items": items
    }

@app.get("/api/frames/{task}/{fname}", name="get_frame")
async def get_frame(task: str, fname: str):
    f = DATA_ROOT / task / "frames" / fname
    if not f.exists():
        raise HTTPException(404, "frame not found")
    return FileResponse(f, media_type="image/jpeg")

class LabelIn(BaseModel):
    task: str
    file: str
    cx: float      # center x in px (Bild)
    cy: float      # center y in px
    box_px: float  # Seitenlänge der Box in px
    cls: int = 0   # YOLO-Klasse (Standard 0 = Ball)

@app.post("/api/label")
async def save_label(lbl: LabelIn):
    tdir = DATA_ROOT / lbl.task
    f_img = tdir / "frames" / lbl.file
    if not f_img.exists():
        raise HTTPException(404, "frame not found")
    w, h = img_size(f_img)
    line = to_yolo_line(lbl.cx, lbl.cy, lbl.box_px, w, h, cls=lbl.cls)
    out = label_path(tdir, lbl.file)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        f.write(line)
    return {"ok": True, "label_file": out.name}

@app.get("/api/label/{task}/{fname}")
async def get_label(task: str, fname: str):
    tdir = DATA_ROOT / task
    lbl = label_path(tdir, fname)
    if not lbl.exists():
        return {"exists": False, "lines": []}
    with lbl.open("r", encoding="utf-8") as f:
        lines = [ln.strip() for ln in f.readlines() if ln.strip()]
    return {"exists": True, "lines": lines}

@app.get("/api/export/{task}")
async def export_task(task: str):
    tdir = DATA_ROOT / task
    if not tdir.exists():
        raise HTTPException(404, "task not found")
    # ZIP zusammenstellen (frames + labels)
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=f"-{task}.zip")
    tmp.close()
    with zipfile.ZipFile(tmp.name, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for sub in ("frames", "labels"):
            p = tdir / sub
            if p.exists():
                for f in sorted(p.rglob("*")):
                    if f.is_file():
                        zf.write(f, arcname=str(Path(task) / f.relative_to(tdir)))
    return FileResponse(tmp.name, filename=f"{task}.zip", media_type="application/zip")


# --------------------------------------------------------------------------------------
# Root: index.html ausliefern (subpath-freundlich)
# --------------------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
def index():
    # Liefert die statische Single-Page (die darin verwendeten Pfade sind relativ: ./api/...)
    with open(Path("static") / "index.html", "r", encoding="utf-8") as f:
        return f.read()
