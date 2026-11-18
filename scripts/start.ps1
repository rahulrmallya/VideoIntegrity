# Start the FrameSeal development servers in separate windows.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'launch_helpers.ps1')
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'

Assert-FrameSealPortAvailable 8000
Assert-FrameSealPortAvailable 5173
$null = Initialize-FrameSealBackend $backend
Initialize-FrameSealFrontend $frontend

$apiCommand = '.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000'
$api = Start-Process -FilePath 'powershell.exe' -WorkingDirectory $backend -WindowStyle Normal -PassThru -ArgumentList '-NoLogo', '-NoExit', '-Command', $apiCommand
$ui = Start-Process -FilePath 'powershell.exe' -WorkingDirectory $frontend -WindowStyle Normal -PassThru -ArgumentList '-NoLogo', '-NoExit', '-Command', 'npm.cmd run dev'
Wait-FrameSealUrl 'http://127.0.0.1:8000/api/health' $api
Wait-FrameSealUrl 'http://localhost:5173' $ui
Start-Process 'http://localhost:5173'
