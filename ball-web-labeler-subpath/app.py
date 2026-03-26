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
- /api/task/{id}/label/empty: Negativ-Frame (leere .txt)
- /api/task/{id}/label-count: Anzahl Frames mit Label-Datei
- /api/stats/labeled-total: Summe gelabelter Frames (Labeler-Tasks + optional IMPORT_YOLO_BALL_DIR)
- /api/stats/import-yolo: Status des importierten YOLO-Splits (Train/Val)
- /api/export/import-yolo-zip: ZIP des Import-Ordners (für lokales Training)
- /api/task/{id}/export: ZIP flach (images/, labels/)
- /api/task/{id}/export-yolo-split: ZIP für Training (images/train|val, labels/train|val)
- /api/export/yolo-dataset-full: Ein ZIP (Labeler + standardmäßig IMPORT_YOLO_BALL_DIR, Query include_import)
- /api/stats/labeled-export: Metriken für Voll-Export (Frames, Tasks)
- /api/health:          Healthcheck

Umgebung:
- LABEL_VIDEO_RETENTION_DAYS (Standard 5): Originalvideo video.* löschen wenn älter (0 = aus)
- LABEL_VIDEO_CLEANUP_INTERVAL_SEC (Standard 3600): Prüfintervall in Sekunden
- IMPORT_YOLO_BALL_DIR: optionaler Pfad zu einem YOLO-Root (images/train|val, labels/train|val) für Zähler + Training
- BALL_DETECTION_EXPORT_API_KEY: optional; wenn gesetzt, verlangen /api/export/yolo-dataset-full und
  /api/stats/labeled-export den Header Authorization: Bearer <dieselber Wert>

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
import random
import asyncio
import hashlib
import datetime as dt
from collections import defaultdict
from contextlib import asynccontextmanager
from enum import Enum
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Response, Query, Depends
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
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

_raw_import = os.getenv("IMPORT_YOLO_BALL_DIR", "").strip()
IMPORT_YOLO_BALL_DIR: Optional[Path] = (
    Path(_raw_import).resolve() if _raw_import else None
)

APP_ROOT_PATH = os.getenv("APP_ROOT_PATH", "").rstrip("/")  # z. B. "/ball-detection"

BALL_DETECTION_EXPORT_API_KEY = os.getenv("BALL_DETECTION_EXPORT_API_KEY", "").strip()

# YOLO-Split-Import (images/train|val + passende labels/train|val)
IMPORT_YOLO_IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}

export_bearer = HTTPBearer(auto_error=False)


def require_export_bearer(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(export_bearer),
) -> None:
    """Schützt Voll-Export + Export-Stats, wenn BALL_DETECTION_EXPORT_API_KEY gesetzt ist."""
    if not BALL_DETECTION_EXPORT_API_KEY:
        return
    token = (creds.credentials if creds else "") or ""
    token = token.strip()
    if token != BALL_DETECTION_EXPORT_API_KEY:
        raise HTTPException(
            status_code=401,
            detail=(
                "Authorization: Bearer <Token> erforderlich (gleicher Wert wie "
                "Umgebungsvariable BALL_DETECTION_EXPORT_API_KEY)."
            ),
        )


class YoloFullExportStrategy(str, Enum):
    """Split-Strategie für GET /api/export/yolo-dataset-full."""

    global_split = "global_split"
    per_task_split = "per_task_split"


# Originalvideos löschen, wenn älter als N Tage (mtime). 0 = deaktiviert.
LABEL_VIDEO_RETENTION_DAYS = int(os.getenv("LABEL_VIDEO_RETENTION_DAYS", "5"))
LABEL_VIDEO_CLEANUP_INTERVAL_SEC = int(os.getenv("LABEL_VIDEO_CLEANUP_INTERVAL_SEC", "3600"))

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


def delete_old_source_videos(data_dir: Path, max_age_days: int) -> int:
    """Entfernt video.* in Task-Ordnern, deren mtime älter als max_age_days ist."""
    if max_age_days <= 0:
        return 0
    cutoff = time.time() - max_age_days * 86400
    removed = 0
    if not data_dir.is_dir():
        return 0
    for day_dir in data_dir.iterdir():
        if not day_dir.is_dir():
            continue
        for td in day_dir.iterdir():
            if not td.is_dir():
                continue
            for vid in td.glob("video.*"):
                if vid.suffix.lower() not in ALLOWED_VIDEO_EXT:
                    continue
                try:
                    if vid.is_file() and vid.stat().st_mtime < cutoff:
                        vid.unlink()
                        removed += 1
                except OSError:
                    pass
    return removed


