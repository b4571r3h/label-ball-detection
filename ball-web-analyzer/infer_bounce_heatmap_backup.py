#!/usr/bin/env python3
"""
Bounce Heatmap for Table Tennis from a single video.
- Detects the ball with a YOLO model
- Lets you CALIBRATE the table once by clicking its 4 corners in the first frame
  (order: top-left, top-right, bottom-right, bottom-left)
- Projects detections onto the table plane (top-down) via homography
- Finds likely BOUNCES (local maxima in screen-y with plausibility checks)
- Saves:
    * heatmap PNG (top-down on official table size 2.74m x 1.525m)
    * CSV of bounce events (frame, time_s, x_m, y_m, confidence)
    * (optional) annotated video preview with bounce dots
Usage:
    python infer_bounce_heatmap.py --weights runs/detect/train/weights/best.pt \
      --source "path/to/video.mp4 or https://www.youtube.com/watch?v=..." \
      --conf 0.25 --imgsz 640 --calib table_calib.json --save_heatmap heatmap.png \
      --save_csv bounces.csv --save_preview preview.mp4
"""
import argparse, json, sys, io, contextlib, shutil, tempfile
from pathlib import Path
import numpy as np
import cv2
from ultralytics import YOLO

# ---------- YouTube helper ----------
def is_url(s: str) -> bool:
    return s.startswith("http://") or s.startswith("https://")

def ensure_ffmpeg():
    if shutil.which("ffmpeg") is None:
        raise SystemExit("ffmpeg not found. Please install it and ensure it's in PATH.")

def download_youtube(url: str) -> Path:
    try:
        import yt_dlp  # type: ignore
    except Exception as e:
        raise SystemExit("yt-dlp not installed. Install with: pip install yt-dlp") from e
    ensure_ffmpeg() 
    tmpdir = Path(tempfile.mkdtemp(prefix="yt_bounce_"))
    ydl_opts = {
        "outtmpl": str(tmpdir / "%(title).200s.%(ext)s"),
        "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
    }
    buf_out, buf_err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(buf_out), contextlib.redirect_stderr(buf_err):
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            filename = ydl.prepare_filename(info)
    path = Path(filename)
    if not path.exists():
        files = list(tmpdir.glob("*"))
        if not files:
            raise RuntimeError("yt-dlp produced no file")
        path = max(files, key=lambda p: p.stat().st_mtime)
    return path

# ---------- Geometry ----------
TABLE_W = 2.74   # meters
TABLE_H = 1.525  # meters

def pick_points(img, n=4, title="Click table corners: TL, TR, BR, BL (Enter confirms, r=reset, u=undo)"):
    pts = []
    clone = img.copy()
    win = "Calibrate Table"
    cv2.namedWindow(win, cv2.WINDOW_NORMAL)

    # einmal anzeigen, damit das Fenster sicher existiert (macOS HighGUI fix)
    cv2.imshow(win, clone)
    cv2.waitKey(1)

    def on_mouse(event, x, y, flags, param):
        nonlocal pts
        if event == cv2.EVENT_LBUTTONDOWN and len(pts) < n:
            pts.append((x, y))

    # >>> WICHTIG: Maus-Callback registrieren <<<
    cv2.setMouseCallback(win, on_mouse)

    labels = ["TL","TR","BR","BL"]
    while True:
        vis = clone.copy()
        cv2.putText(vis, title, (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0,255,255), 2, cv2.LINE_AA)
        cv2.putText(vis, f"clicked: {len(pts)}/{n}  (u=undo, r=reset, Enter/Return or y=confirm, q/ESC=abort)",
                    (10, 56), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200,255,200), 2, cv2.LINE_AA)
        for i, (x, y) in enumerate(pts):
            cv2.circle(vis, (x, y), 8, (0,0,255), -1)
            tag = f"{i+1}:{labels[i] if i < len(labels) else ''}"
            cv2.putText(vis, tag, (x+10, y-10), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0,0,255), 2, cv2.LINE_AA)

        cv2.imshow(win, vis)
        key = cv2.waitKey(20) & 0xFF

        if key in (27, ord('q')):           # ESC / q -> Abbruch
            cv2.destroyWindow(win)
            raise SystemExit("Calibration aborted.")
        if key in (ord('u'), 8):            # Undo / Backspace
            if pts: pts.pop()
        if key == ord('r'):                 # Reset
            pts = []
        if len(pts) >= n and key in (13, 10, ord('y')):  # Enter/Return oder 'y'
            break

    cv2.destroyWindow(win)
    return np.array(pts, dtype=np.float32)


def compute_homography(img_pts):
    # img_pts order: TL, TR, BR, BL
    src = np.asarray(img_pts, dtype=np.float32)
    dst = np.array([[0,0],[TABLE_W,0],[TABLE_W,TABLE_H],[0,TABLE_H]], dtype=np.float32)
    H, _ = cv2.findHomography(src, dst, method=0)
    return H

