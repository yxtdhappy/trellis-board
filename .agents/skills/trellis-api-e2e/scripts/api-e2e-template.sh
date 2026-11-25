#!/usr/bin/env bash
# 接口 E2E 用例模板：复制本文件后替换占位符。
# 必填：E2E_BASE_URL；E2E_TOKEN_FILE 或 E2E_TOKEN 至少一个（推荐临时目录下的 token 文件）。
# token 由用户提供，不要写进本文件。
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
# 库文件与模板同目录；放在别处时用 E2E_LIB 指定绝对路径。
source "${E2E_LIB:-$HERE/api-e2e-lib.sh}"

E2E_BASE_URL=${E2E_BASE_URL:-'http://localhost:<port><context-path>'}
E2E_LOG_FILE=${E2E_LOG_FILE:-'/path/to/backend.log'}
E2E_EVIDENCE_FILE=${E2E_EVIDENCE_FILE:-"$HERE/evidence/api-e2e-$(date +%Y%m%d-%H%M%S).log"}
E2E_REQUIRE_JSON=${E2E_REQUIRE_JSON:-1}
E2E_REQUIRE_CODE=${E2E_REQUIRE_CODE:-1}
# 若本脚本创建了 E2E_TOKEN_FILE，设置 E2E_TOKEN_FILE_CREATED=1 允许 e2e_done 删除。

e2e_init || exit 1

RUN_DIR=$(mktemp -d)
PREFIX="E2E_$(date +%Y%m%d%H%M%S)"
ID=''

cleanup() {
    if [ -n "$ID" ]; then
        e2e_post /delete "$(jq -n --arg id "$ID" '{id:$id}')" "$RUN_DIR/delete.json" >/dev/null
    fi
    rm -rf "$RUN_DIR"
    e2e_done
}
trap cleanup EXIT

# 1. 创建（替换字段为被测接口契约）
CREATE=$(jq -n --arg name "$PREFIX" \
    '{name:$name, type:"<TYPE>", url:"<URL>", pwd:"<PWD>"}')
e2e_post /save "$CREATE" "$RUN_DIR/save.json" >/dev/null

# 复杂/中文请求体：先 Write 到 $RUN_DIR/body.json，再 e2e_post_file /save "$RUN_DIR/body.json" "$RUN_DIR/save.json"
e2e_assert_code "创建成功" 20000 "$RUN_DIR/save.json"
e2e_assert_no_placeholders "创建响应文案无占位符" "$RUN_DIR/save.json"
ID=$(e2e_data "$RUN_DIR/save.json")
e2e_assert_true "返回主键" "$([ -n "$ID" ] && echo 1 || echo 0)"

# 2. 查询并核对回填
e2e_post /list '{}' "$RUN_DIR/list.json" >/dev/null
CARD=$(e2e_item "$RUN_DIR/list.json" "$ID")
e2e_assert_eq "列表可见" "$(printf '%s' "$CARD" | jq -r '.id // empty')" "$ID"
e2e_assert_eq "回填名称" "$(printf '%s' "$CARD" | jq -r '.name // empty')" "$PREFIX"
e2e_assert_eq "删除前按前缀可见" \
    "$(jq -r --arg p "$PREFIX" "(.data.${E2E_LIST_KEY} // []) | map(select(.name | startswith(\$p))) | length" "$RUN_DIR/list.json")" 1

# 3. 边界：上限-1 / 上限 / 上限+1（按需取消注释）
# OK=$(printf 'a%.0s' $(seq 1 100))
# BAD=$(printf 'a%.0s' $(seq 1 101))
# EDIT=$(jq -n --arg id "$ID" --arg v "$OK" '{id:$id,loadUrl:$v}')
# e2e_post /save "$EDIT" "$RUN_DIR/ok.json" >/dev/null
# e2e_assert_code "上限内保存成功" 20000 "$RUN_DIR/ok.json"
# EDIT=$(jq -n --arg id "$ID" --arg v "$BAD" '{id:$id,loadUrl:$v}')
# e2e_post /save "$EDIT" "$RUN_DIR/bad.json" >/dev/null
# e2e_assert_true "超限被拒绝" "$([ "$(jq -r '.ok' "$RUN_DIR/bad.json")" = false ] && echo 1 || echo 0)"

# 4. 反向与清理（删除后确认列表 0 条）
e2e_post /delete "$(jq -n --arg id "$ID" '{id:$id}')" "$RUN_DIR/delete.json" >/dev/null
e2e_assert_code "删除成功" 20000 "$RUN_DIR/delete.json"
ID=''
e2e_post /list '{}' "$RUN_DIR/final.json" >/dev/null
e2e_assert_eq "无残留" \
    "$(jq -r --arg p "$PREFIX" "(.data.${E2E_LIST_KEY} // []) | map(select(.name | startswith(\$p))) | length" "$RUN_DIR/final.json")" 0

e2e_summary