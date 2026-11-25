#!/usr/bin/env bash
# trellis-api-e2e 的 Bash 自测：mock 服务 + 本地代理 + 合成日志/响应。
# 不连接真实后端，不使用真实 token；所有数据都是自测常量。
set -u

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SKILL_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
LIB="${E2E_SELFTEST_LIB:-$SKILL_DIR/scripts/api-e2e-lib.sh}"
MOCK="$SCRIPT_DIR/mock-server.mjs"
PROXY="$SKILL_DIR/scripts/local-gateway-proxy.mjs"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/e2e-selftest.XXXXXX")

PASS=0
FAIL=0
MOCK_PID=''
PROXY_PID=''

stop_pid() {
    local pid=$1 winpid=''
    [ -n "$pid" ] || return 0
    # Git Bash 的 PID 与 Windows PID 不同；taskkill 需要 WINPID。
    winpid=$(ps -W 2>/dev/null | awk -v p="$pid" '$1 == p { print $4; exit }')
    if [ -n "$winpid" ] && command -v taskkill >/dev/null 2>&1 &&
       taskkill //PID "$winpid" //T //F >/dev/null 2>&1; then
        wait "$pid" 2>/dev/null || true
    else
        kill "$pid" 2>/dev/null || true
    fi
}

cleanup() {
    stop_pid "$PROXY_PID"
    stop_pid "$MOCK_PID"
    rm -rf "$TMP"
}
trap cleanup EXIT

command -v node >/dev/null 2>&1 || { echo "self-test: 缺少 node" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "self-test: 缺少 curl" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "self-test: 缺少 jq" >&2; exit 1; }

# 清掉可能影响默认值的外部配置，保证测的是技能默认行为。
unset E2E_TOKEN_FILE E2E_LOG_FILE E2E_FAILURE_JQ E2E_REDACT_KEYS_JSON E2E_REDACT_KEY_PATTERN
unset E2E_SUCCESS_CODE E2E_TOKEN_FILE_CREATED E2E_DELETE_TOKEN_FILE E2E_EVIDENCE_FILE

node "$MOCK" --port-file "$TMP/mock.port" >"$TMP/mock.log" 2>&1 &
MOCK_PID=$!

for _ in $(seq 1 100); do
    [ -s "$TMP/mock.port" ] && break
    sleep 0.1
done
if [ ! -s "$TMP/mock.port" ]; then
    echo "self-test: mock server 未启动" >&2
    cat "$TMP/mock.log" >&2
    exit 1
fi
MOCK_PORT=$(cat "$TMP/mock.port")

PROXY_PORT=$(node -e '
const net = require("node:net");
const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(String(server.address().port));
  server.close();
});
')
cat >"$TMP/proxy-config.json" <<EOF
{
  "listenHost": "127.0.0.1",
  "listenPort": $PROXY_PORT,
  "routes": [
    {
      "name": "selftest",
      "prefix": "/appgw/svc",
      "target": "http://127.0.0.1:$MOCK_PORT"
    }
  ]
}
EOF

node "$PROXY" --config "$TMP/proxy-config.json" >"$TMP/proxy.log" 2>&1 &
PROXY_PID=$!

ready=0
for _ in $(seq 1 50); do
    code=$(curl -s -o /dev/null -w '%{http_code}' \
        "http://127.0.0.1:$PROXY_PORT/__local_gateway/health" 2>/dev/null || true)
    if [ "$code" = "200" ]; then
        ready=1
        break
    fi
    sleep 0.1
done
if [ "$ready" != "1" ]; then
    echo "self-test: 代理未就绪" >&2
    cat "$TMP/proxy.log" >&2
    exit 1
fi

export E2E_BASE_URL="http://127.0.0.1:$PROXY_PORT/appgw/svc"
export E2E_TOKEN='selftest-token'
export E2E_REQUIRE_JSON=1
export E2E_REQUIRE_CODE=1
export E2E_DELETE_TOKEN_FILE=0

source "$LIB"

run_case() {
    local name=$1
    shift
    local log="$TMP/case-$name.log" status
    ( "$@" ) >"$log" 2>&1
    status=$?
    if [ "$status" -eq 0 ]; then
        printf 'PASS %s\n' "$name"
        PASS=$((PASS + 1))
    else
        printf 'FAIL %s\n' "$name"
        FAIL=$((FAIL + 1))
        sed 's/^/    /' "$log"
    fi
}

assert_not_matches() { # file pattern
    if grep -q -- "$2" "$1"; then
        printf 'unexpected match: %s in %s\n' "$2" "$1" >&2
        return 1
    fi
    return 0
}

# R1：代理请求日志保留 query 键名，但不输出值。
r1_proxy_query_log() {
    set -e
    local resp
    resp=$(curl -sS "http://127.0.0.1:$PROXY_PORT/appgw/svc/echo?token=SECRET&page=1")
    printf '%s' "$resp" | grep -q 'token=SECRET'
    sleep 0.3
    grep -q '\[proxy\].*echo' "$TMP/proxy.log"
    grep -q 'token' "$TMP/proxy.log"
    grep -q 'page' "$TMP/proxy.log"
    ! grep -q 'SECRET' "$TMP/proxy.log"
}

