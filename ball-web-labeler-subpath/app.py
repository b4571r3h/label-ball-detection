#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pathlib import Path
import os, re, time, json, shutil, subprocess, datetime, io, contextlib

APP_DIR = Path(__file__).parent.resolve()
STATIC_DIR = APP_DIR / "static"

DATA_ROOT = Path(os.getenv("LABEL_DATA_DIR", APP_DIR / "data")).resolve()
DATA_ROOT.mkdir(parents=True, exist_ok=True)
APP_ROOT_PATH = os.getenv("APP_ROOT_PATH", "").rstrip("/")
BALL_CLASS_ID = 0

app = FastAPI(title="TT Ball Web Labeler", version="1.2.0", root_path=APP_ROOT_PATH)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/", response_class=FileResponse)
def root_index():
    return FileResponse(str(STATIC_DIR / "index.html"))

class IngestYT(BaseModel):
    youtube_url: str
    fps: float = 5.0
    task_name: str | None = None

class LabelBody(BaseModel):
    image: str
    cx: float
    cy: float
    box_px: float = 24
    split: str = "train"

class SkipBody(BaseModel):
    image: str
    split: str = "train"

@app.get("/api/health", response_class=PlainTextResponse)
def health():
    return "ok"

def ensure_ffmpeg():
    if shutil.which("ffmpeg") is None:
        raise HTTPException(500, detail="ffmpeg not found. Install it (e.g. apt install ffmpeg).")

def slugify(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-+", "-", s)
    return s.strip("-") or f"task-{int(time.time())}"

def dated_task_root(suggested_slug: str) -> Path:
    day = datetime.date.today().isoformat()
    base = DATA_ROOT / day / suggested_slug
    p = base
    i = 2
    while p.exists():
        p = Path(f"{base}-{i}")
        i += 1
    p.mkdir(parents=True, exist_ok=True)
    return p

def task_id_from_root(root: Path) -> str:
    return str(root.relative_to(DATA_ROOT))

def resolve_task_root(task_id: str) -> Path:
    p = (DATA_ROOT / task_id).resolve()
    if not p.exists() or not p.is_dir():
        raise HTTPException(404, detail=f"task not found: {task_id}")
    if DATA_ROOT not in p.parents and p != DATA_ROOT:
        raise HTTPException(400, detail="invalid task path")
    return p

def prepare_structure(root: Path):
    img_root = root / "images"
    lbl_root = root / "labels"
    for split in ("train", "val"):
        (img_root / split).mkdir(parents=True, exist_ok=True)
        (lbl_root / split).mkdir(parents=True, exist_ok=True)
    return img_root, lbl_root

def yt_download(url: str, out_dir: Path):
    try:
        import yt_dlp
    except Exception as e:
        raise HTTPException(500, detail="yt-dlp not installed.") from e
    ensure_ffmpeg()
    out_dir.mkdir(parents=True, exist_ok=True)
    opts = {
        "outtmpl": str(out_dir / "%(title).200s.%(ext)s"),
        "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
    }
    buf_out, buf_err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(buf_out), contextlib.redirect_stderr(buf_err):
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            filename = ydl.prepare_filename(info)
    p = Path(filename)
    if not p.exists():
        files = list(out_dir.glob("*"))
        if not files:
            raise HTTPException(500, detail="yt-dlp produced no file")
        p = max(files, key=lambda f: f.stat().st_mtime)
    title = info.get("title") or "youtube"
    return p, title

def extract_frames_ffmpeg(video_path: Path, img_out: Path, fps: float = 5.0, split: str = "train") -> list[str]:
    ensure_ffmpeg()
    out_dir = img_out / split
    out_dir.mkdir(parents=True, exist_ok=True)
    for p in out_dir.glob("*.jpg"):
        p.unlink()
    pattern = out_dir / "%06d.jpg"
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(video_path), "-vf", f"fps={fps}", str(pattern)
    ]
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as e:
        raise HTTPException(400, detail=f"ffmpeg failed to extract frames: {e}") from e
    frames = sorted([p.name for p in out_dir.glob("*.jpg")])
    if not frames:
        raise HTTPException(400, detail="No frames extracted.")
    return frames

