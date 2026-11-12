# Pi 初始化 EXDEV 修复设计

## 问题边界

`@mindfoldhq/trellis@0.6.17` 的所有模板写入最终进入
`packages/cli/src/utils/atomic-write.ts`。Pi 的 `.pi/extensions/trellis/index.ts` 与
`.pi/agents/**`、`.pi/prompts/**` 使用同一条写入链，因此问题属于共享原子写能力，而不是
Pi 配置器单独绕过了写入器。

桌面安装包不从 `D:\git_workspace\trellis` 直接运行，而是复制根目录
`node_modules/@mindfoldhq/trellis`。修复必须在校验 Trellis 版本后进入本次 runtime 暂存目录，
不能只改开发机 `node_modules` 或已安装应用。

## 失败识别

`initializeTrellis()` 先正常执行一次 CLI。只有以下条件同时成立才进入补齐：

- 用户选择的 Agent 包含 `pi`；
- 命令退出码非零；
- `stderr + stdout` 包含 `EXDEV`；
- 输出包含 `.pi/extensions/trellis` 或 `\.pi\extensions\trellis`。

其他错误直接沿用原失败，不补文件、不重试，避免掩盖权限、模板或 Agent 初始化问题。

## 客户端补齐

新增独立脚本 `desktop/sidecar/trellis-pi-repair.mjs`，由固定 runtime 中的 `node.exe` 执行：

1. 从参数取得 runtime root 和仓库 root。
2. 动态导入 runtime 内的
   `node_modules/@mindfoldhq/trellis/dist/configurators/index.js`。
3. 调用 `collectPlatformTemplates("pi")` 获取已渲染的完整目标集合。
4. 校验每个目标路径仍位于仓库 root 内。
5. 已存在目标直接跳过，不比较、不覆盖；缺失文件创建父目录后使用 `openSync(..., "wx")`
   直接写入。
6. 写入失败时删除本次刚创建的目标文件并返回错误。

`collectPlatformTemplates("pi")` 当前生成 51 项：3 个 prompts、43 个共享
`.agents/skills`、3 个 agents、Pi 扩展和 `.pi/settings.json`。失败发生在扩展写入时，前面的
文件通常已经存在；修复脚本会跳过它们，只补齐扩展和 settings 等缺失项。

## 重试

补齐成功后，`initializeTrellis()` 使用完全相同的 CLI 参数再执行一次，最多一次。重试成功返回本次
结果；重试失败或补齐失败则抛出错误。`--skip-existing` 会让已存在的文件继续跳过，同时让 Pi
剩余的 settings 和后置 Agent 初始化继续执行。

不能直接复制 `.index.ts.<pid>.tmp`：上游在 `catch` 中会先删除临时文件再抛错，客户端收到失败时
通常已没有源文件。

## 打包与兼容

- `build-sidecar.ps1` 将补齐脚本复制到 `resources/trellis-runtime/`，与 `node.exe` 和
  Trellis 包一起进入安装包。
- 补齐脚本依赖 Trellis 私有模块路径；Trellis 依赖版本升级时，由桌面打包测试重新验证该入口。
- 正常初始化路径和第三方 npm 包内容不变。

## Pi 完成状态

`shared/trellis-agent-tools.js` 当前用 `.pi` 判定 Pi 已安装。给工具定义增加“全部路径存在”的
判定模式，Pi 同时要求 `.pi/extensions/trellis/index.ts` 和 `.pi/settings.json`。前者是扩展，
后者是 Pi 配置集合的最后一项；补齐过程只写了一半时不会误判完成。

## 兼容与回滚

- 未发生 `EXDEV` 时写入行为与上游 `0.6.17` 一致。
- 其他 Agent 的模板内容、初始化参数和文件位置不变。
- 回滚时删除补齐调用和脚本复制步骤，并恢复 Pi presence path；已生成项目文件不需要迁移。
- 不关闭 DLP、杀毒软件或文件系统过滤策略。
