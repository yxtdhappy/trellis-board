# 发版 tag run 复用 Rust 缓存：tag 推送转发到 main 作用域构建

## Goal

`v*` tag 推送的发版构建复用 main 上已有的 882 MB Rust 缓存，把 17 分钟冷编译压回 ~7 分钟；停止写永远不会被命中的 tag 作用域缓存副本。

## 关键发现

- 缓存作用域是「run 的 ref」：tag 推送的 run 落在 GitHub 合成的作用域 `refs/heads/refs/tags/vX.Y.Z`（`actions/caches` 里可见），与 `refs/heads/main` 互不可见。
- **已证伪**：把仓库默认分支从 `codex/team-board` 改成 `main` 之后，重跑原 tag run（`gh run rerun 43387102376`）仍然 `No cache found.` —— rust-cache 步骤 5s、`Rust unit tests` 4m02s、`Bundle desktop client` 6m19s、post 保存 1m20s；同时 `actions/caches` 里 `refs/heads/main` 的同 key 条目（925059061 B）完好存在。文档里的「当前分支无命中则退回默认分支重试」**对 tag ref 不成立**。
- 该重跑又把两份 tag 作用域缓存写了回来（rust 925205715 B、npm 67509901 B），已删除；仓库现在只剩 `refs/heads/main` 两条（rust 882.20 MiB、npm 64.38 MiB）。
- 上一轮实测基线：main 上的 run 命中缓存时 `Rust unit tests` 1m04s、`Bundle desktop client` 2m53s、restore 55s；冷启动时 4m54s / 7m10s / 保存 2m28s。

## 需求

- **R1 tag 推送转发到 main 作用域**：`windows.yml` 新增 `dispatch-main` 作业（`if: github.event_name == 'push'`，`permissions: actions: write`），执行 `gh api -X POST repos/${{ github.repository }}/actions/workflows/windows.yml/dispatches -f ref=main -f "inputs[release_tag]=${{ github.ref_name }}"`。`GITHUB_TOKEN` 触发的 `workflow_dispatch` 会真正创建 run（GitHub 2022-09-08 changelog 的例外）。
- **R2 构建作业只在 dispatch 上跑**：`node-tests`、`desktop-build` 加 `if: github.event_name == 'workflow_dispatch'`，checkout 用 `ref: ${{ inputs.release_tag != '' && format('refs/tags/{0}', inputs.release_tag) || github.sha }}` —— 缓存作用域来自 run 的 ref（main），源码来自 tag，不需要 `expected_sha` 校验。
- **R3 只由 main 写缓存**：`Swatinem/rust-cache` 加 `save-if: ${{ github.ref == 'refs/heads/main' }}`。
- **R4 并发不再互相取消**：`concurrency.cancel-in-progress` 改 `false`，避免连续两次发版把前一次构建中途取消、留下半个 release。
- **R5 文档**：`apps/desktop/README.md:364-368`、`.trellis/spec/backend/desktop-agent-runtime.md:163-169` 记录「tag 推送不得改回直接构建」。
- **R6 死缓存清理**：已完成，配额 7255 MiB → 946 MiB（含本轮重跑又写出、已删的两条）。

## 验收标准

- [x] `gh repo view --json defaultBranchRef` → `main`（已切）。
- [x] 证伪实验已记录：默认分支为 main 时 tag run 仍 miss。
- [ ] 推送 workflow 改动后 `gh workflow run windows.yml`（main，无 tag）：rust-cache 打印 `Cache hit for: v0-rust-desktop-build-Windows_NT-x64-8bca1467-…`，`Rust unit tests` ≤ 2min，`Bundle desktop client` ≤ 4min，三个作业全绿。
- [ ] 推一个 `v*` tag：出现 `dispatch build on main` 作业并成功转发，被转发的 run 命中缓存。
- [ ] 转发后的 run 结束后 `actions/caches` 无新增 `refs/heads/refs/tags/*` 条目。
- [ ] 下次真实发版（`npm run release:desktop`）走完整链路并产出 release 资产。

## 不在范围

- `[profile.release]` 的 `lto` / `codegen-units` / `opt-level` 调整。
- 拆 `Rust unit tests` 与 `Bundle` 为并行作业。
- 锁定 `rust-toolchain` 版本。
- 改用 `tauri-action`：它只负责 `tauri build` + 上传 Tauri bundle/裸 EXE，没有 cache 相关输入；我们的交付物是 `package-portable.ps1` 产出的自定义绿色 zip，它无法上传任意文件，换过去仍要写自定义 upload，且解决不了作用域问题。
- `scripts/release-desktop.mjs` 不动：发版仍是 `npm run release:desktop` → bump → 推 main → 推 tag，本地不需要 `gh`。

## 关键决策

- 不改发版入口、不让脚本本地调 `gh`：作用域问题只能在 CI 侧解决，把 tag 推送变成「转发 + 在 main 作用域构建」对使用者零感知。
- 用 checkout `ref` 而不是 `expected_sha` 参数校验：run 的 ref 决定缓存作用域，checkout 的 ref 决定源码，两者解耦后无需再传 sha 做断言。
- 保留 `push: tags` 触发：它就是发版入口，只是不再直接构建。
- 已知天花板：GitHub 回收 7 天未访问的缓存，两次发版间隔超过 7 天仍会冷构建；`Cargo.lock` 变化时依赖 rust-cache 的 prefix restore-key 部分命中（实测 v0.4.0 的 release 提交改了锁文件里的 client 版本，key 后缀 `-0ade1cf1` 未变，说明该 hash 对版本行不敏感）。
