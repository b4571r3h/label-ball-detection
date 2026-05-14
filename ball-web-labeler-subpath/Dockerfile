FROM python:3.11-slim
ENV PIP_NO_CACHE_DIR=1 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 LABEL_DATA_DIR=/data APP_ROOT_PATH=""
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --upgrade pip && pip install -r requirements.txt
# Jeder Commit invalidiert nachfolgende Schichten (verhindert veraltetes static/main.js im Cache)
ARG GIT_SHA=unknown
RUN echo "$GIT_SHA" >/tmp/.labeler_git_sha
COPY . /app
RUN mkdir -p ${LABEL_DATA_DIR}
EXPOSE 8000
CMD ["sh","-c","pip install -q --upgrade yt-dlp && uvicorn app:app --host 0.0.0.0 --port 8000"]
