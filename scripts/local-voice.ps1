param(
    [ValidateSet('setup', 'download', 'start', 'stop', 'test')]
    [string]$Action = 'start'
)
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $RepoRoot '.local-voice'
$PythonExe = Join-Path $RuntimeDir 'venv310\Scripts\python.exe'
$ServerFile = Join-Path $RepoRoot 'services\local-tts\server.py'
$PidFile = Join-Path $RuntimeDir 'service.pid'

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
}

if ($Action -eq 'setup') {
    New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
    # tltk depends on scikit-learn 1.2, which has no Python 3.12 Windows wheel.
    Invoke-Checked 'py' @('-3.10', '-m', 'venv', (Join-Path $RuntimeDir 'venv310'))
    Invoke-Checked $PythonExe @('-m', 'pip', 'install', '--upgrade', 'pip')
    Invoke-Checked $PythonExe @('-m', 'pip', 'install', 'torch==2.6.0', '--index-url', 'https://download.pytorch.org/whl/cpu')
    Invoke-Checked $PythonExe @('-m', 'pip', 'install', '-r', (Join-Path $RepoRoot 'services\local-tts\requirements.txt'))
    Write-Host 'Dependencies installed. Run .\scripts\local-voice.ps1 download next.'
    exit
}
if ($Action -eq 'test') {
    Invoke-Checked 'python' @('-m', 'unittest', 'discover', '-s', (Join-Path $RepoRoot 'services\local-tts'), '-p', 'test_*.py')
    exit
}
if ($Action -eq 'stop') {
    if (Test-Path -LiteralPath $PidFile) {
        $ServicePid = [int](Get-Content -LiteralPath $PidFile)
        $ServiceProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $ServicePid"
        # PIDs can be reused; never stop an unrelated process from a stale file.
        if ($ServiceProcess -and $ServiceProcess.CommandLine -like "*$ServerFile*") {
            # Windows venv launchers may own a child Python process with the socket.
            Invoke-Checked 'taskkill' @('/PID', [string]$ServicePid, '/T', '/F')
        }
        Remove-Item -LiteralPath $PidFile
    }
    Write-Host 'Local TTS stopped.'
    exit
}
if (-not (Test-Path -LiteralPath $PythonExe)) { throw 'Run .\scripts\local-voice.ps1 setup first.' }
if ($Action -eq 'download') {
    Invoke-Checked 'ollama' @('pull', 'qwen3:4b')
    Invoke-Checked $PythonExe @($ServerFile, '--download')
    exit
}
if (Test-Path -LiteralPath $PidFile) {
    $ServicePid = [int](Get-Content -LiteralPath $PidFile)
    $ServiceProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $ServicePid"
    if ($ServiceProcess -and $ServiceProcess.CommandLine -like "*$ServerFile*") {
        Write-Host "Local TTS already running (PID $ServicePid)."
        exit
    }
}
if (Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port 8788 is already in use. Check the existing service before starting another.'
}
$ServiceProcess = Start-Process -FilePath $PythonExe -ArgumentList @('-u', ('"' + $ServerFile + '"')) `
    -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $RuntimeDir 'stdout.log') `
    -RedirectStandardError (Join-Path $RuntimeDir 'stderr.log')
Set-Content -LiteralPath $PidFile -Value $ServiceProcess.Id
$ReadyDeadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $ReadyDeadline) {
    $ServiceProcess.Refresh()
    if ($ServiceProcess.HasExited) { throw 'Local TTS failed to start. See .local-voice\stderr.log.' }
    try {
        $Health = Invoke-RestMethod http://127.0.0.1:8788/health -TimeoutSec 1
        if ($Health.status -eq 'ok') {
            Write-Host "Local TTS ready on http://127.0.0.1:8788 (PID $($ServiceProcess.Id), CPU)."
            exit
        }
    } catch { }
    Start-Sleep -Milliseconds 250
}
throw 'Local TTS is still starting after 45 seconds. See .local-voice\stderr.log and /health.'
