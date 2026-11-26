---
mode: independent
agent: trellis-check
session: claude_467c3cd0-5986-4fe8-a230-eaaf48580990
base: 737f1f8bb8d6dfb77aa90851c7266bddabbb8661
scope: packages/desktop/src-tauri/src/agent/device.rs,packages/desktop/src-tauri/src/agent/device/tests.rs,packages/desktop/src-tauri/src/agent/task_sync/upload.rs,packages/desktop/src-tauri/src/agent/task_sync/tests/mod.rs,packages/desktop/src-tauri/src/main/tests.rs,packages/web/src/components/layout/project-rail/association.ts,packages/web/src/components/layout/project-rail/types.ts,packages/web/src/lib/project-rail-association.js,packages/web/src/lib/project-rail-association.d.ts,packages/web/test/project-rail-association.test.js,.trellis/spec/frontend/rendering-and-state.md
diff: sha256:423e2b951f0fa26ef0fd19419d94d53cbc54b402cfaccc598b5a0b1e90e0d30d
---
## Check Complete

独立检查已完成：代码阅读、提交内容比对、前端/桌面 Node 测试实跑均已完成；Rust 代码仅做静态阅读审查，本机无 Rust 工具链，未执行 `cargo` 编译与测试，Rust 侧最终验证只能依赖 Windows CI。

## 检查范围

已逐项比对 `git diff 737f1f8 HEAD -- <路径>`，以下文件当前内容与修复提交 `737f1f8` 完全一致（diff 为空），属于本次 stamp scope：

- `packages/desktop/src-tauri/src/agent/device.rs`
- `packages/desktop/src-tauri/src/agent/device/tests.rs`
- `packages/desktop/src-tauri/src/agent/task_sync/upload.rs`
- `packages/desktop/src-tauri/src/agent/task_sync/tests/mod.rs`
- `packages/desktop/src-tauri/src/main/tests.rs`
- `packages/web/src/components/layout/project-rail/association.ts`
- `packages/web/src/components/layout/project-rail/types.ts`
- `packages/web/src/lib/project-rail-association.js`
- `packages/web/src/lib/project-rail-association.d.ts`
- `packages/web/test/project-rail-association.test.js`
- `.trellis/spec/frontend/rendering-and-state.md`

同时阅读了 `prd.md`、`design.md`、`implement.md`、`implementation-report.md`，以及 `737f1f8` 的完整 diff（19 个文件，+793/-12）。

说明：`packages/desktop/src-tauri/src/agent/task_sync/tests/upload_cleanup.rs` 和 `packages/desktop/src-tauri/src/agent/agent_service.rs` 在后续提交（`f7d0d73`、`51c55a0`、`44dd7ca`）中被改动，**不在** stamp scope 内，本报告只作为背景提及，不声明其与 `737f1f8` 绑定。

## 发现（按严重度）

**无阻断发现。**

低风险 / 提示项：

1. **`737f1f8` 当时的 `upload_cleanup.rs` 首个用例会失败（已被后续提交修正，非当前阻断）**：该用例在 `737f1f8` 中给 `local` 传 `HashSet::new()`，但同时断言只清理 `dead`；`alive` 同样满足“服务端空、基线存在、本地目录不在集合中”，会被一并清理，断言必然不成立。`f7d0d73`（stamp scope 之外）将其改为 `HashSet::from([alive.to_string()])`。当前 HEAD 的用例逻辑正确，但可说明修复提交当轮若执行 Rust 测试会失败，CI 是 Rust 侧唯一实际验证来源。
2. **设计文档与实现的文案样式有轻微偏差**：`design.md` 伪代码给“正在上传”用了 `text-primary`，实现（`project-rail-association.js:49-72`）用 `text-muted-foreground`，与 PRD “与「同步中」一致”的要求相符，也与 spec 中同步分支一致；属于设计稿措辞未同步，不影响验收。
3. **`.d.ts` 返回类型不够精确**：`project-rail-association.d.ts` 中 `pendingUploadView` 复用 `Omit<ProjectListenerView, 'state' | 'counts'>`，其 `detail` 声明为 `string`，而 JS 实现可能返回 `null`（`pendingUploadTaskDirs` 为空时）。消费方 `ProjectAssociationView.detail` 为 `string | null`，且声明文件不会被 `tsc` 用于校验 JS 实现，因此不构成类型破坏，但声明与实现存在文字级不一致。
4. **前端优先级分支缺少直接自动化断言**：新增 Node 用例直接测试 `pendingUploadView` 的标签、样式和详情；`projectAssociationView` 中“`liveSyncStatus=error` 优先于 pending 上传”的分支属于 TS 代码，Node 测试不覆盖，本次通过代码阅读确认结构优先级正确；`normalizeAssociation` 的 `pendingUploadRetrying` 默认 false 也由 Rust 序列化用例覆盖，Web 侧无直接断言。
5. **30s 阈值测试存在理论抖动风险**：`device/tests.rs` 中 `stamp(29)` 生成的 `createdAt` 若在调用被测函数前耗时超过 1 秒（极端调度/时钟回拨），可能误判为 true；正常 CI 下风险极低。
6. **冲突中的死目录不会被清理（既有语义）**：`conflictBlocked` 目录会被 `requested` 过滤而不参与 fetch，因此即使本地目录已不存在也不会被清理。这符合现有冲突处理语义，仅提示该场景不在本次收敛保证内。

