#!/bin/bash
# Start-Script für Ball Web Analyzer (lokale Entwicklung)

cd ball-web-analyzer/webapp

echo "🏓 Starting Ball Web Analyzer..."
echo "📍 YOLO Model: $(ls -la ../runs/detect/train4/weights/best.pt 2>/dev/null || echo 'NOT FOUND')"
echo "📍 Infer Script: $(ls -la ../infer_bounce_heatmap.py 2>/dev/null || echo 'NOT FOUND')"
echo ""

# Virtuelle Umgebung erstellen falls nicht vorhanden
if [ ! -d "venv" ]; then
    echo "📦 Creating virtual environment..."
    python3 -m venv venv
fi

# Virtuelle Umgebung aktivieren
echo "🔄 Activating virtual environment..."
source venv/bin/activate

# Dependencies installieren
echo "📦 Installing dependencies..."
pip install -r requirements-fastapi.txt

# PyTorch und Ultralytics installieren
echo "🤖 Installing PyTorch and Ultralytics..."
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
pip install ultralytics

# Data-Verzeichnis erstellen
echo "📁 Creating data directory..."
mkdir -p data

echo ""
echo "🚀 Starting FastAPI server on http://localhost:8001"
echo "   Ball Labeler:  http://localhost:8000/ball-detection/"
echo "   Ball Analyzer: http://localhost:8001/"
echo ""

# Server starten
python fastapi_app.py
