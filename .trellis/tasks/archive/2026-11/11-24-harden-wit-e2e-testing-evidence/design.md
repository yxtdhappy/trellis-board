# Design：加固 wit-e2e-testing 技能

## 1. 设计结论

- 五处修复都在现有脚本内完成，不新增运行时依赖；自测复用 Node 18+ 和本地 mock server。
- 代理只在“写日志”时脱敏 query，转发路径保持原样；日志格式从 `?token=SECRET&page=1` 改为 `?[token,page]`。
- token 删除改为“所有权”模型：`E2E_TOKEN_FILE_CREATED=1` 才允许删除；模板不再隐式指向 `$HOME/.e2e-token`。
- 脱敏采用“精确键名 + 键名模式”双规则，Bash/PS 都把键名转小写；响应摘要脱敏失败时省略，不回退原文。
- 业务失败判据在初始化时生成并校验；字符串/数字 code 统一 `tostring` 比较；缺 code 由 `E2E_REQUIRE_CODE` 决定是否进入 failure delta。
- 两个模板默认打开 `E2E_REQUIRE_JSON=1`、`E2E_REQUIRE_CODE=1`；库默认 0，避免破坏非 WIT 项目。
- 自测放在 `scripts/self-test/`，Bash 覆盖 R1–R5，PowerShell 覆盖 R2–R5；代理测试是 Node 进程级的，Bash 运行器执行一次即可。

## 2. 现状与约束

### 2.1 目标文件

| 文件 | 现状 | 本轮改动 |
| --- | --- | --- |
| `scripts/local-gateway-proxy.mjs` | `:361`/`:368` 构造含 search 的上游路径；`:566` 打印 `resolved.path`；`:589` 响应日志只打印 pathname | 只改请求日志，转发保持 |
| `scripts/api-e2e-lib.sh` | `:28` 失败判据；`:32` 默认键；`:51-57` 递归脱敏；`:152` fail-open；`:172` 失败分支；`:239-247` 占位符；`:254-260` token 删除 | R2–R5 |
| `scripts/api-e2e-lib.ps1` | `:27` 成功码；`:30` 默认键；`:67-76` 键校验；`:123-147` 脱敏；`:161-177` 摘要；`:243-260` 失败判定；`:367-379` 占位符；`:386-393` token 删除 | R2–R5 |
| `scripts/api-e2e-template.sh` | `:11` 默认 `$HOME/.e2e-token` | 去掉 fallback，补 REQUIRE 默认 |
| `scripts/api-e2e-template.ps1` | `:9-11` 默认 `$HOME/.e2e-token` | 去掉 fallback，补 REQUIRE 默认 |
| `references/local-forwarding-proxy.md` | `:167` 承诺不打印 query 凭据 | 改为“只打印键名”，并给日志格式 |
| `SKILL.md` / `references/api-e2e-playbook.md` | token/脱敏/失败判据的旧说法 | M1 同步新契约；M2 拆成 API 版（见第 9 节） |
| `scripts/read-log-delta.ps1`、`references/log-sources.md` | — | M1 不改；M2 随 API 技能迁移，行为不变 |
| `references/report-template.md` | 页面与接口证据混在一张表 | M1 不改；M2 拆成 API 版与 UI 版 |

### 2.2 约束

- 技能目录 `C:/Users/yuhaojie/.claude/skills/wit-e2e-testing` 不是 git 仓库；修改前必须备份到任务 `research/skill-before/`，修改后生成 diff。
- Bash 库依赖 jq ≥ 1.6（`walk`）；本机 jq 1.8.2。PS 库不依赖 jq。
- 模板已有 `#Requires -Version 7.0`；本轮只验证 PowerShell 7。
- 不改变 `E2E_SUCCESS_CODE` 默认值 `20000`，不改变现有环境变量名；新增变量都有默认值。
- 任务 `package` 字段是 create 默认 `server`，本任务实际交付物不涉及 `packages/server`。

## 3. 契约变更

### 3.1 环境变量

