# 实施报告

## 结果

Git 子进程现在会从服务进程继承标准代理环境，服务端经本机代理访问 GitHub 的远端探测已恢复。

## 实现内容

- `server/team/git-manager.js` 新增共享 `gitEnvironment()`：
  - 继承 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`。
  - 继承对应小写变量。
  - 空值不注入。
  - 保持 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=Never`、Git 配置隔离、askpass、SSH 和 TLS 逻辑不变。
- 未修改通用 `minimalEnvironment()`；代理变量不会扩散到插件、Python、工具链或其他子进程。
- `tests/team-credentials.test.js` 增加大写、小写、空值和通用最小环境隔离测试。
- `.trellis/spec/backend/architecture-and-runtime.md` 增加 Git 出站代理环境契约。

## 验证

- `node --test tests/team-credentials.test.js`：7/7 通过。
- `node --check server/team/git-manager.js`：通过。
- `git diff --check`：改动文件通过。
- `npm test`：372 通过、5 跳过；两个 Windows 临时目录清理 `EPERM` 单独重跑均通过。
- 真实服务健康检查：`status=ok`、`mode=team`、PID `54416`。
- 浏览器 `POST /api/admin/projects/probe`：HTTP 200。
- 项目名称回填 `trellis-board`，共享分支回填 `codex/team-board`。

## 未执行

- 未提交、未推送、未创建 MR。
