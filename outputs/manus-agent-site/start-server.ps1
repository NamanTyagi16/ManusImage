$ErrorActionPreference = "Stop"

$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $AppDir

Write-Host "Starting Manus Agent Site..." -ForegroundColor Cyan
Write-Host "Folder: $AppDir"
Write-Host ""

node server.mjs