| 变量 | 默认 | 作用 | 读取时机 |
| --- | --- | --- | --- |
| `E2E_TOKEN_FILE_CREATED` | `0` | 声明 `E2E_TOKEN_FILE` 由本轮创建；只有 1 才允许按 `E2E_DELETE_TOKEN_FILE=1` 删除 | Bash source 时；PS 脚本加载时 |
| `E2E_DELETE_TOKEN_FILE` | `1` | 是否尝试删除 token 文件；仍受 CREATED 约束 | 同上 |
| `E2E_REDACT_KEY_PATTERN` | `(pwd|passw|secret|token|cookie|authorization|credential|privatekey|sessionid)` | 键名模式，命中即删除；与精确键名规则取并集 | Bash source 时；PS 初始化时 |
| `E2E_REQUIRE_JSON` | 库 `0`，模板 `1` | 200 非 JSON 是否进入 failure delta | Bash `e2e_init`；PS `Initialize-E2E` |
| `E2E_REQUIRE_CODE` | 库 `0`，模板 `1` | 200 缺 `code` 是否进入 failure delta | 同上 |
| `E2E_FAILURE_JQ` | 空，初始化时生成 | 自定义业务失败表达式；非空时优先使用 | Bash `e2e_init` |
| `E2E_SUCCESS_CODE` | `20000` | 业务成功码；参与默认表达式生成 | Bash `e2e_init` 读取当前值 |

**为什么在 init 读取 `E2E_REQUIRE_*`**：两个模板都是先 `source`/dot-source 库、再设置环境变量。若库在 source 时把 `E2E_REQUIRE_JSON` 默认成 0，模板随后设置的 1 不会生效。因此 Bash 在 `e2e_init`、PS 在 `Initialize-E2E` 里读取并赋值，避免 source 顺序陷阱。`E2E_FAILURE_JQ` 的默认值也在 init 生成，确保使用模板最终设置的 `E2E_SUCCESS_CODE`。

### 3.2 token 状态机

```text
E2E_TOKEN_FILE 已设置?
  ├─ 否：必须 E2E_TOKEN；结束时不删除任何文件
  └─ 是：读取文件
        E2E_DELETE_TOKEN_FILE=0        -> 保留
        E2E_DELETE_TOKEN_FILE=1
          ├─ E2E_TOKEN_FILE_CREATED=1  -> 删除
          └─ E2E_TOKEN_FILE_CREATED=0  -> 保留 + stderr/Write-Host 提示
```

模板不再提供 `$HOME/.e2e-token` fallback；未提供 token 时 `e2e_init`/`Initialize-E2E` 的现有错误信息已经足够明确。文档推荐路径为系统临时目录（Bash `${TMPDIR:-/tmp}`，PS `[IO.Path]::GetTempPath()`），并明确“创建后设置 CREATED=1”。

### 3.3 失败判据

默认表达式（Bash 在 `e2e_init` 生成）：

```jq
((.ok == false) or
 ((.code? != null) and ((.code | tostring) != (20000 | tostring))))
```

这里 `20000` 是 `E2E_SUCCESS_CODE` 的当前值。生成时用 `jq -Rn --arg code "$E2E_SUCCESS_CODE" '$code'` 先转成 JSON 字符串常量，再拼进表达式，避免 `E2E_SUCCESS_CODE=SUCCESS` 这类非数字值把表达式写成非法 jq 语法：

```bash
local success_code_jq
success_code_jq=$(jq -Rn --arg code "$E2E_SUCCESS_CODE" '$code')
E2E_FAILURE_JQ="((.ok == false) or ((.code? != null) and ((.code | tostring) != ($success_code_jq | tostring))))"
```

语义：

| 响应 | 结果 | 说明 |
| --- | --- | --- |
| `{"code":20000}` | 不失败 | 数字 code |
| `{"code":"20000"}` | 不失败 | 字符串 code |
| `{"code":"50000"}` | 失败 | 非成功码 |
| `{"ok":false}` | 失败 | 布尔失败 |
| `{}` / 无 code | 不因 code 失败 | 保持旧行为；需 `E2E_REQUIRE_CODE=1` 才进入 failure delta |

`e2e_init` 用 `jq -n "$E2E_FAILURE_JQ" >/dev/null 2>&1` 做编译检查；表达式会执行一次，但不带 `-e`，结果真假不影响检查。非法表达式返回非零并打印表达式。

### 3.4 failure delta 原因

Bash 用 `failure_reason` 统一输出；PS 用 `$failureReason`。原因字符串固定为：

- `curl failed rc=<n>; request may not have reached the service`
- `HTTP <status>`
- `response is not valid JSON`
- `response has no code`
- `business failure predicate matched`
- `request failed: <exception message>`（PS 连接异常）

证据行改为 `LOG  failure delta (<reason>; last <N> lines)`。

## 4. 详细设计

### 4.1 代理 query 日志

