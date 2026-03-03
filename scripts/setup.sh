#!/bin/bash

echo "===  PolySignal Setup ==="
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

echo "✓ Node.js $(node -v) detected"

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed."
    exit 1
fi

echo "✓ npm $(npm -v) detected"

# Check if .env exists
if [ ! -f .env ]; then
    echo ""
    echo "⚠️  No .env file found. Creating from .env.example..."
    cp .env.example .env
    echo "✓ Created .env file"
    echo ""
    echo "📝 IMPORTANT: Edit .env and add your Avanza credentials:"
    echo "   - AVANZA_USERNAME"
    echo "   - AVANZA_PASSWORD"
    echo "   - AVANZA_TOTP_SECRET (optional but recommended)"
    echo ""
fi

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install

# Build packages
echo ""
echo "Building packages..."
npm run build

# Initialize database
echo ""
echo "Initializing database..."
mkdir -p data
echo "✓ Database directory created"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "1. Edit .env with your Avanza credentials"
echo "2. Start the API server: npm run dev:api"
echo "3. Start the dashboard: npm run dev"
echo "4. Or start both: npm run dev:all"
echo ""
echo "Manual operations:"
echo "- Refresh instruments: npm run refresh:instruments"
echo "- Trigger scan: npm run scan"
echo ""
