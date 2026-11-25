# Implement：trellis-api-e2e 初始化分发与后端任务流程接入

## 0. 前置

- 任务处于 planning；本文档和三份 artifact 经用户 review 后，再执行 `task.py start`。
- 当前 active 任务是父任务 `11-23-trellis-workflow-evidence-loop`（in_progress）。启动本子任务前需要父任务收尾/归档，或由用户确认切换 active；本任务不擅自改父任务状态。
- 不构建、不访问真实后端、不使用真实 token、不提交/推送。
- 工作区其他无关改动（`packages/*`、`plugins/*`、`.trellis/scripts/*` 等）保持原状，不纳入本任务。

## 1. 复制并重命名技能源

目标：仓库 `.agents/skills/trellis-api-e2e/` 成为 kit 的单一来源。

```bash
SRC="C:/Users/yuhaojie/.claude/skills/wit-api-e2e"
DST="D:/wit/trellis-board/.agents/skills/trellis-api-e2e"
test -d "$SRC"
test ! -e "$DST"
cp -R "$SRC" "$DST"
find "$DST" -type f | sort

# 2) 重命名为 Trellis 内置技能（脚本文件名不变）
sed -i 's/wit-api-e2e/trellis-api-e2e/g' \
  "$DST/SKILL.md" "$DST"/references/*.md "$DST"/scripts/*.sh \
  "$DST"/scripts/*.ps1 "$DST"/scripts/*.mjs "$DST"/scripts/self-test/*
grep -RIn 'wit-api-e2e' "$DST" || true
grep -n '^name:' "$DST/SKILL.md"
grep -n '^description:' "$DST/SKILL.md"
```

期望：14 个文件，包含：

```text
SKILL.md
references/api-e2e-playbook.md
references/local-forwarding-proxy.md
references/log-sources.md
references/report-template.md
scripts/api-e2e-lib.sh
scripts/api-e2e-lib.ps1
scripts/api-e2e-template.sh
scripts/api-e2e-template.ps1
scripts/local-gateway-proxy.mjs
scripts/read-log-delta.ps1
scripts/self-test/mock-server.mjs
scripts/self-test/run.sh
scripts/self-test/run.ps1
```

重命名检查：

```bash
head -10 "$DST/SKILL.md"          # name: trellis-api-e2e
grep -RIn 'wit-api-e2e' "$DST" || true   # 期望无输出
```

检查无 `.e2e-token`、`evidence/`、真实主机地址、真实 token：

```bash
grep -RInE 'BEGIN (RSA|OPENSSH) PRIVATE KEY|Bearer [A-Za-z0-9._-]{20,}|10\.[0-9]+\.[0-9]+\.[0-9]+' "$DST" || true
```

执行记录：待填（文件数、检查结果）。

## 2. 扩展分发代码

### 2.1 manifest

`trellis-kit/manifest.json`：

- `version` 从 `0.2.0` 改为 `0.3.0`。
- 在 skill 组件附近加入：

```json
{
  "id": "trellis-api-e2e-skill",
  "kind": "skill",
  "source": ".agents/skills/trellis-api-e2e",
  "target": ".agents/skills/trellis-api-e2e",
  "directory": true
}
```

### 2.2 apply.py

按 `design.md` 第 4 节：

- 新增 `copy_tree(src_dir, dst_dir)`，复用 `copy_file`。
- 组件循环按 `component.get("directory")` 选择 `copy_tree` 或 `copy_file`。
- `--agent-only` 允许 `"skill"`。
- 平台循环新增 `directory_skills`，对每个非共享平台复制整目录；共享平台继续跳过。
- 目标根目录必须取 `platforms/registry.json` 的 `paths.skills`，禁止硬编码 `.claude`：
  - `claude-code` → `.claude/skills/trellis-api-e2e`
  - `opencode` → `.opencode/skills/trellis-api-e2e`
  - `omp` → `.omp/skills/trellis-api-e2e`
  - `antigravity` → `.agent/skills/trellis-api-e2e`
  - `codex` / `pi` / `dsh` → 共享 `.agents/skills/trellis-api-e2e`，不重复复制
