# SpinEvo Ball Detection Labeler

FastAPI-Backend + statische UI zum Labeln von Tischtennis-Bällen (YOLO-Format).

## Training / YOLO Export

### Voll-Export (Labeler + optional Server-Import)

Die Startseite zeigt unter „Frames gelabelt“ die Summe aus **Web-Labeler** (`LABEL_DATA_DIR`) und **Import-Ordner** (`IMPORT_YOLO_BALL_DIR`) — wie `/api/stats/labeled-total`. Der Voll-Export enthält **standardmäßig beides** (`include_import=true`), damit die ZIP-Größe zur Anzeige passt.

- **Endpunkt:** `GET /api/export/yolo-dataset-full`
- **Query (Defaults):**
  - `val_fraction=0.2` (0.05–0.5) — gilt nur für den **Labeler**-Anteil
  - `seed=42`
  - `include_import=true` — `false` = nur Daten aus der Web-App (kein `IMPORT_YOLO_BALL_DIR`)
  - `strategy=global_split` oder `per_task_split` — nur für den Labeler-Teil; **Import** behält die bestehenden Ordner `images/train` und `images/val` und wird **ohne Neu-Split** angehängt
    - **global_split** (Standard): alle Labeler-Paare gemischt, dann ein Train/Val-Split
    - **per_task_split**: je Task ein eigener Split; Vereinigung der Mengen

**Antwort:** `200`, `Content-Type: application/zip`, Dateiname `spinvo-yolo-dataset-full.zip`.

Nach dem Entpacken:

- `dataset.yaml` (`path: .`, `train: images/train`, `val: images/val`, `nc: 1`, `names: ['ball']`)
- `images/train/`, `images/val/` (überwiegend `.jpg` aus dem Labeler; Import kann je nach Daten auch `.png` usw. enthalten)
- `labels/train/`, `labels/val/` (`.txt`, gleicher Basisname wie das Bild)

**Negativ-Beispiele („kein Ball“):** Es existiert eine `.txt` pro Bild; Inhalt kann leer sein (0 Bytes).

**Namenskollisionen:** Dateinamen enthalten einen eindeutigen Präfix aus einem SHA256-Fragment der `task_id`.

**Keine Daten:** `422` mit JSON `{"detail": "…"}` (kein ZIP).

**Beispiel-URLs** (lokal ohne Subpfad):

```bash
curl -L -o spinvo-yolo-dataset-full.zip \
  "http://127.0.0.1:8000/api/export/yolo-dataset-full?val_fraction=0.2&seed=42&strategy=global_split"
```

Mit Subpfad `APP_ROOT_PATH=/ball-detection` (z. B. Live):

```bash
curl -L -o spinvo-yolo-dataset-full.zip \
  "https://balls.spinevo.app/ball-detection/api/export/yolo-dataset-full"
```

Ultralytics (nach Entpacken nach z. B. `data/spinevo_ball/`):

```bash
yolo detect train data=data/spinevo_ball/dataset.yaml model=yolov8n.pt epochs=100 imgsz=640
```

(Optional `path:` in `dataset.yaml` auf ein absolutes Verzeichnis setzen, falls ihr den Ordner verschiebt.)

### Metriken vor dem Download

`GET /api/stats/labeled-export` → u. a. `frames_total` (Summe wie im Voll-Export mit Standard-`include_import`), `frames_total_labeler`, `frames_total_import`, `tasks_included`.  
`last_export_build` ist aktuell immer `null` (Platzhalter für späteres Caching).

### Optionale Absicherung

Wenn `BALL_DETECTION_EXPORT_API_KEY` in der Umgebung gesetzt ist, erfordern **Voll-Export** und **labeled-export** den Header:

```http
Authorization: Bearer <gleicher Wert wie BALL_DETECTION_EXPORT_API_KEY>
```

### Weitere Exporte

- Pro Task: `GET /api/task/{task_id}/export-yolo-split` (Train/Val nur für diesen Task)
- Server-Import-Ordner (`IMPORT_YOLO_BALL_DIR`): `GET /api/export/import-yolo-zip`

### OpenAPI

- Ohne Subpfad: `/openapi.json`, `/docs`
- Mit Subpfad: `{APP_ROOT_PATH}/openapi.json`, `{APP_ROOT_PATH}/docs`

### Hinweis zu großen Datenmengen

Der Voll-Export baut die ZIP-Datei synchron auf dem Server (Temp-Datei). Bei sehr vielen Bildern können Timeouts auftreten — dann einen asynchronen Export (Job + späterer Download) ergänzen.

## Rally-Labeling (neu)

Das Rally-Tool ist jetzt im Labeler integriert und unter folgender UI erreichbar:

- `/rally-label/`
- Einstieg auch über den Button **Rally-Labeling** auf der Startseite

### Workflow

1. Task auswählen und laden
2. Mit `←` / `→` durch Frames navigieren
3. Mit `S` Rally-Start und mit `E` Rally-Ende setzen
4. Mit `D` alle Events auf dem aktuellen Frame löschen
5. Über **Speichern** persistieren

### Gespeicherte Dateien pro Task

Unter `LABEL_DATA_DIR/<task_id>/`:

- `rally_labels.json` (Events + Metadaten)
- `rally_timeseries.csv` (frameweise Zeitreihe inkl. Labelcode)

### Relevante API-Endpunkte

- `GET /api/rally/tasks`
- `GET /api/rally/task/{task_id}/points`
- `GET /api/rally/task/{task_id}/labels`
- `POST /api/rally/task/{task_id}/labels`

## Prediction-Review (neu)

Review-Seite für Modell-Vorhersagen aus spinevo (`dev/tcn/predict_video.py`):
Ball/Pose-Overlay, TCN-Wahrscheinlichkeits-Kurven (Threshold/Min-Gap live
nachjustierbar) und erkannte Ballwechsel als klickbare Segmente. Hat der Task
Rally-Labels (Ground Truth), werden Predicted und Labels als zwei Spuren
verglichen (inkl. mittlerer Start-Abweichung).

- UI: `/prediction-review`
- Upload (Bearer wie Export): `POST /api/predictions/upload` — multipart mit
  `predictions` (JSON, braucht mind. `rallies`-Array; optional `prob_start`/
  `prob_end`-Kurven), optional `video` (legt neuen video-Modus-Task an),
  optional `points_csv` (spinevo-Schema, liefert das Overlay) und optional
  `task_id` (an bestehenden Task hängen statt neues Video).
- `GET /api/predictions/tasks`, `GET /api/predictions/task/{task_id}`
- Gespeichert wird `predictions.json` im Task-Ordner; Video/points.csv nutzen
  die bestehende Task-Infrastruktur. Prediction-Tasks erscheinen dadurch auch
  im Rally-Label-Tool → Ground Truth nachlabeln und direkt vergleichen.
