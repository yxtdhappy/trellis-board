# 修复 Pi 初始化 EXDEV 失败

## Goal

让桌面客户端在 Pi 初始化因 Windows 同目录原子重命名返回 `EXDEV` 而中断时，自动补齐缺失的 Pi
模板并重试一次初始化；若修复失败，则准确报错且不把半成品识别为已完成。

## Background

- 实际命令：bundled `trellis init -y --skip-existing -u yhj --codex --opencode --pi --claude`。
- 失败点：
  `.pi/extensions/trellis/.index.ts.<pid>.tmp` → `.pi/extensions/trellis/index.ts`。
- 两个路径均位于同一 C 盘、同一目录，Windows 仍返回
  `EXDEV: cross-device link not permitted`。
- 失败后 `.pi/agents`、`.pi/prompts` 和空的 `.pi/extensions/trellis` 已生成，检测器按 `.pi`
  存在把 Pi 标记为“已安装”，导致后续无法正常重试。
- 上游 `0.6.17` 的 Pi 配置器先生成 `.pi/**` 模板，再统一经过
  `writeTemplateMap()` → `writeFile()` → `writeFileAtomic()`；失败发生在共享写函数的
  `fs.renameSync()`，不是 Pi 模板内容错误。
- 桌面客户端运行时来自根目录 npm 依赖 `@mindfoldhq/trellis@0.6.17`，由
  `desktop/sidecar/build-sidecar.ps1` 复制进安装包；直接修改 `node_modules` 或本机已安装副本
  会在下次安装/打包时丢失。

## Requirements

- R1：保持 Trellis CLI 原有的临时文件加原子重命名逻辑，不修改 npm 包安装目录。
- R2：仅当选择的 Agent 包含 Pi，且初始化输出同时包含 `EXDEV` 和 Pi 扩展路径时，客户端读取
  `collectPlatformTemplates("pi")`，直接创建缺失目标文件；已有文件保持不变。
- R3：补齐成功后使用相同参数重试一次完整初始化，使 Pi 后续文件和其他 Agent 初始化继续执行。
- R4：其他初始化错误不得触发 Pi 补齐；补齐或重试失败时返回明确错误，不能无限重试。
- R5：补齐脚本必须进入桌面安装包使用的固定 runtime，不能只存在于开发机源码。
- R6：Pi 的完成状态必须同时验证 `.pi/extensions/trellis/index.ts` 和 `.pi/settings.json`，
  不能仅凭 `.pi` 目录或单一文件判定完成。

## Acceptance Criteria

- [x] 自动化测试模拟 Pi `EXDEV` 失败，验证客户端补齐缺失文件后只重试一次。
- [x] 非 Pi `EXDEV` 或其他初始化错误不触发补齐和重试。
- [x] 补齐过程不覆盖已有 Pi 文件或共享 `.agents/skills` 文件。
- [x] Pi 初始化失败后不会留下让检测器误判为已安装的半成品。
- [x] 在目标 Windows 环境实际执行包含 Pi 的初始化并成功。
- [x] `codex`、`opencode`、`claude-code` 初始化无回归。
- [x] 构建或打包流程会带上 Pi 补齐脚本。

## Out of Scope

- 不要求用户关闭 DLP、杀毒软件或安全策略。
- 不改变 Trellis Agent 标识、Pi 模板内容或预检交互。
- 不自动提交初始化生成文件。