- 未选择平台不创建目录；平台缺少 `paths.skills` 时记录并跳过，不回退到 `.claude`。

### 2.3 build_overlay.py

按 `design.md` 第 5 节：`directory: true` 用 `shutil.copytree(src, dst, dirs_exist_ok=True)`，否则保持单文件复制。

### 2.4 静态检查

```bash
python -m py_compile trellis-kit/apply.py trellis-kit/build_overlay.py
python -m json.tool trellis-kit/manifest.json >/dev/null
```

执行记录：待填（退出码）。

## 3. 流程与技能文案

### 3.1 workflow

编辑仓库 `.trellis/workflow.md`：

- Phase 2.2 下增加后端代码任务 API E2E 子项（design 6.1）。
- `[workflow-state:planning]` 增加规划提示（6.2）。
- `[workflow-state:in_progress]` 增加执行提示（6.3）。
- 不重排 2.3，避免外部引用失效。

### 3.2 trellis-check

编辑：

- `.agents/skills/trellis-check/SKILL.md`
- `.claude/skills/trellis-check/SKILL.md`（当前项目副本）
- overlay 的 `.agents/skills/trellis-check/SKILL.md` 由 `build_overlay.py` 同步；overlay 不需要 `.claude/skills` 副本，`apply.py` 会按平台从 `.agents` 动态复制。

在 Step 4 增加 `### Backend API E2E` 检查项（design 7.1）。

### 3.3 trellis-finish-work

编辑：

- `.agents/skills/trellis-finish-work/SKILL.md`
- `.claude/commands/trellis/finish-work.md`
- `trellis-kit/overlay/.claude/commands/trellis/finish-work.md`（手动同步）

在 Step 3 末尾增加报告提醒（design 7.2）。

### 3.4 README

`trellis-kit/README.md` 增加：

- 目录型技能（`directory: true`）说明。
- `trellis-api-e2e` 会随项目初始化安装。
- 已有项目补装命令示例。

### 3.5 生成 overlay

```bash
python trellis-kit/build_overlay.py
```

期望：overlay 中 `.agents/skills/trellis-api-e2e/` 14 个文件；`.trellis/workflow.md` 含新文案；`.agents/skills/trellis-check`、`trellis-finish-work` 同步。

执行记录：待填（sync 文件数、overlay 文件数）。

## 4. 验证

### 4.1 安装文件数

```bash
TMP1=$(mktemp -d)
python trellis-kit/apply.py --target "$TMP1" --agent-only
test "$(find "$TMP1/.agents/skills/trellis-api-e2e" -type f | wc -l)" -eq 14
test -f "$TMP1/.agents/skills/trellis-api-e2e/scripts/self-test/run.sh"
test -f "$TMP1/.agents/skills/trellis-api-e2e/scripts/self-test/run.ps1"
```

### 4.2 平台与 dry-run

```bash
TMP2=$(mktemp -d)
python trellis-kit/apply.py --target "$TMP2" --dry-run --platform claude-code
test -z "$(find "$TMP2" -type f -print -quit)"
python trellis-kit/apply.py --target "$TMP2" --platform claude-code
test "$(find "$TMP2/.claude/skills/trellis-api-e2e" -type f | wc -l)" -eq 14

# 非共享平台：各自的 paths.skills
for pair in "opencode:.opencode/skills" "omp:.omp/skills" "antigravity:.agent/skills"; do
  platform="${pair%%:*}"; root="${pair#*:}"
  TMP_P=$(mktemp -d)
  python trellis-kit/apply.py --target "$TMP_P" --platform "$platform"
  test "$(find "$TMP_P/$root/trellis-api-e2e" -type f | wc -l)" -eq 14
done

# 共享平台：只落 .agents/skills，不在平台目录重复
for pair in "codex:.codex/skills" "pi:.pi/skills" "dsh:.dsh/skills"; do
  platform="${pair%%:*}"; root="${pair#*:}"
  TMP_S=$(mktemp -d)
  python trellis-kit/apply.py --target "$TMP_S" --platform "$platform"
  test "$(find "$TMP_S/.agents/skills/trellis-api-e2e" -type f | wc -l)" -eq 14
  test ! -e "$TMP_S/$root/trellis-api-e2e"
done
```