# R3：accessToken / refreshToken / cookie / 嵌套 password / dbPassword 不进证据。
r3_redaction() {
    set -e
    export E2E_EVIDENCE_FILE="$TMP/r3.evidence"
    export E2E_PASS=0 E2E_FAIL=0
    trap 'e2e_done' EXIT
    e2e_init >/dev/null
    local http
    http=$(e2e_request GET /ok '' "$TMP/r3.json")
    [ "$http" = "200" ]
    assert_not_matches "$E2E_EVIDENCE_FILE" 'AT-SECRET'
    assert_not_matches "$E2E_EVIDENCE_FILE" 'RT-SECRET'
    assert_not_matches "$E2E_EVIDENCE_FILE" 'COOKIE-SECRET'
    assert_not_matches "$E2E_EVIDENCE_FILE" 'PWD-SECRET'
    assert_not_matches "$E2E_EVIDENCE_FILE" 'DB-SECRET'
    grep -q 'visible' "$E2E_EVIDENCE_FILE"
    grep -q 'AT-SECRET' "$TMP/r3.json"
}

# R4a：字符串 code "20000" 不误判失败。
r4a_string_code() {
    set -e
    export E2E_EVIDENCE_FILE="$TMP/r4a.evidence"
    export E2E_PASS=0 E2E_FAIL=0
    trap 'e2e_done' EXIT
    e2e_init >/dev/null
    local http
    http=$(e2e_request GET /string-code '' "$TMP/r4a.json")
    [ "$http" = "200" ]
    ! grep -q 'failure delta' "$E2E_EVIDENCE_FILE"
}

# R4b：数字 code 20000 正常。
r4b_numeric_code() {
    set -e
    export E2E_EVIDENCE_FILE="$TMP/r4b.evidence"
    export E2E_PASS=0 E2E_FAIL=0
    trap 'e2e_done' EXIT
    e2e_init >/dev/null
    local http
    http=$(e2e_request GET /ok '' "$TMP/r4b.json")
    [ "$http" = "200" ]
    ! grep -q 'failure delta' "$E2E_EVIDENCE_FILE"
}

# R4c：业务失败进入 failure delta。
r4c_business_failure() {
    set -e
    export E2E_EVIDENCE_FILE="$TMP/r4c.evidence"
    export E2E_PASS=0 E2E_FAIL=0
    trap 'e2e_done' EXIT
    e2e_init >/dev/null
    local http
    http=$(e2e_request GET /bad-code '' "$TMP/r4c.json")
    [ "$http" = "200" ]
    grep -q 'failure delta' "$E2E_EVIDENCE_FILE"
    grep -q 'business failure predicate matched' "$E2E_EVIDENCE_FILE"
}

# R4d：非法 E2E_FAILURE_JQ 在 init 阶段失败。
r4d_invalid_failure_jq() {
    local out
    export E2E_EVIDENCE_FILE="$TMP/r4d.evidence"
    export E2E_FAILURE_JQ='(('
    if out=$(e2e_init 2>&1); then
        return 1
    fi
    printf '%s' "$out" | grep -q 'E2E_FAILURE_JQ 不是合法 jq 表达式'
}

# R5a：200 + HTML 时 REQUIRE_JSON 让响应进入 failure delta。
r5a_non_json_200() {
    set -e
    export E2E_EVIDENCE_FILE="$TMP/r5a.evidence"
    export E2E_PASS=0 E2E_FAIL=0
    export E2E_REQUIRE_JSON=1 E2E_REQUIRE_CODE=0
    trap 'e2e_done' EXIT
    e2e_init >/dev/null
    local http
    http=$(e2e_request GET /html '' "$TMP/r5a.html")
    [ "$http" = "200" ]
    grep -q 'response is not valid JSON' "$E2E_EVIDENCE_FILE"
}

# R5b：200 + 缺 code 时 REQUIRE_CODE 让响应进入 failure delta。
r5b_missing_code_200() {
    set -e
    export E2E_EVIDENCE_FILE="$TMP/r5b.evidence"
    export E2E_PASS=0 E2E_FAIL=0
    export E2E_REQUIRE_JSON=0 E2E_REQUIRE_CODE=1
    trap 'e2e_done' EXIT
    e2e_init >/dev/null
    local http
    http=$(e2e_request GET /no-code '' "$TMP/r5b.json")
    [ "$http" = "200" ]
    grep -q 'response has no code' "$E2E_EVIDENCE_FILE"
}

