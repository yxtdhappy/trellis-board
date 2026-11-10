# 实施报告

## 完成内容

- 项目接入按 `team_id + remote_identity_hash + sync_branch` 判重。
- clone 前返回 `409 PROJECT_ALREADY_CONNECTED`，避免重复工作副本。
- 写数据库前在 `BEGIN IMMEDIATE` 事务中复检，阻止并发重复记录。
- 同一仓库的不同同步分支可以分别接入。
- 同团队冲突返回项目元数据；跨团队冲突只返回通用文案，避免信息泄露。
- Windows 子进程超时等待 `taskkill /T /F` 完成；非零退出回退单进程终止。
- UUID 工作副本清理使用 5 次重试、100ms 间隔。
- 清理失败不覆盖原始 Git/工具链错误，只追加服务端诊断日志。
- 前端收到重复接入错误后刷新项目列表，再显示服务端错误。
- partial clone 的 sparse-checkout、read-tree、初始化上下文检出和远端 tree/模板清单读取
  复用 clone 的 HTTPS/SSH 认证上下文。
- `ensureSparseTrellis()` 使用项目凭据执行稀疏收敛，覆盖后续请求触发懒取 blob 的场景。
- 稀疏检出失败返回经脱敏的 Git stderr/stdout，不再只显示泛化错误。
- 区分了两个独立根因：GitHub 是后续命令缺失 askpass；SSH 是认证完整但 promisor lazy fetch
  的真实网络耗时超过 30 秒。
- `LOCAL_TIMEOUT` 增至 60 秒为 `sparse-checkout init` 等本地 Git 操作提供新基线；
  `sparse-checkout set`、`read-tree`、checkout、merge、分叉恢复 rebase、clone、远端
  `ls-tree` 和模板清单 `show` 使用 210 秒远端超时。
- `PUSH_TIMEOUT=150s`、`PROBE_TIMEOUT=60s`、`TRELLIS_INIT_TIMEOUT=210s`、
  SSH 主机扫描 45s、toolchain 预检 60s、团队 `task.py` 150s、
  `runProcess` 默认值 60s。
- 项目成功接入后的表单重置不再触发空 URL 探测，受控分支 Select 清空时不会出现
  “请先填写 Git 远端 URL”伪 toast；用户显式点击“识别远端”时的校验保持不变。
- 定时刷新失败日志保留 `name/code/status/message/details`，非 TeamError 额外记录脱敏后的
  stack/cause；项目 `last_error` 改写为带 code 的脱敏摘要。

## 修改文件

- `server/team/errors.js`
- `server/team/projects.js`
- `server/team/process.js`
- `server/team/git-manager.js`
- `server/team/http.js`
- `server/team/error-diagnostics.js`
- `server/plugins/supervisor.js`
- `web/src/hooks/useAdminProjects.ts`
- `web/src/features/admin/OnboardingTab.tsx`
- `web/src/lib/onboarding-probe.js`
- `web/src/lib/onboarding-probe.d.ts`
- `tests/team-core.test.js`
- `tests/team-credentials.test.js`
- `tests/team-sparse-onboarding.test.js`
- `tests/onboarding-probe.test.js`
- `tests/team-error-diagnostics.test.js`
- `.trellis/spec/backend/architecture-and-runtime.md`
- `.trellis/spec/backend/http-and-filesystem.md`
- `.trellis/spec/backend/quality-guidelines.md`
- `.trellis/spec/frontend/rendering-and-state.md`
- `.trellis/spec/frontend/quality-guidelines.md`

## 验证结果

- `node --test tests/team-sparse-onboarding.test.js tests/team-core.test.js tests/team-credentials.test.js`：
  50/50 通过。
- `node --test tests/plugin-sdk.test.js`：7/7 通过。
- `npm --prefix web run lint`：通过，仅保留既有 warning。
- `npm run build`：全部开发任务完成后通过，包含 TypeScript 构建和 Vite 生产构建。
- 本次修改文件 `oxfmt --check`：通过。
- `git diff --check`：通过。

