#!/usr/bin/env bash
# 接口级 E2E 通用库。用例脚本先 source 本文件，再调用 e2e_init。
#
# 必填环境变量：
#   E2E_BASE_URL       例：http://localhost:8855/mdp-backend-service
#   E2E_TOKEN_FILE     用户提供的测试 token 文件（推荐）；与 E2E_TOKEN 同时存在时优先使用本文件
#   E2E_TOKEN          仅作兼容：未设置 E2E_TOKEN_FILE 时直接放环境变量
# 可选环境变量：
#   E2E_AUTH_HEADER    默认 Weareint-Token
#   E2E_LOG_FILE       后端日志路径；不设则不做日志增量证据
#   E2E_EVIDENCE_FILE  证据文件；不设则只输出到 stdout
#   E2E_LOG_GREP       日志增量过滤正则；默认 AccessLog|traceId|ERROR|WARN|Exception|Caused by
#   E2E_FAILURE_LOG_LINES 失败请求最多输出的日志行数；默认 200
#   E2E_SUCCESS_CODE   业务成功码；默认 20000（WIT Result）。非 WIT 项目需覆盖
#   E2E_FAILURE_JQ     判定业务失败的 jq 表达式；为空时按 E2E_SUCCESS_CODE 生成（字符串/数字 code 都安全）
#   E2E_DELETE_TOKEN_FILE 设为 0 时保留 E2E_TOKEN_FILE；默认 1（仅删除本轮创建的文件）
#   E2E_TOKEN_FILE_CREATED 设为 1 表示 token 文件由本轮脚本创建，结束时才允许删除；默认 0
#   E2E_REQUIRE_JSON   设为 1 时，非 JSON 响应进入 failure delta；默认 0（模板默认 1）
#   E2E_REQUIRE_CODE   设为 1 时，响应缺少 code 进入 failure delta；默认 0（模板默认 1）
#   E2E_LIST_KEY       列表接口 data 下的数组键；默认 list
#   E2E_RESP_SELECTOR  证据里记录的响应字段；默认 {code,msgCode,msg,ok,data}
#   E2E_REDACT_KEYS_JSON 递归脱敏的精确键名 JSON 数组；默认 ["pwd","password","passwd","token","secret"]
#   E2E_REDACT_KEY_PATTERN 递归脱敏的键名正则；默认覆盖 pwd/passw/secret/token/cookie/authorization 等
#   E2E_PLACEHOLDER_PATTERN 未格式化占位符正则；默认 '\{[0-9]+\}|%[sd]'
#   E2E_CURL_TIMEOUT   curl 总超时秒数；默认 60
#   E2E_CONNECT_TIMEOUT curl 连接超时秒数；默认 5

E2E_AUTH_HEADER=${E2E_AUTH_HEADER:-Weareint-Token}
E2E_LOG_GREP=${E2E_LOG_GREP:-'AccessLog|traceId|ERROR|WARN|Exception|Caused by'}
E2E_FAILURE_LOG_LINES=${E2E_FAILURE_LOG_LINES:-200}
E2E_SUCCESS_CODE=${E2E_SUCCESS_CODE:-20000}
E2E_FAILURE_JQ=${E2E_FAILURE_JQ:-}
E2E_DELETE_TOKEN_FILE=${E2E_DELETE_TOKEN_FILE:-1}
E2E_TOKEN_FILE_CREATED=${E2E_TOKEN_FILE_CREATED:-0}
E2E_REQUIRE_JSON=${E2E_REQUIRE_JSON:-0}
E2E_REQUIRE_CODE=${E2E_REQUIRE_CODE:-0}
E2E_LIST_KEY=${E2E_LIST_KEY:-list}
E2E_RESP_SELECTOR=${E2E_RESP_SELECTOR:-'{code,msgCode,msg,ok,data}'}
E2E_REDACT_KEYS_JSON=${E2E_REDACT_KEYS_JSON:-'["pwd","password","passwd","token","secret"]'}
E2E_REDACT_KEY_PATTERN=${E2E_REDACT_KEY_PATTERN:-'(pwd|passw|secret|token|cookie|authorization|credential|privatekey|sessionid)'}
E2E_CURL_TIMEOUT=${E2E_CURL_TIMEOUT:-60}
E2E_CONNECT_TIMEOUT=${E2E_CONNECT_TIMEOUT:-5}
E2E_PASS=0
E2E_FAIL=0

