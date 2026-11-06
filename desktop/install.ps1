#Requires -Version 5.1
<#
.SYNOPSIS
  按用户安装 Trellis Board 桌面客户端，无需管理员权限。

.DESCRIPTION
  默认安装到 %LOCALAPPDATA%\TrellisBoard，创建开始菜单/桌面快捷方式，
  写 HKCU Run 自启值并启动客户端。用户数据位于 <InstallDir>\data，升级时保留。

  退出码：
    0 成功
    1 参数或源文件错误
    2 SHA256 校验失败（不落盘）
    3 复制/安装失败并已回滚
    4 快捷方式或自启写入失败并已回滚
    5 需要提权（仅显式机器级安装）
#>
[CmdletBinding()]
param(
  [string]$Source = "",
  [string]$InstallDir = "",
  [string]$ServerUrl = "",
  [string]$Checksum = "",
  [switch]$NoAutostart,
  [switch]$NoLaunch,
  [switch]$Quiet,
  [switch]$Uninstall,
  [switch]$PurgeData
)

$ErrorActionPreference = 'Stop'

$AppName = 'Trellis Board'
$ExeName = 'trellis-board-client.exe'
$ProcessName = 'trellis-board-client'
$RunValueName = 'TrellisBoardClient'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$ProtocolScheme = 'trellisboard'
$ProtocolKey = "HKCU:\Software\Classes\$ProtocolScheme"
$script:FailureCode = 1

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

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-BoardUrl {
  param([string]$Value)
  $uri = $null
  if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri)) {
    Fail 1 "服务端地址不是合法 URL: $Value"
  }
  if ($uri.Scheme -eq 'https' -and $uri.AbsolutePath -eq '/') {
    return $uri.GetLeftPart([UriPartial]::Authority)
  }
  if ($uri.Scheme -eq 'http' -and @('localhost', '127.0.0.1') -contains $uri.Host -and $uri.AbsolutePath -eq '/') {
    return $uri.GetLeftPart([UriPartial]::Authority)
  }
  Fail 1 "服务端地址必须使用 HTTPS；仅 localhost/127.0.0.1 允许 HTTP 根地址"
}

function Get-ExpectedHash {
  param([string]$File, [string]$Explicit)
  if ($Explicit) {
    if ($Explicit -notmatch '^[0-9A-Fa-f]{64}$') {
      Fail 2 "SHA256 参数格式无效"
    }
    return $Explicit.ToLowerInvariant()
  }
  $manifest = Join-Path (Split-Path -Parent $File) 'SHA256SUMS.txt'
  if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
    Fail 2 "缺少 SHA256SUMS.txt（可用 -Checksum 显式提供）"
  }
  $name = Split-Path -Leaf $File
  foreach ($line in Get-Content -LiteralPath $manifest) {
    if ($line -match '^\s*([0-9A-Fa-f]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -eq $name) {
      return $Matches[1].ToLowerInvariant()
    }
  }
  Fail 2 "SHA256SUMS.txt 中没有 $name 的校验值"
}

function New-Shortcut {
  param(
    [string]$ShortcutPath,
    [string]$TargetPath,
    [string]$Arguments,
    [string]$WorkingDirectory
  )
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $TargetPath
  $shortcut.Arguments = $Arguments
  $shortcut.WorkingDirectory = $WorkingDirectory
  $shortcut.IconLocation = "$TargetPath,0"
  $shortcut.Description = $AppName
  $shortcut.Save()
}

if ($Uninstall) {
  $uninstallScript = Join-Path $PSScriptRoot 'uninstall.ps1'
  if (-not (Test-Path -LiteralPath $uninstallScript -PathType Leaf)) {
    Fail 1 "缺少卸载脚本: $uninstallScript"
  }
  $uninstallArgs = @('-File', $uninstallScript, '-InstallDir', $InstallDir)
  if ($PurgeData) { $uninstallArgs += '-PurgeData' }
  if ($Quiet) { $uninstallArgs += '-Quiet' }
  & powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass @uninstallArgs
  exit $LASTEXITCODE
}

