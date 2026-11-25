# Trellis CLI 0.6.17 registry / spec 模板机制

> 目的：确认能否复用上游能力，避免自研注入器。以下事实来自本仓库 `node_modules/@mindfoldhq/trellis`（0.6.17，根 `package.json` 固定版本）源码与 `init --help` 实测。路径均相对于 `node_modules/@mindfoldhq/trellis/`。

## 1. CLI 参数

`trellis init --help` 确认存在：

- `-t, --template <name>`：按 ID 选择 registry 模板。
- `-r, --registry <source>`：自定义 registry（支持 GitHub/GitLab/自托管/SSH）。
- `--append`：只补缺失文件，不覆盖已有文件。
- `--overwrite`：覆盖已有文件。
- `-s, --skip-existing`：跳过已存在文件（默认策略）。
- `--monorepo` / `--no-monorepo`：强制/禁用 monorepo 模式。
- `-y, --yes`：非交互。
- `-u, --user <name>`：开发者身份。

## 2. Registry 地址解析

`dist/utils/template-fetcher.js:206-252` `parseRegistrySource`：

- 支持 `gh:` / `github:` / `gitlab:` / `bitbucket:`、HTTPS、SSH。
- 自托管 HTTPS 默认按 GitLab 处理，repo 为路径前两段，subdir 为其余段，ref 默认 `main`。
- **约束**：GitLab 项目路径必须恰好两段 `group/repo`；`group/sub/repo` 会被解析成 `repo=group/sub`、`subdir=repo`，导致 404 或 clone 失败。
- `preferGit = sourceKind === "ssh" || host !== undefined`：自托管通常直接走 Git 克隆，而不是 HTTP raw。
- `rawBaseUrl` 仅用于 GitHub 风格或探测；GitLab 模板最终通过 `gitlab:<repo>/<template.path>#<ref>` 下载。

## 3. index.json 与安装路径

`template-fetcher.js:300-350`、`:24-32`：

```json
{
  "version": 1,
  "templates": [
    { "id": "...", "type": "spec", "name": "...", "path": "specs/...", "description": "...", "tags": [] }
  ]
}
```

安装路径：

| type | 目标 |
| --- | --- |
| `spec` | `.trellis/spec` |
| `skill` | `.agents/skills` |
| `command` | `.claude/commands` |
| `full` | 仓库根 |

MVP 只需要 `type: "spec"`。模板 `path` 指向仓库内目录，目录内容被复制到 `.trellis/spec` 根。

## 4. 下载与复制策略

- `probeRegistryIndex`：`preferGit` 时直接 `cloneRegistryRef`，否则 HTTP 探测 `index.json`；HTTP 401/403 提示检查本机 Git 凭据。
- `probeRegistryIndexGit`（`:548-570`）：克隆后读根 `index.json`；缺失返回 not-found。
- `downloadTemplateById`：无预取时再次 probe；找不到模板返回 `Template not found`；成功调用 `downloadGitRegistryPath`。
- `cloneRegistryRef`：`git clone --filter=blob:none --no-checkout <gitUrl>`，再 `fetch --depth 1 origin <ref>` + `checkout --detach FETCH_HEAD`；30s 超时。
- `copyDirectoryWithStrategy`（`:745-759`）：
  - `skip` 且目标已存在：直接返回 false（不下载）；
  - `overwrite`：删除目标后复制；
  - `append` 且目标已存在：`copyMissing`，只补缺失文件；
  - 其他：`copyAll`。
- `downloadGitRegistryPath`（`:760-772`）：把 `<repo>/<template.path>` 目录内容复制到 `.trellis/spec`。

## 5. init 流程中的挂接点

`dist/commands/init.js`：

- `registrySourceForConfig = options.registry`（:946），保存用户输入的完整 URL（保留内网 host）。
- `templateStrategy` 默认 `"skip"`；`--overwrite` → overwrite；`--append` → append（:954-960）。
- `-y --template` 单仓：`selectedTemplate = options.template`；有 registry 时先 probe（:1128-1150）。
- 下载：`downloadTemplateById(...)`（:1375）；成功且非 skipped 才 `useRemoteTemplate=true`，并记录 `registrySpecConfigToPersist = { source: registrySourceForConfig, template: selectedTemplate }`（:1376-1390）。
- 下载失败：打印 warning，回退空白模板，继续执行，**退出码仍为 0**（约 :1390-1400）。因此桌面端不能靠退出码判断套用成功。
- `createWorkflowStructure(cwd, { skipSpecTemplates: useRemoteTemplate, packages, remoteSpecPackages, ... })`（约 :1465）：使用远程模板时不写空白 spec。
- `writeSpecRegistryConfig(cwd, registrySpecConfigToPersist)`（:1512）：写入 `.trellis/config.yaml` 的 `registry.spec.source/template`。
- `initializeHashes(cwd, { trackedPaths: writtenPaths })`（:1515）记录本次写入；随后若 `useRemoteTemplate`，遍历 `collectSpecPaths(cwd)` 并对每个 spec 文件 `updateHashes`（:1517-1526）。**说明模板文件（含 `.company-spec.json`）会被登记哈希；桌面端若在 init 后改写 marker，会导致 `trellis update` 将其视为本地修改。**

## 6. monorepo 行为

- `monorepoPackages` 存在时，每个包 `destDir = path.join(cwd, PATHS.SPEC, sanitizePkgName(pkg.name))`（:1042/1080-1081）。
- `-y` 会把同一个 `options.template` 应用到每个包；没有“按包选不同模板”的交互。
- `--no-monorepo` 可强制根级 `.trellis/spec`。
- 结论：MVP 对 JS workspace monorepo 跳过自动套用，避免把 Vue 模板错误套到后端包。

## 7. 更新机制

`dist/commands/update.js`：

- `loadSpecRegistryConfig`（:470）读取 `.trellis/config.yaml` 的 `registry.spec`。
- `collectRegistrySpecTemplates` 下载 registry 模板到临时目录，收集 `.trellis/spec` 文件，走既有哈希冲突流程。
- 结论：只要 registry 与 `.trellis/config.yaml` 保持可访问，`trellis update` 就能刷新 spec；这是选择 registry 方案而不是注入脚本的关键收益。

## 8. 对本项目的直接结论

1. 不需要新增 `trellis-board` 注入器；只需在 `init_args` 追加 `--registry/--template/--append`。
2. registry 必须是两段路径的 GitLab 项目；这是外部约束，需先确认。
3. 模板必须自带静态 `.company-spec.json`，桌面端只读校验，不能改写（否则破坏哈希跟踪）。
4. 失败会静默回退空白 spec 且退出码 0；必须做 marker + 入口文件校验。
5. monorepo 的 `-y` 行为不适合按包选模板；MVP 跳过。
6. 桌面端已有 `TrellisRuntime` 与 210s 初始化超时；registry 下载额外耗时在此预算内。

## 9. 复现命令

```bash
node_modules/.bin/trellis init --help
rg -n "parseRegistrySource|copyDirectoryWithStrategy|downloadGitRegistryPath" node_modules/@mindfoldhq/trellis/dist/utils/template-fetcher.js
rg -n "registrySpecConfigToPersist|skipSpecTemplates|writeSpecRegistryConfig|initializeHashes" node_modules/@mindfoldhq/trellis/dist/commands/init.js
rg -n "loadSpecRegistryConfig|collectRegistrySpecTemplates" node_modules/@mindfoldhq/trellis/dist/commands/update.js
```
