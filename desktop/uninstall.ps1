#Requires -Version 5.1
<#
.SYNOPSIS
  卸载按用户安装的 Trellis Board 桌面客户端，无需管理员权限。

.DESCRIPTION
  停止客户端，删除开始菜单/桌面快捷方式和 HKCU 自启值。
  默认保留 <InstallDir>\data（设备凭证与日志）；-PurgeData 时一并删除。
  -RevokeDevice 会调用现有设备撤销接口后再删除本地文件。

  退出码：
    0 成功（或本来就没有安装）
    1 参数错误
    3 删除文件失败
    6 设备撤销失败（本地文件未删除，可重试或加 -SkipRevoke）
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "",
  [string]$ServerUrl = "",
  [string]$AgentId = "",
  [switch]$RevokeDevice,
  [switch]$SkipRevoke,
  [switch]$PurgeData,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$AppName = 'Trellis Board'
$ExeName = 'trellis-board-client.exe'
$ProcessName = 'trellis-board-client'
$RunValueName = 'TrellisBoardClient'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$script:FailureCode = 0

function Write-Info {
  param([string]$Message)
  if (-not $Quiet) {
    Write-Host $Message
  }
}

function Fail {
  param([int]$Code, [string]$Message)
  $script:FailureCode = $Code
  Write-Error $Message -ErrorAction Continue
  exit $Code
}

if (-not $InstallDir) {
  $InstallDir = Join-Path $env:LOCALAPPDATA 'TrellisBoard'
}
if ([IO.Path]::IsPathRooted($InstallDir) -eq $false) {
  Fail 1 "安装目录必须是绝对路径: $InstallDir"
}

$InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\', '/')
$forbidden = @(
  [IO.Path]::GetPathRoot($InstallDir).TrimEnd('\', '/'),
  $env:LOCALAPPDATA,
  $env:USERPROFILE,
  $env:APPDATA,
  $env:SystemRoot,
  $env:ProgramFiles,
  ${env:ProgramFiles(x86)}
) | Where-Object { $_ }
if ($forbidden -contains $InstallDir) {
  Fail 1 "拒绝卸载到受保护目录: $InstallDir"
}
if (-not (Split-Path -Leaf $InstallDir)) {
  Fail 1 "安装目录缺少叶子目录名: $InstallDir"
}

$targetExe = Join-Path $InstallDir $ExeName
$targetSidecar = Join-Path $InstallDir 'trellis-agent.exe'
$dataDir = Join-Path $InstallDir 'data'

Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300

if ($RevokeDevice -and -not $SkipRevoke) {
  $agentExe = Join-Path $dataDir 'agent\trellis-agent.exe'
  if (-not (Test-Path -LiteralPath $agentExe -PathType Leaf)) {
    $agentExe = Join-Path $InstallDir 'trellis-agent.exe'
  }
  if (-not (Test-Path -LiteralPath $agentExe -PathType Leaf)) {
    Fail 6 "找不到 sidecar，无法撤销设备；可先手动在 Board 撤销，或使用 -SkipRevoke"
  }
  $token = $env:TRELLIS_BOARD_SESSION
  if (-not $token) {
    $secure = Read-Host -Prompt 'Board 会话 Cookie（trellis_team_session，输入不回显）' -AsSecureString
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
      [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    )
  }
  if (-not $token) {
    Fail 6 "缺少会话 Cookie（设置 TRELLIS_BOARD_SESSION 或交互输入）"
  }
  if (-not $ServerUrl -or -not $AgentId) {
    $configPath = Join-Path $dataDir 'agent\config.json'
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
      $agentConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
      if (-not $ServerUrl) { $ServerUrl = $agentConfig.serverUrl }
      if (-not $AgentId) { $AgentId = $agentConfig.agentId }
    }
  }
  if (-not $ServerUrl -or -not $AgentId) {
    Fail 6 "撤销设备需要 -ServerUrl 和 -AgentId（或本地 agent 配置）"
  }
  $Env:TRELLIS_BOARD_SESSION = $token
  try {
    & $agentExe revoke --server $ServerUrl --agent $AgentId
    if ($LASTEXITCODE -ne 0) {
      Fail 6 "设备撤销失败（sidecar 退出码 $LASTEXITCODE）"
    }
    Write-Info "已撤销设备 $AgentId"
  } finally {
    Remove-Item Env:TRELLIS_BOARD_SESSION -ErrorAction SilentlyContinue
  }
}

$startMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$desktopDir = [Environment]::GetFolderPath('Desktop')
foreach ($shortcut in @(
    (Join-Path $startMenuDir "$AppName.lnk"),
    (Join-Path $desktopDir "$AppName.lnk")
  )) {
  if (Test-Path -LiteralPath $shortcut -PathType Leaf) {
    Remove-Item -LiteralPath $shortcut -Force
    Write-Info "已删除快捷方式：$shortcut"
  }
}

Remove-ItemProperty -Path $RunKey -Name $RunValueName -ErrorAction SilentlyContinue
Write-Info "已移除开机自启"

try {
  if (Test-Path -LiteralPath $targetExe -PathType Leaf) {
    Remove-Item -LiteralPath $targetExe -Force
    Write-Info "已删除：$targetExe"
  }
  if (Test-Path -LiteralPath $targetSidecar -PathType Leaf) {
    Remove-Item -LiteralPath $targetSidecar -Force
    Write-Info "已删除：$targetSidecar"
  }
  if ($PurgeData -and (Test-Path -LiteralPath $dataDir -PathType Container)) {
    Remove-Item -LiteralPath $dataDir -Recurse -Force
    Write-Info "已删除用户数据：$dataDir"
  }
  if (Test-Path -LiteralPath $InstallDir -PathType Container) {
    $remaining = @(Get-ChildItem -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue)
    if ($remaining.Count -eq 0) {
      Remove-Item -LiteralPath $InstallDir -Force
    } elseif (-not $PurgeData) {
      Write-Info "保留用户数据：$dataDir（再次运行并加 -PurgeData 可删除）"
    }
  }
} catch {
  $script:FailureCode = 3
  Write-Error "卸载未完成：$($_.Exception.Message)" -ErrorAction Continue
}

exit $script:FailureCode
