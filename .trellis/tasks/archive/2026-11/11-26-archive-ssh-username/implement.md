# 实施计划

## Steps

- [x] 在 `archive-git-credentials.js` 统一 SSH/HTTPS 用户名归一化；SSH 缺省 `git`，更新时空用户名回落 `git`。
- [x] 在 SSH 临时 wrapper 中加入引用后的 `-o User=<username>`，保持现有私钥、known_hosts、超时和脱敏边界。
- [x] 管理页为 SSH 展示用户名输入，新增和编辑默认回填 `git`；HTTP/HTTPS Token 字段不变。
- [x] 更新 `archive-git-credentials.test.js`：默认用户名、自定义用户名、旧空值兼容和 wrapper 参数。
- [x] 同步更新 `docs/team-operations.md`、后端 spec 和前端归档凭据契约，说明用户名持久化且不依赖容器 SSH 配置。

## Validation

- [x] 定向测试：`node --test packages/server/test/archive-git-credentials.test.js packages/server/test/archive-git-store.test.js`
- [ ] 全量测试：两次运行各有一个不同且无关的 Windows 并发临时文件失败，失败文件单独复跑通过。
- [x] 仅在所有代码修改完成后执行一次前端构建：`yarn build`
- [x] 使用 oxfmt 只格式化本次改动文件；定向格式检查通过，仓库级检查被 32 个既有文件阻断。
- [x] 本地浏览器打开 `/admin.html`：新建/编辑 SSH 凭据默认显示 `git`，保存后重新读取不丢失。
- [ ] 使用现有生产 SSH 来源执行“测试”和“立即同步”，确认实际 SSH 用户为 `git`；待发布后执行。
- [ ] 发布后重建生产容器，再执行同一测试和同步；不创建 `/root/.ssh/config`。

## Risk And Rollback

- 风险文件：临时 SSH wrapper、凭据创建/更新、管理页凭据表单。
- 私钥或来源隔离相关测试失败时立即停止，不通过放宽校验修复。
- 回滚只需恢复代码和前端产物；数据库新增的用户名值兼容旧版本，不删除任务、凭据或快照。
- 若生产验证仍连接为 `root`，优先检查部署是否包含本次构建，而不是恢复容器 SSH 配置文件。
