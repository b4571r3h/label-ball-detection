# TT Ball Detection & Analysis Platform

Dieses Setup enthält zwei separate Web-Anwendungen für Tischtennisball-Verarbeitung:

## 🏓 Anwendungen

### 1. Ball Detection Labeler (`/ball-detection/`)
- **Zweck**: Videos/Bilder labeln für YOLO-Training
- **Funktionen**: 
  - Video-Upload oder YouTube-Links
  - Frame-Extraktion (max 2 Min)
  - Ball-Position per Klick markieren
  - YOLO-Format Labels exportieren
- **Port**: 8000 (lokal) / 80/ball-detection (Docker)

### 2. Ball Web Analyzer (`/ball-analyzer/`)
- **Zweck**: Videos mit trainiertem YOLO-Modell analysieren
- **Funktionen**:
  - Video-Upload oder YouTube-Links
  - Tisch-Kalibrierung (4-Punkt-Klick)
  - Ball-Detektion mit YOLO
  - Bounce-Heatmap Generierung
  - Analyse-Ergebnisse (Video, Heatmap, CSV)
- **Port**: 8001 (lokal) / 80/ball-analyzer (Docker)

## 🚀 Lokale Entwicklung

### Ball Labeler starten:
```bash
cd ball-web-labeler-subpath
python3 app.py
# → http://localhost:8000/
```

### Ball Analyzer starten:
```bash
./start-analyzer.sh
# → http://localhost:8001/
```

## 🐳 Docker-Deployment

### Beide Apps zusammen:
```bash
docker-compose -f compose.dual.yaml up -d
```

**URLs nach Deployment:**
- Ball Labeler: `http://your-server/ball-detection/`
- Ball Analyzer: `http://your-server/ball-analyzer/`

### Einzeln deployfen:

**Nur Ball Labeler:**
```bash
cd ball-web-labeler-subpath
docker-compose -f compose.deploy.yaml up -d
```

**Nur Ball Analyzer:**
```bash
cd ball-web-analyzer/webapp
docker build -f Dockerfile-fastapi -t ball-analyzer .
docker run -p 8001:8001 -v $(pwd)/../../data:/data/analyzer ball-analyzer
```

## 📁 Verzeichnisstruktur

```
web/
├── ball-web-labeler-subpath/          # Labeling-App
│   ├── app.py                         # FastAPI Server
│   ├── static/                        # Frontend (HTML/JS)
│   └── data/                          # Label-Daten
│
├── ball-web-analyzer/                 # Analyse-App & YOLO-Modell
│   ├── webapp/                        # FastAPI Server
│   │   ├── fastapi_app.py
│   │   ├── static/                    # Frontend (HTML/JS)
│   │   └── Dockerfile-fastapi
│   ├── runs/detect/train4/weights/    # Trainierte YOLO-Weights
│   ├── infer_bounce_heatmap.py        # Inference-Script
│   └── tools/                         # Helper-Scripts
│
├── compose.dual.yaml                  # Docker-Compose für beide Apps
├── Caddyfile-dual                     # Reverse-Proxy Config
└── start-analyzer.sh                  # Lokaler Start-Script
```

## 🎯 Workflow

### Labeling-Workflow:
1. Video in Ball Labeler hochladen
2. Durch Frames navigieren und Ball-Positionen markieren
3. Labels als ZIP exportieren
4. Für YOLO-Training verwenden

### Analyse-Workflow:
1. Video in Ball Analyzer hochladen
2. 4 Tisch-Ecken kalibrieren (TL→TR→BR→BL)
3. Analyse starten (YOLO-Detektion + Heatmap)
4. Ergebnisse anschauen und herunterladen

## 🔧 Konfiguration

### Umgebungsvariablen:

**Ball Labeler:**
- `LABEL_DATA_DIR`: Pfad für Label-Daten (default: `/data`)
- `APP_ROOT_PATH`: Subpath für Deployment (z.B. `/ball-detection`)

**Ball Analyzer:**
- `ANALYZER_DATA_DIR`: Pfad für Analyse-Daten (default: `/data/analyzer`)
- `APP_ROOT_PATH`: Subpath für Deployment (z.B. `/ball-analyzer`)

### YOLO-Modell:
- Standard: `ball-web-analyzer/runs/detect/train4/weights/best.pt`
- Trainiert mit den gelabelten Daten aus dem Ball Labeler

## 🛠️ Troubleshooting

### Häufige Probleme:

1. **YOLO-Modell nicht gefunden:**
   ```bash
   # Prüfen ob Weights existieren:
   ls -la ball-web-analyzer/runs/detect/train4/weights/best.pt
   ```

2. **Inference-Script nicht gefunden:**
   ```bash
   # Prüfen ob Script existiert:
   ls -la ball-web-analyzer/infer_bounce_heatmap.py
   ```

3. **Port-Konflikte:**
   - Ball Labeler: Port 8000
   - Ball Analyzer: Port 8001
   - Caddy Proxy: Port 80

4. **Docker-Volumes:**
   - Stelle sicher, dass die Data-Verzeichnisse existieren
   - Prüfe Schreibrechte für Docker-Container

## 🎥 Unterstützte Formate

**Video-Input:**
- MP4, MOV, AVI, M4V
- YouTube-URLs
- Automatische 2-Minuten-Begrenzung

**Output:**
- YOLO-Labels (.txt)
- Bounce-Heatmaps (.png)
- Analyse-Videos (.mp4)
- Bounce-Daten (.csv)
# SSH Key Fix Test Sun Sep  7 15:18:57 UTC 2025
# SSH Fix Sun Sep  7 15:23:43 UTC 2025
# GitHub Packages Permission Fix Sun Sep  7 15:34:10 UTC 2025
