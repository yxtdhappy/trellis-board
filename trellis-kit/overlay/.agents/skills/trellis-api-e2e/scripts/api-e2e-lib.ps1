# 接口级 E2E 通用库（PowerShell 版）。用例脚本先 dot-source 本文件，再调用 Initialize-E2E。
#
# 必填环境变量：
#   E2E_BASE_URL       例：http://localhost:8855/mdp-backend-service
#   E2E_TOKEN_FILE     用户提供的测试 token 文件（推荐）；与 E2E_TOKEN 同时存在时优先使用本文件
#   E2E_TOKEN          仅作兼容：未设置 E2E_TOKEN_FILE 时直接放环境变量
# 可选环境变量：
#   E2E_AUTH_HEADER    默认 Weareint-Token
#   E2E_LOG_FILE       后端日志路径；不设则不做日志增量证据
#   E2E_EVIDENCE_FILE  证据文件；不设则只输出到控制台
#   E2E_LOG_GREP       日志增量过滤正则；默认 AccessLog|traceId|ERROR|WARN|Exception|Caused by
#   E2E_FAILURE_LOG_LINES 失败请求最多输出的日志行数；默认 200
#   E2E_SUCCESS_CODE   业务成功码；默认 20000（WIT Result）。非 WIT 项目需覆盖
#   E2E_FAILURE_PROPERTY 兼容旧用法：响应中判定业务失败的布尔字段；默认 ok
#   E2E_DELETE_TOKEN_FILE 设为 0 时 Clear-E2ESecret 保留 E2E_TOKEN_FILE；默认 1（仅删除本轮创建的文件）
#   E2E_TOKEN_FILE_CREATED 设为 1 表示 token 文件由本轮脚本创建，结束时才允许删除；默认 0
#   E2E_REQUIRE_JSON   设为 1 时，非 JSON 响应进入 failure delta；默认 0（模板默认 1）
#   E2E_REQUIRE_CODE   设为 1 时，响应缺少 code 进入 failure delta；默认 0（模板默认 1）
#   E2E_LIST_KEY       列表接口 data 下的数组键；默认 list
#   E2E_REDACT_KEYS_JSON 递归脱敏的精确键名 JSON 数组；默认 ["pwd","password","passwd","token","secret"]
#   E2E_REDACT_KEY_PATTERN 递归脱敏的键名正则；默认覆盖 pwd/passw/secret/token/cookie/authorization 等
#   E2E_PLACEHOLDER_PATTERN 未格式化占位符正则；默认 '\{[0-9]+\}|%[sd]'
#   E2E_CURL_TIMEOUT   HttpClient 总超时秒数；默认 60
#   E2E_CONNECT_TIMEOUT 连接超时秒数；默认 5

Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue

$script:E2E_AuthHeader = if ($env:E2E_AUTH_HEADER) { $env:E2E_AUTH_HEADER } else { 'Weareint-Token' }
$script:E2E_LogGrep = if ($env:E2E_LOG_GREP) { $env:E2E_LOG_GREP } else { 'AccessLog|traceId|ERROR|WARN|Exception|Caused by' }
$script:E2E_FailureLogLines = if ($env:E2E_FAILURE_LOG_LINES) { [int]$env:E2E_FAILURE_LOG_LINES } else { 200 }
$script:E2E_SuccessCode = if ($env:E2E_SUCCESS_CODE) { $env:E2E_SUCCESS_CODE } else { '20000' }
$script:E2E_FailureProperty = if ($env:E2E_FAILURE_PROPERTY) { $env:E2E_FAILURE_PROPERTY } else { 'ok' }
$script:E2E_ListKey = if ($env:E2E_LIST_KEY) { $env:E2E_LIST_KEY } else { 'list' }
$script:E2E_RedactKeys = @('pwd', 'password', 'passwd', 'token', 'secret')
$script:E2E_RedactPattern = if ($env:E2E_REDACT_KEY_PATTERN) { $env:E2E_REDACT_KEY_PATTERN } else { '(pwd|passw|secret|token|cookie|authorization|credential|privatekey|sessionid)' }
$script:E2E_RequireJson = $false
$script:E2E_RequireCode = $false
$script:E2E_PlaceholderPattern = if ($env:E2E_PLACEHOLDER_PATTERN) { $env:E2E_PLACEHOLDER_PATTERN } else { '\{[0-9]+\}|%[sd]' }
$script:E2E_TotalTimeout = if ($env:E2E_CURL_TIMEOUT) { [int]$env:E2E_CURL_TIMEOUT } else { 60 }
$script:E2E_ConnectTimeout = if ($env:E2E_CONNECT_TIMEOUT) { [int]$env:E2E_CONNECT_TIMEOUT } else { 5 }
$script:E2E_Pass = 0
$script:E2E_Fail = 0
$script:E2E_Token = $null