@asynccontextmanager
async def video_retention_lifespan(app: FastAPI):
    async def cleanup_loop():
        while True:
            try:
                n = delete_old_source_videos(DATA_DIR, LABEL_VIDEO_RETENTION_DAYS)
                if n:
                    print(
                        f"[labeler] Video cleanup: {n} file(s) removed "
                        f"(>{LABEL_VIDEO_RETENTION_DAYS}d, interval {LABEL_VIDEO_CLEANUP_INTERVAL_SEC}s)"
                    )
            except Exception as e:
                print(f"[labeler] Video cleanup error: {e}")
            await asyncio.sleep(LABEL_VIDEO_CLEANUP_INTERVAL_SEC)

    task = asyncio.create_task(cleanup_loop())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


def extract_frames(video_path: Path, out_dir: Path, fps: int, max_duration_seconds: int = 120) -> int:
    """Extrahiert Frames mit OpenCV (keine ffmpeg-Abhängigkeit).
    
    Args:
        video_path: Pfad zum Video
        out_dir: Ausgabeordner für Frames
        fps: Gewünschte FPS für Extraktion
        max_duration_seconds: Maximale Dauer in Sekunden (Standard: 120 = 2 Minuten)
    """
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise HTTPException(400, f"Kann Video nicht öffnen: {video_path.name}")

    native_fps = cap.get(cv2.CAP_PROP_FPS)
    try:
        native_fps = float(native_fps)
    except Exception:
        native_fps = 0.0
    if not native_fps or native_fps <= 0:
        native_fps = 25.0

    # OpenCV liefert bei manchen Videos (häufig vom YouTube-Download) Frame-Count/Duration nicht zuverlässig.
    total_frames = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    try:
        total_frames = int(total_frames)
    except Exception:
        total_frames = 0

    video_duration = (total_frames / native_fps) if total_frames > 0 else 0.0

    # Sampling-Rate (in Frames)
    step = max(int(round(native_fps / max(1, fps))), 1)

    # Stop-Kriterium:
    # - Wenn Frame-Count bekannt ist -> frame_limit
    # - Sonst -> time_limit (per CAP_PROP_POS_MSEC bzw. Fallback idx/native_fps)
    if total_frames > 0:
        max_frames = int(native_fps * max_duration_seconds)
        actual_frames = min(total_frames, max_frames)
        actual_duration = actual_frames / native_fps
        stop_mode = "frame_limit"
    else:
        actual_frames = 0
        actual_duration = float(max_duration_seconds)
        stop_mode = "time_limit"

    print(
        f"Video Info: duration={video_duration:.1f}s frame_count={total_frames} "
        f"stop_mode={stop_mode}, processing first ~{actual_duration:.1f}s (step={step})"
    )

    idx = 0
    saved = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break

        if stop_mode == "frame_limit" and idx >= actual_frames:
            break

        if idx % step == 0:
            out = out_dir / f"{saved + 1:06d}.jpg"
            cv2.imwrite(str(out), frame)
            saved += 1

        idx += 1

        if stop_mode == "time_limit":
            # Zeit anhand der Decoder-Position bestimmen (falls verfügbar)
            pos_msec = cap.get(cv2.CAP_PROP_POS_MSEC)
            elapsed_s = None
            try:
                elapsed_s = float(pos_msec) / 1000.0
            except Exception:
                elapsed_s = None
            if not elapsed_s or elapsed_s <= 0:
                elapsed_s = idx / native_fps
            if elapsed_s > max_duration_seconds:
                break

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


class EmptyLabelIn(BaseModel):
    """Negativ-Beispiel: leere YOLO-Datei (keine Objekte im Bild)."""
    filename: str


# ---------------------------------------------------------------------
# FastAPI Apps (Core + Wrapper für Subpfad)
# ---------------------------------------------------------------------

_core_kw = {
    "title": "SpinEvo Ball Detection Labeler API",
    "description": (
        "**YOLOv8 Voll-Export:** `GET /api/export/yolo-dataset-full` liefert ein ZIP mit "
        "`dataset.yaml`, `images/train`, `images/val`, `labels/train`, `labels/val` "
        "(standardmäßig Labeler-Daten + optional `IMPORT_YOLO_BALL_DIR`, vgl. `/api/stats/labeled-total`). "
        "Labels: eine Zeile pro Box `0 cx cy w h` (normalisiert); Negativ-Beispiele = leere `.txt`. "
        "**Auth (optional):** Wenn die Umgebungsvariable `BALL_DETECTION_EXPORT_API_KEY` gesetzt ist, "
        "Header `Authorization: Bearer <gleicher Wert>` für diesen Endpunkt und "
        "`GET /api/stats/labeled-export` senden. "
        "Siehe README-Abschnitt „Training / YOLO Export“."
    ),
}
if not APP_ROOT_PATH:
    _core_kw["lifespan"] = video_retention_lifespan

