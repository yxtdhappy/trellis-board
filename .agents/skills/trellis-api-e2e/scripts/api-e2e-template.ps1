# 接口 E2E 用例模板（PowerShell 版）：复制本文件后替换占位符。
# 必填：E2E_BASE_URL；E2E_TOKEN_FILE 或 E2E_TOKEN 至少一个（推荐临时目录下的 token 文件）。
# token 由用户提供，不要写进本文件。
$ErrorActionPreference = 'Stop'

$lib = if ($env:E2E_LIB) { $env:E2E_LIB } else { Join-Path $PSScriptRoot 'api-e2e-lib.ps1' }
. $lib

if (-not $env:E2E_BASE_URL) { $env:E2E_BASE_URL = 'http://localhost:<port><context-path>' }
if (-not $env:E2E_LOG_FILE) { $env:E2E_LOG_FILE = 'D:/logs/app.log' }
if (-not $env:E2E_EVIDENCE_FILE) {
    $env:E2E_EVIDENCE_FILE = Join-Path $PSScriptRoot ('evidence/api-e2e-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
}
if (-not $env:E2E_REQUIRE_JSON) { $env:E2E_REQUIRE_JSON = '1' }
if (-not $env:E2E_REQUIRE_CODE) { $env:E2E_REQUIRE_CODE = '1' }
# 若本脚本创建了 E2E_TOKEN_FILE，设置 $env:E2E_TOKEN_FILE_CREATED = '1' 允许 Clear-E2ESecret 删除。

if (-not (Initialize-E2E)) { exit 1 }

$script:RunDir = Join-Path ([IO.Path]::GetTempPath()) ('e2e-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $script:RunDir -Force | Out-Null
$prefix = 'E2E_' + (Get-Date -Format 'yyyyMMddHHmmss')
$script:Id = ''

function Invoke-Cleanup {
    if ($script:Id) {
        $delete = @{ id = $script:Id } | ConvertTo-Json -Compress
        Invoke-E2EPost -Path '/delete' -Body $delete -OutFile (Join-Path $script:RunDir 'delete.json') | Out-Null
    }
    if (Test-Path -LiteralPath $script:RunDir) {
        [IO.Directory]::Delete($script:RunDir, $true)
    }
    Clear-E2ESecret
}

$ok = $false
try {
    # 1. 创建（替换字段为被测接口契约）
    $createBody = @{
        name = $prefix
        type = '<TYPE>'
        url  = '<URL>'
        pwd  = '<PWD>'
    } | ConvertTo-Json -Compress
    $saveOut = Join-Path $script:RunDir 'save.json'
    Invoke-E2EPost -Path '/save' -Body $createBody -OutFile $saveOut | Out-Null

    # 复杂/中文请求体：先 Write 到 $script:RunDir/body.json，再 Invoke-E2EPostFile -Path '/save' -BodyFile ... -OutFile ...
    Assert-E2ECode -Description '创建成功' -Expected '20000' -Path $saveOut
    Assert-E2ENoPlaceholders -Description '创建响应文案无占位符' -Path $saveOut
    $script:Id = Get-E2EData -Path $saveOut
    Assert-E2ETrue -Description '返回主键' -Condition (-not [string]::IsNullOrWhiteSpace($script:Id))

    # 2. 查询并核对回填
    $listOut = Join-Path $script:RunDir 'list.json'
    Invoke-E2EPost -Path '/list' -Body '{}' -OutFile $listOut | Out-Null
    $card = Get-E2EItem -Path $listOut -Id $script:Id
    Assert-E2EEqual -Description '列表可见' -Actual $card.id -Expected $script:Id
    Assert-E2EEqual -Description '回填名称' -Actual $card.name -Expected $prefix
    $prefixCount = @(Get-E2EList -Path $listOut | Where-Object { [string]$_.name -like "$prefix*" }).Count
    Assert-E2EEqual -Description '删除前按前缀可见' -Actual $prefixCount -Expected 1

    # 3. 边界：上限-1 / 上限 / 上限+1（按需取消注释）
    # $okValue = 'a' * 100
    # $badValue = 'a' * 101
    # $okBody = @{ id = $script:Id; loadUrl = $okValue } | ConvertTo-Json -Compress
    # Invoke-E2EPost -Path '/save' -Body $okBody -OutFile (Join-Path $script:RunDir 'ok.json') | Out-Null
    # Assert-E2ECode -Description '上限内保存成功' -Expected '20000' -Path (Join-Path $script:RunDir 'ok.json')
    # $badBody = @{ id = $script:Id; loadUrl = $badValue } | ConvertTo-Json -Compress
    # Invoke-E2EPost -Path '/save' -Body $badBody -OutFile (Join-Path $script:RunDir 'bad.json') | Out-Null
    # Assert-E2ETrue -Description '超限被拒绝' -Condition ((Read-E2EJson (Join-Path $script:RunDir 'bad.json')).ok -eq $false)

    # 4. 删除并确认前缀 0 条残留
    $deleteOut = Join-Path $script:RunDir 'delete.json'
    $deleteBody = @{ id = $script:Id } | ConvertTo-Json -Compress
    Invoke-E2EPost -Path '/delete' -Body $deleteBody -OutFile $deleteOut | Out-Null
    Assert-E2ECode -Description '删除成功' -Expected '20000' -Path $deleteOut
    $script:Id = ''

    $finalOut = Join-Path $script:RunDir 'final.json'
    Invoke-E2EPost -Path '/list' -Body '{}' -OutFile $finalOut | Out-Null
    $finalCount = @(Get-E2EList -Path $finalOut | Where-Object { [string]$_.name -like "$prefix*" }).Count
    Assert-E2EEqual -Description '无残留' -Actual $finalCount -Expected 0

    $ok = Write-E2ESummary
} finally {
    Invoke-Cleanup
}

if (-not $ok) { exit 1 }