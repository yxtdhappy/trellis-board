# 检查报告

## 结论

实现通过代码审查、数据库/凭据/探测测试、完整 Node 测试、前端 lint、TypeScript/生产构建和浏览器主要流程验收。未发现阻断交付的代码问题。

## Findings (fixed)

- 修复项目列表 SQL 中 Git 凭据表与项目扫描缓存复用 `c` 别名造成的列冲突。
- 补齐项目对象 `teamId`，确保刷新、拉取、推送和远端探测能正确解析团队与凭据。
- Git 子进程输出改为按字节限长，并按 Token、私钥、口令显式脱敏。
- 修正 Git 凭据字段不存在时项目凭据解析失败的路径。
- AES-GCM AAD 绑定团队、主机、认证类型和版本，避免密文被替换用途。
- Windows SSH 包装器增加 `-F NUL`，服务启动清理崩溃遗留认证目录。
- 探测开始时清理过期 SSH challenge，避免确认框反复取消造成内存积累。
- 团队切换重挂载凭据页和项目接入页，丢弃旧凭据、旧表单和迟到探测结果。
- 修复系统管理员仅有一支团队时选择具体团队后切换器消失的问题。

## Findings (not fixed)

- 真实 GitHub/GitLab 私有仓库的 HTTPS/SSH clone、fetch、push 未实机验证。
- Windows OpenSSH askpass、带口令私钥及真实主机指纹变化流程缺少真实 SSH 服务端证据。
- `data/git-credentials.key` 与数据库同目录是已接受部署风险，备份必须成组。

## Verification

### Focused tests

- `node --test tests/team-credentials.test.js`: 6/6 通过。
- 覆盖密文保存、团队/主机隔离、项目引用删除保护、主密钥丢失、限流、输出截断脱敏和 HTTP 权限。

### Full tests

- `npm test`: 346 项，340 通过、5 跳过、1 失败。
- 失败项为 `plugins/acp-dispatch/test/index.test.js` 中既有 Windows 临时目录 `EPERM` 清理问题。
- 单独重跑失败用例：1/1 通过。

### Lint / Type / Build

- `npm --prefix web run lint`: 通过，0 error；仅仓库既存 warnings 和 `useGitCredentials` effect warning。
- TypeScript 类型检查：通过。
- 首次构建缺少 `web/node_modules`；`npm --prefix web ci` 后构建通过，修复浏览器发现的问题后最终重建通过。
- `git diff --check`: 通过。

### Browser

- Chrome DevTools MCP 连接超时两次，使用 `ego-browser`。
- 已验收凭据新建/编辑、秘密不回显、HTTPS/SSH 动态表单、按钮触发探测、名称/默认分支回填、凭据变化失效、团队切换清空、项目创建、已接入项目凭据展示和当前团队凭据选择。
- 测试数据与隔离 `4318` 服务已清理/停止。

## Remaining verification

- 真实 WIT/GitHub/GitLab 私有远端需要使用实际凭据做一次 HTTPS 和 SSH 认证远端 smoke test。
- 未提交、未推送、未创建 MR。
