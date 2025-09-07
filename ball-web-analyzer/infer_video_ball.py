#!/usr/bin/env python3
import argparse, cv2, numpy as np, subprocess, sys
from pathlib import Path
from ultralytics import YOLO

def is_url(s: str) -> bool:
    return s.startswith("http://") or s.startswith("https://")

def resolve_source(src: str) -> str:
    if is_url(src):
        here = Path(__file__).resolve().parent
        py = sys.executable
        out = subprocess.check_output([py, str(here/"tools"/"download_youtube.py"), src], text=True).strip()
        return out
    return src

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", required=True, help="path to YOLO weights (.pt)")
    ap.add_argument("--source", required=True, help="video file path or YouTube URL")
    ap.add_argument("--conf", type=float, default=0.25, help="confidence threshold")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--save", type=str, default="", help="optional output video path (mp4)")
    args = ap.parse_args()

    model = YOLO(args.weights)
    src_path = resolve_source(args.source)

    cap = cv2.VideoCapture(src_path)
    if not cap.isOpened():
        raise SystemExit(f"Cannot open video: {src_path}")
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    writer = None
    if args.save:
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(args.save, fourcc, fps, (w, h))

    green = (0, 255, 0)

    while True:
        ok, frame = cap.read()
        if not ok: break

        results = model.predict(frame, conf=args.conf, imgsz=args.imgsz, verbose=False)
        for r in results:
            for b in r.boxes:
                x1, y1, x2, y2 = map(int, b.xyxy[0].tolist())
                cv2.rectangle(frame, (x1, y1), (x2, y2), green, 2)
                if hasattr(b, "conf") and b.conf is not None:
                    conf = float(b.conf[0])
                    cv2.putText(frame, f"ball {conf:.2f}", (x1, max(20, y1-6)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, green, 2)

        if writer is not None:
            writer.write(frame)

        cv2.imshow("Ball Detector (green boxes)", frame)
        if cv2.waitKey(1) & 0xFF in (27, ord('q')):
            break

    cap.release()
    if writer is not None:
        writer.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    main()
