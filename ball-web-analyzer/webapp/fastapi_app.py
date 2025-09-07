#!/usr/bin/env python3
"""
Ball Web Analyzer - FastAPI Version
Analysiert Videos mit trainiertem YOLO-Modell und erstellt Bounce-Heatmaps
"""

import os
import json
import shutil
import tempfile
import subprocess
import sys
from pathlib import Path
from datetime import datetime as dt
from typing import Optional, List

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ---- Konfiguration ----
# Für lokale Entwicklung: ./data, für Docker: /data/analyzer
DEFAULT_DATA_DIR = "./data" if not os.getenv("ANALYZER_DATA_DIR") else "/data/analyzer"
DATA_DIR = Path(os.getenv("ANALYZER_DATA_DIR", DEFAULT_DATA_DIR))
APP_ROOT_PATH = os.getenv("APP_ROOT_PATH", "").rstrip("/")  # z.B. "/ball-analyzer"

# Erstelle Datenverzeichnis
DATA_DIR.mkdir(parents=True, exist_ok=True)
print(f"📁 Data Directory: {DATA_DIR.absolute()}")

# YOLO Modell-Pfad (relativ zur ball-web-analyzer)
YOLO_WEIGHTS = Path(__file__).resolve().parents[1] / "runs/detect/train4/weights/best.pt"
INFER_SCRIPT = Path(__file__).resolve().parents[1] / "infer_bounce_heatmap.py"
TOOLS_DIR = Path(__file__).resolve().parents[1] / "tools"

print(f"YOLO Weights: {YOLO_WEIGHTS}")
print(f"Infer Script: {INFER_SCRIPT}")

# ---- FastAPI Setup ----
core = FastAPI(
    title="Ball Web Analyzer",
    description="Analysiert TT-Videos mit YOLO und erstellt Bounce-Heatmaps",
    version="1.0.0"
)

# CORS für Browser-Zugriff
core.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Statische Dateien
STATIC_DIR = Path(__file__).parent / "static"
STATIC_DIR.mkdir(exist_ok=True)
core.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# ---- Datenmodelle ----
class AnalysisRequest(BaseModel):
    video_source: str  # "upload" oder "youtube"
    youtube_url: Optional[str] = None
    table_points: List[List[float]]  # [[x1,y1], [x2,y2], [x3,y3], [x4,y4]]
    confidence: float = 0.25
    max_duration: int = 120  # 2 Minuten

class CalibrationPoints(BaseModel):
    points: List[List[float]]  # [[x1,y1], [x2,y2], [x3,y3], [x4,y4]]

# ---- Hilfsfunktionen ----
def new_analysis_id() -> str:
    """Generiert eine neue Analysis-ID"""
    now = dt.utcnow()
    return f"{now.strftime('%Y-%m-%d')}/analysis-{int(now.timestamp())}"

def analysis_dir(analysis_id: str) -> Path:
    """Gibt das Verzeichnis für eine Analysis zurück"""
    return DATA_DIR / analysis_id.replace("/", os.sep)

def download_youtube(url: str) -> Path:
    """Lädt YouTube-Video herunter"""
    try:
        result = subprocess.run([
            sys.executable, str(TOOLS_DIR / "download_youtube.py"), url
        ], capture_output=True, text=True, check=True)
        
        # Letzter Output ist der Pfad
        video_path = result.stdout.strip().split('\n')[-1]
        return Path(video_path)
    except subprocess.CalledProcessError as e:
        raise HTTPException(400, f"YouTube-Download fehlgeschlagen: {e.stderr}")

def get_video_info(video_path: Path) -> dict:
    """Ermittelt Video-Informationen"""
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise HTTPException(400, f"Kann Video nicht öffnen: {video_path.name}")
    
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = frame_count / fps
    
    # Erstes Frame für Kalibrierung
    ret, frame = cap.read()
    if not ret:
        cap.release()
        raise HTTPException(400, "Kann erstes Frame nicht lesen")
    
    height, width = frame.shape[:2]
    cap.release()
    
    return {
        "width": width,
        "height": height,
        "fps": fps,
        "duration": duration,
        "frame_count": frame_count
    }