e2e_write() {
    # 证据走 stderr：stdout 只留给 e2e_request 返回的 HTTP 状态码，
    # 这样 HTTP=$(e2e_get ...) 不会被多行证据污染。
    if [ -n "${E2E_EVIDENCE_FILE:-}" ]; then
        tee -a "$E2E_EVIDENCE_FILE" >&2
    else
        cat >&2
    fi
}

e2e_say() { printf '%s\n' "$*" | e2e_write; }

# 递归删除请求/响应中的敏感字段，避免嵌套 password/token 进入证据。
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

e2e_make_header_file() {
    E2E_HEADER_FILE=$(mktemp "${TMPDIR:-/tmp}/e2e-header.XXXXXX") || return 1
    chmod 600 "$E2E_HEADER_FILE" 2>/dev/null || true
    printf '%s: %s\n' "$E2E_AUTH_HEADER" "$E2E_TOKEN" > "$E2E_HEADER_FILE" || {
        rm -f "$E2E_HEADER_FILE"
        E2E_HEADER_FILE=''
        return 1
    }
}

e2e_cleanup_header_file() {
    if [ -n "${E2E_HEADER_FILE:-}" ] && [ -f "$E2E_HEADER_FILE" ]; then
        rm -f "$E2E_HEADER_FILE"
    fi
    E2E_HEADER_FILE=''
}

e2e_init() {
    local missing=0 env_token=${E2E_TOKEN:-}
    [ -n "${E2E_BASE_URL:-}" ] || { echo "e2e_init: 缺少 E2E_BASE_URL" >&2; missing=1; }
    command -v curl >/dev/null 2>&1 || { echo "e2e_init: 缺少 curl" >&2; return 1; }
    command -v jq >/dev/null 2>&1 || { echo "e2e_init: 缺少 jq" >&2; return 1; }
    if [ -n "${E2E_TOKEN_FILE:-}" ]; then
        [ -f "$E2E_TOKEN_FILE" ] || {
            echo "e2e_init: token 文件不存在: $E2E_TOKEN_FILE" >&2
            return 1
        }
        if [ -n "$env_token" ]; then
            echo "e2e_init: 警告: 同时设置了 E2E_TOKEN 与 E2E_TOKEN_FILE，按规则使用 E2E_TOKEN_FILE" >&2
        fi
        E2E_TOKEN=$(tr -d '\000\r\n' < "$E2E_TOKEN_FILE" 2>/dev/null) || true
        # 去掉编辑器/DLP 可能写入的 UTF-8 BOM 和首尾空白。
        E2E_TOKEN=${E2E_TOKEN#$'\xEF\xBB\xBF'}
        E2E_TOKEN=$(printf '%s' "$E2E_TOKEN" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    elif [ -n "$env_token" ]; then
        E2E_TOKEN=$env_token
        echo "e2e_init: 警告: 使用 E2E_TOKEN 会把凭据留在命令行/环境记录中，建议改用 E2E_TOKEN_FILE" >&2
    else
        echo "e2e_init: 需要 E2E_TOKEN_FILE（推荐）或 E2E_TOKEN" >&2
        missing=1
    fi
    [ "$missing" = 0 ] || return 1
    [ -n "${E2E_TOKEN:-}" ] || { echo "e2e_init: token 为空或文件不可读" >&2; return 1; }
    if [ -n "${E2E_LOG_FILE:-}" ] && [ ! -f "$E2E_LOG_FILE" ]; then
        echo "e2e_init: 日志文件不存在: $E2E_LOG_FILE" >&2
        return 1
    fi
    local flag jq_version major minor rest code_json
    for flag in E2E_DELETE_TOKEN_FILE E2E_TOKEN_FILE_CREATED E2E_REQUIRE_JSON E2E_REQUIRE_CODE; do
        case "${!flag}" in
            0|1) ;;
            *) echo "e2e_init: $flag 必须是 0 或 1: ${!flag}" >&2; return 1 ;;
        esac
    done
    jq_version=$(jq --version 2>/dev/null) || {
        echo "e2e_init: 无法读取 jq 版本" >&2
        return 1
    }
    jq_version=${jq_version#jq-}
    major=${jq_version%%.*}
    rest=${jq_version#*.}
    minor=${rest%%.*}
    case "$major" in ''|*[!0-9]*) echo "e2e_init: 无法解析 jq 版本: $jq_version" >&2; return 1 ;; esac
    case "$minor" in ''|*[!0-9]*) echo "e2e_init: 无法解析 jq 版本: $jq_version" >&2; return 1 ;; esac
    if [ "$major" -lt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -lt 6 ]; }; then
        echo "e2e_init: 需要 jq >= 1.6（walk 支持），当前: $jq_version" >&2
        return 1
    fi
    jq -e 'type == "array" and all(.[]; type == "string")' <<<"$E2E_REDACT_KEYS_JSON" >/dev/null 2>&1 || {
        echo "e2e_init: E2E_REDACT_KEYS_JSON 必须是字符串数组: $E2E_REDACT_KEYS_JSON" >&2
        return 1
    }
    jq -n --arg p "$E2E_REDACT_KEY_PATTERN" '"" | test($p)' >/dev/null 2>&1 || {
        echo "e2e_init: E2E_REDACT_KEY_PATTERN 不是合法正则: $E2E_REDACT_KEY_PATTERN" >&2
        return 1
    }
    if [ -z "${E2E_FAILURE_JQ:-}" ]; then
        code_json=$(jq -Rn --arg code "$E2E_SUCCESS_CODE" '$code') || {
            echo "e2e_init: 无法生成默认失败判据" >&2
            return 1
        }
        E2E_FAILURE_JQ="((.ok == false) or (((.code? // $code_json) | tostring) != ($code_json | tostring)))"
    fi
    jq -n "$E2E_FAILURE_JQ" >/dev/null 2>&1 || {
        echo "e2e_init: E2E_FAILURE_JQ 不是合法 jq 表达式: $E2E_FAILURE_JQ" >&2
        return 1
    }
    e2e_cleanup_header_file
    e2e_make_header_file || { echo "e2e_init: 无法创建临时 header 文件" >&2; return 1; }
    if [ -n "${E2E_EVIDENCE_FILE:-}" ]; then
        mkdir -p "$(dirname "$E2E_EVIDENCE_FILE")"
        : > "$E2E_EVIDENCE_FILE"
    fi
    e2e_say "==== API E2E $(date '+%F %T') base=$E2E_BASE_URL ===="
}