function Write-E2EEvidence {
    param([string]$Text)
    Write-Host $Text
    if ($script:E2E_EvidenceFile) {
        Add-Content -LiteralPath $script:E2E_EvidenceFile -Value $Text -Encoding UTF8
    }
}

function Initialize-E2E {
    if (-not $env:E2E_BASE_URL) { Write-Host 'Initialize-E2E: 缺少 E2E_BASE_URL' -ForegroundColor Red; return $false }
    $script:E2E_BaseUrl = $env:E2E_BASE_URL.TrimEnd('/')

    foreach ($name in @('E2E_DELETE_TOKEN_FILE', 'E2E_TOKEN_FILE_CREATED', 'E2E_REQUIRE_JSON', 'E2E_REQUIRE_CODE')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value -and $value -notin @('0', '1')) {
            Write-Host "Initialize-E2E: $name 必须是 0 或 1: $value" -ForegroundColor Red
            return $false
        }
    }
    $script:E2E_RequireJson = ([Environment]::GetEnvironmentVariable('E2E_REQUIRE_JSON') -eq '1')
    $script:E2E_RequireCode = ([Environment]::GetEnvironmentVariable('E2E_REQUIRE_CODE') -eq '1')
    try {
        $null = [regex]::new($script:E2E_RedactPattern)
    } catch {
        Write-Host "Initialize-E2E: E2E_REDACT_KEY_PATTERN 不是合法正则: $script:E2E_RedactPattern" -ForegroundColor Red
        return $false
    }

    if ($env:E2E_TOKEN_FILE) {
        if (-not (Test-Path -LiteralPath $env:E2E_TOKEN_FILE)) {
            Write-Host "Initialize-E2E: token 文件不存在: $env:E2E_TOKEN_FILE" -ForegroundColor Red; return $false
        }
        if ($env:E2E_TOKEN) {
            Write-Host 'Initialize-E2E: 警告: 同时设置了 E2E_TOKEN 与 E2E_TOKEN_FILE，按规则使用 E2E_TOKEN_FILE' -ForegroundColor Yellow
        }
        $script:E2E_Token = ([IO.File]::ReadAllText($env:E2E_TOKEN_FILE)).Trim().TrimStart([char]0xFEFF).Trim()
    } elseif ($env:E2E_TOKEN) {
        Write-Host 'Initialize-E2E: 警告: 使用 E2E_TOKEN 会把凭据留在命令行/环境记录中，建议改用 E2E_TOKEN_FILE' -ForegroundColor Yellow
        $script:E2E_Token = $env:E2E_TOKEN
    } else {
        Write-Host 'Initialize-E2E: 需要 E2E_TOKEN_FILE（推荐）或 E2E_TOKEN' -ForegroundColor Red; return $false
    }
    if ([string]::IsNullOrWhiteSpace($script:E2E_Token)) {
        Write-Host 'Initialize-E2E: token 为空或文件不可读' -ForegroundColor Red; return $false
    }
    if ($env:E2E_REDACT_KEYS_JSON) {
        try {
            $keys = $env:E2E_REDACT_KEYS_JSON | ConvertFrom-Json
            if ($keys -isnot [array]) { throw '必须是 JSON 数组' }
            $script:E2E_RedactKeys = @($keys | ForEach-Object {
                    if ($_ -isnot [string]) { throw '元素必须是字符串' }
                    ([string]$_).ToLowerInvariant()
                })
        } catch {
            Write-Host "Initialize-E2E: E2E_REDACT_KEYS_JSON 必须是字符串数组: $($env:E2E_REDACT_KEYS_JSON)" -ForegroundColor Red
            return $false
        }
    }

    $script:E2E_LogFile = $env:E2E_LOG_FILE
    if ($script:E2E_LogFile -and -not (Test-Path -LiteralPath $script:E2E_LogFile)) {
        Write-Host "Initialize-E2E: 日志文件不存在: $script:E2E_LogFile" -ForegroundColor Red; return $false
    }
    $script:E2E_EvidenceFile = $env:E2E_EVIDENCE_FILE
    if ($script:E2E_EvidenceFile) {
        $dir = Split-Path -Parent $script:E2E_EvidenceFile
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        [IO.File]::WriteAllText($script:E2E_EvidenceFile, '')
    }
    Write-E2EEvidence "==== API E2E $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') base=$script:E2E_BaseUrl ===="
    return $true
}

