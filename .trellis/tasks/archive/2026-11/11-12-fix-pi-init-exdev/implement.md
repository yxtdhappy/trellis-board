# Pi 初始化 EXDEV 实施计划

## 1. 客户端 Pi 补齐脚本

- [x] 新增 `desktop/sidecar/trellis-pi-repair.mjs`，通过
  `collectPlatformTemplates("pi")` 枚举完整目标集合。
- [x] 只创建缺失文件；已有文件不覆盖，目标路径必须位于仓库 root 内。
- [x] 使用排他创建直写；写入失败时删除本次创建的文件。
- [x] 修改完成前不执行完整构建。

## 2. 初始化失败后补齐并重试

- [x] 在 `desktop/sidecar/trellis-runtime.js` 增加仅针对 Pi `EXDEV` 的失败识别。
- [x] 补齐成功后使用相同参数重试一次，禁止循环重试。
- [x] 补齐或重试失败时返回可定位错误，其他初始化错误保持原行为。
- [x] 为 `initializeTrellis()` 注入可替换的进程执行器，使用替身验证调用顺序。

## 3. Pi 完整性判断

- [x] 为 Agent 工具定义增加“全部 presence path 存在”判定模式。
- [x] Pi 同时要求 `.pi/extensions/trellis/index.ts` 与 `.pi/settings.json`。
- [x] 更新 `tests/trellis-agent-tools.test.js`，覆盖只有 `.pi/agents`、只有单个完成标记和两个
  标记都存在。

## 4. 打包与自动化验证

- [x] 在 `desktop/sidecar/build-sidecar.ps1` 校验并复制补齐脚本到 runtime。
- [x] 更新 `tests/desktop-package.test.js`，验证构建脚本和资源入口存在。
- [x] 新增测试：真实执行补齐脚本，断言 51 项目标中的缺失文件被创建、已有文件内容不变、
  无临时文件。
- [x] 新增测试：Pi `EXDEV` 时执行“补齐 → 重试一次”；其他错误不进入补齐。
- [x] 运行目标测试 `node --test tests/desktop-trellis-runtime.test.js tests/desktop-package.test.js tests/trellis-agent-tools.test.js agent/test/project-onboarding.test.js`。
- [x] 开发完成后执行一次 `npm test`：510 通过、12 跳过、1 个既有 ACP 长命令测试超时；
  失败项单独复跑通过。

## 5. Windows 实际验收

- [x] 最后一次构建 `desktop/sidecar/build-sidecar.ps1`，确认安装资源中包含
  `trellis-pi-repair.mjs`。
- [x] 在临时干净 Git 仓库分别通过源码 sidecar 和构建后的 SEA 客户端执行包含 Pi 的初始化。
- [x] 验证 `.pi/extensions/trellis/index.ts` 内容非空、无残留 `.tmp` 文件。
- [x] 验证 `.pi/settings.json` 存在且 Codex、OpenCode、Claude Code 初始化继续完成。
- [x] 验证失败残留不满足两个完成标记时，客户端仍认为 Pi 需要初始化。

## 风险与回滚点

- 风险：直写仍被文件系统过滤层拒绝时，补齐失败；此时返回错误，不进入重试。
- 风险：Trellis 升级后配置器导出路径变化；打包测试和 Windows 初始化验收必须覆盖。
- 风险：`.agents/skills` 跨 Agent 共享；补齐只能创建缺失文件，不能覆盖已有内容。
- 回滚点 1：移除失败识别、补齐调用和重试。
- 回滚点 2：移除补齐脚本打包。
- 回滚点 3：恢复 Pi presence path 为 `.pi`。