### Partial clone 增量回归

- `node --test tests/team-sparse-onboarding.test.js`：23/23 通过。
- `node --test tests/team-core.test.js`：17/17 通过。
- `node --test tests/team-credentials.test.js`：10/10 通过。
- 断言 `clone`、`checkout`、`sparse-checkout`、`read-tree`、远端 `ls-tree`、模板清单 `show`
  均收到 `GIT_ASKPASS_REQUIRE=force`、askpass 路径和测试 HTTPS 凭据。
- 断言 `ensureSparseTrellis()` 先解析项目凭据，再执行 sparse-checkout/read-tree。
- 注入含测试 Token 的 Git stderr，断言返回错误保留 `无法收敛项目工作副本：fatal: ...`，
  Token 被替换为 `[redacted]`。
- 断言 `sparse-checkout init` 的 `timeoutMs=60000`，clone、`sparse-checkout set`、
  read-tree、checkout、merge、rebase 和远端 `ls-tree`/`show` 的 `timeoutMs=210000`；
  push 为 `150000`，本地 rev-parse 默认值为 `60000`。
- 断言远端探测 `ls-remote` 为 `60000`，SSH 主机扫描为 `45000`。
- 真实 SSH 证据：clone 1.36s、两次 sparse-checkout <0.5s、首次 read-tree 30.475s；
  放宽超时后完整接入 43.006s 成功，commit
  `516bd1b71d482f6eca027410b9059540131b11c9`。最终所有执行超时增加 30s。

### 重置与诊断增量回归

- `node --test tests/onboarding-probe.test.js tests/team-error-diagnostics.test.js`：6/6 通过。
- `node --test tests/onboarding-probe.test.js`：1/1 通过。
- 断言空分支、空 URL、空白字符串均不触发自动探测，有效分支与 URL 允许探测。
- 断言 scheduler 保留 TeamError 结构化字段并脱敏 details；非 TeamError 的 stack/cause
  不含秘密或宿主绝对路径。
- 临时数据库断言 `last_error` 为
  `GIT_REMOTE_FAILED: 同步项目失败 [redacted-path] token=[redacted]`，
  不包含测试 Token 或 Windows 用户目录。
- `npm --prefix web run lint`：通过，仅有既有 warning。
- `web/node_modules/.bin/tsc.cmd -b`：通过。
- 真实浏览器状态流验收：项目接入成功、批准弹窗打开后，通知区域为空，页面不存在
  “请先填写 Git 远端 URL”。最终 POST 被浏览器测试拦截，真实数据库仍为 5 个项目，
  未写入测试项目。

## 全量测试

本轮新增测试前的 `npm test` 基线：449 项，434 通过、3 失败、12 跳过。

- `plugins/a2a-intake/test/index.test.js` 的 Windows 临时目录清理 `EPERM`；单独复跑 13/13 通过。
- `plugins/acp-dispatch/test/index.test.js` 的 Windows 临时目录清理 `EPERM`；单独复跑仍会随机落在不同用例，属于既有临时目录清理抖动。
- `tests/plugin-manifest-conventions.test.js` 发现被忽略目录 `plugins/witops-core` 缺少 `plugin.json`；该目录不属于本任务改动。

## 未执行

- 用户已重启 4317 团队服务；本次浏览器验收运行在重启后的服务上。
- 未修改真实项目数据，也未为当前已恢复项目强制写入 `last_error`。
- 未在真实私有 GitHub 仓库上执行重启后的接入 E2E；本地回归已证明认证参数传递，但真实远端
  askpass、GitHub 权限和服务进程环境仍需主代理重启后验收。
- 未执行会写入真实数据库的重复接入和多分支 E2E。
- 未删除两个已知孤儿工作目录。
- 未提交、未推送。

## 后续条件

- 真实服务重启后验证首次接入、重复 409、同仓库不同分支。
- 删除两个孤儿目录前必须停止服务、再次检查引用并取得明确授权。
