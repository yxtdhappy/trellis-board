# Design：trellis-api-e2e 初始化分发与后端任务流程接入

## 1. 设计结论

采用“目录型技能组件 + 流程软要求”：

1. 在仓库 `.agents/skills/trellis-api-e2e/` 放置完整技能源（14 个文件），作为 kit 的单一来源。
2. 扩展 `trellis-kit/apply.py` 与 `build_overlay.py`，让 manifest 的 `directory: true` 组件按目录复制；不再只复制 `SKILL.md`。
3. 在 `.trellis/workflow.md` 的 Phase 2.2、`[workflow-state:planning]`、`[workflow-state:in_progress]` 写入后端代码任务的 API E2E 步骤；报告固定 `{TASK_DIR}/api-e2e-report.md`。
4. 在 `trellis-check` 和 `trellis-finish-work` 增加提醒；不修改 `task.py` / `task_store.py`，不新增 task.json 字段，不做硬门禁。

## 2. 目标文件

| 文件 | 改动 |
| --- | --- |
| `.agents/skills/trellis-api-e2e/**` | 新增完整技能源，14 个文件 |
| `trellis-kit/manifest.json` | 新增目录型组件，版本 0.2.0 → 0.3.0 |
| `trellis-kit/apply.py` | 支持 `directory: true`；平台循环复制目录技能 |
| `trellis-kit/build_overlay.py` | 支持目录组件同步到 overlay |
| `trellis-kit/overlay/.agents/skills/trellis-api-e2e/**` | 由 `build_overlay.py` 生成 |
| `trellis-kit/overlay/.trellis/workflow.md` | 由 `build_overlay.py` 从仓库同步 |
| `.trellis/workflow.md` | Phase 2.2 + 两个 workflow-state 提示 |
| `.agents/skills/trellis-check/SKILL.md` | 增加后端 API E2E 检查项 |
| `.claude/skills/trellis-check/SKILL.md` | 同步当前项目 Claude 副本 |
| `trellis-kit/overlay/.agents/skills/trellis-check/SKILL.md` | 由 build_overlay 同步 |
| `trellis-kit/overlay/.claude/skills/trellis-check/SKILL.md` | 不需要：apply.py 从 overlay 的 `.agents/skills` 动态复制到平台 skills |
| `.agents/skills/trellis-finish-work/SKILL.md` | Step 3 增加报告提醒 |
| `.claude/commands/trellis/finish-work.md` | 同步当前项目命令 |
| `trellis-kit/overlay/.agents/skills/trellis-finish-work/SKILL.md` | 由 build_overlay 同步 |
| `trellis-kit/overlay/.claude/commands/trellis/finish-work.md` | 手动同步 |
| `trellis-kit/README.md` | 目录技能与补装说明 |

## 3. 技能源与 manifest

### 3.1 技能源

从已加固的用户级 `C:/Users/yuhaojie/.claude/skills/wit-api-e2e/` 复制到仓库 `.agents/skills/trellis-api-e2e/`，并完成重命名：

- `SKILL.md` frontmatter 的 `name` 改为 `trellis-api-e2e`，`description` 以 `trellis-api-e2e` 开头并保留英文触发词。
- 技能正文、references、scripts 注释中的 `wit-api-e2e` 全部改为 `trellis-api-e2e`；脚本文件名保持不变（`api-e2e-*`），避免破坏内部引用。
- 在 SKILL.md 中明确：这是 Trellis 内置技能，由 trellis-kit 安装，不依赖用户级 skills。
- 复制前确认 14 个文件、无 `.e2e-token` / evidence / 临时文件、无真实主机地址；技能内部文档中的路径保持相对/通用，不写入用户主目录。
- 本任务只改仓库内技能源和分发；“Trellis 自带”不等于修改上游 `@mindfoldhq/trellis` npm 包。

文件清单：

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

### 3.2 manifest 组件

在现有 skill 组件附近加入：

```json
{
  "id": "trellis-api-e2e-skill",
  "kind": "skill",
  "source": ".agents/skills/trellis-api-e2e",
  "target": ".agents/skills/trellis-api-e2e",
  "directory": true
}
```

`kind: "skill"` 是新增类型，表示“可随 agent-only 安装的完整技能”；`directory: true` 是复制方式，不是新目录约定。版本升到 `0.3.0`。

## 4. apply.py

### 4.1 复制函数

新增 `copy_tree(src_dir, dst_dir)`，内部复用现有 `copy_file`，从而继承 `--dry-run`、`--force`、冲突检测、`written` 去重和“从不删除”：

```python
def copy_tree(src_dir: Path, dst_dir: Path) -> int:
    if not src_dir.is_dir():
        print(f"missing source directory: {src_dir}", file=sys.stderr)
        return 1
    for src in sorted(p for p in src_dir.rglob("*") if p.is_file()):
        rc = copy_file(src, dst_dir / src.relative_to(src_dir))
        if rc:
            return rc
    return 0
```

### 4.2 组件循环

