# Minimal Ball Detector (YOLOv8) – with YouTube Support

Ziel: Ein schlankes **YOLOv8**-Modell trainieren, das **Bälle** erkennt und sie im Video mit **grünen Boxen** markiert – inklusive **YouTube-Video**-Support (Auto-Download via `yt-dlp`).

## 0) Voraussetzungen
- Python 3.10–3.12 empfohlen (3.13 kann je nach Paketen haken)
- **ffmpeg** (für yt-dlp Merge von Audio/Video)
  - macOS: `brew install ffmpeg`
  - Ubuntu/Debian: `sudo apt install ffmpeg`
  - Windows: ffmpeg installieren und `ffmpeg\bin` zum PATH hinzufügen

### macOS Zertifikate (nur wenn SSL-Fehler auftreten)
```bash
open "/Applications/Python 3.13/Install Certificates.command"  # Version ggf. anpassen
# alternativ:
python -m pip install -U certifi
export SSL_CERT_FILE="$(python -c 'import certifi; print(certifi.where())')"
```

## 1) Setup
```bash
python3 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
python -m pip install -U pip
pip install -r requirements.txt
```

## 2) Frames aus YouTube- oder lokalen Videos extrahieren
- **Lokal**:
```bash
python tools/extract_frames.py --video path/to/video.mp4 --out data/ball_det/images/train --fps 5
```
- **YouTube-Link** (wird automatisch per `yt-dlp` in ein Temp-File geladen):
```bash
python tools/extract_frames.py --video "https://www.youtube.com/watch?v=XXXX" --out data/ball_det/images/train --fps 5
```

## 3) Labeln (YOLO-Format)
Zu jedem Bild eine `.txt` mit Zeilen im Format:
```
0 x_center y_center width height
```
Werte normiert in [0,1]. Klasse ist immer `0` (= ball).
Struktur:
```
data/ball_det/
  images/train/*.jpg
  labels/train/*.txt
  images/val/*.jpg
  labels/val/*.txt
```

## 4) Training
```bash
yolo detect train model=yolov8n.pt data=ball_data.yaml epochs=50 imgsz=640 batch=16
# oder:
python tools/train_ball.py --data ball_data.yaml --model yolov8n.pt --epochs 50 --imgsz 640 --batch 16
```

## 5) Inferenz (lokale Datei **oder YouTube**)
- **Lokal**:
```bash
python infer_video_ball.py --weights runs/detect/train/weights/best.pt --source path/to/video.mp4 --conf 0.25
```
- **YouTube** (Auto-Download):
```bash
python infer_video_ball.py --weights runs/detect/train/weights/best.pt --source "https://www.youtube.com/watch?v=XXXX" --conf 0.25
```
Optional speichern:
```bash
python infer_video_ball.py --weights runs/detect/train/weights/best.pt --source "https://www.youtube.com/watch?v=XXXX" --save out.mp4
```

## 6) Tipps
- Für sehr kleine Bälle: `imgsz=960` oder `model=yolov8s.pt` probieren.
- Negative Beispiele (ohne Ball, leere .txt) reduzieren False Positives.
- Train/Val aus **verschiedenen Matches/Kanälen** erstellen (keine Datenleckage).

Viel Erfolg!