def run_analysis(video_path: Path, calib_path: Path, output_dir: Path, confidence: float = 0.25) -> dict:
    """Führt die YOLO-Analyse und Heatmap-Generierung aus"""
    
    if not YOLO_WEIGHTS.exists():
        raise HTTPException(500, f"YOLO-Modell nicht gefunden: {YOLO_WEIGHTS}")
    
    if not INFER_SCRIPT.exists():
        raise HTTPException(500, f"Inference-Script nicht gefunden: {INFER_SCRIPT}")
    
    heatmap_path = output_dir / "heatmap.png"
    csv_path = output_dir / "bounces.csv"
    preview_path = output_dir / "preview.mp4"
    
    # Tisch-Hintergrundbild für Heatmap
    table_bg = Path(__file__).resolve().parents[1] / "assets" / "table_background.png"
    
    cmd = [
        sys.executable, str(INFER_SCRIPT),
        "--weights", str(YOLO_WEIGHTS),
        "--source", str(video_path),
        "--conf", str(confidence),
        "--imgsz", "640",
        "--calib", str(calib_path),
        "--save_heatmap", str(heatmap_path),
        "--save_csv", str(csv_path),
        "--save_preview", str(preview_path),
    ]
    
    # Hintergrundbild hinzufügen, falls vorhanden
    if table_bg.exists():
        cmd.extend(["--bg_image", str(table_bg)])
        print(f"🏓 Using table background: {table_bg}")
    else:
        print(f"⚠️ Table background not found: {table_bg}")
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=300)
        
        return {
            "success": True,
            "heatmap": heatmap_path.exists(),
            "csv": csv_path.exists(), 
            "preview": preview_path.exists(),
            "stdout": result.stdout,
            "stderr": result.stderr
        }
    except subprocess.CalledProcessError as e:
        raise HTTPException(500, f"Analyse fehlgeschlagen: {e.stderr}")
    except subprocess.TimeoutExpired:
        raise HTTPException(500, "Analyse-Timeout (5 Minuten)")

# ---- API Endpunkte ----

@core.get("/", include_in_schema=False)
def root():
    """Hauptseite"""
    return FileResponse(STATIC_DIR / "index.html")

@core.get("/api/health")
def health():
    """Health Check"""
    return {
        "status": "ok",
        "yolo_model": YOLO_WEIGHTS.exists(),
        "infer_script": INFER_SCRIPT.exists()
    }

@core.post("/api/upload")
async def upload_video(file: UploadFile = File(...)):
    """Video hochladen"""
    if not file.filename.lower().endswith(('.mp4', '.mov', '.avi', '.m4v')):
        raise HTTPException(400, "Nur Video-Dateien erlaubt (.mp4, .mov, .avi, .m4v)")
    
    # Neue Analysis erstellen
    analysis_id = new_analysis_id()
    ad = analysis_dir(analysis_id)
    ad.mkdir(parents=True, exist_ok=True)
    
    # Video speichern
    ext = Path(file.filename).suffix.lower()
    video_path = ad / f"video{ext}"
    
    with open(video_path, "wb") as f:
        content = await file.read()
        f.write(content)
    
    # Video-Info ermitteln
    video_info = get_video_info(video_path)
    
    # Metadaten speichern
    meta = {
        "analysis_id": analysis_id,
        "source": "upload",
        "filename": file.filename,
        "created": dt.utcnow().isoformat() + "Z",
        "video_info": video_info
    }
    
    (ad / "meta.json").write_text(json.dumps(meta, indent=2))
    
    return {
        "analysis_id": analysis_id,
        "video_info": video_info,
        "meta": meta
    }