def project_to_table(H, pts_xy):
    # pts_xy: (N,2) in image pixels
    pts = np.hstack([pts_xy, np.ones((len(pts_xy),1))])
    m = pts @ H.T
    m[:,0] /= (m[:,2] + 1e-9)
    m[:,1] /= (m[:,2] + 1e-9)
    return m[:,:2]  # (N,2) in meters

def inside_table(xy, margin=0.03):
    x,y = xy
    return (-margin <= x <= TABLE_W+margin) and (-margin <= y <= TABLE_H+margin)

# ---------- Bounce detection ----------
def find_bounces(track, fps, proj_pts, confs, min_gap_s=0.25):
    """
    track: list of (frame_idx, x_img, y_img)
    proj_pts: list of (x_m, y_m) after homography projection
    confs: list of confidences
    Heuristic: local maximum in y_img with conf gate and inside table after projection.
    """
    bounces = []
    if len(track) < 3:
        return bounces
    ys = np.array([p[2] for p in track], dtype=float)
    frames = np.array([p[0] for p in track], dtype=int)
    last_bounce_frame = -10**9
    min_gap = int(min_gap_s * fps)

    for i in range(1, len(track)-1):
        # local maximum in screen y
        if ys[i-1] < ys[i] > ys[i+1]:
            if confs[i] < 0.15:  # low conf -> skip
                continue
            xy_m = proj_pts[i]
            if not inside_table(xy_m, margin=0.05):
                continue
            if frames[i] - last_bounce_frame < min_gap:
                continue
            bounces.append((frames[i], xy_m[0], xy_m[1], float(confs[i])))
            last_bounce_frame = frames[i]
    return bounces