在 `local-gateway-proxy.mjs` 增加纯函数：

```js
const redactQueryForLog = (path) => {
  const queryIndex = path.indexOf("?");
  if (queryIndex < 0) return path;
  const keys = [
    ...new Set(new URLSearchParams(path.slice(queryIndex + 1)).keys()),
  ];
  const pathname = path.slice(0, queryIndex);
  return keys.length ? `${pathname}?[${keys.join(",")}]` : pathname;
};
```

`handleRequest` 中：

```js
const logPath = redactQueryForLog(resolved.path);
console.log(
  `[proxy] ${request.method} ${requestUrl.pathname} -> ${routeLabel} ${resolved.target.origin}${logPath}`,
);
```

- 前半段 `requestUrl.pathname` 本来就不含 query。
- 后半段用 `logPath` 替代 `resolved.path`；`resolved.path` 仍传给 `requestOptions`，上游 query 不变。
- 没有 query 时输出与旧格式一致；有 query 时输出 `?[token,page]`，不输出值。
- 响应日志 `:589` 只打印 pathname，不改。
- 健康检查在请求日志之前返回，不受影响。

### 4.2 Bash 库

#### 4.2.1 默认值与初始化

```bash
E2E_SUCCESS_CODE=${E2E_SUCCESS_CODE:-20000}
E2E_FAILURE_JQ=${E2E_FAILURE_JQ:-}
E2E_DELETE_TOKEN_FILE=${E2E_DELETE_TOKEN_FILE:-1}
E2E_TOKEN_FILE_CREATED=${E2E_TOKEN_FILE_CREATED:-0}
E2E_REDACT_KEY_PATTERN=${E2E_REDACT_KEY_PATTERN:-'(pwd|passw|secret|token|cookie|authorization|credential|privatekey|sessionid)'}
```

`e2e_init` 增加：

1. 校验 `E2E_DELETE_TOKEN_FILE`、`E2E_TOKEN_FILE_CREATED` 为 `0`/`1`。
2. 校验 jq 版本 ≥ 1.6（`jq --version` 解析 major/minor）。低于 1.6 直接失败，避免 `walk` 缺失导致所有脱敏 fail-closed、证据不可用。
3. 读取 `E2E_REQUIRE_JSON=${E2E_REQUIRE_JSON:-0}`、`E2E_REQUIRE_CODE=${E2E_REQUIRE_CODE:-0}`，校验 0/1。
4. 若 `E2E_FAILURE_JQ` 为空，用当前 `E2E_SUCCESS_CODE` 生成默认表达式；然后 `jq -n "$E2E_FAILURE_JQ"` 校验。
5. 校验 `E2E_REDACT_KEY_PATTERN`：`jq -n --arg p "$E2E_REDACT_KEY_PATTERN" '"" | test($p)'`；失败则初始化失败。
6. 保留现有 `E2E_REDACT_KEYS_JSON` 数组校验，并要求元素都是字符串（`type == "array" and all(.[]; type == "string")`）；否则 `ascii_downcase` 会在运行时失败。

校验顺序放在创建临时 header 文件之前，初始化失败不会留下 header 文件。

#### 4.2.2 递归脱敏

```bash
e2e_redact_jq() {
    jq -c --argjson keys "$E2E_REDACT_KEYS_JSON" --arg pattern "$E2E_REDACT_KEY_PATTERN" '
        ($keys | map(ascii_downcase)) as $normalized
        | walk(if type == "object"
            then with_entries(select(
                ((.key | ascii_downcase) as $k
                 | (($normalized | index($k)) != null) or ($k | test($pattern)))
                | not))
            else . end)
    ' "$@"
}
```

- `$normalized` 让 `E2E_REDACT_KEYS_JSON='["accessToken"]'` 在 Bash 也命中；PS 已在 init 里 lowercase，行为对齐。
- `test($pattern)` 覆盖 `accessToken`、`dbPassword`、`set-cookie` 等组合键；精确键名列表保持向后兼容。
- 误伤（如 `tokenCount`）由 `E2E_REDACT_KEY_PATTERN` 覆盖，文档说明。

#### 4.2.3 响应摘要 fail-closed

```bash
if resp=$(jq -c "$E2E_RESP_SELECTOR" "$out" 2>/dev/null); then
    local redacted
    if redacted=$(printf '%s' "$resp" | e2e_redact_jq 2>/dev/null); then
        resp=$redacted
    else
        resp='<response summary omitted: redaction failed>'
    fi
else
    resp='<invalid json>'
fi
```