function Get-E2ELogOffset {
    if (-not $script:E2E_LogFile) { return $null }
    return (Get-Item -LiteralPath $script:E2E_LogFile).Length
}

function Read-E2ELogDelta {
    param($Offset, [switch]$Full)
    if ($null -eq $Offset -or -not $script:E2E_LogFile) { return '' }
    $path = $script:E2E_LogFile
    $length = (Get-Item -LiteralPath $path).Length
    if ($length -lt $Offset) { $Offset = 0 }
    $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        $stream.Seek([long]$Offset, [IO.SeekOrigin]::Begin) | Out-Null
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)
        $text = $reader.ReadToEnd()
    } finally {
        $stream.Dispose()
    }
    if ($Full) {
        $lines = @($text -split "`r?`n")
        if ($lines.Count -gt $script:E2E_FailureLogLines) {
            return (($lines | Select-Object -Last $script:E2E_FailureLogLines) -join "`n")
        }
        return $text
    }
    return (($text -split "`r?`n" | Where-Object { $_ -match $script:E2E_LogGrep }) -join "`n")
}

function Remove-E2ESensitiveField {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Collections.IDictionary]) {
        $copy = [ordered]@{}
        foreach ($key in @($Value.Keys)) {
            $name = ([string]$key).ToLowerInvariant()
            if ($script:E2E_RedactKeys -contains $name -or $name -match $script:E2E_RedactPattern) { continue }
            $copy[$key] = Remove-E2ESensitiveField -Value $Value[$key]
        }
        return $copy
    }
    if ($Value -is [pscustomobject]) {
        $copy = [ordered]@{}
        foreach ($property in $Value.PSObject.Properties) {
            $name = ([string]$property.Name).ToLowerInvariant()
            if ($script:E2E_RedactKeys -contains $name -or $name -match $script:E2E_RedactPattern) { continue }
            $copy[$property.Name] = Remove-E2ESensitiveField -Value $property.Value
        }
        return $copy
    }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
        $items = @($Value | ForEach-Object { Remove-E2ESensitiveField -Value $_ })
        return ,$items
    }
    return $Value
}

function ConvertTo-E2ESafeJson {
    param([string]$Body)
    if (-not $Body) { return '' }
    try {
        $obj = $Body | ConvertFrom-Json -AsHashtable -Depth 100
        $safe = Remove-E2ESensitiveField -Value $obj
        return ($safe | ConvertTo-Json -Compress -Depth 100)
    } catch {
        return '<unredacted: invalid json>'
    }
}

function ConvertTo-E2ESummary {
    param([string]$Content)
    if ([string]::IsNullOrWhiteSpace($Content)) { return '<empty>' }
    try {
        $obj = $Content | ConvertFrom-Json -AsHashtable -Depth 100
        $safe = Remove-E2ESensitiveField -Value $obj
        return ([ordered]@{
                code    = $safe['code']
                msgCode = $safe['msgCode']
                msg     = $safe['msg']
                ok      = $safe['ok']
                data    = $safe['data']
            } | ConvertTo-Json -Compress -Depth 100)
    } catch {
        return '<invalid json>'
    }
}

