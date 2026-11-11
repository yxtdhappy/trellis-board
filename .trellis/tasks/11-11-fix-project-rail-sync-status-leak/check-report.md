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
