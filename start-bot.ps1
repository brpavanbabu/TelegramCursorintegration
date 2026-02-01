# Telegram + Cursor Integration - Start Script
# This script starts the bot in a clean way

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "🤖 Telegram + Cursor Integration Bot" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# Check if config.json exists
if (-not (Test-Path "config.json")) {
    Write-Host "❌ config.json not found!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please run setup first:" -ForegroundColor Yellow
    Write-Host "   node setup.js" -ForegroundColor White
    Write-Host ""
    exit 1
}

# Check if node_modules exists
if (-not (Test-Path "node_modules")) {
    Write-Host "❌ node_modules not found!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install dependencies first:" -ForegroundColor Yellow
    Write-Host "   npm install" -ForegroundColor White
    Write-Host ""
    exit 1
}

# Stop any existing bot processes
Write-Host "🔍 Checking for existing bot processes..." -ForegroundColor Yellow
$existingProcesses = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and $_.CommandLine -like "*telegram-cursor-bot.js*"
}

if ($existingProcesses) {
    Write-Host "⚠️  Stopping existing bot processes..." -ForegroundColor Yellow
    $existingProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Write-Host "✅ Existing processes stopped" -ForegroundColor Green
}

# Start the bot
Write-Host ""
Write-Host "🚀 Starting Telegram + Cursor Integration Bot..." -ForegroundColor Green
Write-Host ""

node telegram-cursor-bot.js
