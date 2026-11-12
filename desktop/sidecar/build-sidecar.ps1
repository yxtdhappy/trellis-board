param(
  [string]$NodeExecutable = "",
  [string]$OutputDirectory = "",
  [string]$Version = "",
  [string]$StageDirectory = "",
  [string]$ResourcesDirectory = ""
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

$sidecarRoot = $PSScriptRoot
$desktopRoot = Split-Path -Parent $sidecarRoot
$repoRoot = Split-Path -Parent $desktopRoot

if (-not $NodeExecutable) {
  $NodeExecutable = (Get-Command node -ErrorAction Stop).Source
}
if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
  Fail 1 "Node executable not found: $NodeExecutable"
}
$NodeExecutable = (Resolve-Path -LiteralPath $NodeExecutable).Path

$nodeVersion = (& $NodeExecutable -p 'process.versions.node').Trim()
$nodeArch = (& $NodeExecutable -p 'process.arch').Trim()
if ($nodeVersion -notmatch '^24\.') {
  Fail 2 "Sidecar packaging requires Node 24, got $nodeVersion"
}
if ($nodeArch -ne 'x64') {
  Fail 2 "Sidecar packaging requires x64 Node, got $nodeArch"
}

$requiredFiles = @(
  (Join-Path $sidecarRoot 'cli.js'),
  (Join-Path $sidecarRoot 'sea-entry.js'),
  (Join-Path $sidecarRoot 'main.js'),
  (Join-Path $sidecarRoot 'desktop-device.js'),
  (Join-Path $sidecarRoot 'desktop-association.js'),
  (Join-Path $sidecarRoot 'parent-watchdog.js'),
  (Join-Path $sidecarRoot 'trellis-runtime.js'),
  (Join-Path $sidecarRoot 'bundle.mjs'),
  (Join-Path $repoRoot 'agent\index.js'),
  (Join-Path $repoRoot 'agent\task-snapshot-sync.js'),
  (Join-Path $repoRoot 'agent\task-command.js'),
  (Join-Path $repoRoot 'agent\project-onboarding.js'),
  (Join-Path $repoRoot 'agent\git-sync.js'),
  (Join-Path $repoRoot 'agent\api.js'),
  (Join-Path $repoRoot 'agent\credential-store.js'),
  (Join-Path $repoRoot 'agent\windows\dpapi.ps1'),
  (Join-Path $repoRoot 'shared\trellis-watcher.js'),
  (Join-Path $repoRoot 'shared\task-snapshot.js'),
  (Join-Path $repoRoot 'shared\slug.js'),
  (Join-Path $repoRoot 'shared\trellis-agent-tools.js'),
  (Join-Path $repoRoot 'package.json')
)
foreach ($file in $requiredFiles) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    Fail 1 "Required file missing: $file"
  }
}

if (-not $Version) {
  $packageJson = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
  $Version = [string]$packageJson.version
}
if ($Version -notmatch '^[0-9A-Za-z._-]+$') {
  Fail 1 "Invalid package version: $Version"
}

$esbuild = Join-Path $desktopRoot 'node_modules\esbuild\package.json'
$postjectCli = Join-Path $desktopRoot 'node_modules\postject\dist\cli.js'
if (-not (Test-Path -LiteralPath $esbuild -PathType Leaf)) {
  Fail 3 "esbuild is not installed. Run: npm --prefix `"$desktopRoot`" install"
}
if (-not (Test-Path -LiteralPath $postjectCli -PathType Leaf)) {
  Fail 3 "postject is not installed. Run: npm --prefix `"$desktopRoot`" install"
}

if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $desktopRoot 'src-tauri\binaries'
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path

if (-not $StageDirectory) {
  $StageDirectory = Join-Path ([IO.Path]::GetTempPath()) ('trellis-sidecar-build-' + [Guid]::NewGuid())
}
New-Item -ItemType Directory -Path $StageDirectory -Force | Out-Null
$StageDirectory = (Resolve-Path -LiteralPath $StageDirectory).Path
$buildDirectory = Join-Path $StageDirectory 'build'
New-Item -ItemType Directory -Path $buildDirectory -Force | Out-Null
$runtimeStage = Join-Path $StageDirectory 'trellis-runtime'

if (-not $ResourcesDirectory) {
  $ResourcesDirectory = Join-Path $desktopRoot 'src-tauri\resources'
}
New-Item -ItemType Directory -Path $ResourcesDirectory -Force | Out-Null
$ResourcesDirectory = (Resolve-Path -LiteralPath $ResourcesDirectory).Path
$runtimeTarget = Join-Path $ResourcesDirectory 'trellis-runtime'

$rootNodeModules = Join-Path $repoRoot 'node_modules'
$trellisCli = Join-Path $rootNodeModules '@mindfoldhq\trellis\bin\trellis.js'
if (-not (Test-Path -LiteralPath $trellisCli -PathType Leaf)) {
  Fail 1 "Bundled Trellis CLI is missing: $trellisCli. Run npm install in the repository root."
}
$trellisPackage = Get-Content -LiteralPath (Join-Path $rootNodeModules '@mindfoldhq\trellis\package.json') -Raw |
  ConvertFrom-Json
$trellisVersion = [string]$trellisPackage.version

