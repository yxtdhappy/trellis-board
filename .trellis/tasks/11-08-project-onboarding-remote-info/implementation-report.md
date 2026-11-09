# 实施报告

## 结果

团队级 Git 凭据管理、HTTPS/SSH 认证、远端名称/分支识别、SSH 主机首次确认、项目凭据更换和管理页面均已实现。Git 凭据只在服务端解密使用，项目仍支持无凭据公开仓库和已有项目兼容。

## 实现内容

### 数据库与凭据

- 数据库升级到 schema v7，新增 `git_credential`、`git_ssh_known_host` 和 `team_project.git_credential_id`。
- v6 数据库升级前自动写入 `data/backups/board.sqlite.pre-v7.*`，旧账号、项目、审计和任务索引保留。
- Git 凭据使用 `data/git-credentials.key` 的 32 字节主密钥和 AES-256-GCM 加密。
- 密文 AAD 绑定凭据 ID、团队、主机、认证类型和密钥版本，数据库元数据被篡改时无法偷换解密用途。
- 支持 HTTPS 用户名/访问令牌和 SSH 私钥/可选口令，秘密字段不回填，主机与认证类型创建后不可修改。
- 凭据按团队隔离并按主机、认证类型绑定；被项目引用时禁止删除。

### Git 与远端探测

- 远端探测只执行 `git ls-remote --symref`，返回推荐名称、默认分支和全部 remote heads，不创建工作副本。
- 有效 symbolic `HEAD` 才默认选择分支；否则前端要求管理员手动选择。
- 增加超时、1 MiB 输出限制、按用户频率/并发限制和迟到响应丢弃。
- HTTPS 使用短生命周期 askpass 环境；SSH 使用操作级临时私钥、严格 `known_hosts` 和可选口令 askpass。
- 服务启动时清理崩溃遗留的 `data/.git-auth/`，操作结束始终删除临时认证材料。
- SSH 首次连接通过一次性 challenge 展示 SHA256 指纹；主机密钥变化必须再次人工确认。
- clone、fetch、push、远端包含检查和 scheduled refresh 均使用项目绑定的凭据。

### API 与前端

- 新增 Git 凭据 CRUD、远端探测、SSH 主机确认和项目凭据更换 API。
- 管理台新增“Git 凭据”页签，支持团队凭据列表、编辑、删除保护、引用项目展示和 HTTPS/SSH 动态表单。
- 项目接入第一行改为 Git URL + 右侧“识别远端”按钮，第二行选择团队凭据，再显示项目名称和可搜索分支。
- URL 或凭据变化立即清除旧探测；项目名称手动修改后不会因后续探测被自动覆盖。
- 已接入项目显示当前凭据，并提供“更换凭据”弹窗；保存前重新验证远端访问。
- 团队切换会重挂载凭据和项目接入页面，清空旧表单、旧分支和旧探测。
- 修复系统管理员只有单团队时无法从具体团队切回“全部团队”的问题。

### 文档

- 更新后端 HTTP/安全规范、后端质量覆盖、前端状态规范和管理页入口说明。
- 更新 README 与团队运维手册，明确数据库、WAL/SHM 和 `git-credentials.key` 必须成组备份。

## 验证

- `npm test`：346 项，340 通过、5 跳过、1 个既有 Windows 临时目录 `EPERM` 偶发失败。
- 上述失败用例单独重跑通过：1/1。
- Git 凭据定向测试：6/6 通过。
- `npm --prefix web run lint`：通过，0 error；无失败项。
- 首次 `npm run build` 因 worktree 缺少 `web/node_modules` 未进入编译；安装锁文件依赖后构建通过。
- 浏览器 E2E 发现并修复单团队成员切换器问题后，执行了一次最终 `npm run build`，TypeScript 与 Vite 生产构建成功。
- `git diff --check`：通过。
- `node --check`：新增/修改后端关键文件通过。

## 浏览器验收

- Chrome DevTools MCP 两次连接超时，按项目规则改用 `ego-browser`。
- 隔离服务 `http://127.0.0.1:4318` 完成管理员登录、团队切换和真实页面操作。
- 验证 HTTPS 凭据创建、页面不回显令牌、编辑时秘密字段为空且主机/类型不可变。
- 验证 HTTPS/SSH 动态字段切换。
- 验证 URL 输入与失焦不触发探测，点击“识别远端”后才回填 `remote` 和默认分支 `main`。
- 验证凭据变化清除旧探测并禁用提交。
- 验证团队切换清空 URL、分支和旧探测。
- 验证公开本地 bare Git 仓库成功识别、选择 `dev`、克隆并创建项目。
- 验证项目凭据弹窗只展示当前团队凭据。
- 验证脚本缓存被工具链校验拒绝，说明现有工具链安全边界仍生效。

截图：`C:/Users/yuhaojie/.codex/visualizations/2026/11/08/01a1bb47-cf5a-7560-8ab7-a5f08661fc6b/git-credentials-e2e/credentials-page.png`

## 已知事项

- 未使用真实 GitHub/GitLab 私有仓库验证 HTTPS/SSH clone、fetch、push；当前自动化使用本地 bare/file 仓库和凭据服务单测。
- Windows OpenSSH askpass、带口令私钥和真实 SSH 主机 trust/change 流程缺少真实远端执行证据。
- `data/git-credentials.key` 与数据库同目录是已接受风险；二者必须作为完整备份单元。
- 未提交、未推送、未创建 MR。