# e2e_request <METHOD> <path> <json-body> <outfile> [body-file]；返回 HTTP 状态码
e2e_request() {
    local method=$1 path=$2 body=${3:-} out=$4 body_file=${5:-}
    local before='' after='' http='' safe='' delta='' curl_rc=0 resp='' failure_reason=''
    if [ -n "${E2E_LOG_FILE:-}" ] && [ -f "$E2E_LOG_FILE" ]; then
        before=$(wc -l < "$E2E_LOG_FILE")
    fi
    local -a args=(-sS --max-time "$E2E_CURL_TIMEOUT" --connect-timeout "$E2E_CONNECT_TIMEOUT"
        -o "$out" -w '%{http_code}' -X "$method"
        "$E2E_BASE_URL$path")
    if [ -n "${E2E_HEADER_FILE:-}" ]; then
        args+=(-H "@$E2E_HEADER_FILE")
    fi
    if [ "$method" != GET ] && [ "$method" != HEAD ]; then
        args+=(-H 'Content-Type: application/json')
        if [ -n "$body_file" ]; then
            args+=(--data-binary "@$body_file")
        else
            args+=(--data-binary "$body")
        fi
    fi
    http=$(curl "${args[@]}") || curl_rc=$?
    if [ "$curl_rc" -ne 0 ]; then
        http='000'
    fi
    if [ "$method" != GET ] && [ "$method" != HEAD ]; then
        if [ -n "$body_file" ]; then
            safe=$(e2e_redact_jq "$body_file" 2>/dev/null) || safe='<unredacted: invalid json>'
        elif [ -n "$body" ]; then
            safe=$(printf '%s' "$body" | e2e_redact_jq 2>/dev/null) || safe='<unredacted: invalid json>'
        fi
    fi
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
    if [ "$curl_rc" -ne 0 ]; then
        failure_reason="curl failed rc=$curl_rc; request may not have reached the service"
    elif [ "$http" -ge 400 ] 2>/dev/null; then
        failure_reason="HTTP $http"
    elif [ "${E2E_REQUIRE_JSON:-0}" = 1 ] && ! jq -e . "$out" >/dev/null 2>&1; then
        failure_reason='response is not valid JSON'
    elif [ "${E2E_REQUIRE_CODE:-0}" = 1 ] &&
         ! jq -e 'type == "object" and has("code")' "$out" >/dev/null 2>&1; then
        failure_reason='response has no code'
    elif jq -e "$E2E_FAILURE_JQ" "$out" >/dev/null 2>&1; then
        failure_reason='business failure predicate matched'
    fi
    {
        printf -- '---- %s %s %s HTTP=%s\n' "$(date '+%F %T')" "$method" "$path" "$http"
        [ -n "$safe" ] && printf 'REQ  %s\n' "$safe"
        printf 'RESP %s\n' "$resp"
        if [ -n "$before" ]; then
            after=$(wc -l < "$E2E_LOG_FILE" 2>/dev/null || printf '%s' "$before")
            if [ "$after" -lt "$before" ]; then
                printf 'LOG  log rotated or truncated; showing last %s lines\n' "$E2E_FAILURE_LOG_LINES"
                delta=$(tail -n "$E2E_FAILURE_LOG_LINES" "$E2E_LOG_FILE")
            else
                delta=$(sed -n "$((before + 1)),${after}p" "$E2E_LOG_FILE")
            fi
        fi
        if [ -n "$failure_reason" ]; then
            printf 'LOG  failure delta (%s; last %s lines)\n' "$failure_reason" "$E2E_FAILURE_LOG_LINES"
            [ -n "$delta" ] && printf '%s\n' "$delta" | tail -n "$E2E_FAILURE_LOG_LINES"
        elif [ -n "$delta" ]; then
            printf '%s\n' "$delta" | grep -E "$E2E_LOG_GREP" || true
        fi
    } | e2e_write
    printf '%s' "$http"
}