原始 `$out` 不动，断言继续读原文。请求体路径已经是 fail-closed（`:146-148`），不改。

#### 4.2.4 失败判定与证据

在 `e2e_request` 里把失败判断集中成 `failure_reason`：

```bash
local failure_reason=''
if [ "$curl_rc" -ne 0 ]; then
    failure_reason="curl failed rc=$curl_rc; request may not have reached the service"
elif [ "$http" -ge 400 ] 2>/dev/null; then
    failure_reason="HTTP $http"
elif [ "${E2E_REQUIRE_JSON:-0}" = 1 ] && ! jq -e . "$out" >/dev/null 2>&1; then
    failure_reason='response is not valid JSON'
elif [ "${E2E_REQUIRE_CODE:-0}" = 1 ] &&
     ! jq -e 'type == "object" and has("code")' "$out" >/dev/null 2>&1; then
    failure_reason='response has no code'
elif ! jq -e "$E2E_FAILURE_JQ" "$out" >/dev/null 2>&1; then
    failure_reason='business failure predicate matched'
fi
```

证据块里：

```bash
if [ -n "$failure_reason" ]; then
    printf 'LOG  failure delta (%s; last %s lines)\n' "$failure_reason" "$E2E_FAILURE_LOG_LINES"
    [ -n "$delta" ] && printf '%s\n' "$delta" | tail -n "$E2E_FAILURE_LOG_LINES"
elif [ -n "$delta" ]; then
    printf '%s\n' "$delta" | grep -E "$E2E_LOG_GREP" || true
fi
```

不再单独打印 `LOG curl failed...`，原因已包含在 `failure_reason`。HTTP 200 + 非 JSON/缺 code 现在会进入 failure delta，但不会改变 `e2e_request` 返回的 HTTP 状态码，也不会直接增加 `E2E_FAIL`；断言仍按原逻辑决定通过/失败。

#### 4.2.5 占位符断言

```bash
e2e_assert_no_placeholders() {
    local hits pattern=${E2E_PLACEHOLDER_PATTERN:-'\{[0-9]+\}|%[sd]'}
    if ! jq -e . "$2" >/dev/null 2>&1; then
        E2E_FAIL=$((E2E_FAIL + 1))
        e2e_say "FAIL  $1 (响应不是合法 JSON: $2)"
        return
    fi
    if ! hits=$(jq -r '.. | strings' "$2" 2>/dev/null); then
        E2E_FAIL=$((E2E_FAIL + 1))
        e2e_say "FAIL  $1 (读取响应失败: $2)"
        return
    fi
    hits=$(printf '%s\n' "$hits" | grep -E "$pattern" | head -5 || true)
    if [ -z "$hits" ]; then
        E2E_PASS=$((E2E_PASS + 1)); e2e_say "PASS  $1"
    else
        E2E_FAIL=$((E2E_FAIL + 1))
        e2e_say "FAIL  $1 (发现未格式化占位符: $(printf '%s' "$hits" | tr '\n' ' '))"
    fi
}
```

扫描范围仍是所有字符串（不在本轮收窄），只修 fail-open。

#### 4.2.6 token 删除

```bash
e2e_done() {
    e2e_cleanup_header_file
    unset E2E_TOKEN
    if [ "${E2E_DELETE_TOKEN_FILE:-1}" = "1" ] &&
       [ -n "${E2E_TOKEN_FILE:-}" ] && [ -f "$E2E_TOKEN_FILE" ]; then
        if [ "${E2E_TOKEN_FILE_CREATED:-0}" = "1" ]; then
            rm -f -- "$E2E_TOKEN_FILE"
        else
            printf 'e2e_done: E2E_TOKEN_FILE 不是本轮创建，保留未删: %s\n' "$E2E_TOKEN_FILE" >&2
            printf 'e2e_done: 如确认可删，设置 E2E_TOKEN_FILE_CREATED=1 后重跑\n' >&2
        fi
    fi
}
```

### 4.3 PowerShell 库

#### 4.3.1 初始化与默认值

- 顶部新增 `$script:E2E_RedactPattern` 默认模式；`Initialize-E2E` 读取 env 覆盖并 `[regex]::new(...)` 校验。
- `Initialize-E2E` 读取 `$env:E2E_REQUIRE_JSON` / `$env:E2E_REQUIRE_CODE`，赋给 `$script:E2E_RequireJson` / `$script:E2E_RequireCode`，校验 0/1。
- `Initialize-E2E` 校验 `$env:E2E_DELETE_TOKEN_FILE` / `$env:E2E_TOKEN_FILE_CREATED` 为 0/1。
- `$script:E2E_RedactKeys` 的默认列表保持不变；env 覆盖时继续 lowercase。

