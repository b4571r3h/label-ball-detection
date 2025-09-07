#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
TT Ball Admin Panel – FastAPI Backend

Features:
- Dashboard mit Storage-Übersicht
- Labeler-Tasks verwalten (anzeigen, löschen, downloaden)
- Analyzer-Ergebnisse verwalten (Heatmaps, Videos, CSV)
- Bulk-Operationen für Cleanup
"""

from __future__ import annotations

import os
import json
import shutil
import zipfile
import tempfile
from pathlib import Path
from typing import List, Dict, Any
from datetime import datetime

from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ---------------------------------------------------------------------
# Konfiguration
# ---------------------------------------------------------------------

BASE_DIR = Path(__file__).parent.resolve()
STATIC_DIR = BASE_DIR / "static"

# Datenverzeichnisse (aus Environment oder Default)
LABELER_DATA_DIR = Path(os.getenv("LABEL_DATA_DIR", "/data/labels")).resolve()
ANALYZER_DATA_DIR = Path(os.getenv("ANALYZER_DATA_DIR", "/data/analyzer")).resolve()

APP_ROOT_PATH = os.getenv("APP_ROOT_PATH", "").rstrip("/")

# ---------------------------------------------------------------------
# Pydantic Models
# ---------------------------------------------------------------------

class StorageStats(BaseModel):
    total_size_mb: float
    labeler_size_mb: float
    analyzer_size_mb: float
    labeler_tasks: int
    analyzer_analyses: int

class TaskInfo(BaseModel):
    task_id: str
    frames_count: int
    labels_count: int
    video_size_mb: float
    total_size_mb: float
    created: str
    has_video: bool
    meta: Dict[str, Any]

class AnalysisInfo(BaseModel):
    analysis_id: str
    has_heatmap: bool
    has_preview: bool
    has_csv: bool
    total_size_mb: float
    created: str

# ---------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------

def get_dir_size(path: Path) -> float:
    """Berechnet Verzeichnisgröße in MB."""
    if not path.exists():
        return 0.0
    
    total = 0
    for file_path in path.rglob("*"):
        if file_path.is_file():
            total += file_path.stat().st_size
    
    return total / (1024 * 1024)  # Convert to MB

def safe_remove(path: Path) -> bool:
    """Sicheres Löschen von Dateien/Verzeichnissen."""
    try:
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
        return True
    except Exception:
        return False

def read_meta_safe(meta_path: Path) -> Dict[str, Any]:
    """Sicheres Lesen von meta.json."""
    try:
        if meta_path.exists():
            return json.loads(meta_path.read_text())
        return {}
    except Exception:
        return {}

# ---------------------------------------------------------------------
# FastAPI App
# ---------------------------------------------------------------------

core = FastAPI(title="TT Ball Admin Panel")
core.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@core.get("/", include_in_schema=False)
def admin_index():
    return FileResponse(str(STATIC_DIR / "index.html"))

@core.get("/api/health")
def api_health():
    return {"status": "ok", "service": "admin"}

# ---------------------------------------------------------------------
# Dashboard & Stats
# ---------------------------------------------------------------------

@core.get("/api/stats", response_model=StorageStats)
def api_stats():
    """Storage-Statistiken."""
    labeler_size = get_dir_size(LABELER_DATA_DIR)
    analyzer_size = get_dir_size(ANALYZER_DATA_DIR)
    
    # Task-Zählung
    labeler_tasks = 0
    if LABELER_DATA_DIR.exists():
        for day_dir in LABELER_DATA_DIR.glob("*"):
            if day_dir.is_dir():
                labeler_tasks += len([d for d in day_dir.glob("*") if d.is_dir()])
    
    # Analysis-Zählung
    analyzer_analyses = 0
    if ANALYZER_DATA_DIR.exists():
        for day_dir in ANALYZER_DATA_DIR.glob("*"):
            if day_dir.is_dir():
                analyzer_analyses += len([d for d in day_dir.glob("*") if d.is_dir()])
    
    return StorageStats(
        total_size_mb=labeler_size + analyzer_size,
        labeler_size_mb=labeler_size,
        analyzer_size_mb=analyzer_size,
        labeler_tasks=labeler_tasks,
        analyzer_analyses=analyzer_analyses
    )

# ---------------------------------------------------------------------
# Labeler Task Management
# ---------------------------------------------------------------------

@core.get("/api/labeler/tasks", response_model=List[TaskInfo])
def api_labeler_tasks():
    """Alle Labeler-Tasks auflisten."""
    tasks = []
    
    if not LABELER_DATA_DIR.exists():
        return tasks
    
    for day_dir in sorted(LABELER_DATA_DIR.glob("*")):
        if not day_dir.is_dir():
            continue
            
        for task_dir in sorted(day_dir.glob("*")):
            if not task_dir.is_dir():
                continue
                
            task_id = str(task_dir.relative_to(LABELER_DATA_DIR))
            
            # Frames zählen
            frames_dir = task_dir / "frames"
            frames_count = len(list(frames_dir.glob("*.jpg"))) if frames_dir.exists() else 0
            
            # Labels zählen
            labels_dir = task_dir / "labels"
            labels_count = len(list(labels_dir.glob("*.txt"))) if labels_dir.exists() else 0
            
            # Video-Info
            video_files = list(task_dir.glob("video.*"))
            video_size_mb = 0.0
            has_video = False
            if video_files:
                has_video = True
                video_size_mb = video_files[0].stat().st_size / (1024 * 1024)
            
            # Metadaten
            meta = read_meta_safe(task_dir / "meta.json")
            created = meta.get("created", "unknown")
            
            # Gesamtgröße
            total_size_mb = get_dir_size(task_dir)
            
            tasks.append(TaskInfo(
                task_id=task_id,
                frames_count=frames_count,
                labels_count=labels_count,
                video_size_mb=video_size_mb,
                total_size_mb=total_size_mb,
                created=created,
                has_video=has_video,
                meta=meta
            ))
    
    return tasks

@core.delete("/api/labeler/task/{task_id:path}")
def api_delete_labeler_task(task_id: str):
    """Labeler-Task löschen."""
    task_path = LABELER_DATA_DIR / task_id
    
    if not task_path.exists():
        raise HTTPException(404, "Task nicht gefunden")
    
    if safe_remove(task_path):
        return {"status": "deleted", "task_id": task_id}
    else:
        raise HTTPException(500, "Fehler beim Löschen")

@core.get("/api/labeler/task/{task_id:path}/download")
def api_download_labeler_task(task_id: str):
    """Labeler-Task als ZIP downloaden."""
    task_path = LABELER_DATA_DIR / task_id
    
    if not task_path.exists():
        raise HTTPException(404, "Task nicht gefunden")
    
    # Temp ZIP erstellen
    tmp_dir = Path(tempfile.mkdtemp())
    zip_name = f"labeler-task-{task_id.replace('/', '-')}.zip"
    zip_path = tmp_dir / zip_name
    
    with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        for file_path in task_path.rglob("*"):
            if file_path.is_file():
                arcname = file_path.relative_to(task_path)
                zf.write(file_path, arcname)
    
    return FileResponse(
        path=str(zip_path),
        filename=zip_name,
        media_type="application/zip"
    )

# ---------------------------------------------------------------------
# Analyzer Results Management
# ---------------------------------------------------------------------

@core.get("/api/analyzer/analyses", response_model=List[AnalysisInfo])
def api_analyzer_analyses():
    """Alle Analyzer-Ergebnisse auflisten."""
    analyses = []
    
    if not ANALYZER_DATA_DIR.exists():
        return analyses
    
    for day_dir in sorted(ANALYZER_DATA_DIR.glob("*")):
        if not day_dir.is_dir():
            continue
            
        for analysis_dir in sorted(day_dir.glob("*")):
            if not analysis_dir.is_dir():
                continue
                
            analysis_id = str(analysis_dir.relative_to(ANALYZER_DATA_DIR))
            
            # Dateien prüfen
            has_heatmap = (analysis_dir / "heatmap.png").exists()
            has_preview = any(analysis_dir.glob("preview.*"))
            has_csv = (analysis_dir / "bounces.csv").exists()
            
            # Erstellungszeit (aus Verzeichnisname oder mtime)
            try:
                created = datetime.fromtimestamp(analysis_dir.stat().st_mtime).isoformat()
            except:
                created = "unknown"
            
            # Gesamtgröße
            total_size_mb = get_dir_size(analysis_dir)
            
            analyses.append(AnalysisInfo(
                analysis_id=analysis_id,
                has_heatmap=has_heatmap,
                has_preview=has_preview,
                has_csv=has_csv,
                total_size_mb=total_size_mb,
                created=created
            ))
    
    return analyses

@core.delete("/api/analyzer/analysis/{analysis_id:path}")
def api_delete_analyzer_analysis(analysis_id: str):
    """Analyzer-Analyse löschen."""
    analysis_path = ANALYZER_DATA_DIR / analysis_id
    
    if not analysis_path.exists():
        raise HTTPException(404, "Analyse nicht gefunden")
    
    if safe_remove(analysis_path):
        return {"status": "deleted", "analysis_id": analysis_id}
    else:
        raise HTTPException(500, "Fehler beim Löschen")

@core.get("/api/analyzer/analysis/{analysis_id:path}/download/{file_type}")
def api_download_analyzer_file(analysis_id: str, file_type: str):
    """Einzelne Analyzer-Datei downloaden."""
    analysis_path = ANALYZER_DATA_DIR / analysis_id
    
    if not analysis_path.exists():
        raise HTTPException(404, "Analyse nicht gefunden")
    
    # Datei-Mapping
    file_mapping = {
        "heatmap": ("heatmap.png", "image/png"),
        "csv": ("bounces.csv", "text/csv"),
        "preview": None  # Wird dynamisch gesucht
    }
    
    if file_type not in file_mapping:
        raise HTTPException(400, "Ungültiger Dateityp")
    
    if file_type == "preview":
        # Preview-Video finden
        preview_files = list(analysis_path.glob("preview.*"))
        if not preview_files:
            raise HTTPException(404, "Preview-Video nicht gefunden")
        file_path = preview_files[0]
        media_type = "video/mp4"
    else:
        filename, media_type = file_mapping[file_type]
        file_path = analysis_path / filename
        
        if not file_path.exists():
            raise HTTPException(404, f"{file_type} nicht gefunden")
    
    return FileResponse(
        path=str(file_path),
        filename=file_path.name,
        media_type=media_type
    )

@core.get("/api/analyzer/analysis/{analysis_id:path}/download-all")
def api_download_analyzer_all(analysis_id: str):
    """Alle Analyzer-Dateien als ZIP downloaden."""
    analysis_path = ANALYZER_DATA_DIR / analysis_id
    
    if not analysis_path.exists():
        raise HTTPException(404, "Analyse nicht gefunden")
    
    # Temp ZIP erstellen
    tmp_dir = Path(tempfile.mkdtemp())
    zip_name = f"analyzer-{analysis_id.replace('/', '-')}.zip"
    zip_path = tmp_dir / zip_name
    
    with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        for file_path in analysis_path.rglob("*"):
            if file_path.is_file():
                arcname = file_path.relative_to(analysis_path)
                zf.write(file_path, arcname)
    
    return FileResponse(
        path=str(zip_path),
        filename=zip_name,
        media_type="application/zip"
    )

# ---------------------------------------------------------------------
# Bulk Operations
# ---------------------------------------------------------------------

@core.post("/api/cleanup/old-tasks")
def api_cleanup_old_tasks(days: int = 30):
    """Alte Tasks löschen (älter als X Tage)."""
    if days < 1:
        raise HTTPException(400, "Mindestens 1 Tag")
    
    cutoff = datetime.now().timestamp() - (days * 24 * 3600)
    deleted_count = 0
    
    # Labeler Tasks
    if LABELER_DATA_DIR.exists():
        for day_dir in LABELER_DATA_DIR.glob("*"):
            if not day_dir.is_dir():
                continue
            for task_dir in day_dir.glob("*"):
                if task_dir.is_dir() and task_dir.stat().st_mtime < cutoff:
                    if safe_remove(task_dir):
                        deleted_count += 1
    
    # Analyzer Analyses
    if ANALYZER_DATA_DIR.exists():
        for day_dir in ANALYZER_DATA_DIR.glob("*"):
            if not day_dir.is_dir():
                continue
            for analysis_dir in day_dir.glob("*"):
                if analysis_dir.is_dir() and analysis_dir.stat().st_mtime < cutoff:
                    if safe_remove(analysis_dir):
                        deleted_count += 1
    
    return {"deleted_count": deleted_count, "cutoff_days": days}

# ---------------------------------------------------------------------
# Wrapper App für Subpfad
# ---------------------------------------------------------------------

if APP_ROOT_PATH:
    app = FastAPI()
    app.mount(APP_ROOT_PATH, core)
    
    @app.get("/", include_in_schema=False)
    def _root_redirect():
        from fastapi.responses import RedirectResponse
        return RedirectResponse(url=f"{APP_ROOT_PATH}/")
else:
    app = core

# ---------------------------------------------------------------------
# Dev Server
# ---------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8002, reload=True)
