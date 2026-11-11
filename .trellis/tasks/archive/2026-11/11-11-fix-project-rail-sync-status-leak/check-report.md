# 项目栏同步状态跨项目污染检查报告

## 检查结论

父项目状态只从自身 taskSpace 聚合，跨项目读取路径已移除。聚合优先级、无关联回退、
当前分支关联入口和多分支状态可见性均有回归覆盖。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| 定向回归 `node --test tests/project-rail-association.test.js` | 3/3 通过 |
| 全量 `npm test` | 491 通过、12 跳过、1 失败 |
| 失败项单独复跑 | 通过 |
| `npm --prefix web run lint` | 通过；仅仓库既有 warning |
| `npm run build` | 通过 |
| 本次文件 `oxfmt --check` | 通过 |
| `git diff --check` | 通过 |

全量测试唯一失败为未修改的 `plugins/acp-dispatch` 长命令用例等待运行结束超时；
单独复跑同用例通过，判定为全量并发执行下的环境抖动。

全仓 `npm run format:check` 仍命中 9 个与本任务无关的既有格式问题，本次未修改这些文件。

## 页面 E2E

- 重启本地 team 服务：旧 PID `34124` 停止，新 PID `26024` 启动；
  `/api/health` 返回 `status=ok, mode=team`，日志确认 `Trellis Team Board 已启动`。
- 在 `http://127.0.0.1:4317/` 注入最小 Tauri IPC 数据后验证：
  `mdp-backend-service=已关联 · 正在同步已有任务`、
  `trellis-board=已关联 · 同步正常`、`mdp-backend-web=未关联 · 关联本地仓库`。
- 依次选择 `mdp-backend-service`、`trellis-board`、`mdp-backend-service`、
  `mdp-backend-web`，三个项目状态均保持自身值，没有跟随当前项目切换。
- 项目切换触发 `/api/tasks/query`、`/api/task-operations` 返回 200；
  对应服务端日志增量无 ERROR、WARN 或异常堆栈。
- 页面控制台唯一 404 为 team 模式预期的 `/api/panels`，不属于本任务。
- 限制：浏览器不提供真实 Tauri IPC，本轮使用最小 mock 验证前端桌面渲染分支；
  未自动完成已安装 Tauri 客户端的冷启动账号登录。
