# 实施计划：Git 凭据管理与项目远端自动识别

## 实施顺序

### 1. 数据库与配置基础

- [ ] 在 `server/database.js` 增加 schema v7、`git_credential`、`git_ssh_known_host`、`team_project.git_credential_id` 和 v6 迁移备份。
- [ ] 更新数据库测试，覆盖新库、v6 升级、幂等、失败回滚和旧项目空凭据兼容。
- [ ] 在 `data` 目录定义凭据主密钥路径，确保路径不进入仓库或无权限目录。

### 2. 凭据加密与服务

- [ ] 新增 `server/team/git-credentials.js`，集中实现主密钥、AES-256-GCM、凭据 CRUD、主机匹配、团队权限、引用检查和公开元数据投影。
- [ ] 扩展 `server/team/audit.js` 的敏感键规则覆盖 `privateKey`、`passphrase`、`secret`、`token`、`credential`。
- [ ] 新增单元测试：密钥缺失/损坏、密文随机、秘密不回显、团队隔离、主机/类型不匹配、被引用时禁止删除。

### 3. Git 认证与远端探测

- [ ] 扩展 `server/team/process.js`：按调用配置输出上限、返回 `truncated`、支持按已知秘密值脱敏。
- [ ] 扩展 `server/team/git-manager.js`：项目对象携带 `credentialId`；clone/fetch/push/ls-remote 接受认证上下文；实现 HTTPS askpass、SSH 临时私钥/known_hosts 和清理。
- [ ] 实现远端描述、推荐名称、`ls-remote` 输出解析、默认分支校验、探测超时/输出上限/并发和频率限制。
- [ ] 实现 SSH `ssh-keyscan`、一次性 challenge、首次信任和主机变化检测。
- [ ] 新增测试：名称推导、无 symbolic HEAD、无 heads、输出截断、认证错误、限流、秘密不出现在 stderr、SSH challenge 过期/串用户。

### 4. HTTP API 与项目集成

- [ ] 在 `server/team/http.js` 增加凭据 CRUD、远端探测、SSH 信任确认和项目凭据更换路由，全部使用团队管理员权限。
- [ ] 在 `server/team/projects.js` 的 connect/read/list/approve/refresh/disable 响应中加入凭据元数据；创建和更换时验证凭据主机/类型。
- [ ] 让 refresh、fetch、push、`remoteContainsCommit` 和 scheduled refresh 通过项目凭据执行；失败时保留原状态机语义。
- [ ] 扩展团队 HTTP、release 和 isolation 测试，覆盖跨团队拒绝、项目复用同一凭据、更换凭据、无凭据兼容和真实 bare Git 接入。

### 5. 前端 API 与状态

- [ ] 在 `web/src/api/admin.ts` 增加凭据、探测、SSH trust 和项目凭据更换类型与请求函数；解析器拒绝对秘密字段做回填。
- [ ] 新增 `useGitCredentials` 或在现有项目 hook 内实现唯一凭据状态源，负责列表刷新、CRUD、探测、指纹确认、迟到响应丢弃和错误展示。
- [ ] 将凭据状态组合进 `useAdminConsole` / `useAdminProjects`，团队切换时清空旧凭据、旧探测结果和旧引用关系。

### 6. 管理页面

- [ ] 在 `AdminPage.tsx` 增加“Git 凭据”页签和可见性控制。
- [ ] 新增 `CredentialsTab.tsx`：多凭据列表、HTTPS/SSH 动态表单、编辑时秘密留空、引用项目展示、删除阻止提示。
- [ ] 确保系统管理员处于 `all` 团队范围时不能新建/编辑，团队管理员只能操作本团队。

### 7. 项目接入与凭据更换

- [ ] 重排 `OnboardingTab.tsx`：第一行 URL + “识别远端”，第二行凭据选择，再显示名称/分支。
- [ ] 实现显式按钮探测、成功回填、无默认分支时强制手选、URL/凭据变化失效、手动名称保留、请求序号和 SSH 指纹确认。
- [ ] 调整创建请求携带 `credentialId`，未完成有效探测时禁止提交。
- [ ] 在已接入项目列表展示凭据名称，新增最小“更换凭据”弹窗；服务端验证通过后才更新引用。

### 8. 文档与验收

- [ ] 更新 `.trellis/spec/backend/http-and-filesystem.md` 的路由/权限/敏感信息边界和 `.trellis/spec/frontend/rendering-and-state.md` 的凭据状态规则。
- [ ] 更新运行说明：`data/git-credentials.key` 必须与数据库一起备份，泄露 `data/` 等同于泄露全部 Git 凭据。
- [ ] 开发阶段不运行构建；全部实现结束后只运行一次 `npm run build`。
- [ ] 运行 `npm test`，修复所有新增/回归失败。
- [ ] 启动真实 Board 服务，使用浏览器验证：创建 HTTPS/SSH 凭据、字段不回显、删除引用阻止、公开与认证远端探测、默认/无默认分支、项目创建、刷新、凭据更换。

## 验证命令

```powershell
npm test
npm run build
node server/index.js
```

浏览器验收使用 Chrome DevTools MCP，复用现有登录会话；不新建隔离浏览器 profile。

## 风险点与回滚

- 首要风险：`data` 中的主密钥与数据库同目录。发布前必须确认备份目录权限，且不得把 `data/` 上传到仓库或普通对象存储。
- `team_project` 迁移失败会阻止启动；实现前先做 v6 数据库备份测试，禁止通过删除数据库解决。
- Git askpass、SSH 临时文件和 Windows 路径引号是高风险实现点，必须有“秘密不在命令行、临时文件必清理”的测试。
- 前端必须丢弃旧探测响应，否则 A 仓库分支可能被提交给 B 仓库。
- 任一回滚需恢复 v6 数据库；已生成的 `git-credentials.key` 可保留，但旧版本不会读取。

## 开工前检查

- [ ] PRD 无未决产品问题。
- [ ] 数据库迁移、密钥缺失、引用删除和 SSH 主机变化均有明确错误路径。
- [ ] 最终计划获得用户明确批准后才执行 `task.py start`。