if (-not $InstallDir) {
  $InstallDir = Join-Path $env:LOCALAPPDATA 'TrellisBoard'
}
if ([IO.Path]::IsPathRooted($InstallDir) -eq $false) {
  Fail 1 "安装目录必须是绝对路径: $InstallDir"
}

if (-not $Source) {
  $Source = Join-Path $PSScriptRoot $ExeName
} elseif (Test-Path -LiteralPath $Source -PathType Container) {
  $Source = Join-Path $Source $ExeName
}
if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
  Fail 1 "客户端可执行文件不存在: $Source"
}
$Source = (Resolve-Path -LiteralPath $Source).Path

if ($Env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
  Fail 1 "仅支持 Windows x64，当前架构: $Env:PROCESSOR_ARCHITECTURE"
}

$sourceDirectory = Split-Path -Parent $Source
$sidecarSource = @(
  (Join-Path $sourceDirectory 'trellis-agent.exe'),
  (Join-Path $sourceDirectory 'trellis-agent-x86_64-pc-windows-msvc.exe')
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

$expectedHash = Get-ExpectedHash -File $Source -Explicit $Checksum
$actualHash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash) {
  Fail 2 "SHA256 校验失败：期望 $expectedHash，实际 $actualHash；未写入任何文件"
}

$boardUrl = $null
if ($ServerUrl) {
  $boardUrl = Assert-BoardUrl $ServerUrl
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$InstallDir = (Resolve-Path -LiteralPath $InstallDir).Path
$targetExe = Join-Path $InstallDir $ExeName
$dataDir = Join-Path $InstallDir 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

$stagingDir = Join-Path $InstallDir ('.staging-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
$stagedExe = Join-Path $stagingDir $ExeName
$backupExe = Join-Path $stagingDir "$ExeName.previous"
$stagedSidecar = Join-Path $stagingDir 'trellis-agent.exe'
$backupSidecar = Join-Path $stagingDir 'trellis-agent.exe.previous'
$targetSidecar = Join-Path $InstallDir 'trellis-agent.exe'
$createdShortcuts = New-Object System.Collections.Generic.List[string]
$wroteRunValue = $false
$wroteProtocol = $false
$installedNewExe = $false
$installedNewSidecar = $false
$stage = 'files'

try {
  Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 300

  Copy-Item -LiteralPath $Source -Destination $stagedExe -Force
  if (Test-Path -LiteralPath $targetExe -PathType Leaf) {
    Copy-Item -LiteralPath $targetExe -Destination $backupExe -Force
  }
  Move-Item -LiteralPath $stagedExe -Destination $targetExe -Force
  $installedNewExe = $true

  if ($sidecarSource) {
    Copy-Item -LiteralPath $sidecarSource -Destination $stagedSidecar -Force
    if (Test-Path -LiteralPath $targetSidecar -PathType Leaf) {
      Copy-Item -LiteralPath $targetSidecar -Destination $backupSidecar -Force
    }
    Move-Item -LiteralPath $stagedSidecar -Destination $targetSidecar -Force
    $installedNewSidecar = $true
  } else {
    Write-Warning "未找到 trellis-agent.exe；客户端可启动，但后台同步不可用"
  }
  $stage = 'shortcuts'

  $startMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  $desktopDir = [Environment]::GetFolderPath('Desktop')
  $startMenuShortcut = Join-Path $startMenuDir "$AppName.lnk"
  $desktopShortcut = Join-Path $desktopDir "$AppName.lnk"
  if (Test-Path -LiteralPath $startMenuDir -PathType Container) {
    New-Shortcut -ShortcutPath $startMenuShortcut -TargetPath $targetExe -Arguments '' -WorkingDirectory $InstallDir
    $createdShortcuts.Add($startMenuShortcut)
  }
  if (Test-Path -LiteralPath $desktopDir -PathType Container) {
    New-Shortcut -ShortcutPath $desktopShortcut -TargetPath $targetExe -Arguments '' -WorkingDirectory $InstallDir
    $createdShortcuts.Add($desktopShortcut)
  }

  if (-not $NoAutostart) {
    New-Item -Path $RunKey -Force | Out-Null
    $current = (Get-ItemProperty -Path $RunKey -Name $RunValueName -ErrorAction SilentlyContinue).$RunValueName
    Set-ItemProperty -Path $RunKey -Name $RunValueName -Value ('"' + $targetExe + '" --minimized')
    $wroteRunValue = $true
    if ($current) {
      Write-Info "已更新开机自启：$targetExe --minimized"
    } else {
      Write-Info "已注册开机自启：$targetExe --minimized"
    }
  } else {
    Remove-ItemProperty -Path $RunKey -Name $RunValueName -ErrorAction SilentlyContinue
    Write-Info "已跳过开机自启"
  }

  # 注册 trellisboard:// 深链，供浏览器登录后把一次性设备令牌交给客户端。
  $protocolCommandKey = Join-Path $ProtocolKey 'shell\open\command'
  New-Item -Path $protocolCommandKey -Force | Out-Null
  Set-ItemProperty -Path $ProtocolKey -Name '(default)' -Value "URL:$AppName device enrollment"
  Set-ItemProperty -Path $ProtocolKey -Name 'URL Protocol' -Value ''
  Set-ItemProperty -Path $protocolCommandKey -Name '(default)' -Value ('"' + $targetExe + '" "%1"')
  $wroteProtocol = $true
  Write-Info "已注册 deep link 协议：$ProtocolScheme`:"

  $configPath = Join-Path $dataDir 'client.json'
  if ($boardUrl) {
    $config = [ordered]@{
      schemaVersion = 1
      serverUrl = $boardUrl
    }
    $config | ConvertTo-Json -Compress | Set-Content -LiteralPath $configPath -Encoding utf8
    Write-Info "已写入服务端地址：$boardUrl"
  } elseif (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Write-Info "未指定 -ServerUrl；首次启动后请用 -ServerUrl 重新安装或手工写入 $configPath"
  }

  if (-not $NoLaunch) {
    Start-Process -FilePath $targetExe | Out-Null
    Write-Info "已启动 $AppName"
  }

  $versionInfo = (Get-Item -LiteralPath $targetExe).VersionInfo.ProductVersion
  Write-Info "安装完成：$targetExe"
  if ($versionInfo) {
    Write-Info "客户端版本：$versionInfo"
  }
  Write-Output "installed=$targetExe"
  $script:FailureCode = 0
} catch {
  $script:FailureCode = if ($stage -eq 'shortcuts') { 4 } else { 3 }
  foreach ($shortcut in $createdShortcuts) {
    Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue
  }
  if ($wroteRunValue) {
    Remove-ItemProperty -Path $RunKey -Name $RunValueName -ErrorAction SilentlyContinue
  }
  if ($wroteProtocol) {
    Remove-Item -LiteralPath $ProtocolKey -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($installedNewSidecar) {
    if (Test-Path -LiteralPath $backupSidecar -PathType Leaf) {
      Copy-Item -LiteralPath $backupSidecar -Destination $targetSidecar -Force -ErrorAction SilentlyContinue
    } else {
      Remove-Item -LiteralPath $targetSidecar -Force -ErrorAction SilentlyContinue
    }
  }
  if ($installedNewExe) {
    if (Test-Path -LiteralPath $backupExe -PathType Leaf) {
      Copy-Item -LiteralPath $backupExe -Destination $targetExe -Force -ErrorAction SilentlyContinue
    } else {
      Remove-Item -LiteralPath $targetExe -Force -ErrorAction SilentlyContinue
    }
  }
  Write-Error "安装失败并已回滚：$($_.Exception.Message)" -ErrorAction Continue
} finally {
  if (Test-Path -LiteralPath $stagingDir) {
    Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

exit $script:FailureCode