```python
if component.get("directory"):
    rc = copy_tree(source / component["source"], target / component["target"])
else:
    rc = copy_file(source / component["source"], target / component["target"])
```

`agent_only` 允许列表增加 `"skill"`：

```python
if args.agent_only and kind not in ("core", "agent", "platform", "skill"):
    continue
```

### 4.3 平台循环

现有单文件 `skill_sources` 保持不变；新增目录技能列表：

```python
directory_skills = [
    c for c in manifest.get("components", [])
    if c.get("directory") and c.get("kind") == "skill" and not c.get("platform")
]
```

对每个非共享平台：

```python
for component in directory_skills:
    name = Path(component["source"]).name
    rc = copy_tree(source / component["source"], target / skill_root / name)
    if rc:
        return rc
```

共享 `.agents/skills` 的平台继续跳过，由 `.agents` 目标组件负责一次复制。目标根目录必须读取 `trellis-kit/platforms/registry.json` 的 `paths.skills`，不能硬编码 `.claude`。七平台矩阵：

| 平台 | skills 根目录 | 处理 |
| --- | --- | --- |
| `claude-code` | `.claude/skills` | 整目录复制到 `.claude/skills/trellis-api-e2e` |
| `codex` | `.agents/skills`（`sharedSkills`） | 只由共享 `.agents` 组件复制一次 |
| `opencode` | `.opencode/skills` | 整目录复制到 `.opencode/skills/trellis-api-e2e` |
| `pi` | `.agents/skills`（`sharedSkills`） | 只由共享 `.agents` 组件复制一次 |
| `omp` | `.omp/skills` | 整目录复制到 `.omp/skills/trellis-api-e2e` |
| `antigravity` | `.agent/skills` | 整目录复制到 `.agent/skills/trellis-api-e2e` |
| `dsh` | `.agents/skills`（`sharedSkills`） | 只由共享 `.agents` 组件复制一次 |

这样：

- `--agent-only` 无平台：只复制 `.agents/skills/trellis-api-e2e`。
- `--platform claude-code`：复制 `.agents`（若没有共享平台则跳过）+ `.claude/skills/trellis-api-e2e` 整目录。
- `--platform opencode`：复制 `.agents` + `.opencode/skills/trellis-api-e2e` 整目录。
- `--platform omp` / `antigravity`：分别复制到 `.omp/skills` / `.agent/skills`。
- 同时选择共享和非共享平台：`.agents` 只复制一次，非共享平台各复制一份。
- 未选择的平台不创建目录；某平台缺少 `paths.skills` 时记录并跳过，不硬编码回退。

## 5. build_overlay.py

组件循环从“必须 `is_file`”改为：

```python
if component.get("directory"):
    if not src.is_dir():
        raise SystemExit(f"missing source directory: {src}")
    shutil.copytree(src, dst, dirs_exist_ok=True)
else:
    if not src.is_file():
        raise SystemExit(f"missing source: {src}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
```

`copytree(..., dirs_exist_ok=True)` 保留 overlay 中已有但源已删除的文件；这与 kit “从不删除”的语义一致。overlay 中残留旧文件的风险由本任务的结构检查记录，不在本次引入删除逻辑。

## 6. workflow 文案

### 6.1 Phase 2.2

```markdown
- 2.2 Quality check `[required · repeatable]`
  - Backend code task (`work_type=backend`; `fullstack` backend interface changes): after code-level checks, run one round of `trellis-api-e2e` against the local backend and write `{TASK_DIR}/api-e2e-report.md`. This is a workflow requirement, not a `task.py verify` gate. No API change → record "not applicable" + reason.
```

不新增/重排 2.3，避免外部引用失效。

### 6.2 `[workflow-state:planning]`

```text
Backend code task: plan the API E2E round and `api-e2e-report.md` in `implement.md`.
```

### 6.3 `[workflow-state:in_progress]`

```text
Backend code task: after code-level checks, run one round of `trellis-api-e2e` and write `{TASK_DIR}/api-e2e-report.md`; no API change → record "not applicable" + reason. Soft workflow requirement, not `task.py verify`.
```

`[workflow-state:in_progress-inline]` 不重复；inline 平台仍通过 Phase 2 正文看到要求，避免四份 block 文案漂移。若后续需要，可单独加。

## 7. 技能提醒

### 7.1 trellis-check

在 Step 4 的 “Spec Sync” 前插入：

```markdown
### Backend API E2E

- [ ] Backend code task (`work_type=backend`; `fullstack` backend interface changes): ran one round of `trellis-api-e2e` and wrote `api-e2e-report.md`? If no API change, is the reason recorded?
```

### 7.2 trellis-finish-work

Step 3 末尾、`task.py archive` 之前：

```markdown
For a backend code task, confirm `api-e2e-report.md` exists or records why it does not apply. A missing report is a warning to surface, not a `task.py verify` failure.
```

### 7.3 副本同步

- 仓库 `.agents` 是 kit 源；仓库 `.claude` 是当前项目实际加载的副本。
- overlay `.agents` 由 `build_overlay.py` 同步；overlay `.claude` 目前不会被 build_overlay 更新，需手动同步并在实现的验证记录中列出。
- 不修改 `task.py`、`task_store.py`、`task.py verify`。

