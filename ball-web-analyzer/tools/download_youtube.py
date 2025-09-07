#!/usr/bin/env python3
import argparse, tempfile, sys
from pathlib import Path
import contextlib, io, shutil

def is_url(s: str) -> bool:
    return s.startswith("http://") or s.startswith("https://")

def ensure_ffmpeg():
    if shutil.which("ffmpeg") is None:
        raise SystemExit("ffmpeg not found. Install it and ensure it's in PATH.")

def download(url: str) -> Path:
    ensure_ffmpeg()
    import yt_dlp  # type: ignore
    tmpdir = Path(tempfile.mkdtemp(prefix="yt_dlp_"))
    ydl_opts = {
        "outtmpl": str(tmpdir / "%(title).200s.%(ext)s"),
        "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,  # wichtig
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

def main():
    ap = argparse.ArgumentParser(description="Download a YouTube URL to a temp mp4 and print path")
    ap.add_argument("url")
    args = ap.parse_args()
    if not is_url(args.url):
        print(args.url, flush=True)
        return
    f = download(args.url)
    print(str(f), flush=True)

if __name__ == "__main__":
    main()
