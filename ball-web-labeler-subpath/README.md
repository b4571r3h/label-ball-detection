# SpinEvo Ball Detection Labeler

FastAPI-Backend + statische UI zum Labeln von Tischtennis-Bällen (YOLO-Format).

## Training / YOLO Export

### Voll-Export (alle Tasks, ein ZIP)

- **Endpunkt:** `GET /api/export/yolo-dataset-full`
- **Query (Defaults):**
  - `val_fraction=0.2` (0.05–0.5)
  - `seed=42`
  - `strategy=global_split` oder `per_task_split`
    - **global_split** (Standard): alle gelabelten Bild+Label-Paare werden gemischt, dann ein gemeinsamer Train/Val-Split — sinnvoll für ein einziges Gesamtmodell.
    - **per_task_split**: je Task ein eigener Split; die Mengen werden vereinigt (ohne Mischen zwischen Tasks innerhalb eines Splits).

**Antwort:** `200`, `Content-Type: application/zip`, Dateiname `spinvo-yolo-dataset-full.zip`.

Nach dem Entpacken:

- `dataset.yaml` (`path: .`, `train: images/train`, `val: images/val`, `nc: 1`, `names: ['ball']`)
- `images/train/`, `images/val/` (`.jpg`)
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

`GET /api/stats/labeled-export` → u. a. `frames_total`, `tasks_included`.  
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