#### 4.3.2 脱敏

`Remove-E2ESensitiveField` 的两个分支统一：

```powershell
$name = ([string]$key).ToLowerInvariant()
if ($script:E2E_RedactKeys -contains $name -or
    $name -match $script:E2E_RedactPattern) { continue }
```

`ConvertTo-E2ESummary` 已经是 fail-closed（`<invalid json>`），不改；`ConvertTo-E2ESafeJson` 的 `<unredacted: invalid json>` 也保留。

#### 4.3.3 失败判定

`Invoke-E2ERequest` 增加 `$failureReason = ''`，把 `$failed` 的判断改为：

```powershell
$failed = ($status -eq 0 -or $status -ge 400)
if ($status -eq 0) {
    $failureReason = "request failed: $failureMessage"
} elseif ($status -ge 400) {
    $failureReason = "HTTP $status"
}
if (-not $failed) {
    $jsonValid = $true
    try { $null = $text | ConvertFrom-Json } catch { $jsonValid = $false }
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
```

- `ConvertFrom-Json` 不带 `-AsHashtable` 只做 JSON 合法性判断，避免标量/数组在 hashtable 转换上误判。
- `RequireCode` 打开时，空响应也判失败；`RequireJson` 打开时，空响应同样失败。
- 证据行：`LOG  failure delta ($failureReason; last N lines)`。
- 现有 `$lines += "LOG  request failed: $failureMessage"` 删除，原因已合并；避免重复。

#### 4.3.4 占位符断言

```powershell
function Assert-E2ENoPlaceholders {
    param([string]$Description, [string]$Path)
    try {
        $text = [IO.File]::ReadAllText($Path)
        $null = $text | ConvertFrom-Json
    } catch {
        $script:E2E_Fail++
        Write-E2EEvidence "FAIL  $Description (响应不是合法 JSON 或不可读: $Path)"
        return
    }
    $matches = [regex]::Matches($text, $script:E2E_PlaceholderPattern)
    ...
}
```

#### 4.3.5 token 删除

`Clear-E2ESecret`：

```powershell
$created = if ($env:E2E_TOKEN_FILE_CREATED) { $env:E2E_TOKEN_FILE_CREATED } else { '0' }
if ($deleteTokenFile -eq '1' -and $env:E2E_TOKEN_FILE -and
    (Test-Path -LiteralPath $env:E2E_TOKEN_FILE)) {
    if ($created -eq '1') {
        Remove-Item -LiteralPath $env:E2E_TOKEN_FILE -ErrorAction SilentlyContinue
    } else {
        Write-Host "Clear-E2ESecret: E2E_TOKEN_FILE 不是本轮创建，保留未删: $env:E2E_TOKEN_FILE" -ForegroundColor Yellow
        Write-Host 'Clear-E2ESecret: 如确认可删，设置 E2E_TOKEN_FILE_CREATED=1 后重跑' -ForegroundColor Yellow
    }
}
```

### 4.4 模板

Bash `api-e2e-template.sh`：

- 删除 `E2E_TOKEN_FILE=${E2E_TOKEN_FILE:-"$HOME/.e2e-token"}`。
- 在 env 区增加（放在 `e2e_init` 前即可，库在 init 读取）：
  ```bash
  E2E_REQUIRE_JSON=${E2E_REQUIRE_JSON:-1}
  E2E_REQUIRE_CODE=${E2E_REQUIRE_CODE:-1}
  # 若本脚本创建了 E2E_TOKEN_FILE，设置 E2E_TOKEN_FILE_CREATED=1 允许结束时删除。
  ```
- 头部注释明确 `E2E_TOKEN_FILE`/`E2E_TOKEN` 至少一个，推荐临时目录。

PS `api-e2e-template.ps1`：

- 删除 `if (-not $env:E2E_TOKEN -and -not $env:E2E_TOKEN_FILE) { $env:E2E_TOKEN_FILE = Join-Path $HOME '.e2e-token' }`。
- 增加：
  ```powershell
  if (-not $env:E2E_REQUIRE_JSON) { $env:E2E_REQUIRE_JSON = '1' }
  if (-not $env:E2E_REQUIRE_CODE) { $env:E2E_REQUIRE_CODE = '1' }
  # 若本脚本创建了 E2E_TOKEN_FILE，设置 $env:E2E_TOKEN_FILE_CREATED = '1' 允许结束时删除。
  ```

