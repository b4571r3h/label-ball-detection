#!/usr/bin/env python3
"""
Simple Ball Labeler (YOLO format)
- Click-and-drag to draw a bounding box around the ball
- Multiple boxes per image supported (Enter saves all)
- Saves to YOLO .txt files with class 0 (ball) in labels dir
- Keyboard:
    n / Right Arrow  -> next image (auto-save if not saved)
    p / Left Arrow   -> previous image
    s                -> save labels for current image
    d                -> delete last box
    c                -> clear all boxes
    +/-              -> change rectangle thickness
    q / ESC          -> quit (auto-save current file)
- Loads existing labels if present and renders them
- Supports images: .jpg, .jpeg, .png

Usage:
    python label_tool.py --images data/ball_det/images/train --labels data/ball_det/labels/train
"""
import argparse, os
from pathlib import Path
import cv2
import glob

def yolo_to_xyxy(yolo_line, w, h):
    cls, x, y, bw, bh = map(float, yolo_line.strip().split())
    cx, cy = x * w, y * h
    ww, hh = bw * w, bh * h
    x1 = int(round(cx - ww/2))
    y1 = int(round(cy - hh/2))
    x2 = int(round(cx + ww/2))
    y2 = int(round(cy + hh/2))
    return int(cls), max(0,x1), max(0,y1), min(w-1,x2), min(h-1,y2)

def xyxy_to_yolo(x1, y1, x2, y2, w, h, cls=0):
    x1, y1, x2, y2 = map(float, (x1, y1, x2, y2))
    bw = (x2 - x1) / w
    bh = (y2 - y1) / h
    cx = (x1 + x2) / 2.0 / w
    cy = (y1 + y2) / 2.0 / h
    return f"{cls} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}"

class Labeler:
    def __init__(self, img_dir: Path, lbl_dir: Path):
        self.img_dir = img_dir
        self.lbl_dir = lbl_dir
        self.files = sorted([p for ext in ("*.jpg","*.jpeg","*.png") for p in img_dir.glob(ext)])
        if not self.files:
            raise SystemExit(f"No images found in {img_dir}")
        self.idx = 0
        self.win = "Ball Labeler (YOLO)"
        self.box_thick = 2
        self.load_image()
        cv2.namedWindow(self.win, cv2.WINDOW_NORMAL)
        cv2.setMouseCallback(self.win, self.on_mouse)
        self.dragging = False
        self.start_pt = None
        self.temp_box = None  # (x1,y1,x2,y2)
        self.saved = False

    def load_labels(self, img_path: Path):
        ypath = self.lbl_dir / (img_path.stem + ".txt")
        H, W = self.im.shape[:2]
        boxes = []
        if ypath.exists():
            with open(ypath, "r") as f:
                for line in f:
                    if not line.strip(): continue
                    cls, x1, y1, x2, y2 = yolo_to_xyxy(line, W, H)
                    boxes.append((x1,y1,x2,y2, int(cls)))
        return boxes

    def save_labels(self):
        img_path = self.files[self.idx]
        ypath = self.lbl_dir / (img_path.stem + ".txt")
        self.lbl_dir.mkdir(parents=True, exist_ok=True)
        H, W = self.im.shape[:2]
        if not self.boxes:
            # write empty file (valid negative for YOLO)
            open(ypath, "w").close()
            self.saved = True
            return
        lines = [xyxy_to_yolo(x1,y1,x2,y2,W,H,cls=0) for (x1,y1,x2,y2,cls) in self.boxes]
        with open(ypath, "w") as f:
            f.write("\n".join(lines) + "\n")
        self.saved = True

    def load_image(self):
        img_path = self.files[self.idx]
        self.im = cv2.imread(str(img_path))
        if self.im is None:
            raise SystemExit(f"Cannot read image: {img_path}")
        self.base = self.im.copy()
        self.boxes = self.load_labels(img_path)  # list of (x1,y1,x2,y2,cls)
        self.saved = False

    def clamp_point(self, x, y):
        H, W = self.im.shape[:2]
        return max(0, min(W-1, x)), max(0, min(H-1, y))

    def on_mouse(self, event, x, y, flags, param):
        if event == cv2.EVENT_LBUTTONDOWN:
            self.dragging = True
            x,y = self.clamp_point(x,y)
            self.start_pt = (x,y)
            self.temp_box = None
        elif event == cv2.EVENT_MOUSEMOVE and self.dragging:
            x,y = self.clamp_point(x,y)
            x1,y1 = self.start_pt
            self.temp_box = (min(x1,x), min(y1,y), max(x1,x), max(y1,y))
        elif event == cv2.EVENT_LBUTTONUP and self.dragging:
            self.dragging = False
            x,y = self.clamp_point(x,y)
            x1,y1 = self.start_pt
            box = (min(x1,x), min(y1,y), max(x1,x), max(y1,y), 0)
            # discard tiny boxes
            if box[2]-box[0] >= 3 and box[3]-box[1] >= 3:
                self.boxes.append(box)
                self.saved = False
            self.temp_box = None
            self.start_pt = None

    def render(self):
        vis = self.base.copy()
        # draw existing boxes
        for (x1,y1,x2,y2,cls) in self.boxes:
            cv2.rectangle(vis, (x1,y1), (x2,y2), (0,255,0), self.box_thick)
        # draw temp box
        if self.temp_box is not None:
            x1,y1,x2,y2 = self.temp_box
            cv2.rectangle(vis, (x1,y1), (x2,y2), (0,200,255), self.box_thick)
        # HUD
        H,W = vis.shape[:2]
        text = f"{self.img_dir.name} [{self.idx+1}/{len(self.files)}]  -  s=save  n/p=next/prev  d=delete-last  c=clear  q=quit"
        cv2.rectangle(vis, (0,0), (W, 34), (0,0,0), -1)
        cv2.putText(vis, text, (10,24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255,255,255), 2, cv2.LINE_AA)
        return vis

    def next_image(self):
        if not self.saved:
            self.save_labels()
        if self.idx < len(self.files)-1:
            self.idx += 1
            self.load_image()

    def prev_image(self):
        if not self.saved:
            self.save_labels()
        if self.idx > 0:
            self.idx -= 1
            self.load_image()

    def run(self):
        while True:
            vis = self.render()
            cv2.imshow(self.win, vis)
            key = cv2.waitKey(20) & 0xFF
            if key in (27, ord('q')):
                if not self.saved:
                    self.save_labels()
                break
            elif key in (ord('s'),):
                self.save_labels()
            elif key in (ord('n'), 83):  # right arrow
                self.next_image()
            elif key in (ord('p'), 81):  # left arrow
                self.prev_image()
            elif key in (ord('d'),):
                if self.boxes:
                    self.boxes.pop()
                    self.saved = False
            elif key in (ord('c'),):
                self.boxes = []
                self.saved = False
            elif key in (ord('+'), ord('=')):
                self.box_thick = min(12, self.box_thick+1)
            elif key in (ord('-'), ord('_')):
                self.box_thick = max(1, self.box_thick-1)
        cv2.destroyAllWindows()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", required=True, help="Folder with images to label")
    ap.add_argument("--labels", required=True, help="Folder to write YOLO txt labels")
    args = ap.parse_args()
    img_dir = Path(args.images)
    lbl_dir = Path(args.labels)
    lab = Labeler(img_dir, lbl_dir)
    lab.run()

if __name__ == "__main__":
    main()
