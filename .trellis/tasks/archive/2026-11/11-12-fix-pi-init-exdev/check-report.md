# Pi 初始化 EXDEV 修复检查报告

## 检查范围

- Pi `EXDEV` 失败识别、模板补齐、失败回滚和单次初始化重试。
- 51 项目标的缺失创建、已有文件保护、共享 `.agents/skills` 不覆盖。
- Pi 双完成标记检测。
- 固定 runtime 打包和 Windows SEA sidecar 调用链。
- 无关脏工作区隔离。

## 检查结论

生产逻辑未发现阻断问题。客户端只在所选 Agent 包含 Pi，且 CLI 输出同时包含 `EXDEV` 和
`.pi/extensions/trellis` 时触发补齐；其他错误保持原始失败。补齐成功后只重试一次。

补齐脚本动态读取固定 Trellis package 的 `collectPlatformTemplates("pi")`，目标路径限制在仓库
根内，使用排他创建且不覆盖已有文件。转换过程中发现测试未模拟真实半成品状态和格式偏差，已由
检查代理直接修复。

## 自动验证

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 目标测试 | `node --test tests/desktop-trellis-runtime.test.js tests/desktop-package.test.js tests/trellis-agent-tools.test.js agent/test/project-onboarding.test.js` | 30/30 通过 |
| Pi runtime 聚焦测试 | 目标测试中的 real repair + retry cases | 5/5 通过 |
| 全量测试 | `npm test` | 523 项：510 通过、12 跳过、1 失败 |
| 失败项复跑 | `node --test --test-name-pattern "tool call 执行中不按 idle 超时误杀长命令" plugins/acp-dispatch/test/index.test.js` | 1/1 通过 |
| 格式 | 目标文件 `oxfmt --check` | 通过 |
| 空白错误 | `git diff --check` | 通过 |
| sidecar 构建 | `desktop/sidecar/build-sidecar.ps1` | 通过 |
| SEA 版本 | 构建后的 `trellis-agent.exe version` | `protocolVersion=3` |

全量测试的唯一失败是既有 ACP 长命令测试在并行运行下等待运行结束超时；单独复跑通过，且本任务
未修改 `plugins/acp-dispatch`。

## Windows 实机验证

- 使用源码 sidecar + 构建后的固定 runtime，在临时 Git 仓库执行
  `codex,opencode,pi,claude-code` 初始化，成功。
- 使用构建后的 SEA `trellis-agent.exe` 在另一个临时 Git 仓库执行相同初始化，成功。
- 两次都生成了 `.pi/extensions/trellis/index.ts`、`.pi/settings.json`、`.codex`、
  `.opencode`、`.claude` 和 `.trellis/tasks`，没有 `.tmp` 残留。
- 打包后的 `resources/trellis-runtime/trellis-pi-repair.mjs` 存在。

## 尚未完成

- 尚未制作完整 Tauri 安装包，也未点击真实桌面 UI 完成项目接入。
- 当前机器这次真实初始化没有复现 DLP 的 `EXDEV`；该分支由故障注入测试覆盖。
- 未提交、未推送、未归档。
