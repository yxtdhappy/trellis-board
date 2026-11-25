# trellis-api-e2e 的 PowerShell 自测：mock 服务 + 合成响应/日志。
# 不连接真实后端，不使用真实 token；代理/query 日志用例由 run.sh 覆盖。
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillDir = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$Lib = Join-Path $SkillDir 'scripts/api-e2e-lib.ps1'
$Mock = Join-Path $ScriptDir 'mock-server.mjs'
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("e2e-selftest-ps-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Tmp -Force | Out-Null

$script:CasePass = 0
$script:CaseFail = 0
$script:Tmp = $Tmp
$mockProcess = $null

function Stop-Mock {
    if ($mockProcess -and -not $mockProcess.HasExited) {
        Stop-Process -Id $mockProcess.Id -Force -ErrorAction SilentlyContinue
        $mockProcess.WaitForExit(2000) | Out-Null
    }
}

try {
    $node = (Get-Command node -ErrorAction Stop).Source
    $portFile = Join-Path $Tmp 'mock.port'
    $mockOut = Join-Path $Tmp 'mock.out'
    $mockErr = Join-Path $Tmp 'mock.err'
    $mockProcess = Start-Process -FilePath $node `
        -ArgumentList @($Mock, '--port-file', $portFile) `
        -NoNewWindow -PassThru `
        -RedirectStandardOutput $mockOut -RedirectStandardError $mockErr

    for ($i = 0; $i -lt 100; $i++) {
        if (Test-Path -LiteralPath $portFile) { break }
        Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Path -LiteralPath $portFile)) {
        throw "mock server 未启动: $(Get-Content -Raw -LiteralPath $mockErr -ErrorAction SilentlyContinue)"
    }
    $mockPort = (Get-Content -Raw -LiteralPath $portFile).Trim()

    # 清掉可能影响默认值的外部配置，保证测的是技能默认行为。
    foreach ($name in @(
            'E2E_TOKEN_FILE', 'E2E_LOG_FILE', 'E2E_REDACT_KEYS_JSON',
            'E2E_REDACT_KEY_PATTERN', 'E2E_SUCCESS_CODE')) {
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
    $env:E2E_BASE_URL = "http://127.0.0.1:$mockPort"
    $env:E2E_TOKEN = 'selftest-token'
    $env:E2E_DELETE_TOKEN_FILE = '0'
    $env:E2E_TOKEN_FILE_CREATED = '0'
    $env:E2E_REQUIRE_JSON = '0'
    $env:E2E_REQUIRE_CODE = '0'

    . $Lib

    function Initialize-Case {
        param(
            [string]$Name,
            [string]$RequireJson = '0',
            [string]$RequireCode = '0'
        )
        $env:E2E_EVIDENCE_FILE = Join-Path $script:Tmp "$Name.evidence"
        $script:E2E_Pass = 0
        $script:E2E_Fail = 0
        Remove-Item Env:E2E_TOKEN -ErrorAction SilentlyContinue
        Remove-Item Env:E2E_TOKEN_FILE -ErrorAction SilentlyContinue
        $env:E2E_TOKEN = 'selftest-token'
        $env:E2E_DELETE_TOKEN_FILE = '0'
        $env:E2E_TOKEN_FILE_CREATED = '0'
        $env:E2E_REQUIRE_JSON = $RequireJson
        $env:E2E_REQUIRE_CODE = $RequireCode
        if (-not (Initialize-E2E)) { throw 'Initialize-E2E failed' }
    }

    function Run-Case {
        param([string]$Name, [scriptblock]$Body)
        try {
            & $Body
            Write-Host "PASS $Name"
            $script:CasePass++
        } catch {
            Write-Host "FAIL $Name"
            Write-Host "    $($_.Exception.Message)"
            $script:CaseFail++
        }
    }

    Run-Case 'r3_redaction' {
        Initialize-Case 'r3'
        $status = Invoke-E2ERequest -Method GET -Path '/ok' -OutFile (Join-Path $Tmp 'r3.json')
        if ($status -ne 200) { throw "HTTP $status" }
        $evidence = Get-Content -Raw -LiteralPath (Join-Path $Tmp 'r3.evidence')
        foreach ($secret in @('AT-SECRET', 'RT-SECRET', 'COOKIE-SECRET', 'PWD-SECRET', 'DB-SECRET')) {
            if ($evidence.Contains($secret)) { throw "证据泄漏 $secret" }
        }
        if (-not $evidence.Contains('visible')) { throw '证据缺少 visible' }
        $raw = Get-Content -Raw -LiteralPath (Join-Path $Tmp 'r3.json')
        if (-not $raw.Contains('AT-SECRET')) { throw '原始响应缺少 AT-SECRET' }
        Clear-E2ESecret
    }

    Run-Case 'r4a_string_code' {
        Initialize-Case 'r4a'
        $status = Invoke-E2ERequest -Method GET -Path '/string-code' -OutFile (Join-Path $Tmp 'r4a.json')
        if ($status -ne 200) { throw "HTTP $status" }
        $evidence = Get-Content -Raw -LiteralPath (Join-Path $Tmp 'r4a.evidence')
        if ($evidence -match 'failure delta') { throw '字符串 code 被误判失败' }
        Clear-E2ESecret
    }

    Run-Case 'r4b_numeric_code' {
        Initialize-Case 'r4b'
        $status = Invoke-E2ERequest -Method GET -Path '/ok' -OutFile (Join-Path $Tmp 'r4b.json')
        if ($status -ne 200) { throw "HTTP $status" }
        $evidence = Get-Content -Raw -LiteralPath (Join-Path $Tmp 'r4b.evidence')
        if ($evidence -match 'failure delta') { throw '数字 code 被误判失败' }
        Clear-E2ESecret
    }

    Run-Case 'r4c_business_failure' {
        Initialize-Case 'r4c'
        $status = Invoke-E2ERequest -Method GET -Path '/bad-code' -OutFile (Join-Path $Tmp 'r4c.json')
        if ($status -ne 200) { throw "HTTP $status" }
        $evidence = Get-Content -Raw -LiteralPath (Join-Path $Tmp 'r4c.evidence')
        if ($evidence -notmatch 'failure delta') { throw '业务失败缺少 failure delta' }
        if ($evidence -notmatch 'business failure predicate matched') { throw '业务失败原因缺失' }
        Clear-E2ESecret
    }

    Run-Case 'r5a_non_json_200' {
        Initialize-Case 'r5a' -RequireJson '1'
        $status = Invoke-E2ERequest -Method GET -Path '/html' -OutFile (Join-Path $Tmp 'r5a.html')
        if ($status -ne 200) { throw "HTTP $status" }
        $evidence = Get-Content -Raw -LiteralPath (Join-Path $Tmp 'r5a.evidence')
        if ($evidence -notmatch 'response is not valid JSON') { throw '200 HTML 未进入 failure delta' }
        Clear-E2ESecret
    }

    Run-Case 'r5b_missing_code_200' {
        Initialize-Case 'r5b' -RequireCode '1'
        $status = Invoke-E2ERequest -Method GET -Path '/no-code' -OutFile (Join-Path $Tmp 'r5b.json')
        if ($status -ne 200) { throw "HTTP $status" }
        $evidence = Get-Content -Raw -LiteralPath (Join-Path $Tmp 'r5b.evidence')
        if ($evidence -notmatch 'response has no code') { throw '缺 code 未进入 failure delta' }
        Clear-E2ESecret
    }

    Run-Case 'r5c_placeholder_invalid_json' {
        Initialize-Case 'r5c'
        $status = Invoke-E2ERequest -Method GET -Path '/invalid-json' -OutFile (Join-Path $Tmp 'r5c.json')
        if ($status -ne 200) { throw "HTTP $status" }
        Assert-E2ENoPlaceholders -Description 'invalid json' -Path (Join-Path $Tmp 'r5c.json')
        if ($script:E2E_Fail -ne 1) { throw "预期 FAIL=1，实际 $script:E2E_Fail" }
        $evidence = Get-Content -Raw -LiteralPath (Join-Path $Tmp 'r5c.evidence')
        if ($evidence -notmatch '响应不是合法 JSON') { throw '非法 JSON 断言未 FAIL' }
        Clear-E2ESecret
    }

    Run-Case 'r5d_placeholder_found' {
        Initialize-Case 'r5d'
        $status = Invoke-E2ERequest -Method GET -Path '/placeholder' -OutFile (Join-Path $Tmp 'r5d.json')
        if ($status -ne 200) { throw "HTTP $status" }
        Assert-E2ENoPlaceholders -Description 'placeholder' -Path (Join-Path $Tmp 'r5d.json')
        if ($script:E2E_Fail -ne 1) { throw "预期 FAIL=1，实际 $script:E2E_Fail" }
        Clear-E2ESecret
    }

    Run-Case 'r5e_placeholder_clean' {
        Initialize-Case 'r5e'
        $status = Invoke-E2ERequest -Method GET -Path '/clean' -OutFile (Join-Path $Tmp 'r5e.json')
        if ($status -ne 200) { throw "HTTP $status" }
        Assert-E2ENoPlaceholders -Description 'clean' -Path (Join-Path $Tmp 'r5e.json')
        if ($script:E2E_Fail -ne 0 -or $script:E2E_Pass -ne 1) {
            throw "预期 PASS=1 FAIL=0，实际 PASS=$script:E2E_Pass FAIL=$script:E2E_Fail"
        }
        Clear-E2ESecret
    }

    Run-Case 'r2a_token_preserved' {
        Remove-Item Env:E2E_TOKEN -ErrorAction SilentlyContinue
        Remove-Item Env:E2E_TOKEN_FILE -ErrorAction SilentlyContinue
        $tokenFile = Join-Path $Tmp 'token-preserve'
        Set-Content -LiteralPath $tokenFile -Value 'selftest-token' -NoNewline
        $env:E2E_TOKEN_FILE = $tokenFile
        $env:E2E_TOKEN_FILE_CREATED = '0'
        $env:E2E_DELETE_TOKEN_FILE = '1'
        $env:E2E_EVIDENCE_FILE = Join-Path $Tmp 'r2a.evidence'
        $script:E2E_Pass = 0
        $script:E2E_Fail = 0
        if (-not (Initialize-E2E)) { throw 'Initialize-E2E failed' }
        Clear-E2ESecret
        if (-not (Test-Path -LiteralPath $tokenFile)) { throw '用户 token 文件被误删' }
        Remove-Item Env:E2E_TOKEN_FILE -ErrorAction SilentlyContinue
    }

    Run-Case 'r2b_owned_token_deleted' {
        Remove-Item Env:E2E_TOKEN -ErrorAction SilentlyContinue
        Remove-Item Env:E2E_TOKEN_FILE -ErrorAction SilentlyContinue
        $tokenFile = Join-Path $Tmp 'token-delete'
        Set-Content -LiteralPath $tokenFile -Value 'selftest-token' -NoNewline
        $env:E2E_TOKEN_FILE = $tokenFile
        $env:E2E_TOKEN_FILE_CREATED = '1'
        $env:E2E_DELETE_TOKEN_FILE = '1'
        $env:E2E_EVIDENCE_FILE = Join-Path $Tmp 'r2b.evidence'
        $script:E2E_Pass = 0
        $script:E2E_Fail = 0
        if (-not (Initialize-E2E)) { throw 'Initialize-E2E failed' }
        Clear-E2ESecret
        if (Test-Path -LiteralPath $tokenFile) { throw '本轮创建的 token 文件未删除' }
        Remove-Item Env:E2E_TOKEN_FILE -ErrorAction SilentlyContinue
    }

    Run-Case 'r2c_env_token_only' {
        Remove-Item Env:E2E_TOKEN_FILE -ErrorAction SilentlyContinue
        Remove-Item Env:E2E_TOKEN -ErrorAction SilentlyContinue
        $env:E2E_TOKEN = 'selftest-token'
        $env:E2E_DELETE_TOKEN_FILE = '1'
        $env:E2E_EVIDENCE_FILE = Join-Path $Tmp 'r2c.evidence'
        $script:E2E_Pass = 0
        $script:E2E_Fail = 0
        if (-not (Initialize-E2E)) { throw 'Initialize-E2E failed' }
        Clear-E2ESecret
        if ($null -ne $script:E2E_Token) { throw 'Clear-E2ESecret 未清空内存 token' }
    }

    Write-Host "SELF-TEST(PS) pass=$script:CasePass fail=$script:CaseFail"
    if ($script:CaseFail -ne 0) { exit 1 }
} finally {
    Stop-Mock
    if (Test-Path -LiteralPath $Tmp) {
        Remove-Item -LiteralPath $Tmp -Recurse -ErrorAction SilentlyContinue
    }
}