### 4.3 冲突与覆盖

```bash
TMP3=$(mktemp -d)
python trellis-kit/apply.py --target "$TMP3" --agent-only >/dev/null
printf 'x\n' >> "$TMP3/.agents/skills/trellis-api-e2e/SKILL.md"
python trellis-kit/apply.py --target "$TMP3" --agent-only; test $? -ne 0
python trellis-kit/apply.py --target "$TMP3" --agent-only --force
```

### 4.4 文案与门禁零改动

```bash
grep -q "api-e2e-report.md" .trellis/workflow.md
grep -q "api-e2e-report.md" .agents/skills/trellis-check/SKILL.md
grep -q "api-e2e-report.md" .agents/skills/trellis-finish-work/SKILL.md
grep -q "api-e2e-report.md" trellis-kit/overlay/.trellis/workflow.md
git diff -- .trellis/scripts/task.py .trellis/scripts/common/task_store.py | test ! -s /dev/stdin
```

### 4.5 任务校验

```bash
python ./.trellis/scripts/task.py validate 11-25-integrate-api-e2e-workflow
```

期望：`implement.jsonl` / `check.jsonl` 合法，`validate` 通过。

执行记录（2026-11-25）：

| 检查 | 结果 |
| --- | --- |
| 技能文件数 | `.agents/skills/trellis-api-e2e` = 14；`.claude/skills/trellis-api-e2e` = 14；overlay = 14 |
| 重命名 | 三份 `SKILL.md` 均为 `name: trellis-api-e2e`；目录内无 `wit-api-e2e` 残留 |
| 技能自测 | Bash 14/14 通过；PowerShell 12/12 通过 |
| `apply.py --agent-only` | `.agents/skills/trellis-api-e2e` = 14 |
| `apply.py --platform claude-code` | `.claude/skills/trellis-api-e2e` = 14 |
| `apply.py --platform opencode/omp/antigravity` | 各自 `.opencode/skills`、`.omp/skills`、`.agent/skills` = 14 |
| `apply.py --platform codex/pi/dsh` | 共享 `.agents/skills` = 14；平台目录无重复 |
| dry-run | 目标目录无写入 |
| 冲突/覆盖 | 改动后无 `--force` 退出非 0；`--force` 后恢复 14 文件 |
| overlay | `trellis-kit/overlay/.agents/skills/trellis-api-e2e` = 14 |
| 文案 | workflow（仓库+overlay）、check、finish-work 均含 `api-e2e-report.md` |
| `task.py` 零改动 | `git diff -- .trellis/scripts/task.py .trellis/scripts/common/task_store.py` 为空 |
| `task.py validate` | implement/check 各 5 条，All validations passed |

说明：本任务不跑真实 API E2E；技能自测使用 mock 服务，不连接真实后端、不使用真实 token。

## 5. 收尾

- 更新本文件“执行记录”。
- 生成 `check-report.md`（按任务流程）。
- 确认未修改 `task.py` / `task_store.py`。
- 列出变更文件与验证输出，提交前请用户 review。
- 不提交、不推送，除非用户明确要求。

## 6. 回滚

- 代码回滚：`git checkout -- trellis-kit/apply.py trellis-kit/build_overlay.py trellis-kit/manifest.json trellis-kit/README.md`（仅在本任务提交前、且用户授权时；不使用破坏性 reset）。
- 文案回滚：恢复 `.trellis/workflow.md`、`trellis-check`、`trellis-finish-work` 及 overlay 对应文件。
- 技能源回滚：删除新增的 `.agents/skills/trellis-api-e2e/` 与 overlay 对应目录（新增目录，不涉及已有文件）。
- 不删除用户级 `C:/Users/yuhaojie/.claude/skills/wit-api-e2e`。