# ---------- Main ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", required=True, help="YOLO weights (.pt)")
    ap.add_argument("--source", required=True, help="video path or YouTube URL")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--calib", type=str, default="table_calib.json", help="store/load table corner calibration")
    ap.add_argument("--save_heatmap", type=str, default="heatmap.png")
    ap.add_argument("--save_csv", type=str, default="bounces.csv")
    ap.add_argument("--save_preview", type=str, default="", help="optional annotated MP4")
    ap.add_argument("--show", action="store_true", help="show live window during processing")
    args = ap.parse_args()

    # Resolve source
    temp_dir = None
    src_path = args.source
    if is_url(src_path):
        p = download_youtube(src_path)
        src_path = str(p)
        temp_dir = p.parent

    # Open video
    cap = cv2.VideoCapture(src_path)
    if not cap.isOpened():
        raise SystemExit(f"Cannot open video: {src_path}")
    FPS = cap.get(cv2.CAP_PROP_FPS) or 30.0
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    N = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    # Calibration: load or create
    if Path(args.calib).exists():
        data = json.loads(Path(args.calib).read_text())
        img_pts = np.array(data["img_pts"], dtype=np.float32)
    else:
        # Read first frame for picking
        ok, first = cap.read()
        if not ok:
            raise SystemExit("Could not read first frame for calibration.")
        img_pts = pick_points(first, 4, "Click table corners: TL, TR, BR, BL (Enter confirms, r=reset)")
        Path(args.calib).write_text(json.dumps({"img_pts": img_pts.tolist()}), encoding="utf-8")
        # rewind
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

    Hmat = compute_homography(img_pts)

    # --- Show calibration overlay for ~2s once processing starts ---
    def draw_calib_overlay(frame):
        pts = np.array(img_pts, dtype=np.int32).reshape(-1,1,2)
        cv2.polylines(frame, [pts], isClosed=True, color=(255,255,0), thickness=2)
        labels = ['TL','TR','BR','BL']
        for i,(x,y) in enumerate(img_pts):
            cv2.circle(frame, (int(x),int(y)), 6, (0,255,255), -1)
            cv2.putText(frame, labels[i], (int(x)+8,int(y)-8), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0,255,255), 2)
        cv2.putText(frame, 'Table calibrated', (20,40), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0,255,255), 2)

    overlay_frames = int((cap.get(cv2.CAP_PROP_FPS) or 30.0) * 2.0)

    # YOLO model
    det = YOLO(args.weights)

    # Preview writer
    writer = None
    if args.save_preview:
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(args.save_preview, fourcc, FPS, (W, H))

    # Accumulators
    frames_list, img_pts_list, proj_pts_list, confs_list = [], [], [], []
    GREEN = (0,255,0)
    CYAN  = (255,255,0)
    RED   = (0,0,255)

    frame_idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        # Detect ball
        results = det.predict(frame, conf=args.conf, imgsz=args.imgsz, verbose=False)
        cx = cy = None
        cbest = 0.0

        for r in results:
            if r.boxes is None or len(r.boxes) == 0:
                continue
            # take the highest-confidence box (assuming 1 class)
            b = r.boxes
            # pick argmax conf
            j = int(np.argmax(b.conf.cpu().numpy()))
            x1, y1, x2, y2 = map(int, b.xyxy[j].tolist())
            c = float(b.conf[j])
            cx = (x1 + x2) / 2.0
            cy = (y1 + y2) / 2.0
            cbest = c
            # draw detection
            if args.show or writer is not None:
                cv2.rectangle(frame, (x1,y1), (x2,y2), GREEN, 2)
                cv2.putText(frame, f"ball {c:.2f}", (x1, max(20, y1-6)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, GREEN, 2)
            break

        if cx is not None:
            frames_list.append(frame_idx)
            img_pts_list.append((cx, cy))
            confs_list.append(cbest)
            proj = project_to_table(Hmat, np.array([[cx, cy]], dtype=np.float32))[0]
            proj_pts_list.append((float(proj[0]), float(proj[1])))

        # draw table polygon & projected "shadow" point
        if overlay_frames > 0:
            draw_calib_overlay(frame)
            overlay_frames -= 1
        if args.show or writer is not None:
            pts = img_pts.astype(np.int32) if (img_pts:=img_pts) is not None else None
            poly = np.array(img_pts, dtype=np.int32).reshape(-1,1,2)
            cv2.polylines(frame, [poly], isClosed=True, color=CYAN, thickness=2)
            if cx is not None:
                cv2.circle(frame, (int(cx), int(cy)), 4, CYAN, -1)

        if args.show:
            cv2.imshow("Bounce Heatmap Processing", frame)
            if cv2.waitKey(1) & 0xFF in (27, ord('q')):
                break

        if writer is not None:
            writer.write(frame)

        frame_idx += 1

    cap.release()
    if writer is not None:
        writer.release()
    cv2.destroyAllWindows()

    # Convert accumulators to arrays
    if not img_pts_list:
        raise SystemExit("No ball detections collected. Check your weights/conf/source.")
    track = [(int(f), float(x), float(y)) for f,(x,y) in zip(frames_list, img_pts_list)]
    proj_pts_arr = np.array(proj_pts_list, dtype=float)
    confs = np.array(confs_list, dtype=float)

    # Find bounces
    bounces = find_bounces(track, FPS, proj_pts_arr, confs, min_gap_s=0.25)

    # Save CSV
    with open(args.save_csv, "w") as f:
        f.write("frame,time_s,x_m,y_m,conf\n")
        for fr, xm, ym, c in bounces:
            t = fr / (FPS if FPS>0 else 30.0)
            f.write(f"{fr},{t:.3f},{xm:.4f},{ym:.4f},{c:.3f}\n")

    # Heatmap
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    if bounces:
        xs = [b[1] for b in bounces]
        ys = [b[2] for b in bounces]
        bins_x = 30
        bins_y = 17
        H2, xe, ye = np.histogram2d(xs, ys, bins=[bins_x, bins_y],
                                    range=[[0, TABLE_W],[0, TABLE_H]])
        # transpose for imshow orientation
        H2 = H2.T
        fig = plt.figure(figsize=(6, 3.5))
        ax = plt.gca()
        im = ax.imshow(H2, origin="lower", extent=[0, TABLE_W, 0, TABLE_H], aspect='auto')
        ax.set_xlabel("Table X (m)  [0 = left sideline from TL->TR click]")
        ax.set_ylabel("Table Y (m)  [0 = top baseline from TL->TR click]")
        ax.set_title(f"Bounce Heatmap (n={len(bounces)})")
        plt.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
        plt.tight_layout()
        fig.savefig(args.save_heatmap, dpi=200)
        plt.close(fig)
    else:
        # create empty heatmap picture
        fig = plt.figure(figsize=(6, 3.5))
        ax = plt.gca()
        ax.set_xlim(0, TABLE_W)
        ax.set_ylim(0, TABLE_H)
        ax.set_title("Bounce Heatmap (no bounces found)")
        ax.set_xlabel("Table X (m)")
        ax.set_ylabel("Table Y (m)")
        plt.tight_layout()
        fig.savefig(args.save_heatmap, dpi=200)
        plt.close(fig)

    # Optional: annotate preview with bounce dots AFTER processing
    if args.save_preview:
        cap = cv2.VideoCapture(src_path)
        if cap.isOpened():
            fourcc = cv2.VideoWriter_fourcc(*"mp4v")
            writer2 = cv2.VideoWriter(args.save_preview.replace(".mp4","_bounces.mp4"), fourcc, FPS, (W, H))
            bounce_frames = {fr:(xm,ym) for fr,xm,ym,_ in bounces}
            frame_idx = 0
            while True:
                ok, frame = cap.read()
                if not ok: break
                if frame_idx in bounce_frames:
                    xm, ym = bounce_frames[frame_idx]
                    # project table coord back to image to draw a dot at "plane" location
                    # build inverse mapping using corner polygon for a simple visualization:
                    # We'll draw a small circle at the detected ball position for that frame (already in first pass)
                    cv2.putText(frame, "BOUNCE", (20,40), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0,0,255), 3)
                writer2.write(frame)
                frame_idx += 1
            writer2.release()
            cap.release()

    # Cleanup temp
    if temp_dir is not None:
        try: shutil.rmtree(temp_dir)
        except Exception: pass

    print(f"Saved CSV: {args.save_csv}")
    print(f"Saved heatmap: {args.save_heatmap}")
    if args.save_preview:
        print(f"Saved preview (raw and _bounces.mp4) next to: {args.save_preview}")

if __name__ == "__main__":
    main()
