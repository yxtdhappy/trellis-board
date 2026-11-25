# 公司开发规范（company-spec）

Trellis Board 通过 `trellis-kit` 的可选 feature 把公司开发规范写入项目的
`.trellis/spec`。规范内容放在独立的内网 Git registry 中，不随桌面端安装包发布。

## 能力开关

- 开关文件：`trellis-kit/features/company-spec/feature.json`
- `enabledByDefault`：新项目初始化弹窗的默认选项。默认 `false`，即默认不套用。
- `registry`：registry 仓库地址。当前为
  `ssh://git@git.weintdata.cn:1022/prod-mdp/weint-dev-specs.git`。
- 运行期覆盖：
  - `TRELLIS_COMPANY_SPEC_ENABLED=0`：隐藏首次初始化下拉和项目入口。
  - `TRELLIS_COMPANY_SPEC_ENABLED=1`：强制默认选中“自动识别”。
  - `TRELLIS_COMPANY_SPEC_REGISTRY=<url>`：替换 registry 地址。
- `trellis-kit/apply.py --feature company-spec` 只把启用记录写入
  `.trellis/.kit-version`，不复制 feature 描述文件。

## 首次初始化

项目首次 `trellis init` 时，初始化弹窗会显示“公司开发规范”下拉：

- 不套用：保留 Trellis 原生空白 spec。
- 自动识别：根据 `package.json`、`pom.xml`、`build.gradle`、`src-tauri` 等
  识别技术栈并选择模板。
- 手动模板：直接选择前端、后端或全栈模板。

启用后桌面端给 CLI 追加：

```text
trellis init ... --registry <registry> --template <template> --append
```

初始化完成后校验 `.trellis/spec/.company-spec.json` 和入口 `index.md`；
校验失败只提示，不阻断初始化。

## 已有项目：补套、更新、换模板

项目侧边栏的“公司开发规范”图标可随时打开管理对话框。状态只看
`.trellis/spec/.company-spec.json`，与项目是否第一次初始化无关。

| 状态 | 含义 | 可用操作 |
| --- | --- | --- |
| `not_applied` | 没有 marker | 选择模板补套（整体替换） |
| `applied` | marker、入口、registry.spec 一致 | 检查更新（默认保留本地修改） |
| `template_mismatch` | marker 与 registry.spec 模板不同 | 更换模板（整体替换） |
| `update_source_missing` | marker 在，但缺少 registry.spec | 重新套用以修复 |
| `incomplete` | marker 损坏或入口缺失 | 重新套用以修复 |

写操作由 `trellis-kit/features/company-spec/apply.mjs` 执行，不重跑
`trellis init`，也不调用 `trellis update --force`：

- `keep-local`：未修改文件更新，本地修改保留，新增文件补齐，模板删除且未修改
  的文件删除。
- `overwrite`：保留用户删除的文件，但覆盖冲突文件。
- `replace`：先备份 `.trellis/spec`，再整体替换。

备份位置：`.trellis/.runtime/company-spec-backups/<timestamp>/spec`。
helper 同时维护 `.trellis/.template-hashes.json` 和 `.trellis/config.yaml` 的
`registry.spec`，因此后续手工执行 `trellis update` 仍能识别本地修改。

## registry 仓库

独立仓库建议保持两段 GitLab 路径（`group/repo`），因为 Trellis CLI 0.6.17 的
`parseRegistrySource` 只把前两段当作项目路径。

```text
index.json                 # { version, templates: [...] }
bundles/                   # 可组合的规范片段
specs/<template-id>/       # 生成物，init/helper 下载的就是这里
scripts/build-templates.mjs
scripts/sync-wiki.mjs
```

常用命令：

```bash
node scripts/build-templates.mjs
node scripts/build-templates.mjs --check
node scripts/sync-wiki.mjs --source <wiki-export-dir>
```

模板 ID：

- `wit-frontend-vue2`、`wit-frontend-mom3`、`wit-frontend-react`
- `wit-backend-java`、`wit-backend-node`
- `wit-fullstack-vue2-java`、`wit-fullstack-mom3-java`
- `wit-fullstack-react-java`、`wit-fullstack-react-node`

## 回滚

1. 从 `feature.json` 移除 feature，或设置 `TRELLIS_COMPANY_SPEC_ENABLED=0`，
   新项目不再出现下拉，已有项目入口隐藏。
2. 已写入的 `.trellis/spec` 不会自动删除；需要时从
   `.trellis/.runtime/company-spec-backups/` 恢复，或按 `keep-local` 重新套用。
3. registry 不可达时只影响检查和更新，不影响项目正常开发。
