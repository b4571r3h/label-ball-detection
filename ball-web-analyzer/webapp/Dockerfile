FROM python:3.11-slim

# System deps (ffmpeg für yt-dlp, libgl für OpenCV)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libgl1 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY webapp/requirements-web.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Projekt rein
COPY . /app

EXPOSE 8501
# Base URL Path für Subpfad, z.B. /ball-web-analyzer
ENV STREAMLIT_SERVER_BASEURLPATH=/ball-web-analyzer
CMD ["streamlit", "run", "webapp/app.py", "--server.port=8501", "--server.address=0.0.0.0", "--server.baseUrlPath=/ball-web-analyzer"]