def write_meta(root: Path, meta: dict):
    (root / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

@app.post("/api/ingest/upload")
async def api_ingest_upload(
    video: UploadFile = File(...),
    fps: float = Form(5.0),
    task_name: str | None = Form(None)
):
    try:
        base = task_name or Path(video.filename).stem
        slug = slugify(base)
        root = dated_task_root(slug)
        img_root, lbl_root = prepare_structure(root)
        tmpfile = root / f"upload_{video.filename}"
        with open(tmpfile, "wb") as f:
            shutil.copyfileobj(video.file, f)
        frames = extract_frames_ffmpeg(tmpfile, img_root, fps=fps, split="train")
        write_meta(root, {"source": video.filename, "fps": fps, "frames": len(frames)})
        return {"task_id": task_id_from_root(root), "frames": len(frames)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, detail=f"Unexpected error: {e}")

@app.post("/api/ingest/youtube")
def api_ingest_youtube(body: IngestYT):
    try:
        temp_root = dated_task_root(slugify(body.task_name or "youtube"))
        tmp_dir = temp_root / "_tmp"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        vpath, title = yt_download(body.youtube_url, tmp_dir)
        final_root = dated_task_root(slugify(title))
        img_root, lbl_root = prepare_structure(final_root)
        frames = extract_frames_ffmpeg(vpath, img_root, fps=body.fps, split="train")
        write_meta(final_root, {"source": body.youtube_url, "title": title, "fps": body.fps, "frames": len(frames)})
        return {"task_id": task_id_from_root(final_root), "frames": len(frames)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, detail=f"Unexpected error: {e}")

@app.get("/api/task/{task_id}/frames")
def api_list_frames(task_id: str, split: str = "train"):
    root = resolve_task_root(task_id)
    imgs = sorted([p.name for p in (root / "images" / split).glob("*.jpg")])
    return {"frames": imgs}

@app.get("/api/task/{task_id}/frame/{fname}")
def api_get_frame(task_id: str, fname: str, split: str = "train"):
    root = resolve_task_root(task_id)
    p = (root / "images" / split / fname)
    if not p.exists():
        raise HTTPException(404, detail="frame not found")
    return FileResponse(str(p))

@app.post("/api/task/{task_id}/label")
def api_label(task_id: str, body: LabelBody):
    root = resolve_task_root(task_id)
    imgp = root / "images" / body.split / body.image
    if not imgp.exists():
        raise HTTPException(404, detail="image not found")
    import cv2
    img = cv2.imread(str(imgp))
    if img is None:
        raise HTTPException(400, detail="could not read image")
    H, W = img.shape[:2]
    w_px = h_px = max(2, float(body.box_px))
    x_center = float(body.cx) / W
    y_center = float(body.cy) / H
    w_norm = w_px / W
    h_norm = h_px / H
    line = f"{BALL_CLASS_ID} {x_center:.6f} {y_center:.6f} {w_norm:.6f} {h_norm:.6f}\n"
    lblp = root / "labels" / body.split / f"{Path(body.image).stem}.txt"
    lblp.write_text(line, encoding="utf-8")
    return {"ok": True, "label": line}

@app.post("/api/task/{task_id}/skip")
def api_skip(task_id: str, body: SkipBody):
    root = resolve_task_root(task_id)
    imgp = root / "images" / body.split / body.image
    if not imgp.exists():
        raise HTTPException(404, detail="image not found")
    lblp = root / "labels" / body.split / f"{Path(body.image).stem}.txt"
    lblp.write_text("", encoding="utf-8")
    return {"ok": True}

@app.get("/api/task/{task_id}/export")
def api_export(task_id: str):
    root = resolve_task_root(task_id)
    zip_path = DATA_ROOT / (task_id.replace("/", "_") + ".zip")
    if zip_path.exists():
        zip_path.unlink()
    shutil.make_archive(str(zip_path.with_suffix("")), "zip", root)
    return FileResponse(str(zip_path))