### 4.5 自测

目录：

```text
scripts/self-test/
  mock-server.mjs
  run.sh
  run.ps1
```

`mock-server.mjs`：

- Node 18+，`http.createServer`，监听 `127.0.0.1:0`；支持 `--port-file <path>`，把实际端口写入文件（同时 stdout 打印 `E2E_SELF_TEST_PORT=<port>`）。
- 端点：

| 路径 | 响应 |
| --- | --- |
| `/ok` | 200 `{"code":20000,"ok":true,"msg":"ok","data":{"id":1,"name":"visible","accessToken":"AT-SECRET","refreshToken":"RT-SECRET","cookie":"sid=COOKIE-SECRET","nested":{"password":"PWD-SECRET"},"dbPassword":"DB-SECRET"}}` |
| `/string-code` | 200 `{"code":"20000","ok":true,"msg":"ok","data":{"id":2}}` |
| `/bad-code` | 200 `{"code":"50000","ok":false,"msg":"bad","data":null}` |
| `/no-code` | 200 `{"ok":true,"msg":"ok","data":{"id":3}}` |
| `/html` | 200 `text/html` `<html><body>proxy error</body></html>` |
| `/invalid-json` | 200 `text/plain` `not-json` |
| `/placeholder` | 200 `{"code":20000,"ok":true,"msg":"hello %s","data":{"id":4}}` |
| `/clean` | 200 `{"code":20000,"ok":true,"msg":"hello world","data":{"id":5}}` |
| `/echo` | 200 `{"code":20000,"ok":true,"msg":"ok","data":{"url":"<req.url>","query":"<search>"}}` |

- 所有响应 `Connection: close`，避免测试进程挂住；SIGTERM/SIGINT 关闭服务器。

`run.sh`：

1. 检查 `curl`、`jq`、`node`；`SKILL_DIR=$(cd "$(dirname "$0")/../.." && pwd)`。
2. `TMP=$(mktemp -d)`；trap 清理 mock/proxy 进程和 `$TMP`。
3. 启动 mock，等待 port 文件；启动代理：
   ```bash
   node "$SKILL_DIR/scripts/local-gateway-proxy.mjs" \
     --listen-port "$PROXY_PORT" \
     --route "/appgw/svc=http://127.0.0.1:$MOCK_PORT" \
     >"$TMP/proxy.log" 2>&1 &
   ```
   轮询 `http://127.0.0.1:$PROXY_PORT/__local_gateway/health` 直到 200。
4. `source "$SKILL_DIR/scripts/api-e2e-lib.sh"`；设置 `E2E_BASE_URL`、`E2E_TOKEN=selftest-token`、`E2E_REQUIRE_JSON=1`、`E2E_REQUIRE_CODE=1`、`E2E_DELETE_TOKEN_FILE=0`。
5. 用例（每个用例独立 `E2E_EVIDENCE_FILE`，在 subshell 里 `e2e_init`/`e2e_done`）：
   - R3：`/ok` → 200；证据不含 `AT-SECRET`/`RT-SECRET`/`COOKIE-SECRET`/`PWD-SECRET`/`DB-SECRET`；含 `visible`；原始 `$TMP/ok.json` 含 `AT-SECRET`。
   - R4a：`/string-code` → 200；证据不含 `failure delta`。
   - R4b：`/ok` → 200；证据不含 `failure delta`。
   - R4c：`/bad-code` → 200；证据含 `failure delta` 和 `business failure predicate matched`。
   - R4d：`E2E_FAILURE_JQ='(('` 的 subshell 执行 `e2e_init`，期望非零。
   - R5a：`/html` → 证据含 `response is not valid JSON`。
   - R5b：`/no-code` → 证据含 `response has no code`。
   - R5c：`/invalid-json` 调 `e2e_assert_no_placeholders`，`E2E_FAIL` 增加。
   - R5d：`/placeholder` 调断言，`E2E_FAIL` 增加。
   - R5e：`/clean` 调断言，`E2E_PASS` 增加且 `E2E_FAIL` 不变。
   - R2a：预置 token 文件 + `CREATED=0` + `DELETE=1` → 文件存在。
   - R2b：预置 + `CREATED=1` + `DELETE=1` → 文件删除。
   - R2c：只设 `E2E_TOKEN` → `e2e_init` 成功，且没有文件操作。
   - R1：`curl "http://127.0.0.1:$PROXY_PORT/appgw/svc/echo?token=SECRET&page=1"` → 响应含 `token=SECRET`；`proxy.log` 含 `token`、`page`，不含 `SECRET`。