$bundleFile = Join-Path $buildDirectory 'trellis-agent.cjs'
$blobFile = Join-Path $buildDirectory 'sea-prep.blob'
$seaConfigFile = Join-Path $buildDirectory 'sea-config.json'
$stagedExe = Join-Path $StageDirectory 'trellis-agent.exe'
$binaryName = 'trellis-agent-x86_64-pc-windows-msvc.exe'
$targetExe = Join-Path $OutputDirectory $binaryName
$exitCode = 0

try {
  $bundleArguments = @(
    (Join-Path $sidecarRoot 'bundle.mjs'),
    '--bundle', $bundleFile,
    '--blob', $blobFile,
    '--sea-config', $seaConfigFile
  )
  & $NodeExecutable @bundleArguments
  if ($LASTEXITCODE -ne 0) {
    Fail 4 "Sidecar bundle failed with exit code $LASTEXITCODE"
  }
  if (-not (Test-Path -LiteralPath $bundleFile -PathType Leaf)) {
    Fail 4 "Sidecar bundle was not written: $bundleFile"
  }

  & $NodeExecutable --experimental-sea-config $seaConfigFile
  if ($LASTEXITCODE -ne 0) {
    Fail 5 "SEA blob generation failed with exit code $LASTEXITCODE"
  }
  if (-not (Test-Path -LiteralPath $blobFile -PathType Leaf)) {
    Fail 5 "SEA blob was not written: $blobFile"
  }

  Copy-Item -LiteralPath $NodeExecutable -Destination $stagedExe
  $postjectArguments = @(
    $postjectCli,
    $stagedExe,
    'NODE_SEA_BLOB', $blobFile,
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
  )
  & $NodeExecutable @postjectArguments
  if ($LASTEXITCODE -ne 0) {
    Fail 6 "postject injection failed with exit code $LASTEXITCODE"
  }

  Copy-Item -LiteralPath $stagedExe -Destination $targetExe -Force
  if (-not (Test-Path -LiteralPath $targetExe -PathType Leaf)) {
    Fail 7 "Sidecar executable was not copied: $targetExe"
  }

  New-Item -ItemType Directory -Path $runtimeStage -Force | Out-Null
  Copy-Item -LiteralPath $NodeExecutable -Destination (Join-Path $runtimeStage 'node.exe')
  Copy-Item -LiteralPath $rootNodeModules -Destination (Join-Path $runtimeStage 'node_modules') -Recurse
  $stagedCli = Join-Path $runtimeStage 'node_modules\@mindfoldhq\trellis\bin\trellis.js'
  if (-not (Test-Path -LiteralPath $stagedCli -PathType Leaf)) {
    Fail 7 "Bundled Trellis CLI was not staged: $stagedCli"
  }

  $protocolVersion = '3'
  $protocolMatch = Select-String -LiteralPath (Join-Path $repoRoot 'agent\protocol.js') `
    -Pattern 'AGENT_PROTOCOL_VERSION\s*=\s*([0-9]+)' | Select-Object -First 1
  if ($protocolMatch) {
    $protocolVersion = $protocolMatch.Matches[0].Groups[1].Value
  }

  @(
    "package=trellis-agent-sidecar"
    "boardVersion=$Version"
    "protocolVersion=$protocolVersion"
    "nodeVersion=$nodeVersion"
    "nodeArch=$nodeArch"
  ) | Set-Content -LiteralPath (Join-Path $OutputDirectory 'VERSION.txt') -Encoding utf8

  @(
    "package=trellis-runtime"
    "trellisVersion=$trellisVersion"
    "nodeVersion=$nodeVersion"
    "nodeArch=$nodeArch"
  ) | Set-Content -LiteralPath (Join-Path $runtimeStage 'VERSION.txt') -Encoding utf8

  $resolvedResources = [IO.Path]::GetFullPath($ResourcesDirectory)
  $resolvedTarget = [IO.Path]::GetFullPath($runtimeTarget)
  if (
    -not $resolvedTarget.StartsWith(
      $resolvedResources + [IO.Path]::DirectorySeparatorChar,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    ([IO.Path]::GetFileName($resolvedTarget) -ne 'trellis-runtime')
  ) {
    Fail 7 "Refusing to replace unexpected runtime directory: $resolvedTarget"
  }
  if (Test-Path -LiteralPath $runtimeTarget) {
    Remove-Item -LiteralPath $runtimeTarget -Recurse
  }
  Copy-Item -LiteralPath $runtimeStage -Destination $runtimeTarget -Recurse

  $hash = (Get-FileHash -LiteralPath $targetExe -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash  $binaryName" | Set-Content -LiteralPath (Join-Path $OutputDirectory 'SHA256SUMS.txt') -Encoding ascii

  Write-Output $targetExe
} catch {
  $exitCode = $script:FailureCode
  [Console]::Error.WriteLine($_.Exception.Message)
} finally {
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $resolvedStage = [IO.Path]::GetFullPath($StageDirectory)
  if (
    $resolvedStage.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
    ([IO.Path]::GetFileName($resolvedStage) -like 'trellis-sidecar-build-*') -and
    (Test-Path -LiteralPath $resolvedStage)
  ) {
    Remove-Item -LiteralPath $resolvedStage -Recurse
  }
}

exit $exitCode
