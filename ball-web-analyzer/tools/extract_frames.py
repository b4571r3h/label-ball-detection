#!/usr/bin/env python3
import argparse, cv2, os, subprocess, sys
from pathlib import Path

def is_url(s: str) -> bool:
    return s.startswith("http://") or s.startswith("https://")

def resolve_video_path(src: str) -> str:
    from pathlib import Path
    import subprocess, sys
    if src.startswith("http://") or src.startswith("https://"):
        here = Path(__file__).resolve().parent
        py = sys.executable
        out = subprocess.check_output([py, str(here/"download_youtube.py"), src], text=True)
        # Falls dennoch Progress/Logs erscheinen: nur die letzte Zeile als Pfad nehmen
        return out.strip().splitlines()[-1]
    return src

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=float, default=5.0, help="Frames per second to extract")
    args = ap.parse_args()

    Path(args.out).mkdir(parents=True, exist_ok=True)
    video_path = resolve_video_path(args.video)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise SystemExit(f"Cannot open: {video_path}")
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, int(round(src_fps / args.fps)))

    idx = 0
    saved = 0
    stem = Path(video_path).stem
    while True:
        ok, frame = cap.read()
        if not ok: break
        if idx % step == 0:
            out_name = f"{stem}_{idx:08d}.jpg"
            cv2.imwrite(str(Path(args.out)/out_name), frame)
            saved += 1
        idx += 1
    cap.release()
    print(f"Saved {saved} frames to {args.out}")

if __name__ == "__main__":
    main()