6. 打印 `PASS/FAIL` 和 summary；有失败则 `exit 1`。

`run.ps1`：

- 检查 `node`；启动同一个 mock server（`Start-Process` + `--port-file`），等待端口文件。
- dot-source `api-e2e-lib.ps1`；设置 env；`Initialize-E2E`。
- 覆盖 R2–R5：
  - `/ok` 脱敏、`/string-code` 不产生 failure delta、`/bad-code`/`/html`/`/no-code` 产生对应原因；
  - 非法 JSON/占位符/正常 JSON 的 `Assert-E2ENoPlaceholders`；
  - 预置 token 文件 + `CREATED=0` 保留、`CREATED=1` 删除。
- R1 代理测试由 Bash 运行器覆盖，PS 运行器不重复；在 `run.ps1` 顶部注释说明。
- `finally` 停止 mock 进程；退出码按失败数设置。

### 4.6 文档与备份

- `SKILL.md`：
  - token 章节：明确 `E2E_TOKEN_FILE_CREATED` 所有权，模板不再默认 `$HOME`；推荐临时目录。
  - 脱敏章节：精确键名 + 模式；响应摘要 fail-closed；值级密钥不在本轮。
  - 失败判据：字符串/数字 code；`E2E_REQUIRE_JSON/CODE` 只在模板默认开。
  - 自测：`bash scripts/self-test/run.sh`、`pwsh -NoProfile -File scripts/self-test/run.ps1`。
- `playbook.md`：env 表补 4 个新变量；token 工作流、failure delta 原因、自测命令同步。
- `local-forwarding-proxy.md:167`：改为“日志只记录 pathname 和 query 键名（`?[token,page]`），不记录值”。
- 备份/ diff：
  ```bash
  mkdir -p "$TASK/research"
  cp -a "$SKILL" "$TASK/research/skill-before"
  (cd "$TASK/research/skill-before" && find . -type f -print0 | sort -z | xargs -0 sha256sum) \
    > "$TASK/research/skill-before.sha256"
  # 修改完成后
  diff -ruN "$TASK/research/skill-before" "$SKILL" > "$TASK/research/skill-after.diff" || [ $? -eq 1 ]
  (cd "$SKILL" && find . -type f -print0 | sort -z | xargs -0 sha256sum) \
    > "$TASK/research/skill-after.sha256"
  ```
  `diff` 退出码 1 表示有差异，属于预期；用 `|| [ $? -eq 1 ]` 放过。diff 里路径为 `skill-before/...` 与技能绝对路径，`patch -p1` 在 `skill-before` 的副本上可复现。

## 5. 测试设计

| 用例 | 输入 | 期望 |
| --- | --- | --- |
| R1 代理日志 | `?token=SECRET&page=1` | 日志无 `SECRET`，含 `token`/`page`；上游响应含 `token=SECRET` |
| R2a 预置 token | `CREATED=0`, `DELETE=1` | 文件保留，stderr/Write-Host 提示 |
| R2b 本轮创建 | `CREATED=1`, `DELETE=1` | 文件删除 |
| R2c 仅 E2E_TOKEN | 无文件 | 初始化成功，无删除 |
| R3 脱敏 | `/ok` 含 4 类秘密 | 证据无秘密值，`visible` 在，原始文件仍有秘密 |
| R4a 字符串 code | `/string-code` | 无 failure delta |
| R4b 数字 code | `/ok` | 无 failure delta |
| R4c 非成功 code | `/bad-code` | failure delta + predicate reason |
| R4d 非法 JQ | `E2E_FAILURE_JQ='(('` | `e2e_init` 非零 |
| R5a 200 HTML | `/html` | failure delta + non-JSON reason |
| R5b 缺 code | `/no-code` | failure delta + no-code reason |
| R5c 非法 JSON 占位符 | `/invalid-json` | 断言 FAIL |
| R5d 有占位符 | `/placeholder` | 断言 FAIL |
| R5e 干净文案 | `/clean` | 断言 PASS |
| R6 自测 | `run.sh` / `run.ps1` | 退出 0，summary fail=0 |

