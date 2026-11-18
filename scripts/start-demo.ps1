# Build the FrameSeal SPA and serve it with the API and WebSocket on one port.
param([ValidateRange(1, 65535)][int]$Port = 8000)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'launch_helpers.ps1')
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'

Assert-FrameSealPortAvailable $Port
$python = Initialize-FrameSealBackend $backend
Initialize-FrameSealFrontend $frontend
Push-Location -LiteralPath $frontend
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
} finally {
    Pop-Location
}

$url = "http://127.0.0.1:$Port"
$arguments = '-m', 'uvicorn', 'app.main:create_demo_app', '--factory', '--host', '127.0.0.1', '--port', "$Port"
$server = Start-Process -FilePath $python -WorkingDirectory $backend -NoNewWindow -PassThru -ArgumentList $arguments
$ready = $false
try {
    Wait-FrameSealUrl "$url/api/health" $server
    $ready = $true
    Start-Process $url
    $server.WaitForExit()
    if ($server.ExitCode -ne 0) { throw "The demo server exited with code $($server.ExitCode)." }
} finally {
    if (-not $ready -and -not $server.HasExited) { Stop-Process -Id $server.Id }
}
