# 🚀 IONOS Server Deployment Anleitung

## Schnell-Deployment (Empfohlen)

### 1. Deployment-Script konfigurieren
```bash
# Datei: deploy-ionos.sh bearbeiten
SERVER_USER="dein-username"        # SSH-Username
SERVER_HOST="87.106.82.60"         # Deine IONOS IP
SERVER_PATH="/home/user/tt-apps"   # Pfad auf dem Server
```

### 2. Ein-Klick Deployment
```bash
./deploy-ionos.sh
```

Das Script macht automatisch:
- ✅ Git Push zu GitHub
- ✅ Docker Images bauen (GitHub Actions)
- ✅ Server-Update über SSH
- ✅ Docker-Images pullen
- ✅ Services starten
- ✅ Health Check

## Manuelles Deployment

### 1. Server vorbereiten
```bash
# SSH zum IONOS Server
ssh user@87.106.82.60

# Repository klonen
git clone https://github.com/b4571r3h/label-ball-detection.git
cd label-ball-detection/web

# Data-Verzeichnisse erstellen
mkdir -p ball-web-labeler-subpath/data
mkdir -p ball-web-analyzer/data

# Docker und Docker-Compose installieren (falls nötig)
sudo apt update
sudo apt install docker.io docker-compose-plugin
sudo usermod -aG docker $USER
```

### 2. Docker Images pullen
```bash
# Labeler Image (bereits verfügbar)
docker pull ghcr.io/b4571r3h/label-ball-detection:latest

# Analyzer Image (wird durch GitHub Actions gebaut)
docker pull ghcr.io/b4571r3h/ball-web-analyzer:latest
```

### 3. Services starten
```bash
# Beide Apps starten
docker-compose -f compose.ionos.yaml up -d

# Logs anschauen
docker-compose -f compose.ionos.yaml logs -f

# Status prüfen
docker-compose -f compose.ionos.yaml ps
```

## URLs nach Deployment

- **Ball Labeler**: `http://87.106.82.60/ball-detection/`
- **Ball Analyzer**: `http://87.106.82.60/ball-analyzer/`

## Troubleshooting

### Docker Images nicht verfügbar?
```bash
# GitHub Actions Build triggern
git push

# Oder lokal bauen und pushen
cd ball-web-analyzer/webapp
docker build -f Dockerfile-fastapi -t ghcr.io/b4571r3h/ball-web-analyzer:latest .
docker push ghcr.io/b4571r3h/ball-web-analyzer:latest
```

### Services laufen nicht?
```bash
# Logs prüfen
docker-compose -f compose.ionos.yaml logs

# Einzelne Services prüfen
docker logs tt-ball-labeler
docker logs tt-ball-analyzer
docker logs tt-caddy

# Services neu starten
docker-compose -f compose.ionos.yaml restart
```

### Ports bereits belegt?
```bash
# Prüfen was auf Port 80 läuft
sudo lsof -i :80

# Alte Container stoppen
docker stop $(docker ps -aq)
docker rm $(docker ps -aq)
```

### Kein Internet-Zugriff?
```bash
# Firewall prüfen
sudo ufw status
sudo ufw allow 80
sudo ufw allow 443

# IONOS Control Panel: Ports 80/443 freigeben
```

## GitHub Actions Setup

### 1. Repository Secrets einrichten
1. Gehe zu GitHub → Settings → Secrets and Variables → Actions
2. Füge hinzu:
   - `GITHUB_TOKEN` (automatisch verfügbar)

### 2. GitHub Container Registry
Die Images werden automatisch bei jedem Push zu `ghcr.io` gepusht:
- `ghcr.io/b4571r3h/label-ball-detection:latest`
- `ghcr.io/b4571r3h/ball-web-analyzer:latest`

## Maintenance

### Updates deployen
```bash
# Lokal: Änderungen machen und pushen
git add .
git commit -m "Update feature"
git push

# Server: Updates holen
ssh user@87.106.82.60
cd /path/to/deployment
git pull
docker-compose -f compose.ionos.yaml pull
docker-compose -f compose.ionos.yaml up -d
```

### Logs anschauen
```bash
# Alle Services
docker-compose -f compose.ionos.yaml logs -f

# Nur Analyzer
docker-compose -f compose.ionos.yaml logs -f ball-analyzer

# Nur Labeler  
docker-compose -f compose.ionos.yaml logs -f ball-labeler
```

### Backup erstellen
```bash
# Data-Verzeichnisse sichern
tar -czf backup-$(date +%Y%m%d).tar.gz \
  ball-web-labeler-subpath/data \
  ball-web-analyzer/data
```
