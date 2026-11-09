# 质量检查报告

## 范围

- 变更集中在 `server/team/git-manager.js`、`server/team/http.js`、Git 凭据测试、后端运行规范、忽略规则和当前任务文档。
- 未修改 HTTP 路径、请求字段、数据库 schema、SSH 主机信任流程或凭据内容。
- 无关的实时协作任务、数据库备份和其他 `11-09-*` 任务保持原状。

## 代码检查

- [x] Git 命令统一通过 `runGit()`，`GIT_CONFIG_GLOBAL` 指向应用目录中的真实空文件。
- [x] SSH wrapper 使用真实临时空配置，不再向 Windows OpenSSH 传 `NUL`。
- [x] Windows 扫描环境只补充 `PROGRAMDATA`；Linux 分支不注入。
- [x] 扫描进程启动失败和非零退出均保留结构化日志。
- [x] 诊断摘要使用现有脱敏函数，不记录本机路径、秘密或完整主机公钥。
- [x] 新增分支均有 Node 回归测试，运行时空文件已加入 `.gitignore`。
- [x] 后端运行规范已同步更新，包含七个必需章节。

## 验证

- `node --check server/team/git-manager.js`：通过。
- `node --check server/team/http.js`：通过。
- `node --test tests/team-credentials.test.js`：9/9 通过。
- `npx oxfmt --check`：本次涉及的三个 JS 文件通过。
- `npm test`：376 通过、5 跳过、8 失败；失败均为无关的 Markdown 前端依赖缺失和 WITOps 插件夹具问题，本任务相关测试全部通过。
- `git diff --check`：通过。
- Trellis 上下文文件校验：通过。

本次为后端单层修复，没有修改前端或插件运行时。

## 未完成

- 未提交、未推送、未归档。
- Ubuntu 真实服务验收未执行。