function Invoke-E2ERequest {
    param(
        [string]$Method,
        [string]$Path,
        [string]$Body = '',
        [string]$OutFile,
        [string]$BodyFile = ''
    )
    $before = Get-E2ELogOffset
    $status = 0
    $text = ''
    $failureMessage = ''
    $handler = [System.Net.Http.SocketsHttpHandler]::new()
    $handler.UseProxy = $false
    $handler.ConnectTimeout = [TimeSpan]::FromSeconds($script:E2E_ConnectTimeout)
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds($script:E2E_TotalTimeout)
    try {
        $request = [System.Net.Http.HttpRequestMessage]::new()
        $request.Method = [System.Net.Http.HttpMethod]::new($Method)
        $request.RequestUri = [Uri]($script:E2E_BaseUrl + $Path)
        $request.Headers.Add($script:E2E_AuthHeader, $script:E2E_Token)
        if ($Method -ne 'GET' -and $Method -ne 'HEAD') {
            if ($BodyFile) {
                $content = [System.Net.Http.ByteArrayContent]::new([IO.File]::ReadAllBytes($BodyFile))
            } elseif ($Body) {
                $content = [System.Net.Http.StringContent]::new($Body, [Text.Encoding]::UTF8, 'application/json')
            } else {
                $content = [System.Net.Http.StringContent]::new('', [Text.Encoding]::UTF8, 'application/json')
            }
            $content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/json; charset=utf-8')
            $request.Content = $content
        }
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        try {
            $status = [int]$response.StatusCode
            $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        } finally {
            $response.Dispose()
        }
    } catch {
        $failureMessage = $_.Exception.Message
        $status = 0
    } finally {
        $client.Dispose()
    }
    if ($OutFile) {
        [IO.File]::WriteAllText($OutFile, $text, [Text.UTF8Encoding]::new($false))
    }

    $lines = @("---- $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Method $Path HTTP=$status")
    if ($Method -ne 'GET' -and $Method -ne 'HEAD') {
        if ($BodyFile -and (Test-Path -LiteralPath $BodyFile)) {
            $lines += "REQ  $(ConvertTo-E2ESafeJson ([IO.File]::ReadAllText($BodyFile)))"
        } elseif ($Body) {
            $lines += "REQ  $(ConvertTo-E2ESafeJson $Body)"
        }
    }
    if ($status -eq 0) {
        $lines += 'RESP <request failed>'
    } else {
        $lines += "RESP $(ConvertTo-E2ESummary $text)"
    }

    $failed = ($status -eq 0 -or $status -ge 400)
    $failureReason = ''
    if ($status -eq 0) {
        $failureReason = "request failed: $failureMessage"
    } elseif ($status -ge 400) {
        $failureReason = "HTTP $status"
    }
    if (-not $failed) {
        $jsonValid = -not [string]::IsNullOrWhiteSpace($text)
        if ($jsonValid) {
            try { $null = $text | ConvertFrom-Json } catch { $jsonValid = $false }
        }
        if ($script:E2E_RequireJson -and -not $jsonValid) {
            $failed = $true; $failureReason = 'response is not valid JSON'
        } elseif ($script:E2E_RequireCode -or $text) {
            $parsed = $null
            if ($jsonValid) {
                try { $parsed = $text | ConvertFrom-Json -AsHashtable -Depth 100 } catch { $parsed = $null }
            }
            if ($script:E2E_RequireCode -and
                (-not ($parsed -is [System.Collections.IDictionary]) -or -not $parsed.Contains('code'))) {
                $failed = $true; $failureReason = 'response has no code'
            } elseif ($parsed -is [System.Collections.IDictionary]) {
                if ($parsed.Contains('code') -and $null -ne $parsed['code'] -and
                    [string]$parsed['code'] -ne [string]$script:E2E_SuccessCode) {
                    $failed = $true; $failureReason = 'business failure predicate matched'
                }
                $propertyName = $script:E2E_FailureProperty
                if ($parsed.Contains($propertyName) -and $parsed[$propertyName] -eq $false) {
                    $failed = $true; $failureReason = 'business failure predicate matched'
                }
            }
        }
    }
    if ($failed) {
        $lines += "LOG  failure delta ($failureReason; last $script:E2E_FailureLogLines lines)"
    }
    if ($script:E2E_LogFile) {
        $delta = Read-E2ELogDelta -Offset $before -Full:$failed
        if ($delta) { $lines += $delta } elseif ($failed) { $lines += '<no matching log lines>' }
    }
    Write-E2EEvidence ($lines -join "`n")
    return $status
}

function Invoke-E2EPost {
    param([string]$Path, [string]$Body = '{}', [string]$OutFile)
    return (Invoke-E2ERequest -Method POST -Path $Path -Body $Body -OutFile $OutFile)
}

function Invoke-E2EPostFile {
    param([string]$Path, [string]$BodyFile, [string]$OutFile)
    if (-not (Test-Path -LiteralPath $BodyFile)) {
        Write-Host "Invoke-E2EPostFile: 文件不存在: $BodyFile" -ForegroundColor Red
        return 0
    }
    try {
        [IO.File]::ReadAllText($BodyFile) | ConvertFrom-Json -AsHashtable -Depth 100 | Out-Null
    } catch {
        Write-Host "Invoke-E2EPostFile: 非法 JSON: $BodyFile" -ForegroundColor Red
        return 0
    }
    return (Invoke-E2ERequest -Method POST -Path $Path -BodyFile $BodyFile -OutFile $OutFile)
}

function Invoke-E2EGet {
    param([string]$Path, [string]$OutFile)
    return (Invoke-E2ERequest -Method GET -Path $Path -OutFile $OutFile)
}

function Read-E2EJson {
    param([string]$Path)
    $text = [IO.File]::ReadAllText($Path)
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return ($text | ConvertFrom-Json)
}

