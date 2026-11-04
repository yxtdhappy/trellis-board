param(
  [string]$NodeExecutable = "",
  [string]$OutputDirectory = "",
  [string]$Version = ""
)

$ErrorActionPreference = 'Stop'

if (-not $NodeExecutable) {
  $NodeExecutable = (Get-Command node -ErrorAction Stop).Source
}
if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
  throw "Node executable not found: $NodeExecutable"
}
$NodeExecutable = (Resolve-Path -LiteralPath $NodeExecutable).Path

$nodeVersion = (& $NodeExecutable -p 'process.versions.node').Trim()
$nodeArch = (& $NodeExecutable -p 'process.arch').Trim()
if ($nodeVersion -notmatch '^24\.') {
  throw "Agent package requires Node 24, got $nodeVersion"
}
if ($nodeArch -ne 'x64') {
  throw "Agent package requires Windows x64, got $nodeArch"
}

if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) 'dist'
}
if (-not $Version) {
  $packageJson = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'package.json') -Raw |
    ConvertFrom-Json
  $Version = [string]$packageJson.version
}
if ($Version -notmatch '^[0-9A-Za-z._-]+$') {
  throw "Invalid package version: $Version"
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path
$packageName = "trellis-board-agent-win-x64-$Version"
$zipPath = Join-Path $OutputDirectory "$packageName.zip"
$stageRoot = Join-Path ([IO.Path]::GetTempPath()) ("trellis-agent-package-" + [Guid]::NewGuid())
$stage = Join-Path $stageRoot $packageName

try {
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  $agentFiles = @(
    'api.js',
    'cli.js',
    'config-store.js',
    'credential-store.js',
    'git-sync.js',
    'index.js',
    'lock.js',
    'logger.js',
    'process.js',
    'protocol.js',
    'README.md',
    'trellis-agent.cmd'
  )
  foreach ($name in $agentFiles) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $stage
  }
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows') -Destination $stage -Recurse
  Copy-Item -LiteralPath $NodeExecutable -Destination (Join-Path $stage 'node.exe')

  $nodeLicense = Join-Path (Split-Path -Parent $NodeExecutable) 'LICENSE'
  if (Test-Path -LiteralPath $nodeLicense -PathType Leaf) {
    Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $stage 'NODE-LICENSE.txt')
  }

  @(
    "package=$packageName"
    "boardVersion=$Version"
    "nodeVersion=$nodeVersion"
    "nodeArch=$nodeArch"
  ) | Set-Content -LiteralPath (Join-Path $stage 'VERSION.txt') -Encoding utf8

  $hashLines = Get-ChildItem -LiteralPath $stage -Recurse -File |
    Sort-Object FullName |
    ForEach-Object {
      $relative = [IO.Path]::GetRelativePath($stage, $_.FullName).Replace('\', '/')
      $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      "$hash  $relative"
    }
  $hashLines | Set-Content -LiteralPath (Join-Path $stage 'SHA256SUMS.txt') -Encoding ascii

  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath
  }
  Compress-Archive -LiteralPath $stage -DestinationPath $zipPath -CompressionLevel Optimal
  Write-Output $zipPath
} finally {
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $resolvedStageRoot = [IO.Path]::GetFullPath($stageRoot)
  if (
    $resolvedStageRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
    ([IO.Path]::GetFileName($resolvedStageRoot) -like 'trellis-agent-package-*') -and
    (Test-Path -LiteralPath $resolvedStageRoot)
  ) {
    Remove-Item -LiteralPath $stageRoot -Recurse
  }
}
