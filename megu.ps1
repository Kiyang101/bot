[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'restart', 'status', 'logs', 'help')]
    [string]$Command = 'help',

    [Parameter(Position = 1)]
    [ValidateSet('bot', 'dashboard')]
    [string]$Service
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = $PSScriptRoot
$LogsDir     = Join-Path $ProjectRoot 'logs'
$StateDir    = Join-Path $ProjectRoot '.megu'
$StateFile   = Join-Path $StateDir 'state.json'

if (-not (Test-Path $LogsDir))  { New-Item -ItemType Directory -Path $LogsDir  | Out-Null }
if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir | Out-Null }

function Get-State {
    if (Test-Path $StateFile) {
        return Get-Content $StateFile -Raw | ConvertFrom-Json
    }
    return [pscustomobject]@{ bot = $null; dashboard = $null }
}

function Set-State($state) {
    $state | ConvertTo-Json | Set-Content -Path $StateFile -Encoding utf8
}

function Test-ProcessAlive($processId) {
    if (-not $processId) { return $false }
    try { return $null -ne (Get-Process -Id $processId -ErrorAction Stop) }
    catch { return $false }
}

function Stop-ProcessTree($processId) {
    if (-not $processId) { return }
    Get-CimInstance Win32_Process |
        Where-Object { $_.ParentProcessId -eq $processId } |
        ForEach-Object { Stop-ProcessTree $_.ProcessId }
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}

function Start-NodeService($name, $field, $arguments) {
    $state = Get-State
    if (Test-ProcessAlive $state.$field) {
        Write-Host "  [$name] already running (PID $($state.$field))" -ForegroundColor Yellow
        return
    }
    $log = Join-Path $LogsDir "$name.log"
    if (Test-Path $log) { Remove-Item $log -Force }
    $errLog = "$log.err"
    if (Test-Path $errLog) { Remove-Item $errLog -Force }

    $p = Start-Process -FilePath 'npm.cmd' -ArgumentList $arguments `
        -WorkingDirectory $ProjectRoot -WindowStyle Hidden `
        -RedirectStandardOutput $log -RedirectStandardError $errLog `
        -PassThru

    $state.$field = $p.Id
    Set-State $state
    Write-Host "  [$name] started (PID $($p.Id))" -ForegroundColor Green
}

function Stop-NodeService($name, $field) {
    $state = Get-State
    $processId = $state.$field
    if (Test-ProcessAlive $processId) {
        Write-Host "  [$name] stopping (PID $processId)..." -ForegroundColor Cyan
        Stop-ProcessTree $processId
        Write-Host "  [$name] stopped" -ForegroundColor Green
    } else {
        Write-Host "  [$name] not running" -ForegroundColor Yellow
    }
    $state.$field = $null
    Set-State $state
}

function Invoke-Start {
    Write-Host "Starting Megu stack..." -ForegroundColor Magenta
    Start-NodeService 'bot'       'bot'       @('start')
    Start-NodeService 'dashboard' 'dashboard' @('run', 'dev', '--workspace', 'dashboard')
    Write-Host ""
    Write-Host "Done." -ForegroundColor Magenta
    Write-Host "  Dashboard: http://localhost:3000"
    Write-Host "  Logs:      .\megu.ps1 logs bot|dashboard"
}

function Invoke-Stop {
    Write-Host "Stopping Megu stack..." -ForegroundColor Magenta
    Stop-NodeService 'bot'       'bot'
    Stop-NodeService 'dashboard' 'dashboard'
    Write-Host ""
    Write-Host "Done." -ForegroundColor Magenta
}

function Invoke-Restart {
    Invoke-Stop
    Start-Sleep -Seconds 2
    Invoke-Start
}

function Invoke-Status {
    $state = Get-State
    Write-Host "Megu stack status:" -ForegroundColor Magenta

    if (Test-ProcessAlive $state.bot)       { Write-Host "  [bot]       RUNNING (PID $($state.bot))" -ForegroundColor Green }
    else                                    { Write-Host "  [bot]       stopped" -ForegroundColor Red }

    if (Test-ProcessAlive $state.dashboard) { Write-Host "  [dashboard] RUNNING (PID $($state.dashboard))" -ForegroundColor Green }
    else                                    { Write-Host "  [dashboard] stopped" -ForegroundColor Red }
}

function Invoke-Logs {
    if (-not $Service) {
        Write-Host "Usage: .\megu.ps1 logs <bot|dashboard>" -ForegroundColor Red
        return
    }
    $logPath = switch ($Service) {
        'bot'       { Join-Path $LogsDir 'bot.log' }
        'dashboard' { Join-Path $LogsDir 'dashboard.log' }
    }
    if (-not (Test-Path $logPath)) {
        Write-Host "Log not found: $logPath" -ForegroundColor Red
        Write-Host "  (Has the service been started yet?)" -ForegroundColor Yellow
        return
    }
    Write-Host "Tailing $logPath (Ctrl+C to exit)..." -ForegroundColor Cyan
    Get-Content -Path $logPath -Wait -Tail 50
}

function Invoke-Help {
    Write-Host @"

Megu launcher — manages the Discord bot and dashboard.

Usage: .\megu.ps1 <command> [service]

Commands:
  start                Start bot and dashboard (skips ones already running).
  stop                 Stop bot and dashboard.
  restart              Stop then start.
  status               Show whether each service is running.
  logs <service>       Tail the log of bot | dashboard.  Ctrl+C exits.
  help                 Show this message.

Examples:
  .\megu.ps1 start
  .\megu.ps1 logs bot
  .\megu.ps1 restart
  .\megu.ps1 status

Notes:
  * Bot and dashboard run hidden in the background. Their stdout/stderr go to
    .\logs\bot.log and .\logs\dashboard.log — use 'megu logs <service>' to tail.
  * PIDs are tracked in .megu\state.json so stop/restart hit the right process.
"@
}

switch ($Command) {
    'start'   { Invoke-Start }
    'stop'    { Invoke-Stop }
    'restart' { Invoke-Restart }
    'status'  { Invoke-Status }
    'logs'    { Invoke-Logs }
    'help'    { Invoke-Help }
}