_core_kw["openapi_tags"] = [
    {
        "name": "export",
        "description": (
            "YOLOv8-Dataset-Export. Optional Bearer-Auth, wenn `BALL_DETECTION_EXPORT_API_KEY` gesetzt ist."
        ),
    },
]

core = FastAPI(**_core_kw)
core.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@core.get("/", include_in_schema=False)
def index_html():
    return FileResponse(str(STATIC_DIR / "index.html"))


@core.get("/label-review", include_in_schema=False)
def label_review_html():
    """Separate Seite zum Prüfen/Bearbeiten bestehender Labels."""
    return FileResponse(str(STATIC_DIR / "label_review.html"))


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

    # Video-Info vorher ermitteln für Metadaten
    cap = cv2.VideoCapture(str(vid_path))
    if cap.isOpened():
        native_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        video_duration = total_frames / native_fps
        cap.release()
    else:
        video_duration = 0

    # Frames extrahieren (max 2 Minuten)
    n = extract_frames(vid_path, td / "frames", fps=fps, max_duration_seconds=120)

    meta = {
        "source": "upload",
        "filename": file.filename,
        "fps": fps,
        "created": dt.datetime.utcnow().isoformat() + "Z",
        "video_duration_total": round(video_duration, 1),
        "video_duration_processed": min(video_duration, 120),
        "limited_to_2min": video_duration > 120
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

    # Video-Info vorher ermitteln für Metadaten
    cap = cv2.VideoCapture(str(vid_path))
    if cap.isOpened():
        native_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        video_duration = total_frames / native_fps
        cap.release()
    else:
        video_duration = 0

    # Frames extrahieren (max 2 Minuten)
    n = extract_frames(vid_path, td / "frames", fps=fps, max_duration_seconds=120)

    meta = {
        "source": "youtube",
        "url": url,
        "fps": fps,
        "created": dt.datetime.utcnow().isoformat() + "Z",
        "video_duration_total": round(video_duration, 1),
        "video_duration_processed": min(video_duration, 120),
        "limited_to_2min": video_duration > 120
    }
    write_meta(td, meta)

    return {"task_id": tid, "frames": n, "meta": meta}


# -------------------- Frames auflisten/ausliefern --------------------

@core.get("/api/task/{task_id:path}/frames")
def api_task_frames(task_id: str):
    frames = list_frames(task_id)
    return {"task_id": task_id, "frames": frames}


def count_labeled_frames(task_id: str) -> tuple[int, int]:
    """(Anzahl JPGs mit passender labels/*.txt, Gesamt-JPGs)."""
    td = DATA_DIR / task_id
    frames_dir = td / "frames"
    labels_dir = td / "labels"
    if not frames_dir.is_dir():
        return 0, 0
    frame_stems = {f.stem for f in frames_dir.glob("*.jpg")}
    labeled = 0
    if labels_dir.is_dir():
        for lf in labels_dir.glob("*.txt"):
            if lf.stem in frame_stems:
                labeled += 1
    return labeled, len(frame_stems)


def count_yolo_split_import(root: Optional[Path]) -> int:
    """Zählt Bilder in images/{train,val} mit passender .txt in labels/{train,val}."""
    if root is None or not root.is_dir():
        return 0
    n = 0
    for split in ("train", "val"):
        idir = root / "images" / split
        ldir = root / "labels" / split
        if not idir.is_dir() or not ldir.is_dir():
            continue
        for img in idir.iterdir():
            if not img.is_file():
                continue
            if img.suffix.lower() not in IMPORT_YOLO_IMG_EXT:
                continue
            if (ldir / f"{img.stem}.txt").exists():
                n += 1
    return n


def iter_labeler_yolo_pairs() -> list[tuple[str, Path, Path]]:
    """
    Alle gelabelten Paare unter DATA_DIR: (task_id, frame.jpg, labels/stem.txt).
    Negativ-Beispiele: leere .txt-Datei zählt, sobald die Datei existiert (0 Bytes erlaubt).
    """
    out: list[tuple[str, Path, Path]] = []
    if not DATA_DIR.is_dir():
        return out
    for day in sorted(DATA_DIR.iterdir()):
        if not day.is_dir():
            continue
        for t in sorted(day.iterdir()):
            if not t.is_dir():
                continue
            rel = str(t.relative_to(DATA_DIR))
            frames_dir = t / "frames"
            labels_dir = t / "labels"
            if not frames_dir.is_dir() or not labels_dir.is_dir():
                continue
            for img in sorted(frames_dir.glob("*.jpg")):
                lab = (labels_dir / f"{img.stem}.txt").resolve()
                if not lab.is_file():
                    continue
                try:
                    img.resolve().relative_to(DATA_DIR.resolve())
                    lab.relative_to(DATA_DIR.resolve())
                except ValueError:
                    continue
                out.append((rel, img.resolve(), lab))
    return out


def _is_yolo_label_with_ball(label_path: Path) -> bool:
    """
    YOLO Negativ = leere .txt (0 Bytes) oder nur Whitespace.
    Positiv = mindestens eine Box-Zeile -> Datei enthält non-whitespace Content.
    """
    try:
        # Dateien sind typischerweise klein; Lesen ist ok für Stats-Zählung.
        return bool(label_path.read_text(encoding="utf-8").strip())
    except Exception:
        # Falls Lesen fehlschlägt: als "kein Ball" werten, um nicht zu überschätzen.
        return False


def count_labeler_frames_with_ball() -> int:
    """Zählt Frames mit Ball: (DATA_DIR) frame.jpg existiert + labels/stem.txt ist nicht-leer."""
    if not DATA_DIR.is_dir():
        return 0

    total = 0
    for day_dir in sorted(DATA_DIR.iterdir()):
        if not day_dir.is_dir():
            continue
        for task_sub in day_dir.iterdir():
            if not task_sub.is_dir():
                continue
            frames_dir = task_sub / "frames"
            labels_dir = task_sub / "labels"
            if not frames_dir.is_dir() or not labels_dir.is_dir():
                continue

            frame_stems = {f.stem for f in frames_dir.glob("*.jpg")}
            for lf in labels_dir.glob("*.txt"):
                if lf.stem not in frame_stems:
                    continue
                if _is_yolo_label_with_ball(lf):
                    total += 1
    return total


def count_import_frames_with_ball(root: Optional[Path]) -> int:
    """Zählt Import-Frames mit Ball: Import images/{train,val} + labels/{train,val} .txt ist nicht-leer."""
    if root is None or not root.is_dir():
        return 0

    root = root.resolve()
    total = 0
    for split in ("train", "val"):
        idir = root / "images" / split
        ldir = root / "labels" / split
        if not idir.is_dir() or not ldir.is_dir():
            continue
        for img in idir.iterdir():
            if not img.is_file():
                continue
            if img.suffix.lower() not in IMPORT_YOLO_IMG_EXT:
                continue
            lab = (ldir / f"{img.stem}.txt").resolve()
            if lab.is_file() and _is_yolo_label_with_ball(lab):
                total += 1
    return total


def iter_import_yolo_split_pairs(
    root: Optional[Path],
) -> tuple[list[tuple[str, Path, Path]], list[tuple[str, Path, Path]]]:
    """
    Paare aus IMPORT_YOLO_BALL_DIR mit bestehender train/val-Zuordnung.
    pseudo_task_id pro Split, damit export_unique_stem kollisionsfrei bleibt.
    """
    train_out: list[tuple[str, Path, Path]] = []
    val_out: list[tuple[str, Path, Path]] = []
    if root is None or not str(root).strip() or not root.is_dir():
        return train_out, val_out
    root = root.resolve()
    for split_name, bucket in (("train", train_out), ("val", val_out)):
        idir = root / "images" / split_name
        ldir = root / "labels" / split_name
        if not idir.is_dir() or not ldir.is_dir():
            continue
        pseudo = f"__yolo_import__/{split_name}"
        for img in sorted(idir.iterdir()):
            if not img.is_file():
                continue
            if img.suffix.lower() not in IMPORT_YOLO_IMG_EXT:
                continue
            lab = (ldir / f"{img.stem}.txt").resolve()
            if not lab.is_file():
                continue
            try:
                img.resolve().relative_to(root)
                lab.relative_to(root)
            except ValueError:
                continue
            bucket.append((pseudo, img.resolve(), lab))
    return train_out, val_out


def export_unique_stem(task_id: str, frame_filename: str) -> str:
    """Eindeutiger Basisname (ohne Extension) für Bild + Label im ZIP über alle Tasks."""
    pfx = hashlib.sha256(task_id.encode("utf-8")).hexdigest()[:12]
    stem = Path(frame_filename).stem
    return f"{pfx}_{stem}"


def _split_pairs_train_val(
    pairs: list[tuple[str, Path, Path]],
    val_fraction: float,
    seed: int,
) -> tuple[list[tuple[str, Path, Path]], list[tuple[str, Path, Path]]]:
    """Ein Pool; reproduzierbarer Train/Val-Split (gleiche Logik wie pro-Task-Export)."""
    rng = random.Random(seed)
    items = list(pairs)
    rng.shuffle(items)
    n = len(items)
    if n == 0:
        return [], []
    if n == 1:
        return items, list(items)
    n_val = max(1, min(n - 1, int(round(n * val_fraction))))
    val_items = items[:n_val]
    train_items = items[n_val:]
    return train_items, val_items


def _derived_seed(base_seed: int, salt: str) -> int:
    h = hashlib.sha256(f"{base_seed}:{salt}".encode("utf-8")).hexdigest()
    return int(h[:8], 16)


def train_val_for_full_export(
    pairs: list[tuple[str, Path, Path]],
    val_fraction: float,
    seed: int,
    strategy: YoloFullExportStrategy,
) -> tuple[list[tuple[str, Path, Path]], list[tuple[str, Path, Path]]]:
    if strategy == YoloFullExportStrategy.global_split:
        return _split_pairs_train_val(pairs, val_fraction, seed)
    by_task: dict[str, list[tuple[str, Path, Path]]] = defaultdict(list)
    for row in pairs:
        by_task[row[0]].append(row)
    train_all: list[tuple[str, Path, Path]] = []
    val_all: list[tuple[str, Path, Path]] = []
    for tid in sorted(by_task.keys()):
        chunk = by_task[tid]
        tr, va = _split_pairs_train_val(chunk, val_fraction, _derived_seed(seed, tid))
        train_all.extend(tr)
        val_all.extend(va)
    return train_all, val_all


def build_yolo_full_zip_file(
    train_pairs: list[tuple[str, Path, Path]],
    val_pairs: list[tuple[str, Path, Path]],
    strategy: YoloFullExportStrategy,
) -> Path:
    """ZIP auf Disk (Tempdir); enthält dataset.yaml + images/{train,val} + labels/{train,val}. Bilder: .jpg."""
    tmp = Path(tempfile.mkdtemp(prefix="yolo_full_export_"))
    zip_path = tmp / "spinvo-yolo-dataset-full.zip"
    zf = zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED)
    try:
        for split_name, plist in (("train", train_pairs), ("val", val_pairs)):
            for task_id, img_p, lab_p in plist:
                stem = export_unique_stem(task_id, img_p.name)
                sfx = img_p.suffix.lower()
                if sfx not in IMPORT_YOLO_IMG_EXT:
                    sfx = ".jpg"
                arc_img = f"images/{split_name}/{stem}{sfx}"
                arc_lab = f"labels/{split_name}/{stem}.txt"
                zf.write(img_p, arcname=arc_img)
                zf.write(lab_p, arcname=arc_lab)

        comment = (
            f"# SpinEvo Ball-Detection Voll-Export; strategy={strategy.value}; "
            "Negativ: leere .txt (0 Bytes) pro Bild. "
            "Import-Ordner (falls enthalten): bestehende train/val-Pfade, ohne Neu-Split.\n"
        )
        dataset_yaml = comment + (
            "path: .\n"
            "train: images/train\n"
            "val: images/val\n"
            "nc: 1\n"
            "names: ['ball']\n"
        )
        zf.writestr("dataset.yaml", dataset_yaml)
    finally:
        zf.close()
    return zip_path


