# Shared dependency setup and readiness checks for the Windows launchers.

function Initialize-FrameSealBackend([string]$Backend) {
    $python = Join-Path $Backend '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
        $version = if ((& py.exe -0p | Out-String) -match '(?m)^\s+-(?:V:)?3\.12\b') { '-3.12' } else { '-3.11' }
        & py.exe $version -m venv (Join-Path $Backend '.venv') | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.11 or 3.12 and try again.' }
    }

    & $python -m pip --disable-pip-version-check install -r (Join-Path $Backend 'requirements.txt') | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Unable to install backend requirements.' }
    return $python
}

function Initialize-FrameSealFrontend([string]$Frontend) {
    if (Test-Path -LiteralPath (Join-Path $Frontend 'node_modules\.bin\vite.cmd') -PathType Leaf) { return }
    Push-Location -LiteralPath $Frontend
    try {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'Unable to install frontend requirements.' }
    } finally {
        Pop-Location
    }
}

function Assert-FrameSealPortAvailable([int]$Port) {
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        throw "Port $Port is already in use. Stop the existing server before launching FrameSeal."
    }
}

function Wait-FrameSealUrl([string]$Url, [System.Diagnostics.Process]$Process) {
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    while ($timer.Elapsed.TotalSeconds -lt 30) {
        if ($Process.HasExited) { throw "The server exited before $Url was ready." }
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return }
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
    throw "Timed out waiting for $Url."
}