## 8. 测试设计

### 8.1 静态检查

```bash
python -m py_compile trellis-kit/apply.py trellis-kit/build_overlay.py
python -m json.tool trellis-kit/manifest.json >/dev/null
grep -q '^name: trellis-api-e2e$' .agents/skills/trellis-api-e2e/SKILL.md
! grep -RIn 'wit-api-e2e' .agents/skills/trellis-api-e2e
```

### 8.2 目录技能安装

```bash
TMP1=$(mktemp -d)
python trellis-kit/apply.py --target "$TMP1" --agent-only
test "$(find "$TMP1/.agents/skills/trellis-api-e2e" -type f | wc -l)" -eq 14
test -f "$TMP1/.agents/skills/trellis-api-e2e/scripts/self-test/run.sh"
test -f "$TMP1/.agents/skills/trellis-api-e2e/scripts/self-test/run.ps1"
test -f "$TMP1/.agents/skills/trellis-api-e2e/scripts/self-test/mock-server.mjs"
```

### 8.3 平台安装与 dry-run

```bash
TMP2=$(mktemp -d)
python trellis-kit/apply.py --target "$TMP2" --dry-run --platform claude-code
test -z "$(find "$TMP2" -type f -print -quit)"
python trellis-kit/apply.py --target "$TMP2" --platform claude-code
test "$(find "$TMP2/.claude/skills/trellis-api-e2e" -type f | wc -l)" -eq 14

# 非共享平台：各自 skills 根目录都要有完整 14 个文件
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

平台根目录来自 `platforms/registry.json` 的 `paths.skills`；测试中显式列出是为了防止实现硬编码 `.claude`。

### 8.4 overlay

```bash
python trellis-kit/build_overlay.py
test "$(find trellis-kit/overlay/.agents/skills/trellis-api-e2e -type f | wc -l)" -eq 14
grep -q "api-e2e-report.md" trellis-kit/overlay/.trellis/workflow.md
```

### 8.5 冲突与强制覆盖

```bash
TMP3=$(mktemp -d)
python trellis-kit/apply.py --target "$TMP3" --agent-only >/dev/null
printf 'x\n' >> "$TMP3/.agents/skills/trellis-api-e2e/SKILL.md"
python trellis-kit/apply.py --target "$TMP3" --agent-only; test $? -ne 0
python trellis-kit/apply.py --target "$TMP3" --agent-only --force
```

### 8.6 文案与门禁不变

```bash
grep -q "api-e2e-report.md" .trellis/workflow.md
grep -q "api-e2e-report.md" .agents/skills/trellis-check/SKILL.md
grep -q "api-e2e-report.md" .agents/skills/trellis-finish-work/SKILL.md
git diff -- .trellis/scripts/task.py .trellis/scripts/common/task_store.py | test ! -s /dev/stdin
```

### 8.7 任务校验

```bash
python ./.trellis/scripts/task.py validate 11-25-integrate-api-e2e-workflow
```

本任务不运行真实 `trellis-api-e2e`：它是工具链/文档任务，不改变任何服务端接口。验收以安装文件数、overlay 完整性、文案和 `task.py` 零改动为准。

## 9. 实施顺序

1. **S1 技能源**：把用户级 `wit-api-e2e` 复制到仓库 `.agents/skills/trellis-api-e2e/`，重命名 frontmatter/正文引用，核对 14 个文件和敏感内容。
2. **S2 分发代码**：改 `manifest.json`、`apply.py`、`build_overlay.py`，`py_compile` + manifest JSON。
3. **S3 流程/技能文案**：改 `.trellis/workflow.md`、`trellis-check`、`trellis-finish-work` 及对应副本，跑 `build_overlay.py`。
4. **S4 验证**：执行 8.2–8.6；记录实际输出到 `implement.md`。
5. **S5 任务收尾**：更新 `implement.md` 执行记录、jsonl、`task.py validate`，生成 check 报告后进入 review。

## 10. 风险与回滚

- **目录复制引入回归**：`copy_tree` 复用 `copy_file`，不新增删除逻辑；若冲突处理异常，回滚 `apply.py`/`build_overlay.py` 即可，技能源不影响现有单文件技能。
- **overlay 残留**：`copytree` 不删除旧文件；本任务只新增目录，不删除文件；验证时以 14 个文件为准。
- **平台路径**：平台根目录来自 `platforms/registry.json`，不硬编码；若某平台没有 `paths.skills`，现有逻辑跳过，记录为已知限制。
- **报告漏跑**：不进入 verify；通过 workflow 每回合提示 + check/finish 提醒降低概率；用户接受软要求。
- **技能源后续漂移**：仓库副本是 kit 单一来源；用户级更新后需显式同步，写入 README/实现记录。

## 11. 待确认

无。报告路径、触发条件、非硬门禁、初始化分发方式均已确认；本设计只等待 artifact review 和 `task.py start`。