@core.get("/api/task/{task_id:path}/label-count")
def api_task_label_count(task_id: str):
    labeled, total = count_labeled_frames(task_id)
    return {"task_id": task_id, "labeled": labeled, "total_frames": total}


@core.get("/api/stats/labeled-total")
def api_stats_labeled_total():
    """Summe gelabelter Frames: Labeler-Tasks + optional IMPORT_YOLO_BALL_DIR."""
    total_labeler = 0
    if DATA_DIR.is_dir():
        for day_dir in sorted(DATA_DIR.iterdir()):
            if not day_dir.is_dir():
                continue
            for task_sub in day_dir.iterdir():
                if not task_sub.is_dir():
                    continue
                rel = f"{day_dir.name}/{task_sub.name}"
                n, _ = count_labeled_frames(rel)
                total_labeler += n
    total_import = count_yolo_split_import(IMPORT_YOLO_BALL_DIR)
    return {
        "labeled": total_labeler + total_import,
        "labeled_labeler": total_labeler,
        "labeled_import": total_import,
    }


@core.get("/api/stats/import-yolo")
def api_stats_import_yolo():
    """Ob und wie viele Paare im IMPORT_YOLO_BALL_DIR liegen."""
    root = IMPORT_YOLO_BALL_DIR
    paired = count_yolo_split_import(root)
    return {
        "enabled": bool(root and root.is_dir()),
        "path": str(root) if root else "",
        "paired": paired,
    }


