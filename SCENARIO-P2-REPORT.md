# scenario-copilot P0–P2 改造验证报告（R35627）

> 代码位置：`/opt/app/work/github/trellis-board/.worktree/witops-scenario/mom-cli`（git worktree，分支 `codex/scenario-copilot-plan-renderer`，最新提交 `6b20066`）。
> 注意：`/opt/app/work/frontend-backup/mom-cli` 是旧检出，不是本任务改动所在。

## 1. 改造前后指标

| 指标 | 基线 v36（改造前，单文件整段生成） | 产品流水线（plan 模式，v135） |
| --- | --- | --- |
| 用例数 | 12 | 13（12 test + 首屏） |
| step 覆盖率 | 97.5%（76 matched / 4 partial / 0 missing） | **99.4%（79/80）** |
| blocking NEED_SNAPSHOT | 0 | **0** |
| executable | true | true |
| 生成耗时（复用计划） | 整段重生成 | 0.4s（计划复用）/ ~90–350s（有 case 需重新规划） |
| 执行通过 | 11/12 | **3–4/12（振荡）** |

结论：生成质量目标（case 完整、0 占位、覆盖率 ≥95%）已达成；**执行通过率仍未达到 10/10**，这是本报告的核心未完成项。

## 2. 已落地能力（产品路径，非 harness）

- `generationMode` 默认 `plan`：`ScenarioGenerator.generate()` 走 `generatePlanArtifact()`，LLM 只产出 `StepPlan`，代码由 `renderPlaywright` 渲染，不再接受整段 TS。
- 计划持久化与复用：`plans` 写入 run state；`caseHashes` 按 case 指纹复用，outline 变化只重生成受影响 case（`Plan reuse skipped` → `Outline changed ... reusing by case`）。
- stale plan 检测：导入时对每一步（含 composite 的 actions）跑 `planGroundingViolations`，选择器/文本不在快照即丢弃并只重生成该 case。
- 分阶段运行：`--stop-after recon|generate|verify|execute`、`--resume`、`--regenerate`、`--only-failed`、`--grep`、`--state-key`。
- best-artifact guard：生成期只写 `.spec.ts.staging`，`commitStagedArtifact()` 通过 `isArtifactAtLeastAsGood()` 后才 rename，旧文件另有 `.best`；单测 `test/artifact-guard.test.mjs` 5/5。
- 分层 UI 知识：`antd` / `easytable` / `weareint` / app 四层，`scripts/build-ui-knowledge.mjs` 生成，带 evidence 与 `verified:false` 标记；`knowledge capture` CLI 抓接口生成 app 声明。
- 断言/选择器的通用规则：antd→easytable 的 checkbox、row、pagination 归一化；`label` 定位回退 placeholder；引号与 `标签：值` 文案的正则断言；弹窗正文用 weint 契约而非 antd confirm。

## 3. 执行结果（产品流水线，同一 spec 连续观测）

| 版本 | 通过 | 失败用例 |
| --- | --- | --- |
| v121 | 3/13 | 003 004 006 007 008 009 011 012 |
| v126 | 4/12 | 003 004 006 007 008 009 011 012 |
| v130 | 4/12 | 同上 |
| v132 | 4/12 | 003 004 006 007 008 009 011 012 |
| v133 | 4/12 | 003 004 006 007 008 009 011 012 |
| v134 | 3/13 | 003 004 **005** 006 007 008 009 011 012 |
| v135 | 3/13 | 003 004 **005** 006 007 008 009 011 012 |

三类剩余失败：

1. **弹窗流程语义**（006/007/008，超时）：计划在「打开弹窗」后直接 `confirmDialog`（等于提交空表单），或对 hover 才出现的节点图标点击后弹窗未出现。
2. **断言与被测 UI 的事实不符**（004/009/011）：如「上级业务分类：E2E交易业务」实际渲染为路径面包屑；`.ant-form-item` 过滤命中了纯 label 行；删除确认弹窗未打开导致 15s 超时。
3. **数据漂移**（005/012）：fixture 每轮重建 seed 树，行级断言依赖固定名称；行复选框需 hover 才可见。

## 3.5 性能（本轮优化，实测）

| 场景 | 优化前 | 优化后 |
| --- | --- | --- |
| 冷启动（无计划缓存）总时长 | ~1031s（含 3 次全量 healing） | **460s**（healing 受预算约束） |
| 生成阶段（12 case 计划） | 380s（串行） | **203s**（并发 4） |
| 复用计划时的生成 | 0.4s | 0.4s |
| healing 单次执行 | 全量 12 case ≈ 236s | 只跑失败 case ≈ 110–160s |
| 每个失败断言的等待 | 15s | 8s |
| recon 每状态固定等待 | ≥5s | ≥1.2s（networkidle 后） |
| fixture 前置等待 | 800ms | 200ms |