@core.post("/api/youtube")
async def ingest_youtube(url: str = Form(...)):
    """YouTube-Video laden"""
    if not url.strip():
        raise HTTPException(400, "YouTube-URL erforderlich")
    
    # Neue Analysis erstellen
    analysis_id = new_analysis_id()
    ad = analysis_dir(analysis_id)
    ad.mkdir(parents=True, exist_ok=True)
    
    # YouTube-Video herunterladen
    temp_video = download_youtube(url.strip())
    
    # Video in Analysis-Verzeichnis verschieben
    ext = temp_video.suffix.lower()
    video_path = ad / f"video{ext}"
    shutil.move(str(temp_video), str(video_path))
    
    # Video-Info ermitteln
    video_info = get_video_info(video_path)
    
    # Metadaten speichern
    meta = {
        "analysis_id": analysis_id,
        "source": "youtube",
        "url": url,
        "created": dt.utcnow().isoformat() + "Z",
        "video_info": video_info
    }
    
    (ad / "meta.json").write_text(json.dumps(meta, indent=2))
    
    return {
        "analysis_id": analysis_id,
        "video_info": video_info,
        "meta": meta
    }

@core.get("/api/analysis/{analysis_id:path}/frame")
def get_first_frame(analysis_id: str):
    """Erstes Frame für Kalibrierung holen"""
    print(f"🖼️ Loading frame for analysis: {analysis_id}")
    
    ad = analysis_dir(analysis_id)
    print(f"📁 Analysis directory: {ad}")
    
    if not ad.exists():
        raise HTTPException(404, f"Analysis-Verzeichnis nicht gefunden: {ad}")
    
    video_files = list(ad.glob("video.*"))
    print(f"🎬 Found video files: {video_files}")
    
    if not video_files:
        raise HTTPException(404, "Video nicht gefunden")
    
    video_path = video_files[0]
    print(f"🎥 Using video: {video_path}")
    
    cap = cv2.VideoCapture(str(video_path))
    
    if not cap.isOpened():
        raise HTTPException(500, f"Kann Video nicht öffnen: {video_path}")
    
    ret, frame = cap.read()
    cap.release()
    
    if not ret:
        raise HTTPException(500, "Kann Frame nicht lesen")
    
    # Frame als JPEG speichern
    frame_path = ad / "first_frame.jpg"
    success = cv2.imwrite(str(frame_path), frame)
    
    if not success:
        raise HTTPException(500, f"Kann Frame nicht speichern: {frame_path}")
    
    print(f"✅ Frame saved: {frame_path}")
    return FileResponse(str(frame_path), media_type="image/jpeg")

@core.post("/api/analysis/{analysis_id:path}/calibrate")
async def calibrate_table(analysis_id: str, points: CalibrationPoints):
    """Tisch-Kalibrierung speichern"""
    ad = analysis_dir(analysis_id)
    
    if not ad.exists():
        raise HTTPException(404, "Analysis nicht gefunden")
    
    if len(points.points) != 4:
        raise HTTPException(400, "Genau 4 Punkte erforderlich (TL, TR, BR, BL)")
    
    # Kalibrierung speichern
    calib = {"img_pts": points.points}
    calib_path = ad / "table_calib.json"
    calib_path.write_text(json.dumps(calib, indent=2))
    
    return {"success": True, "points": points.points}

@core.post("/api/analysis/{analysis_id:path}/analyze")
async def analyze_video(analysis_id: str, confidence: float = Form(0.25)):
    """Video analysieren und Heatmap erstellen"""
    ad = analysis_dir(analysis_id)
    
    if not ad.exists():
        raise HTTPException(404, "Analysis nicht gefunden")
    
    video_files = list(ad.glob("video.*"))
    if not video_files:
        raise HTTPException(404, "Video nicht gefunden")
    
    calib_path = ad / "table_calib.json"
    if not calib_path.exists():
        raise HTTPException(400, "Tisch-Kalibrierung fehlt")
    
    video_path = video_files[0]
    
    # Analyse ausführen
    result = run_analysis(video_path, calib_path, ad, confidence)
    
    # Ergebnis-Metadaten aktualisieren
    meta_path = ad / "meta.json"
    if meta_path.exists():
        meta = json.loads(meta_path.read_text())
        meta["analysis_completed"] = dt.utcnow().isoformat() + "Z"
        meta["analysis_result"] = result
        meta_path.write_text(json.dumps(meta, indent=2))
    
    return result

