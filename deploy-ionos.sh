#!/bin/bash
# Deployment Script für IONOS Server - Beide Apps

set -e

echo "🚀 Deploying Ball Detection & Analysis Platform to IONOS..."

# Farben für Output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Server-Konfiguration
SERVER_USER="root"
SERVER_HOST="87.106.82.60"
SERVER_PATH="/root/tt-apps"

echo -e "${BLUE}📋 Deployment Configuration:${NC}"
echo -e "  Server: ${SERVER_USER}@${SERVER_HOST}"
echo -e "  Path: ${SERVER_PATH}"
echo ""

# 1. Lokale Änderungen committen
echo -e "${YELLOW}1. Checking for uncommitted changes...${NC}"
if [ -n "$(git status --porcelain)" ]; then
    echo -e "${RED}❌ You have uncommitted changes. Please commit first.${NC}"
    git status --short
    exit 1
fi

# 2. GitHub Push
echo -e "${YELLOW}2. Pushing to GitHub...${NC}"
git push

# 3. Warten auf GitHub Actions Build
echo -e "${YELLOW}3. Waiting for GitHub Actions to build Docker images...${NC}"
echo -e "${BLUE}   Check progress at: https://github.com/b4571r3h/label-ball-detection/actions${NC}"
echo -e "${BLUE}   Press Enter when build is complete...${NC}"
read -p ""

# 4. Server-Verbindung testen
echo -e "${YELLOW}4. Testing server connection...${NC}"
if ! ssh -q ${SERVER_USER}@${SERVER_HOST} exit; then
    echo -e "${RED}❌ Cannot connect to server. Check SSH access.${NC}"
    exit 1
fi

# 5. Repository auf Server aktualisieren
echo -e "${YELLOW}5. Updating repository on server...${NC}"
ssh ${SERVER_USER}@${SERVER_HOST} << EOF
    cd ${SERVER_PATH}
    git pull origin main
    echo -e "${GREEN}✅ Repository updated${NC}"
EOF

# 6. Docker Images pullen
echo -e "${YELLOW}6. Pulling latest Docker images...${NC}"
ssh ${SERVER_USER}@${SERVER_HOST} << EOF
    cd ${SERVER_PATH}
    docker pull ghcr.io/b4571r3h/label-ball-detection:latest
    docker pull ghcr.io/b4571r3h/ball-web-analyzer:latest
    docker pull ghcr.io/b4571r3h/ball-admin:latest
    echo -e "${GREEN}✅ Docker images updated${NC}"
EOF

# 7. Services stoppen
echo -e "${YELLOW}7. Stopping existing services...${NC}"
ssh ${SERVER_USER}@${SERVER_HOST} << EOF
    cd ${SERVER_PATH}
    docker-compose -f compose.ionos.yaml down || true
    echo -e "${GREEN}✅ Services stopped${NC}"
EOF

# 8. Datenverzeichnisse erstellen
echo -e "${YELLOW}8. Creating data directories...${NC}"
ssh ${SERVER_USER}@${SERVER_HOST} << EOF
    cd ${SERVER_PATH}
    mkdir -p ball-web-labeler-subpath/data
    mkdir -p ball-web-analyzer/data
    echo -e "${GREEN}✅ Data directories ready${NC}"
EOF

# 9. Services starten
echo -e "${YELLOW}9. Starting services...${NC}"
ssh ${SERVER_USER}@${SERVER_HOST} << EOF
    cd ${SERVER_PATH}
    docker-compose -f compose.ionos.yaml up -d
    echo -e "${GREEN}✅ Services started${NC}"
EOF

# 10. Health Check
echo -e "${YELLOW}10. Performing health check...${NC}"
sleep 15

# Ball Labeler Check
if curl -s -f https://app.basti-reh.de/ball-detection/api/health > /dev/null; then
    echo -e "${GREEN}✅ Ball Labeler: https://app.basti-reh.de/ball-detection/${NC}"
else
    echo -e "${RED}❌ Ball Labeler health check failed${NC}"
fi

# Ball Analyzer Check  
if curl -s -f https://app.basti-reh.de/ball-analyzer/ > /dev/null; then
    echo -e "${GREEN}✅ Ball Analyzer: https://app.basti-reh.de/ball-analyzer/${NC}"
else
    echo -e "${RED}❌ Ball Analyzer health check failed${NC}"
fi

# Admin Panel Check
if curl -s -f https://app.basti-reh.de/admin/api/health > /dev/null; then
    echo -e "${GREEN}✅ Admin Panel: https://app.basti-reh.de/admin/${NC}"
else
    echo -e "${RED}❌ Admin Panel health check failed${NC}"
fi

echo ""
echo -e "${GREEN}🎉 Deployment completed!${NC}"
echo -e "${BLUE}📱 Access your apps:${NC}"
echo -e "  🏓 Ball Labeler:  https://app.basti-reh.de/ball-detection/"
echo -e "  📊 Ball Analyzer: https://app.basti-reh.de/ball-analyzer/"
echo -e "  🛠️ Admin Panel:   https://app.basti-reh.de/admin/"
echo ""
echo -e "${YELLOW}💡 Useful commands for server management:${NC}"
echo -e "  ssh ${SERVER_USER}@${SERVER_HOST}"
echo -e "  docker-compose -f compose.ionos.yaml logs -f"
echo -e "  docker-compose -f compose.ionos.yaml ps"

