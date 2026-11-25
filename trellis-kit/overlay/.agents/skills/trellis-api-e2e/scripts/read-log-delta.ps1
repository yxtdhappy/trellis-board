[CmdletBinding(DefaultParameterSetName = 'Read')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Marker')]
    [Parameter(Mandatory, ParameterSetName = 'Read')]
    [string]$Path,

    [Parameter(Mandatory, ParameterSetName = 'Marker')]
    [switch]$Marker,

    [Parameter(Mandatory, ParameterSetName = 'Read')]
    [ValidateRange(0, [long]::MaxValue)]
    [long]$From,

    [Parameter(ParameterSetName = 'Read')]
    [string]$Filter,

    [Parameter(ParameterSetName = 'Read')]
    [ValidateRange(1, 100000)]
    [int]$MaxLines = 500,

    [Parameter(ParameterSetName = 'Marker')]
    [Parameter(ParameterSetName = 'Read')]
    [string]$Encoding = 'utf8'
)

$ErrorActionPreference = 'Stop'

$resolvedPath = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).ProviderPath
$file = Get-Item -LiteralPath $resolvedPath -ErrorAction Stop
if ($file.PSIsContainer) {
    throw "日志路径不是文件：$resolvedPath"
}

if ($Marker) {
    [long]$file.Length
    return
}

$encodingName = switch ($Encoding.Trim().ToLowerInvariant()) {
    'utf8' { 65001 }
    'utf-8' { 65001 }
    'gbk' { 936 }
    'gb2312' { 936 }
    'gb18030' { 54936 }
    default { $Encoding.Trim() }
}

try {
    $textEncoding = [System.Text.Encoding]::GetEncoding($encodingName)
}
catch {
    throw "不支持的日志编码：$Encoding"
}

$offset = $From
if ($file.Length -lt $offset) {
    Write-Warning "日志已轮转（当前 $($file.Length) 字节 < 偏移 $offset），从文件头重新读取"
    $offset = 0
}

$share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
$stream = [System.IO.File]::Open(
    $resolvedPath,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    $share
)
try {
    if ($offset -gt 0) {
        [void]$stream.Seek($offset, [System.IO.SeekOrigin]::Begin)
    }
    $reader = [System.IO.StreamReader]::new($stream, $textEncoding, $true)
    try {
        $text = $reader.ReadToEnd()
    }
    finally {
        $reader.Dispose()
    }
}
finally {
    $stream.Dispose()
}

if ([string]::IsNullOrEmpty($text)) {
    return
}

$lines = @($text -split "\r?\n")
if ($lines.Count -gt 0 -and $lines[-1] -eq '') {
    $lines = @($lines | Select-Object -SkipLast 1)
}

if (-not [string]::IsNullOrWhiteSpace($Filter)) {
    $lines = @($lines | Where-Object { $_ -match $Filter })
}

if ($lines.Count -gt $MaxLines) {
    Write-Warning "增量共 $($lines.Count) 行，仅输出最后 $MaxLines 行；缩小范围可设置更精确的 -Filter"
    $lines = @($lines | Select-Object -Last $MaxLines)
}

$lines
