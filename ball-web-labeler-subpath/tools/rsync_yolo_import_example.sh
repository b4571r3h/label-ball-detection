#!/usr/bin/env bash
# Beispiel: Lokales YOLO-Dataset (Train/Val) auf den IONOS-Server kopieren.
# 1) Auf dem Server einmal: mkdir -p /root/tt-apps/ball-yolo-import/ball_det
# 2) compose.ionos.yaml mountet ./ball-yolo-import/ball_det → Container /data/yolo-import
# 3) Danach: docker compose -f compose.ionos.yaml up -d ball-labeler
#
# Passe USER, HOST und ggf. Quellpfad an.

set -euo pipefail

SRC="${SRC:-/Users/Basti/TTVN_TT_AI/ball-detector-yolo-youtube/data/ball_det/}"
DST="${DST:-root@87.106.82.60:/root/tt-apps/ball-yolo-import/ball_det/}"

echo "rsync: $SRC -> $DST"
rsync -avz --progress "$SRC" "$DST"
echo "Fertig. Auf dem Server: compose neu laden / ball-labeler neu starten, dann Zähler prüfen (SpinEvo-UI oder GET .../api/stats/import-yolo)."