def _zip_import_yolo_root(root: Path) -> Path:
    """Baut ein ZIP mit images/train|val und labels/train|val relativ zu root."""
    root = root.resolve()
    if not root.is_dir():
        raise HTTPException(503, "Import-Verzeichnis existiert nicht.")

    tmp = Path(tempfile.mkdtemp(prefix="import_yolo_zip_"))
    zip_path = tmp / "spinvo-yolo-import.zip"
    subdirs = [
        root / "images" / "train",
        root / "images" / "val",
        root / "labels" / "train",
        root / "labels" / "val",
    ]
    file_count = 0
    zf = zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED)
    try:
        for d in subdirs:
            if not d.is_dir():
                continue
            try:
                rel_parent = d.relative_to(root)
            except ValueError:
                continue
            for f in sorted(d.iterdir()):
                if not f.is_file():
                    continue
                try:
                    f.resolve().relative_to(root)
                except ValueError:
                    continue
                arc = rel_parent / f.name
                zf.write(f, arcname=str(arc).replace("\\", "/"))
                file_count += 1

        ds = root / "dataset.yaml"
        if ds.is_file():
            zf.write(ds, arcname="dataset.yaml")
        elif file_count > 0:
            zf.writestr(
                "dataset.yaml",
                "path: .\n"
                "train: images/train\n"
                "val: images/val\n"
                "nc: 1\n"
                "names: ['ball']\n",
            )
    finally:
        zf.close()

    if file_count == 0:
        try:
            zip_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise HTTPException(
            400,
            "Im Import-Ordner liegen keine Dateien unter images/{train,val} oder labels/{train,val}.",
        )

    return zip_path


