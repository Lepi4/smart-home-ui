$ErrorActionPreference = "Stop"

if (!(Test-Path "config/local-config.json")) {
  Copy-Item "config/local-config.example.json" "config/local-config.json"
  Write-Host "Created config/local-config.json"
  Write-Host "Edit this file: fill haUrl and haToken, then run this script again."
  exit 1
}

docker compose up --build
