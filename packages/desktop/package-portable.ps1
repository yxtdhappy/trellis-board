#Requires -Version 5.1
<#
.SYNOPSIS
  组装 Trellis Board Windows x64 绿色 ZIP 包。

.DESCRIPTION
  只打包 `cargo tauri build` 产出的单个客户端 EXE，附加版本文件、SHA256 清单和使用说明。
  客户端不再携带 Node 运行时或 sidecar 可执行体。

  退出码：
    0 成功
    1 参数或输入文件错误
    2 版本信息错误
    3 组装、压缩或替换产物失败
#>
[CmdletBinding()]
param(
  [string]$ReleaseDirectory,
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$script:FailureCode = 1

trap {
  Write-Error $_
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
  $rootPath = Get-FullPath $Root
  if ([string]::Equals($Path, $rootPath, [StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }
  return $Path.StartsWith($rootPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

$desktopRoot = $PSScriptRoot

if (-not $ReleaseDirectory) {
  $ReleaseDirectory = Join-Path $desktopRoot 'src-tauri\target\release'
}
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $desktopRoot 'src-tauri\target\release\bundle\portable'
}

$ReleaseDirectory = Get-FullPath $ReleaseDirectory
$clientExe = Join-Path $ReleaseDirectory 'trellis-board-client.exe'
if (-not (Test-Path -LiteralPath $clientExe -PathType Leaf)) {
  Fail 1 "客户端可执行文件不存在: $clientExe"
}

$tauriConfigPath = Join-Path $desktopRoot 'src-tauri\tauri.conf.json'
if (-not (Test-Path -LiteralPath $tauriConfigPath -PathType Leaf)) {
  Fail 2 "tauri.conf.json 不存在: $tauriConfigPath"
}
$version = (Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json).version
if (-not $version -or $version -notmatch '^[0-9A-Za-z._-]+$') {
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
  "boardVersion=$version" |
    Set-Content -LiteralPath (Join-Path $stagedPackage 'VERSION.txt') -Encoding Ascii

  $instructions = @(
    "Trellis Board $version Windows x64 绿色版"
    ''
    '运行条件'
    '- Windows 10/11 x64。'
    '- 电脑必须已安装 Microsoft Edge WebView2 Evergreen Runtime。Windows 11 默认预装；'
    '- 目标 Windows 10 镜像如缺失该运行时，请先联系 IT 安装。'
    '- 首次启动需要能访问 npm 镜像下载 Node.js 与 Trellis CLI（仅在缺失时下载）。'
    ''
    '启动'
    '- 解压整个目录后，双击 trellis-board-client.exe。'
    '- 不需要运行安装程序，不需要管理员权限。'
    '- 本绿色版不会创建桌面/开始菜单快捷方式，也不会自动设置开机自启。'
    ''
    '数据和升级'
    '- 登录配置、设备凭证、日志、同步数据和运行时（Node.js/Trellis CLI）'
    '  保存在 %LOCALAPPDATA%\TrellisBoard\data。'
    '- 升级前先退出托盘客户端，再用新版解压目录替换程序文件。'
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
    'VERSION.txt'
  )
  $checksumLines = foreach ($relative in $checksumTargets) {
    $nativePath = Join-Path $stagedPackage $relative
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