@core.get("/api/export/import-yolo-zip")
def api_export_import_yolo_zip():
    """ZIP-Download: YOLO-Struktur aus IMPORT_YOLO_BALL_DIR (für lokales YOLOv8-Training)."""
    if IMPORT_YOLO_BALL_DIR is None or not str(IMPORT_YOLO_BALL_DIR).strip():
        raise HTTPException(
            503,
            "IMPORT_YOLO_BALL_DIR ist nicht gesetzt. Auf dem Server in compose.env konfigurieren.",
        )
    zip_path = _zip_import_yolo_root(IMPORT_YOLO_BALL_DIR)
    return FileResponse(
        path=str(zip_path),
        filename="spinvo-yolo-import.zip",
        media_type="application/zip",
    )


@core.get(
    "/api/stats/labeled-export",
    tags=["export"],
    summary="Metriken für YOLO-Voll-Export",
    dependencies=[Depends(require_export_bearer)],
)
def api_stats_labeled_export():
    """
    Anzahl gelabelter Frames (Labeler-Datenbank) und beteiligte Tasks.
    `last_export_build`: reserviert für zukünftiges serverseitiges Caching (derzeit immer null).
    """
    pairs_l = iter_labeler_yolo_pairs()
    imp_tr, imp_va = iter_import_yolo_split_pairs(IMPORT_YOLO_BALL_DIR)
    tasks = {p[0] for p in pairs_l} | {p[0] for p in imp_tr + imp_va}
    n_imp = len(imp_tr) + len(imp_va)
    return {
        "frames_total": len(pairs_l) + n_imp,
        "frames_total_labeler": len(pairs_l),
        "frames_total_import": n_imp,
        "tasks_included": len(tasks),
        "split_strategies": ["global_split", "per_task_split"],
        "default_strategy": YoloFullExportStrategy.global_split.value,
        "import_in_full_export_default": True,
        "last_export_build": None,
    }


@core.get(
    "/api/stats/labeled-balls-total",
    tags=["export"],
    summary="Anzahl Frames mit Ball (nicht-leere YOLO-Labels)",
    dependencies=[Depends(require_export_bearer)],
)
def api_stats_labeled_balls_total():
    """
    Zählt nur Frames, bei denen die YOLO-Labeldatei nicht leer ist (Ball sichtbar).

    - Labeler-Teil: DATA_DIR (frames/*.jpg + labels/*.txt)
    - Optional Import-Teil: IMPORT_YOLO_BALL_DIR (images/{train,val} + passende labels)
    """
    ball_labeler = count_labeler_frames_with_ball()
    ball_import = count_import_frames_with_ball(IMPORT_YOLO_BALL_DIR)
    return {
        "frames_with_ball_total": ball_labeler + ball_import,
        "frames_with_ball_labeler": ball_labeler,
        "frames_with_ball_import": ball_import,
    }


