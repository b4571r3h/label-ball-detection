#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
TT Ball Labeler – FastAPI Backend

Features
- /api/ingest/upload:   MP4/MOV hochladen, Frames extrahieren
- /api/ingest/youtube:  YouTube-URL ingest (yt-dlp), Frames extrahieren
- /api/tasks:           Aufgaben (Tasks) auflisten
- /api/task/{id}/frames:Frames für Task auflisten
- /api/task/{id}/frame/{name}: Bild ausliefern
- /api/task/{id}/label: Klick speichern (YOLO .txt)
- /api/task/{id}/export: ZIP mit YOLO-Struktur erzeugen
- /api/health:          Healthcheck

Subpfad:
- Per Umgebungsvariable APP_ROOT_PATH (z. B. "/ball-detection")
  wird die App unter diesem Pfad gemountet.
  Beispiel: http://HOST/ball-detection/api/health
"""

from __future__ import annotations

import os
import io
import re
import cv2
import json
import math
import time
import shutil
import zipfile
import tempfile
import datetime as dt
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Response
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from PIL import Image

# ---------------------------------------------------------------------
# Konfiguration
# ---------------------------------------------------------------------

BASE_DIR = Path(__file__).parent.resolve()
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = Path(os.getenv("LABEL_DATA_DIR", BASE_DIR / "data")).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)

APP_ROOT_PATH = os.getenv("APP_ROOT_PATH", "").rstrip("/")  # z. B. "/ball-detection"

ALLOWED_VIDEO_EXT = {".mp4", ".mov", ".m4v", ".avi", ".mkv"}

# Ordnerstruktur pro Task:
#   data/
#     <task_id>/
#        video.(mp4|…)
#        frames/000001.jpg, …
#        labels/000001.txt
#        meta.json


# ---------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------

def slugify(s: str, allow_empty: str = "task") -> str:
    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9._-]+", "-", s)
    s = re.sub(r"-{2,}", "-", s).strip("-")
    return s or allow_empty


def new_task_id(hint: str = "") -> str:
    ts = dt.datetime.now().strftime("%Y-%m-%d")
    hint = slugify(hint, allow_empty="task")
    return f"{ts}/{hint}-{int(time.time())}" if hint else f"{ts}/task-{int(time.time())}"


def task_dir(task_id: str) -> Path:
    p = DATA_DIR / task_id
    p.mkdir(parents=True, exist_ok=True)
    (p / "frames").mkdir(parents=True, exist_ok=True)
    (p / "labels").mkdir(parents=True, exist_ok=True)
    return p


def write_meta(td: Path, meta: dict) -> None:
    (td / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")


def read_meta(td: Path) -> dict:
    f = td / "meta.json"
    return json.loads(f.read_text()) if f.exists() else {}


def extract_frames(video_path: Path, out_dir: Path, fps: int) -> int:
    """Extrahiert Frames mit OpenCV (keine ffmpeg-Abhängigkeit)."""
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise HTTPException(400, f"Kann Video nicht öffnen: {video_path.name}")

    native_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    step = max(int(round(native_fps / max(1, fps))), 1)
    idx = 0
    saved = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % step == 0:
            out = out_dir / f"{saved+1:06d}.jpg"
            cv2.imwrite(str(out), frame)
            saved += 1
        idx += 1

    cap.release()
    return saved


def download_youtube(url: str) -> Path:
    """Lädt ein YouTube-Video in ein Temp-Verzeichnis (mp4)."""
    try:
        import yt_dlp  # type: ignore
    except Exception as e:
        raise HTTPException(500, "yt-dlp nicht installiert") from e

    tmpdir = Path(tempfile.mkdtemp(prefix="yt_label_"))
    outtmpl = str(tmpdir / "%(title).200s.%(ext)s")
    ydl_opts = {
        "outtmpl": outtmpl,
        "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        file = ydl.prepare_filename(info)

    p = Path(file)
    if not p.exists():
        # Fallback: zuletzt geänderte Datei im Temp-Verzeichnis
        cand = list(tmpdir.glob("*"))
        if not cand:
            raise HTTPException(500, "yt-dlp hat keine Datei erzeugt")
        p = max(cand, key=lambda x: x.stat().st_mtime)
    return p


def list_frames(task_id: str) -> List[str]:
    td = task_dir(task_id)
    files = sorted((td / "frames").glob("*.jpg"))
    return [f.name for f in files]


def image_size(jpg_path: Path) -> tuple[int, int]:
    with Image.open(jpg_path) as im:
        return im.width, im.height


# ---------------------------------------------------------------------
# Pydantic Models
# ---------------------------------------------------------------------

class LabelIn(BaseModel):
    filename: str  # z. B. "000123.jpg"
    cx: float      # Klick: center-x in Pixel
    cy: float      # Klick: center-y in Pixel
    box: float     # Quadratische Box-Kantenlänge (Pixel)


# ---------------------------------------------------------------------
# FastAPI Apps (Core + Wrapper für Subpfad)
# ---------------------------------------------------------------------

core = FastAPI(title="TT Ball Labeler")
core.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@core.get("/", include_in_schema=False)
def index_html():
    return FileResponse(str(STATIC_DIR / "index.html"))


@core.get("/api/health")
def api_health():
    return {"status": "ok"}


@core.get("/api/tasks")
def api_tasks():
    """Listet Tasks mit Anzahl Frames auf."""
    tasks = []
    if not DATA_DIR.exists():
        return {"tasks": tasks}
    for day in sorted(DATA_DIR.glob("*")):
        if not day.is_dir():
            continue
        for t in sorted(day.glob("*")):
            if not t.is_dir():
                continue
            rel = str(t.relative_to(DATA_DIR))
            frames = len(list((t / "frames").glob("*.jpg")))
            meta = read_meta(t)
            tasks.append({"id": rel, "frames": frames, "meta": meta})
    return {"tasks": tasks}


# -------------------- Ingest: Upload --------------------

@core.post("/api/ingest/upload")
async def api_ingest_upload(
    file: UploadFile = File(...),
    fps: int = Form(5),
    task_name: str = Form("")
):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_VIDEO_EXT:
        raise HTTPException(400, f"Videoformat nicht erlaubt: {ext}")

    tid = new_task_id(task_name)
    td = task_dir(tid)

    # Video speichern
    vid_path = td / f"video{ext}"
    with open(vid_path, "wb") as f:
        f.write(await file.read())

    # Frames extrahieren
    n = extract_frames(vid_path, td / "frames", fps=fps)

    meta = {
        "source": "upload",
        "filename": file.filename,
        "fps": fps,
        "created": dt.datetime.utcnow().isoformat() + "Z",
    }
    write_meta(td, meta)

    return {"task_id": tid, "frames": n, "meta": meta}


# -------------------- Ingest: YouTube --------------------

@core.post("/api/ingest/youtube")
def api_ingest_youtube(
    url: str = Form(...),
    fps: int = Form(5),
    task_name: str = Form("")
):
    if not url.startswith("http"):
        raise HTTPException(400, "Ungültige URL")

    tid = new_task_id(task_name)
    td = task_dir(tid)

    # Download
    ytp = download_youtube(url)
    ext = ytp.suffix.lower()
    vid_path = td / f"video{ext}"
    shutil.move(str(ytp), str(vid_path))

    # Frames
    n = extract_frames(vid_path, td / "frames", fps=fps)

    meta = {
        "source": "youtube",
        "url": url,
        "fps": fps,
        "created": dt.datetime.utcnow().isoformat() + "Z",
    }
    write_meta(td, meta)

    return {"task_id": tid, "frames": n, "meta": meta}


# -------------------- Frames auflisten/ausliefern --------------------

@core.get("/api/task/{task_id}/frames")
def api_task_frames(task_id: str):
    frames = list_frames(task_id)
    return {"task_id": task_id, "frames": frames}


@core.get("/api/task/{task_id}/frame/{filename}")
def api_task_frame_image(task_id: str, filename: str):
    td = task_dir(task_id)
    img = (td / "frames" / filename).resolve()
    if not img.exists() or img.suffix.lower() != ".jpg":
        raise HTTPException(404, "Frame nicht gefunden")
    # Content-Type: image/jpeg wird von FileResponse korrekt gesetzt
    return FileResponse(str(img))


# -------------------- Label speichern (YOLO-Format) --------------------

@core.post("/api/task/{task_id}/label")
def api_task_save_label(task_id: str, li: LabelIn):
    td = task_dir(task_id)
    img = (td / "frames" / li.filename).resolve()
    if not img.exists():
        raise HTTPException(404, "Frame nicht gefunden")

    W, H = image_size(img)
    # quadratische Box
    bw = bh = max(2.0, li.box)
    # YOLO-normalisiert
    x = li.cx / W
    y = li.cy / H
    w = bw / W
    h = bh / H

    # clamp
    x = min(max(x, 0.0), 1.0)
    y = min(max(y, 0.0), 1.0)
    w = min(max(w, 0.0), 1.0)
    h = min(max(h, 0.0), 1.0)

    # eine Klasse "ball" = 0
    txt = f"0 {x:.6f} {y:.6f} {w:.6f} {h:.6f}\n"

    lab_path = (td / "labels" / (Path(li.filename).stem + ".txt")).resolve()
    lab_path.write_text(txt, encoding="utf-8")

    return {"ok": True, "saved": lab_path.name}


# -------------------- Export ZIP (YOLO-Struktur) --------------------

@core.get("/api/task/{task_id}/export")
def api_task_export(task_id: str):
    td = task_dir(task_id)
    frames = sorted((td / "frames").glob("*.jpg"))
    labels = sorted((td / "labels").glob("*.txt"))

    if not frames:
        raise HTTPException(400, "Keine Frames vorhanden")

    # temp ZIP bauen
    tmp = Path(tempfile.mkdtemp(prefix="export_"))
    zip_path = tmp / f"{slugify(task_id, 'task')}.zip"

    # YOLO-Ordnerstruktur: images/ und labels/
    zf = zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED)
    try:
        for f in frames:
            zf.write(f, arcname=f"images/{f.name}")
        for l in labels:
            zf.write(l, arcname=f"labels/{l.name}")

        # Einfaches dataset.yaml hinzufügen (einzelne Klasse)
        dataset_yaml = (
            "path: .\n"
            "train: images\n"
            "val: images\n"
            "nc: 1\n"
            "names: ['ball']\n"
        )
        zf.writestr("dataset.yaml", dataset_yaml)
    finally:
        zf.close()

    return FileResponse(
        path=str(zip_path),
        filename=zip_path.name,
        media_type="application/zip",
    )


# ---------------------------------------------------------------------
# Wrapper-App, um Subpfad korrekt zu bedienen
# ---------------------------------------------------------------------

if APP_ROOT_PATH:
    # Leere Hülle, die die "core"-App unter dem Subpfad mountet
    app = FastAPI()
    app.mount(APP_ROOT_PATH, core)

    @app.get("/", include_in_schema=False)
    def _root_redirect():
        return RedirectResponse(url=f"{APP_ROOT_PATH}/")

else:
    app = core


# ---------------------------------------------------------------------
# Dev-Server
# ---------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    # Lokal starten: python app.py
    # In Docker übernimmt das CMD den Start.
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