# R5c：非法 JSON 的占位符断言必须 FAIL，而不是因 jq 失败而 PASS。
r5c_placeholder_invalid_json() {
    set -e
    export E2E_EVIDENCE_FILE="$TMP/r5c.evidence"
    export E2E_PASS=0 E2E_FAIL=0 E2E_REQUIRE_JSON=0 E2E_REQUIRE_CODE=0
    trap 'e2e_done' EXIT
    e2e_init >/dev/null
    local http
    http=$(e2e_request GET /invalid-json '' "$TMP/r5c.json")
    [ "$http" = "200" ]
    e2e_assert_no_placeholders 'invalid json' "$TMP/r5c.json"
    [ "$E2E_FAIL" -eq 1 ]
    grep -q '响应不是合法 JSON' "$E2E_EVIDENCE_FILE"
}

# R5d：正常 JSON 中的 %s 占位符被断言捕获。
r5d_placeholder_found() {
    set -e
    export E2E_EVIDENCE_FILE="$TMP/r5d.evidence"
    export E2E_PASS=0 E2E_FAIL=0 E2E_REQUIRE_JSON=0 E2E_REQUIRE_CODE=0
    trap 'e2e_done' EXIT
    e2e_init >/dev/null
    local http
    http=$(e2e_request GET /placeholder '' "$TMP/r5d.json")
    [ "$http" = "200" ]
    e2e_assert_no_placeholders 'placeholder' "$TMP/r5d.json"
    [ "$E2E_FAIL" -eq 1 ]
    grep -q '发现未格式化占位符' "$E2E_EVIDENCE_FILE"
}

# R5e：正常文案不误报。
r5e_placeholder_clean() {
    set -e
    export E2E_EVIDENCE_FILE="$TMP/r5e.evidence"
    export E2E_PASS=0 E2E_FAIL=0 E2E_REQUIRE_JSON=0 E2E_REQUIRE_CODE=0
    trap 'e2e_done' EXIT
    e2e_init >/dev/null
    local http
    http=$(e2e_request GET /clean '' "$TMP/r5e.json")
    [ "$http" = "200" ]
    e2e_assert_no_placeholders 'clean' "$TMP/r5e.json"
    [ "$E2E_FAIL" -eq 0 ]
    [ "$E2E_PASS" -eq 1 ]
}

# R2a：用户已有 token 文件默认保留。
r2a_token_preserved() {
    set -e
    export E2E_TOKEN_FILE="$TMP/token-preserve"
    printf 'selftest-token\n' >"$E2E_TOKEN_FILE"
    unset E2E_TOKEN
    export E2E_TOKEN_FILE_CREATED=0 E2E_DELETE_TOKEN_FILE=1
    export E2E_EVIDENCE_FILE="$TMP/r2a.evidence"
    export E2E_PASS=0 E2E_FAIL=0
    trap 'e2e_done' EXIT
    e2e_init >/dev/null 2>&1
    e2e_done
    [ -f "$E2E_TOKEN_FILE" ]
}

# R2b：本轮创建的 token 文件在 CREATED=1 时删除。
r2b_owned_token_deleted() {
    set -e
    export E2E_TOKEN_FILE="$TMP/token-delete"
    printf 'selftest-token\n' >"$E2E_TOKEN_FILE"
    unset E2E_TOKEN
    export E2E_TOKEN_FILE_CREATED=1 E2E_DELETE_TOKEN_FILE=1
    export E2E_EVIDENCE_FILE="$TMP/r2b.evidence"
    export E2E_PASS=0 E2E_FAIL=0
    trap 'e2e_done' EXIT
    e2e_init >/dev/null 2>&1
    e2e_done
    [ ! -f "$E2E_TOKEN_FILE" ]
}

# R2c：仅 E2E_TOKEN 也能运行，不需要 token 文件。
r2c_env_token_only() {
    set -e
    unset E2E_TOKEN_FILE
    export E2E_TOKEN='selftest-token'
    export E2E_TOKEN_FILE_CREATED=0 E2E_DELETE_TOKEN_FILE=1
    export E2E_EVIDENCE_FILE="$TMP/r2c.evidence"
    export E2E_PASS=0 E2E_FAIL=0
    trap 'e2e_done' EXIT
    e2e_init >/dev/null 2>&1
    e2e_done
    [ -z "${E2E_TOKEN:-}" ]
}

run_case r1_proxy_query_log r1_proxy_query_log
run_case r3_redaction r3_redaction
run_case r4a_string_code r4a_string_code
run_case r4b_numeric_code r4b_numeric_code
run_case r4c_business_failure r4c_business_failure
run_case r4d_invalid_failure_jq r4d_invalid_failure_jq
run_case r5a_non_json_200 r5a_non_json_200
run_case r5b_missing_code_200 r5b_missing_code_200
run_case r5c_placeholder_invalid_json r5c_placeholder_invalid_json
run_case r5d_placeholder_found r5d_placeholder_found
run_case r5e_placeholder_clean r5e_placeholder_clean
run_case r2a_token_preserved r2a_token_preserved
run_case r2b_owned_token_deleted r2b_owned_token_deleted
run_case r2c_env_token_only r2c_env_token_only

printf 'SELF-TEST pass=%d fail=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