@core.get(
    "/api/export/yolo-dataset-full",
    tags=["export"],
    summary="YOLOv8-Dataset-ZIP (Labeler + optional Import)",
    response_class=FileResponse,
    responses={
        422: {
            "description": "Keine exportierbaren Bild+Label-Paare",
            "content": {
                "application/json": {"example": {"detail": "Keine gelabelten Frames im Datenverzeichnis."}}
            },
        },
    },
    dependencies=[Depends(require_export_bearer)],
)
def api_export_yolo_dataset_full(
    val_fraction: float = Query(
        0.2,
        ge=0.05,
        le=0.5,
        description="Anteil Validierung (nur Labeler-Teil; Import behält images/train|val).",
    ),
    seed: int = Query(42, description="Zufalls-Seed für reproduzierbaren Split."),
    strategy: YoloFullExportStrategy = Query(
        YoloFullExportStrategy.global_split,
        description=(
            "Gilt nur für Daten unter LABEL_DATA_DIR: "
            "`global_split` mischt alle Labeler-Paare, dann ein Train/Val-Split; "
            "`per_task_split` splittet je Task. "
            "Daten aus IMPORT_YOLO_BALL_DIR (wenn `include_import=true`) werden **ohne Neu-Split** "
            "den bestehenden Ordnern `images/train|val` zugeordnet und angehängt."
        ),
    ),
    include_import: bool = Query(
        True,
        description=(
            "Wenn true und IMPORT_YOLO_BALL_DIR gesetzt: zusätzlich alle Paare aus "
            "`images/{train,val}` + `labels/{train,val}` des Import-Ordners (wie Zähler „labeled-total“)."
        ),
    ),
):
    """
    Ein ZIP für `yolo detect train data=.../dataset.yaml`.

    **Inhalt:** `dataset.yaml` (path `.`, train/val relativ), `images/train|val/*`,
    `labels/train|val/*.txt` (gleicher Basisname wie Bild). Dateinamen sind über alle Quellen eindeutig
    (Präfix = SHA256-Fragment der internen Task-/Split-Kennung).

    **Hinweis:** Sehr große Datenmengen werden synchron als ZIP auf dem Server gebaut (Temp-Datei);
    bei Timeout-Problemen später ggf. asynchronen Job einplanen.
    """
    pairs_l = iter_labeler_yolo_pairs()
    if include_import:
        imp_train, imp_val = iter_import_yolo_split_pairs(IMPORT_YOLO_BALL_DIR)
    else:
        imp_train, imp_val = [], []

    if not pairs_l and not imp_train and not imp_val:
        raise HTTPException(
            status_code=422,
            detail=(
                "Keine exportierbaren Paare: weder Labeler (DATA_DIR mit frames+labels) "
                "noch Import (IMPORT_YOLO_BALL_DIR mit include_import=true)."
            ),
        )

    if pairs_l:
        train_l, val_l = train_val_for_full_export(
            pairs_l, val_fraction=val_fraction, seed=seed, strategy=strategy
        )
    else:
        train_l, val_l = [], []

    train_pairs = train_l + imp_train
    val_pairs = val_l + imp_val
    zip_path = build_yolo_full_zip_file(train_pairs, val_pairs, strategy)
    return FileResponse(
        path=str(zip_path),
        filename="spinvo-yolo-dataset-full.zip",
        media_type="application/zip",
    )


@core.get("/api/task/{task_id:path}/frame/{filename}")
def api_task_frame_image(task_id: str, filename: str):
    td = task_dir(task_id)
    img = (td / "frames" / filename).resolve()
    if not img.exists() or img.suffix.lower() != ".jpg":
        raise HTTPException(404, "Frame nicht gefunden")
    # Content-Type: image/jpeg wird von FileResponse korrekt gesetzt
    return FileResponse(str(img))


# -------------------- Label speichern (YOLO-Format) --------------------

@core.post("/api/task/{task_id:path}/label")
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