反向验证：实现完成后，手动把 `api-e2e-lib.sh:152` 的 fail-closed 临时改回 `|| printf '%s' "$resp"`，跑 R3，确认证据重新出现秘密值；再恢复。该抽验结果记录在 `implement.md` 的验收记录里，不提交临时改动。

## 6. 实施顺序

1. **备份**：复制技能目录、生成 SHA-256 清单。
2. **代理**：`redactQueryForLog` + 日志行；先用手工 curl 验证，再跑后续自测的 R1。
3. **Bash 库**：默认值/init/脱敏/失败/占位符/token；写 `run.sh` 的 Bash 用例并跑通。
4. **PS 库**：默认值/init/脱敏/失败/占位符/token；写 `run.ps1` 并跑通。
5. **模板与文档**：两个模板、`SKILL.md`、`playbook.md`、`local-forwarding-proxy.md`。
6. **全量验证**：两个自测、手工反向验证、生成 diff/清单、`task.py validate`。
7. **M2 拆分**：仅当第 6 步 Bash/PS 自测都退出 0 后，按 9.10 执行；顺序见第 9 节，回滚点见 9.10。

## 7. 影响文件

M1 外部技能目录（`C:/Users/yuhaojie/.claude/skills/wit-e2e-testing/`）：

- `scripts/local-gateway-proxy.mjs`
- `scripts/api-e2e-lib.sh`
- `scripts/api-e2e-lib.ps1`
- `scripts/api-e2e-template.sh`
- `scripts/api-e2e-template.ps1`
- `scripts/self-test/mock-server.mjs`（新增）
- `scripts/self-test/run.sh`（新增）
- `scripts/self-test/run.ps1`（新增）
- `SKILL.md`
- `references/api-e2e-playbook.md`
- `references/local-forwarding-proxy.md`

M2 外部技能目录：

- 新增 `C:/Users/yuhaojie/.claude/skills/wit-api-e2e/`（含迁移后的 `SKILL.md`、API 版 `report-template.md`、全部 `scripts/` 与 `references/`）
- 新增 `C:/Users/yuhaojie/.claude/skills/wit-ui-e2e/`（含 `SKILL.md`、`references/ui-e2e-playbook.md`、UI 版 `references/report-template.md`；方案 A 无 `scripts/`）
- 旧 `C:/Users/yuhaojie/.claude/skills/wit-e2e-testing/` 归档到 `C:/Users/yuhaojie/.claude/skills-archive/wit-e2e-testing-2026-11-24/`

任务目录：

- `prd.md`、`design.md`、`implement.md`
- `implement.jsonl`、`check.jsonl`
- `research/skill-before/`、`research/skill-before.sha256`
- `research/skill-after-m1/`、`research/m1.diff`、`research/skill-after-m1.sha256`
- `research/skill-split-map.md`、`research/check_skill_layout.py`
- `research/skill-after-m2/`、`research/m2.diff`、`research/skill-after-m2.sha256`

M1 不修改 `scripts/read-log-delta.ps1`、`references/log-sources.md`、`references/report-template.md` 的内容；M2 只移动/拆分，不改变日志读取器行为。仓库业务代码不动。

## 8. 待确认

已确认（2026-11-24 m00285）：

1. token 所有权采用 `E2E_TOKEN_FILE_CREATED`（推荐）。
2. `E2E_REQUIRE_*` 库默认 0、模板默认 1（推荐）。
3. 默认脱敏模式按本文正则（推荐）。
4. 值级密钥（URL/JDBC）本轮不做。
5. 自测目录 `scripts/self-test/`。

M2 待确认：

6. **UI 技能的独立性（已确认方案 A，2026-11-24）**：阶段交接，UI 不含代理/日志读取器；B/C 不采用，差异见 `design-m2.md` 9.9。
7. 技能名 `wit-api-e2e` / `wit-ui-e2e`（推荐）。
8. 旧技能归档到 `C:/Users/yuhaojie/.claude/skills-archive/wit-e2e-testing-2026-11-24/`（推荐）。
9. UI 验证使用结构检查 + Chrome DevTools 手工 smoke，不引入 Playwright（推荐）。
10. 共享规则两边各写短版，不抽公共文件（推荐）。

## 9. M2：UI / API 技能拆分

M2 的目录、内容归属、迁移/归档、结构检查、方案 B/C 差异和实施顺序见 [`design-m2.md`](design-m2.md)。M2 只在 M1 的 Bash/PS 自测都通过后开始。