正确性结论：30s 逻辑对缺失 `createdAt`、非法格式、缺失 `pending` 对象、其他 task space 均返回 false，未来时间戳得到负秒数同样为 false，不会误报；`pendingUploadRetrying` 使用 `#[serde(default)]` + camelCase 序列化/反序列化，前端归一化为严格 `=== true`，缺失时 false，语义正确。清理逻辑只对该轮成功 fetch 的目录生效，空服务器 + 基线存在 + 本地目录不存在（含空目录判定为存在）才清理；前缀兄弟目录通过 `path == task_dir || path.starts_with("{task_dir}/")` 排除；`readonlyTaskDirs`、归档目录、非活跃控制目录不参与 fetch，因而不会被清理。

## 实际运行的命令与结果

| 命令 | 结果 |
| --- | --- |
| `yarn test --scope=web --file=project-rail-association` | 通过：pass 17 / fail 0 / skipped 0（约 237ms，包含新增“上传中的任务不显示为等待重试”用例） |
| `yarn test --scope=desktop` | 通过：pass 39 / fail 0 / skipped 1（共 40，跳过项为仅 POSIX 生效的 acp-dispatch 可执行位断言） |
| `git show 737f1f8 --stat`、`git show 737f1f8 -- packages/desktop packages/web .trellis/spec` | 已执行并逐文件阅读（19 文件，+793/-12） |
| `git diff 737f1f8 HEAD -- <上述 11 个 scope 路径>` | 无输出，内容与修复提交一致 |

未运行（按检查要求）：任何 build、`tsc`、`lint`、`cargo`。因此 Rust 代码没有本地编译/测试结果，只有 CI 能验证。

## 剩余风险 / 未覆盖项

- **Rust 未本地编译**：本机无 Rust 工具链，静态阅读未发现类型、借用、导入或测试 helper 作用域问题（`use super::*` 的传递式 glob 与现有测试文件一致，`SnapshotFile`/`SnapshotGroup` 已在 `task_sync.rs:303-307` 重导出，`HashSet`/`BTreeMap` 已在 `task_sync.rs:1` 导入，`pub(super)` 的清理函数对 `task_sync::tests` 可见），但无法替代 `cargo test`，需以 Windows CI 结果为准。
- **`737f1f8` 自身测试状态**：如上所述，`upload_cleanup.rs` 首测在修复提交时点会失败，后续提交已修正；检查的是当前 HEAD 内容。
- **真实 UI 观察仍不完整**：`implementation-report.md` 只观测到收敛后的日志静默，尚未在真实环境中观察到短时“正在上传”标签；本次仅通过单元测试与代码阅读验证。
- **task space 无本地目录但服务器仍有活文件**、**只读绑定下的死目录** 两个场景有测试/代码路径覆盖，但没有真实环境复现记录。

## 结论

建议进入 archive。无阻断问题；清理收敛逻辑、30s 判定、前端文案与优先级均符合 PRD/spec，当前 HEAD 的前端与桌面 Node 测试全部通过。需在 archive 说明中保留“Rust 仅经 CI 验证”和“`upload_cleanup.rs` 测试由 `f7d0d73` 修正、不在 stamp scope”两点。

## Verification Results

- 前端单测：17/17 通过（0 失败、0 跳过）。
- 桌面端 Node 测试：39 通过、1 跳过、0 失败（共 40）。
- 提交一致性：11 个 stamp scope 文件与 `737f1f8` 无差异。
- Rust：未编译，本地无工具链；静态审查未发现编译级问题，等待 CI。
- 未执行 build/tsc/lint/cargo，符合本次检查约束。

## Summary

本次修复在设备端为每个绑定计算 `pendingUploadRetrying`（基于 pending outbox 的 `createdAt` 与 30s 阈值），供前端区分“正在上传”和“等待重试上传”；同时在 `fetch_directory` 成功后，对“本地活动目录不存在、服务端无活文件、且 cursor 有基线”的任务目录清理 cursor 基线与 deferred 记录，从而让 `local_sync_state_from_groups` 不再把死目录视为 dirty，停止每轮重复 warning。前端新增 pending 上传视图并保持原有优先级（error/冲突/拒绝/归属/初次审查优先），spec 同步更新。独立检查未发现阻断问题；Rust 侧仅静态审查，最终以 CI 为准。