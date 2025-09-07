import streamlit as st
import tempfile, subprocess, sys, json
from pathlib import Path
import cv2
import numpy as np

# ----- Konfiguration -----
DEFAULT_WEIGHTS = Path("runs/detect/train/weights/best.pt")  # ggf. anpassen
TOOLS_DIR = Path(__file__).resolve().parents[1] / "tools"
INFER_SCRIPT = Path(__file__).resolve().parents[1] / "infer_bounce_heatmap.py"

st.set_page_config(page_title="Ball Analyzer", page_icon="🏓", layout="wide")

st.title("🏓 Ball Web Analyzer")
st.caption("Video hochladen oder YouTube-Link einfügen, Tisch kalibrieren, dann Ball-Detektion & Bounce-Heatmap generieren.")

# ---- Eingaben ----
col1, col2 = st.columns([1,1])
with col1:
    yt_url = st.text_input("YouTube-Link (optional)", placeholder="https://www.youtube.com/watch?v=...")
with col2:
    up = st.file_uploader("…oder MP4/MOV hier ablegen", type=["mp4","mov","m4v"])

weights = st.file_uploader("YOLO-Gewichte (.pt) – leer lassen um Default zu nutzen", type=["pt"])

# ---- Hilfsfunktionen ----
def download_youtube(url: str) -> Path:
    py = sys.executable
    out = subprocess.check_output([py, str(TOOLS_DIR/"download_youtube.py"), url], text=True).strip().splitlines()[-1]
    return Path(out)

def first_frame(path: str) -> np.ndarray:
    cap = cv2.VideoCapture(path)
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise RuntimeError("Konnte erstes Frame nicht lesen.")
    return frame

def ensure_tmpfile(upload) -> Path:
    tmp = Path(tempfile.mkdtemp())
    out = tmp / upload.name
    out.write_bytes(upload.read())
    return out

# ---- Quelle auflösen ----
video_path = None
if yt_url:
    if st.button("YouTube-Video laden"):
        with st.spinner("Lade YouTube-Video…"):
            p = download_youtube(yt_url)  # nutzt dein tools/download_youtube.py
            st.session_state["video_path"] = str(p)
            st.success("Video geladen.")
if up:
    p = ensure_tmpfile(up)
    st.session_state["video_path"] = str(p)

video_path = st.session_state.get("video_path")

# ---- Kalibrierung (4 Punkte klicken) ----
if video_path:
    frame = first_frame(video_path)
    h, w = frame.shape[:2]
    st.subheader("1) Tisch-Kalibrierung")
    st.write("Klicke **genau diese Reihenfolge**: TL → TR → BR → BL. Zoome bei Bedarf in den Browser.")
    # Anzeige als PNG (RGB)
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    click = st.image(rgb, use_container_width=True)
    st.info("Tipp: Auf Desktop die Browser-Zoomfunktion nutzen, um präziser zu klicken.")

    if "points" not in st.session_state:
        st.session_state["points"] = []

    # einfache Click-Capture mit Koordinaten aus Maus-Event über Streamlit-Image ist nicht nativ verfügbar.
    # Workaround: Koordinaten-Eingabe Felder
    st.markdown("**Koordinaten manuell eingeben (x,y in Pixel)** – oder ersetze später durch st_canvas/Annotation-Widget.")
    cols = st.columns(4)
    labels = ["TL","TR","BR","BL"]
    pts = []
    for i,lab in enumerate(labels):
        with cols[i]:
            x = st.number_input(f"{lab} x", min_value=0, max_value=w-1, value= int(w*0.1 if i in (0,3) else w*0.9))
            y = st.number_input(f"{lab} y", min_value=0, max_value=h-1, value= int(h*0.2 if i in (0,1) else h*0.8))
            pts.append([float(x), float(y)])

    calib_json = None
    if st.button("Kalibrierung speichern"):
        calib_json = {"img_pts": pts}
        calib_path = Path(tempfile.mkdtemp()) / "table_calib.json"
        calib_path.write_text(json.dumps(calib_json), encoding="utf-8")
        st.session_state["calib_path"] = str(calib_path)
        st.success("Kalibrierung gespeichert.")

# ---- Pipeline ausführen ----
if video_path and st.session_state.get("calib_path"):
    st.subheader("2) Detektion & Heatmap")
    outdir = Path(tempfile.mkdtemp())
    out_heatmap = outdir / "heatmap.png"
    out_csv = outdir / "bounces.csv"
    out_preview = outdir / "preview.mp4"
    wpath = None

    if weights:
        wfile = ensure_tmpfile(weights)
        wpath = str(wfile)
    else:
        wpath = str(DEFAULT_WEIGHTS)

    if st.button("Analyse starten"):
        with st.spinner("Läuft Inferenz… (YOLO + Heatmap)"):
            cmd = [
                sys.executable, str(INFER_SCRIPT),
                "--weights", wpath,
                "--source", video_path,
                "--conf", "0.25",
                "--imgsz", "640",
                "--calib", st.session_state["calib_path"],
                "--save_heatmap", str(out_heatmap),
                "--save_csv", str(out_csv),
                "--save_preview", str(out_preview),
            ]
            # Headless ausführen
            subprocess.run(cmd, check=True)
        st.success("Fertig!")

        # Ergebnisse anzeigen
        if out_preview.exists():
            st.video(str(out_preview))
        if out_heatmap.exists():
            st.image(str(out_heatmap), caption="Bounce Heatmap", use_container_width=True)
            with open(out_heatmap, "rb") as f:
                st.download_button("Heatmap herunterladen (PNG)", f, file_name="heatmap.png")
        if out_csv.exists():
            st.dataframe(open(out_csv).read())
            with open(out_csv, "rb") as f:
                st.download_button("CSV herunterladen", f, file_name="bounces.csv")