e2e_post() {
    local body=${2:-}
    [ -n "$body" ] || body='{}'
    e2e_request POST "$1" "$body" "$3"
}
e2e_get() { e2e_request GET "$1" '' "$2"; }

# e2e_post_file <path> <json-file> <outfile>；复杂/中文/大请求体走文件字节流
e2e_post_file() {
    [ -f "$2" ] || { echo "e2e_post_file: 文件不存在: $2" >&2; return 1; }
    jq -e . "$2" >/dev/null 2>&1 || {
        echo "e2e_post_file: 非法 JSON: $2" >&2
        return 1
    }
    e2e_request POST "$1" '' "$3" "$2"
}

e2e_assert_json_file() { # desc json-file
    if jq -e . "$2" >/dev/null 2>&1; then
        E2E_PASS=$((E2E_PASS + 1)); e2e_say "PASS  $1"
    else
        E2E_FAIL=$((E2E_FAIL + 1)); e2e_say "FAIL  $1 (非法 JSON: $2)"
    fi
}

e2e_data() { jq -r '.data // empty | tostring' "$1"; }

# e2e_item <list-response-file> <id>
e2e_item() {
    jq -c --arg id "$2" \
        "(.data.${E2E_LIST_KEY} // [])[] | select((.id | tostring) == \$id)" "$1" 2>/dev/null
}

e2e_assert_eq() { # desc actual expected
    if [ "$2" = "$3" ]; then
        E2E_PASS=$((E2E_PASS + 1)); e2e_say "PASS  $1"
    else
        E2E_FAIL=$((E2E_FAIL + 1)); e2e_say "FAIL  $1 (actual=$2 expected=$3)"
    fi
}

e2e_assert_code() { # desc expected-code response-file
    local actual
    actual=$(jq -r '.code // "missing"' "$3" 2>/dev/null)
    e2e_assert_eq "$1" "$actual" "$2"
}

e2e_assert_contains() { # desc text needle
    case "$2" in
        *"$3"*) E2E_PASS=$((E2E_PASS + 1)); e2e_say "PASS  $1" ;;
        *) E2E_FAIL=$((E2E_FAIL + 1)); e2e_say "FAIL  $1 (未包含: $3)" ;;
    esac
}

e2e_assert_true() { e2e_assert_eq "$1" "${2:-0}" 1; }

# 检查错误/问题文案里是否残留 {0}、%s 等未格式化占位符。
e2e_assert_no_placeholders() { # desc response-file
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
        E2E_FAIL=$((E2E_FAIL + 1)); e2e_say "FAIL  $1 (发现未格式化占位符: $(printf '%s' "$hits" | tr '\n' ' '))"
    fi
}

e2e_summary() {
    e2e_say "==== RESULT pass=$E2E_PASS fail=$E2E_FAIL ===="
    [ "$E2E_FAIL" -eq 0 ]
}

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