function Get-E2EData {
    param([string]$Path)
    $json = Read-E2EJson $Path
    if ($null -eq $json) { return '' }
    $value = $json.data
    if ($null -eq $value) { return '' }
    if ($value -is [string]) { return $value }
    return ($value | ConvertTo-Json -Compress -Depth 20)
}

function Get-E2EList {
    param([string]$Path)
    $json = Read-E2EJson $Path
    if ($null -eq $json -or $null -eq $json.data) { return @() }
    $property = $json.data.PSObject.Properties[$script:E2E_ListKey]
    if ($null -eq $property -or $null -eq $property.Value) { return @() }
    return @($property.Value)
}

function Get-E2EItem {
    param([string]$Path, [string]$Id)
    return (Get-E2EList $Path | Where-Object { [string]$_.id -eq [string]$Id } | Select-Object -First 1)
}

function Assert-E2EEqual {
    param([string]$Description, $Actual, $Expected)
    if ([string]$Actual -eq [string]$Expected) {
        $script:E2E_Pass++
        Write-E2EEvidence "PASS  $Description"
    } else {
        $script:E2E_Fail++
        Write-E2EEvidence "FAIL  $Description (actual=$Actual expected=$Expected)"
    }
}

function Assert-E2ECode {
    param([string]$Description, [string]$Expected, [string]$Path)
    try {
        $actual = (Read-E2EJson $Path).code
    } catch {
        $actual = 'invalid-json'
    }
    if ($null -eq $actual) { $actual = 'missing' }
    Assert-E2EEqual -Description $Description -Actual $actual -Expected $Expected
}

function Assert-E2EContains {
    param([string]$Description, [string]$Text, [string]$Needle)
    if ([string]$Text -and ([string]$Text).Contains([string]$Needle)) {
        $script:E2E_Pass++
        Write-E2EEvidence "PASS  $Description"
    } else {
        $script:E2E_Fail++
        Write-E2EEvidence "FAIL  $Description (未包含: $Needle)"
    }
}

function Assert-E2ETrue {
    param([string]$Description, [bool]$Condition)
    Assert-E2EEqual -Description $Description -Actual $(if ($Condition) { 1 } else { 0 }) -Expected 1
}

function Assert-E2ENoPlaceholders {
    param([string]$Description, [string]$Path)
    try {
        $text = [IO.File]::ReadAllText($Path)
        if ([string]::IsNullOrWhiteSpace($text)) { throw 'empty response' }
        $null = $text | ConvertFrom-Json
    } catch {
        $script:E2E_Fail++
        Write-E2EEvidence "FAIL  $Description (响应不是合法 JSON 或不可读: $Path)"
        return
    }
    $matches = [regex]::Matches($text, $script:E2E_PlaceholderPattern)
    if ($matches.Count -eq 0) {
        $script:E2E_Pass++
        Write-E2EEvidence "PASS  $Description"
    } else {
        $script:E2E_Fail++
        $sample = (($matches | Select-Object -First 5 | ForEach-Object { $_.Value }) -join ' ')
        Write-E2EEvidence "FAIL  $Description (发现未格式化占位符: $sample)"
    }
}

function Write-E2ESummary {
    Write-E2EEvidence "==== RESULT pass=$script:E2E_Pass fail=$script:E2E_Fail ===="
    return ($script:E2E_Fail -eq 0)
}

function Clear-E2ESecret {
    $script:E2E_Token = $null
    Remove-Item Env:E2E_TOKEN -ErrorAction SilentlyContinue
    $deleteTokenFile = if ($env:E2E_DELETE_TOKEN_FILE) { $env:E2E_DELETE_TOKEN_FILE } else { '1' }
    $created = if ($env:E2E_TOKEN_FILE_CREATED) { $env:E2E_TOKEN_FILE_CREATED } else { '0' }
    if ($deleteTokenFile -eq '1' -and $env:E2E_TOKEN_FILE -and (Test-Path -LiteralPath $env:E2E_TOKEN_FILE)) {
        if ($created -eq '1') {
            Remove-Item -LiteralPath $env:E2E_TOKEN_FILE -ErrorAction SilentlyContinue
        } else {
            Write-Host "Clear-E2ESecret: E2E_TOKEN_FILE 不是本轮创建，保留未删: $env:E2E_TOKEN_FILE" -ForegroundColor Yellow
            Write-Host 'Clear-E2ESecret: 如确认可删，设置 E2E_TOKEN_FILE_CREATED=1 后重跑' -ForegroundColor Yellow
        }
    }
}