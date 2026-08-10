# label-ball-detection — Context

This repository is the **labeling and review platform** for table-tennis ball detection. It produces the ground truth that the sibling repository **spinevo** consumes to train its ball model (YOLO) and its rally TCN. It runs as a Docker Compose stack on the IONOS host (87.106.82.60) behind Caddy, public at **balls.spinevo.app**.

This file is the source of the project's **ubiquitous language**. Use these terms in code, issues, and documentation.

## Ubiquitous language

| Term | Meaning |
| --- | --- |
| **Task** | One video's labeling unit on the Labeler. A *frames-mode task* stores extracted frames and pose data server-side. |
| **Ground truth (GT)** | A manually labeled ball position (one class, YOLO format). A negative example is an image with an empty `.txt` label file (0 bytes) — that is a valid label, not missing data. |
| **Prediction set** | A named set of model predictions for a task (`set_tag` upload → `predictions_sets/<tag>.json`; `predictions.json` is the set `default`). The review UI shows all sets and GT as separate tracks. |
| **Rally label** | Start/end frame events for one rally, labeled with the Rally-Label tool. Exported through the rally-dataset API. |
| **Full export** | `GET /api/export/yolo-dataset-full` — a YOLO dataset ZIP combining Labeler data (`LABEL_DATA_DIR`) and the import folder (`IMPORT_YOLO_BALL_DIR`), with `global_split` or `per_task_split` strategy. |
| **Auto-label** | Model-generated labels above `CONF_AUTO`; detections between `CONF_REVIEW` and `CONF_AUTO` go to human review. |

## Services (Compose stack)

| Service | Folder | Role |
| --- | --- | --- |
| `ball-labeler` | `ball-web-labeler-subpath/` | The main Labeler: FastAPI + static UI. Manual labeling, review of prediction sets, Rally-Label tool, dataset export APIs. |
| `ball-auto-label` | `ball-auto-label/` | Auto-label + review server (YOLO inference on uploaded videos). |
| `ball-analyzer` | `ball-web-analyzer/` | Analysis tools: ball inference on videos, bounce heatmaps, table calibration. |
| `ball-admin` | `ball-admin/` | Admin UI for the stack. |
| `caddy` | `Caddyfile-*` | Reverse proxy and TLS for balls.spinevo.app. |

`compose.local.yaml` runs the stack locally; `compose.ionos.yaml` is the production stack (it also runs the `dev-spinevo` container for dev.spinevo.app).

## Export APIs consumed by spinevo

- `GET /api/export/rally-dataset` — manifest + `{stem}_rally.json` + `{stem}_timeseries.csv` per task.
- `GET /api/rally/task/{id}/points_csv` — timeseries CSV built live from `labels_rallye/` + `person_pose/`.
- `GET /api/export/yolo-dataset-full` — YOLO training dataset ZIP.
- Auth: Bearer `BALL_DETECTION_EXPORT_API_KEY` (when set server-side; unset means open GETs).

## Deployment

Images build on GitHub Actions and push to ghcr.io. The user deploys with `./deploy-ionos.sh` from their own machine over SSH. See `IONOS-DEPLOYMENT.md`.
