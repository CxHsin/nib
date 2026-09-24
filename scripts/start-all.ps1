param(
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$envPath = Join-Path $projectRoot ".env"
$defaultNapCatLauncher = "D:\Code\NapCat\launcher.bat"

function Read-DotEnvValue {
  param([Parameter(Mandatory)][string]$Name)
  if (-not (Test-Path -LiteralPath $envPath)) { return $null }
  $line = Get-Content -LiteralPath $envPath -ErrorAction Stop |
    Where-Object { $_ -match "^\s*$([regex]::Escape($Name))=(.*)$" } |
    Select-Object -Last 1
  if (-not $line) { return $null }
  $value = [regex]::Match($line, "^\s*$([regex]::Escape($Name))=(.*)$").Groups[1].Value.Trim()
  if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  return $value
}

function Test-TcpListener {
  param(
    [Parameter(Mandatory)][string]$HostName,
    [Parameter(Mandatory)][int]$Port
  )
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync($HostName, $Port)
    return $task.Wait(1000) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

$wsUrl = Read-DotEnvValue "NAPCAT_WS_URL"
if ([string]::IsNullOrWhiteSpace($wsUrl)) {
  throw "缺少 .env 中的 NAPCAT_WS_URL。先运行 bash scripts/setup.sh。"
}
$wsUri = [Uri]$wsUrl
if ($wsUri.Scheme -notin @("ws", "wss") -or $wsUri.Port -lt 1) {
  throw "NAPCAT_WS_URL 必须是有效的 ws:// 或 wss:// 地址：$wsUrl"
}

$launcher = Read-DotEnvValue "NAPCAT_LAUNCHER_BAT"
if ([string]::IsNullOrWhiteSpace($launcher)) { $launcher = $defaultNapCatLauncher }
$launcher = [Environment]::ExpandEnvironmentVariables($launcher)

Write-Host "[nib] NapCat 地址：$wsUrl"
Write-Host "[nib] NapCat 启动器：$launcher"

if ($CheckOnly) {
  if (-not (Test-Path -LiteralPath $launcher)) {
    Write-Warning "启动器不存在：$launcher"
    exit 2
  }
  Write-Host "[nib] 配置检查通过。"
  exit 0
}

if (-not (Test-TcpListener -HostName $wsUri.Host -Port $wsUri.Port)) {
  if (-not (Test-Path -LiteralPath $launcher)) {
    throw "找不到 NapCat 启动器：$launcher。可在 .env 设置 NAPCAT_LAUNCHER_BAT。"
  }
  Write-Host "[nib] NapCat 尚未监听，正在启动 launcher.bat……"
  Start-Process -FilePath "cmd.exe" `
    -ArgumentList @("/c", "`"$launcher`"") `
    -WorkingDirectory (Split-Path -Parent $launcher)
} else {
  Write-Host "[nib] NapCat 已在运行，复用现有连接。"
}

$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  if (Test-TcpListener -HostName $wsUri.Host -Port $wsUri.Port) { break }
  Start-Sleep -Seconds 1
}
if (-not (Test-TcpListener -HostName $wsUri.Host -Port $wsUri.Port)) {
  throw "等待 NapCat WebSocket 超时：$wsUrl。请检查 NapCat 登录状态和 WebSocket 配置。"
}

Write-Host "[nib] NapCat WebSocket 已就绪，启动 nib……"
Push-Location $projectRoot
try {
  $npmCommand = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
  if ([string]::IsNullOrWhiteSpace($npmCommand)) {
    $npmCommand = (Get-Command npm -ErrorAction SilentlyContinue).Source
  }
  if ([string]::IsNullOrWhiteSpace($npmCommand)) { throw "找不到 npm，请安装 Node.js 22.19+。" }
  & $npmCommand run dev
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