手段：计划生成/修复并发池、healing 只跑失败用例、修复无变化即停止、`MOM_HEAL_BUDGET_MS`（默认 300s）封顶、断言超时下调、recon settle 下调、`--workers` 透传（默认 1，因共享种子数据）。

进一步提速需要「数据按 worker 命名空间化」：fixture 以 `TEST_PARALLEL_INDEX` 生成独立前缀，计划里的种子名改为运行时变量，才能安全开 `--workers=4`，预计执行阶段再降 3–4 倍。

## 4. 复现命令

```bash
cd /opt/app/work/github/trellis-board/.worktree/witops-scenario/mom-cli/packages/scenario-copilot
npm run build
bash /tmp/run-prod.sh   # 内含 CLI 调用与环境变量
```

`/tmp/run-prod.sh` 关键参数：

```
node dist/bin/scenario-copilot.js pipeline \
  -i /opt/app/work/github/trellis-board/tmp/data/scenario-output/dm-business-category.md \
  -u 'http://mom3.fat.weintdata.cn/mdp-backend-web/data-studio/#/dm/plan/businessCategory' \
  -w /opt/app/work/github/qdata/mdp-backend-web-trellis-board \
  --state-key 'product:R35627' --test-version vNNN --generation-mode plan --max-healing 3 \
  --recon-snapshots "$(cat /tmp/recon-states.json)"
```

## 5. 结论

- P0（guard + chunk 校验）、P1（CaseManifest + StepPlan 按 case 生成）、P2（确定性 renderer + 静态校验 + 单 case 局部修复）均已接入产品生成路径并有构建/单测/流水线证据。
- 生成质量三项达标；**执行通过率未达标（3–4/12，目标 10/10）**，且近期改动会让已通过用例回退，说明当前“逐条断言修补”的方式已到收益上限，需要换方法（见下）。
- 建议的下一步（未实施）：
  1. 断言 oracle 化：`expectText` 只允许断言快照中真实存在的元素/文案，计划不得凭空写业务文案；由 renderer 生成断言而非 LLM 指定。
  2. 弹窗流程 op 化：新增 `openDialog`（区分 add-root/add-child/edit/delete-confirm）与 `submitDialog`，把「打开→填表→提交」固化为契约，禁止计划自由拼 click+confirmDialog。
  3. 数据隔离：每轮 fixture 用唯一后缀重建，断言只引用 fixture 声明的名称，避免行级断言随 seed 漂移。

## 6. 2026-11-12 最新状态（产品 CLI，worktree 代码）

| 指标 | 数值 | 说明 |
| --- | --- | --- |
| 生成方式 | plan 模式默认 | `generate()` 默认 `generationMode='plan'`，结构取自大纲原文，不再走 LLM 归一化 |
| Case 完整性 | 13/13（12 test + 2 setup → 12 tests 渲染） | 99.4% step coverage（79/80） |
| blocking NEED_SNAPSHOT | 0 | |
| 计划复用 | 0.4s | 冷生成 188–230s（并发 4），warm 复用 0.4s |
| 全流程耗时 | 冷 460s（基线 1031s） | 生成 380→203s，healing 只跑失败用例 |
| 执行通过 | 3–4/12 | 未达到 10/12，见下 |

### 剩余失败归因（最新一轮 v142）

| Case | 失败点 | 归类 |
| --- | --- | --- |
| CASE-003 | `.ant-pagination-total-text` 不存在；`getByLabel` 命中不到搜索字段 | 断言指向不存在的元素 |
| CASE-004 | 选择父节点后期望表格出现父节点行（表格展示子级） | 大纲语义与页面语义不一致 |
| CASE-005 | 弹窗字段断言作用域/控件形态 | 弹窗态知识不足 |
| CASE-006/007 | 校验文案（`关联数据域不能为空` 等）页面不渲染 | 文案断言无 oracle |
| CASE-008/009/011/012 | 弹窗流程与行/复选框断言 | 同上 |

### 结论

生成侧（P0/P1/P2）已达标并在产品路径生效：结构稳定、覆盖率 99.4%、0 占位、按 case 修复、guard 保文件、耗时减半。
执行侧仍是瓶颈：`outline 文案 ↔ 真实页面` 之间缺少 oracle，断言与步骤仍由 LLM 按大纲措辞编写，重规划后仍会指向页面不存在的元素。

### 建议的下一步（需要确认范围）

实现"断言 oracle 化"：断言只能引用（a）快照中存在的元素属性、（b）契约交互的期望状态、（c）fixture 种子数据；大纲里的业务文案转成"该动作产生的状态变化"（行数、弹窗开合、节点出现/消失）。这是一次结构性改造，超出当前 P0–P2 边界，但它是把执行通过率从 4/12 推到 10/12 的必要条件。
