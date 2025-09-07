FROM python:3.11-slim

ENV PIP_NO_CACHE_DIR=1 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
ENV LABEL_DATA_DIR=/data/labels ANALYZER_DATA_DIR=/data/analyzer APP_ROOT_PATH=""

WORKDIR /app

# Python-Dependencies
COPY ball-admin/requirements.txt /app/requirements.txt
RUN pip install --upgrade pip && pip install -r requirements.txt

# App-Code
COPY ball-admin/ /app

# Datenverzeichnisse erstellen
RUN mkdir -p /data/labels /data/analyzer

EXPOSE 8002

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port 8002 ${APP_ROOT_PATH:+--root-path \"$APP_ROOT_PATH\"}"]
