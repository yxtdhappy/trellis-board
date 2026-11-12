#Requires -Version 5.1
<#
.SYNOPSIS
  组装 Trellis Board Windows x64 绿色 ZIP 包。

.DESCRIPTION
  复用 tauri build 生成的客户端 EXE、sidecar 和固定 Trellis runtime，
  生成解压后可直接运行的目录、校验文件和使用说明。

  退出码：
    0 成功
    1 参数或输入文件错误
    2 版本信息错误
    3 组装、压缩或替换产物失败
#>
[CmdletBinding()]
param(
  [string]$ReleaseDirectory = "",
  [string]$SidecarPath = "",
  [string]$RuntimeDirectory = "",
  [string]$VersionFile = "",
  [string]$OutputDirectory = ""
)

$ErrorActionPreference = 'Stop'
$script:FailureCode = 1

trap {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit $script:FailureCode
}

function Fail {
  param([int]$Code, [string]$Message)
  $script:FailureCode = $Code
  throw $Message
}

function Get-FullPath {
  param([string]$Path)
  return [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Test-PathWithin {
  param(
    [string]$Path,
    [string]$Root
  )
  if ([string]::Equals($Path, $Root, [StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }
  $rootPrefix = $Root + [IO.Path]::DirectorySeparatorChar
  return $Path.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)
}

$desktopRoot = $PSScriptRoot

if (-not $ReleaseDirectory) {
  $ReleaseDirectory = Join-Path $desktopRoot 'src-tauri\target\release'
}
if (-not $SidecarPath) {
  $SidecarPath = Join-Path $desktopRoot 'src-tauri\binaries\trellis-agent-x86_64-pc-windows-msvc.exe'
}
if (-not $RuntimeDirectory) {
  $RuntimeDirectory = Join-Path $desktopRoot 'src-tauri\resources\trellis-runtime'
}
if (-not $VersionFile) {
  $VersionFile = Join-Path $desktopRoot 'src-tauri\binaries\VERSION.txt'
}
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $desktopRoot 'src-tauri\target\release\bundle\portable'
}

$ReleaseDirectory = Get-FullPath $ReleaseDirectory
$clientExe = Join-Path $ReleaseDirectory 'trellis-board-client.exe'
if (-not (Test-Path -LiteralPath $clientExe -PathType Leaf)) {
  Fail 1 "客户端可执行文件不存在: $clientExe"
}

$SidecarPath = Get-FullPath $SidecarPath
if (-not (Test-Path -LiteralPath $SidecarPath -PathType Leaf)) {
  Fail 1 "sidecar 不存在: $SidecarPath"
}

$RuntimeDirectory = Get-FullPath $RuntimeDirectory
foreach ($required in @('node.exe', 'node_modules\@mindfoldhq\trellis\bin\trellis.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $RuntimeDirectory $required) -PathType Leaf)) {
    Fail 1 "Trellis runtime 缺少文件: $(Join-Path $RuntimeDirectory $required)"
  }
}

$VersionFile = Get-FullPath $VersionFile
if (-not (Test-Path -LiteralPath $VersionFile -PathType Leaf)) {
  Fail 2 "版本文件不存在: $VersionFile"
}
$versionLine = Get-Content -LiteralPath $VersionFile |
  Where-Object { $_ -like 'boardVersion=*' } |
  Select-Object -First 1
if (-not $versionLine) {
  Fail 2 "版本文件缺少 boardVersion: $VersionFile"
}
$version = $versionLine.Substring('boardVersion='.Length).Trim()
if ($version -notmatch '^[0-9A-Za-z._-]+$') {
  Fail 2 "版本号格式无效: $version"
}

$controlledOutput = Get-FullPath (Join-Path $ReleaseDirectory 'bundle\portable')
$OutputDirectory = Get-FullPath $OutputDirectory
if (-not (Test-PathWithin -Path $OutputDirectory -Root $controlledOutput)) {
  Fail 1 "输出目录必须位于 $controlledOutput 内"
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

$packageName = "TrellisBoard_${version}_x64-portable"
$packageDirectory = Join-Path $OutputDirectory $packageName
$zipPath = Join-Path $OutputDirectory "$packageName.zip"
$zipChecksumPath = "$zipPath.sha256"
$stageRoot = Join-Path $OutputDirectory ('.staging-' + [Guid]::NewGuid().ToString('N'))
$stagedPackage = Join-Path $stageRoot $packageName
$stagedZip = Join-Path $stageRoot "$packageName.zip"

New-Item -ItemType Directory -Path $stagedPackage -Force | Out-Null

try {
  Copy-Item -LiteralPath $clientExe -Destination (Join-Path $stagedPackage 'trellis-board-client.exe')
  Copy-Item -LiteralPath $SidecarPath -Destination (Join-Path $stagedPackage 'trellis-agent.exe')
  Copy-Item -LiteralPath $RuntimeDirectory -Destination (Join-Path $stagedPackage 'trellis-runtime') -Recurse
  Copy-Item -LiteralPath $VersionFile -Destination (Join-Path $stagedPackage 'VERSION.txt')

  $instructions = @(
    "Trellis Board $version Windows x64 绿色版"
    ''
    '运行条件'
    '- Windows 10/11 x64。'
    '- 电脑必须已安装 Microsoft Edge WebView2 Evergreen Runtime。Windows 11 默认预装；'
    '- 目标 Windows 10 镜像如缺失该运行时，请先联系 IT 安装。'
    ''
    '启动'
    '- 解压整个目录后，双击 trellis-board-client.exe。'
    '- 不需要运行安装程序，不需要管理员权限。'
    '- 本绿色版不会创建桌面/开始菜单快捷方式，也不会自动设置开机自启。'
    ''
    '数据和升级'
    '- 登录配置、设备凭证、日志和同步数据保存在 %LOCALAPPDATA%\TrellisBoard\data。'
    '- 升级前先退出托盘客户端，确认 trellis-agent.exe 已停止，再用新版解压目录替换程序文件。'
    '- 移动程序目录不会迁移用户数据。'
    ''
    '清理'
    '- 删除本程序目录即可移除程序。'
    '- 如不再使用，可额外删除 %LOCALAPPDATA%\TrellisBoard 以清除本地数据。'
  )
  Set-Content -LiteralPath (Join-Path $stagedPackage '使用说明.txt') `
    -Value $instructions -Encoding UTF8

  $checksumTargets = @(
    'trellis-board-client.exe',
    'trellis-agent.exe',
    'trellis-runtime/node.exe',
    'VERSION.txt'
  )
  $checksumLines = foreach ($relative in $checksumTargets) {
    $nativePath = Join-Path $stagedPackage ($relative.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $nativePath -PathType Leaf)) {
      Fail 3 "绿色包缺少文件: $relative"
    }
    $hash = (Get-FileHash -LiteralPath $nativePath -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $relative"
  }
  Set-Content -LiteralPath (Join-Path $stagedPackage 'SHA256SUMS.txt') `
    -Value $checksumLines -Encoding Ascii

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zipArchive = [System.IO.Compression.ZipFile]::Open(
    $stagedZip,
    [System.IO.Compression.ZipArchiveMode]::Create
  )
  try {
    $packagePrefix = $stagedPackage.TrimEnd('\') + '\'
    foreach ($file in Get-ChildItem -LiteralPath $stagedPackage -Recurse -File -Force) {
      $entryName = $packageName + '/' +
        $file.FullName.Substring($packagePrefix.Length).Replace('\', '/')
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zipArchive,
        $file.FullName,
        $entryName,
        [System.IO.Compression.CompressionLevel]::Optimal
      ) | Out-Null
    }
  } finally {
    $zipArchive.Dispose()
  }

  if (Test-Path -LiteralPath $packageDirectory) {
    Remove-Item -LiteralPath $packageDirectory -Recurse
  }
  Move-Item -LiteralPath $stagedPackage -Destination $packageDirectory

  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath
  }
  Move-Item -LiteralPath $stagedZip -Destination $zipPath

  $zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  "$zipHash  $packageName.zip" |
    Set-Content -LiteralPath $zipChecksumPath -Encoding Ascii

  Write-Output "portableDirectory=$packageDirectory"
  Write-Output "portableZip=$zipPath"
  Write-Output "portableZipSha256=$zipChecksumPath"
} catch {
  $script:FailureCode = if ($script:FailureCode -eq 1) { 3 } else { $script:FailureCode }
  throw
} finally {
  $resolvedStage = Get-FullPath $stageRoot
  if (
    (Test-Path -LiteralPath $resolvedStage) -and
    (Test-PathWithin -Path $resolvedStage -Root $OutputDirectory) -and
    ([IO.Path]::GetFileName($resolvedStage) -like '.staging-*')
  ) {
    Remove-Item -LiteralPath $resolvedStage -Recurse
  }
}

exit 0
