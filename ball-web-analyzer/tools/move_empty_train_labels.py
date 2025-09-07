from pathlib import Path
import shutil

IMG_DIR = Path("data/ball_det/images/train")
LBL_DIR = Path("data/ball_det/labels/train")

OUT_IMG = Path("data/ball_det/images/neg")
OUT_LBL = Path("data/ball_det/labels/neg")
OUT_IMG.mkdir(parents=True, exist_ok=True)
OUT_LBL.mkdir(parents=True, exist_ok=True)

moved = 0
for lbl in LBL_DIR.glob("*.txt"):
    txt = lbl.read_text().strip()
    if txt == "":  # leere Datei = kein Objekt
        stem = lbl.stem
        img = None
        for ext in (".jpg", ".png", ".jpeg"):
            p = IMG_DIR / f"{stem}{ext}"
            if p.exists(): img = p; break
        if img:
            shutil.move(str(img), OUT_IMG / img.name)
        shutil.move(str(lbl), OUT_LBL / lbl.name)
        moved += 1

print(f"Verschoben: {moved} leere Labels (und zugehörige Bilder) nach images/neg & labels/neg")