@core.get("/api/task/{task_id:path}/label")
def api_task_get_label(task_id: str, filename: str):
    """
    Lädt bestehende YOLO-Label für eine Frame-Datei.

    Antwort:
    - has_ball: bool
    - boxes: Liste von {class_id, cx, cy, w, h} (alle normalisiert 0..1)
    """
    td = task_dir(task_id)
    img = (td / "frames" / filename).resolve()
    if not img.exists():
        raise HTTPException(404, "Frame nicht gefunden")

    lab_path = (td / "labels" / (Path(filename).stem + ".txt")).resolve()
    if not lab_path.exists():
        return {"filename": filename, "has_ball": False, "boxes": [], "label_missing": True}

    boxes = []
    try:
        content = lab_path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        content = ""

    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 5:
            continue
        try:
            class_id = int(float(parts[0]))
            cx = float(parts[1])
            cy = float(parts[2])
            w = float(parts[3])
            h = float(parts[4])
        except Exception:
            continue

        # clamp (normalisiert 0..1)
        cx = min(max(cx, 0.0), 1.0)
        cy = min(max(cy, 0.0), 1.0)
        w = min(max(w, 0.0), 1.0)
        h = min(max(h, 0.0), 1.0)

        boxes.append({"class_id": class_id, "cx": cx, "cy": cy, "w": w, "h": h})

    has_ball = len(boxes) > 0
    return {"filename": filename, "has_ball": has_ball, "boxes": boxes, "label_missing": False}


@core.post("/api/task/{task_id:path}/label/empty")
def api_task_empty_label(task_id: str, body: EmptyLabelIn):
    """Schreibt eine leere .txt (YOLO: Bild ohne erkennbaren Ball)."""
    td = task_dir(task_id)
    img = (td / "frames" / body.filename).resolve()
    if not img.exists():
        raise HTTPException(404, "Frame nicht gefunden")

    lab_path = (td / "labels" / (Path(body.filename).stem + ".txt")).resolve()
    lab_path.write_text("", encoding="utf-8")

    return {"ok": True, "saved": lab_path.name, "negative": True}


# -------------------- Export ZIP (YOLO-Struktur) --------------------

@core.get("/api/task/{task_id:path}/export")
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


@core.get("/api/task/{task_id:path}/export-yolo-split")
def api_task_export_yolo_split(
    task_id: str,
    val_fraction: float = Query(0.2, ge=0.05, le=0.5, description="Anteil Validierung"),
    seed: int = Query(42, description="Zufalls-Seed für reproduzierbaren Split"),
):
    """
    ZIP für YOLOv8 / SpinEvo: nur Bilder **mit** passender .txt.
    Struktur: images/train, images/val, labels/train, labels/val + dataset.yaml
    """
    td = (DATA_DIR / task_id).resolve()
    if not td.is_dir():
        raise HTTPException(404, "Task nicht gefunden")

    pairs: list[tuple[Path, Path]] = []
    for f in sorted((td / "frames").glob("*.jpg")):
        lab = (td / "labels" / (f.stem + ".txt")).resolve()
        if lab.exists():
            pairs.append((f, lab))

    if not pairs:
        raise HTTPException(
            400,
            "Keine Paare Bild+Label: Es werden nur Frames exportiert, die bereits eine .txt haben.",
        )

    rng = random.Random(seed)
    rng.shuffle(pairs)
    n = len(pairs)

    if n == 1:
        train_pairs = list(pairs)
        val_pairs = list(pairs)
    else:
        n_val = max(1, min(n - 1, int(round(n * val_fraction))))
        val_pairs = pairs[:n_val]
        train_pairs = pairs[n_val:]

    tmp = Path(tempfile.mkdtemp(prefix="export_yolo_"))
    zip_path = tmp / f"spinvo-yolo-{slugify(task_id, 'task')}.zip"
    zf = zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED)
    try:
        for img_p, lab_p in train_pairs:
            zf.write(img_p, arcname=f"images/train/{img_p.name}")
            zf.write(lab_p, arcname=f"labels/train/{lab_p.name}")
        for img_p, lab_p in val_pairs:
            zf.write(img_p, arcname=f"images/val/{img_p.name}")
            zf.write(lab_p, arcname=f"labels/val/{lab_p.name}")

        dataset_yaml = (
            "# Entpacken, dann z. B. SPINEVO_BALL_DATA_DIR auf diesen Ordner setzen.\n"
            "path: .\n"
            "train: images/train\n"
            "val: images/val\n"
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
    # Leere Hülle, die die "core"-App unter dem Subpfad mountet (Lifespan nur hier – Sub-App nicht)
    app = FastAPI(lifespan=video_retention_lifespan)
    app.mount(APP_ROOT_PATH, core)

    @app.get("/", include_in_schema=False)
    def _root_redirect():
        return RedirectResponse(url=f"{APP_ROOT_PATH}/")

else:
    app = core


# ---------------------------------------------------------------------
# Dev-Server
# ---------------------------------------------------------------------


# Table-Labeling entfernt - nur noch Ball-Labeling


if __name__ == "__main__":
    import uvicorn
    # Lokal starten: python app.py
    # In Docker übernimmt das CMD den Start.
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
