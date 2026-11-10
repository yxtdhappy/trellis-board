# 检查报告

## 结论

通过。Git 子进程现在只额外继承标准代理环境变量，真实团队服务经本机代理访问 GitHub 成功，浏览器“识别远端”已恢复。

## 代码审查

- `server/team/git-manager.js` 在共享 Git 环境入口复制 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及对应小写变量。
- 空代理变量不会注入。
- `minimalEnvironment()` 未修改，插件、Python 和工具链不会额外获得代理变量。
- 现有 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=Never`、Git 配置隔离、askpass、SSH、TLS 和秘密脱敏逻辑保持不变。
- 未发现需要额外修复的代码问题。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| `node --test tests/team-credentials.test.js` | 7/7 通过 |
| `node --check server/team/git-manager.js` | 通过 |
| 改动文件 `git diff --check` | 通过 |
| `npm test` | 372 通过、5 跳过、2 个既有 Windows 临时目录 `EPERM` |
| 单独重跑 `plugins/a2a-intake/test/index.test.js` | 12/12 通过 |
| 单独重跑 `tests/plugin-repository-events.test.js` | 2/2 通过 |

两个 `EPERM` 均为测试清理阶段删除系统临时目录失败，与本改动代码路径无关；单独重跑通过。

## 真实服务

- 旧进程：PID `58392`。
- 当前团队模式进程：PID `54416`。
- 健康接口：`status=ok`、`mode=team`、`processId=54416`。
- 服务启动时 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 均已继承。

## 浏览器 E2E

- 页面：`http://127.0.0.1:4317/admin.html`
- 团队：`大数据`
- 仓库：`https://github.com/yxtdhappy/trellis-board.git`
- 凭据：团队内现有 GitHub HTTPS 凭据
- `POST /api/admin/projects/probe`：HTTP 200
- 回填项目名称：`trellis-board`
- 回填默认分支：`codex/team-board`
- 返回分支：`codex/team-board`

浏览器完整页面截图已通过 Chrome DevTools 取回并人工确认，页面同时显示项目名称、共享分支和可用的“克隆并检查工具链”按钮。

## 工作区

检查过程中未提交、未推送、未修改代理地址、CA、Git 凭据或数据库。工作区仍有任务外的既有未提交改动，均保持原状。

## 规范更新

- 在 `.trellis/spec/backend/architecture-and-runtime.md` 增加“Git 子进程的出站代理环境”七段契约。
- 明确代理变量只进入 Git 子进程，不扩散到通用 `minimalEnvironment()`、插件、Python 或工具链。