@core.get("/api/analysis/{analysis_id:path}/heatmap")
def get_heatmap(analysis_id: str):
    """Heatmap-Bild herunterladen"""
    ad = analysis_dir(analysis_id)
    heatmap_path = ad / "heatmap.png"
    
    if not heatmap_path.exists():
        raise HTTPException(404, "Heatmap nicht gefunden")
    
    return FileResponse(str(heatmap_path), media_type="image/png")

@core.get("/api/analysis/{analysis_id:path}/csv")
def get_bounces_csv(analysis_id: str):
    """Bounces-CSV herunterladen"""
    ad = analysis_dir(analysis_id)
    csv_path = ad / "bounces.csv"
    
    if not csv_path.exists():
        raise HTTPException(404, "CSV nicht gefunden")
    
    return FileResponse(str(csv_path), media_type="text/csv", filename="bounces.csv")

def range_requests_response(
    file_path: Path,
    request: Request,
    content_type: str = "video/mp4"
):
    """Unterstützt HTTP Range Requests für Video-Streaming"""
    file_size = file_path.stat().st_size
    
    range_header = request.headers.get("range")
    if range_header:
        # Parse Range header: "bytes=start-end"
        range_match = range_header.replace("bytes=", "").split("-")
        start = int(range_match[0]) if range_match[0] else 0
        end = int(range_match[1]) if range_match[1] else file_size - 1
        
        # Begrenzen auf Dateigröße
        start = max(0, start)
        end = min(end, file_size - 1)
        content_length = end - start + 1
        
        def iter_file():
            with open(file_path, "rb") as f:
                f.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk_size = min(8192, remaining)
                    chunk = f.read(chunk_size)
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk
        
        headers = {
            "content-range": f"bytes {start}-{end}/{file_size}",
            "accept-ranges": "bytes",
            "content-length": str(content_length),
        }
        
        return StreamingResponse(
            iter_file(),
            status_code=206,
            headers=headers,
            media_type=content_type
        )
    else:
        # Kein Range-Request - ganzes File senden
        def iter_file():
            with open(file_path, "rb") as f:
                while chunk := f.read(8192):
                    yield chunk
        
        headers = {
            "content-length": str(file_size),
            "accept-ranges": "bytes"
        }
        
        return StreamingResponse(
            iter_file(),
            headers=headers,
            media_type=content_type
        )

@core.get("/api/analysis/{analysis_id:path}/preview")
def get_preview(analysis_id: str, request: Request):
    """Preview-Video mit Range-Request Support streamen"""
    ad = analysis_dir(analysis_id)
    preview_path = ad / "preview.mp4"
    
    if not preview_path.exists():
        raise HTTPException(404, "Preview nicht gefunden")
    
    return range_requests_response(preview_path, request)

@core.get("/api/analyses")
def list_analyses():
    """Alle Analysen auflisten"""
    analyses = []
    
    for date_dir in DATA_DIR.iterdir():
        if date_dir.is_dir():
            for analysis_dir_path in date_dir.iterdir():
                if analysis_dir_path.is_dir():
                    meta_path = analysis_dir_path / "meta.json"
                    if meta_path.exists():
                        try:
                            meta = json.loads(meta_path.read_text())
                            rel_id = str(analysis_dir_path.relative_to(DATA_DIR)).replace(os.sep, "/")
                            meta["analysis_id"] = rel_id
                            analyses.append(meta)
                        except:
                            pass
    
    # Nach Datum sortieren
    analyses.sort(key=lambda x: x.get("created", ""), reverse=True)
    return {"analyses": analyses}

# ---- FastAPI App Configuration ----
# Für Subpfad-Deployment verwenden wir root_path direkt in uvicorn
app = core

# ---- Entwicklungsserver ----
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("fastapi_app:app", host="0.0.0.0", port=8001, reload=True)

@core.get("/api/health")
def health_check():
    return {"status": "healthy", "service": "ball-analyzer"}
