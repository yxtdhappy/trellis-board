# 公司 GitLab registry 落点验证（2026-11-25）

## 1. 验证目标

确认用户提供的 `http://git.weintdata.cn/devops/weint-spec-board` 是否能作为 Trellis registry，以及 Trellis CLI 0.6.17 对该地址的解析/下载行为。

## 2. 仓库事实

通过已登录的 GitLab 页面调用 API 读取（项目 id 1256）：

- 路径：`devops/weint-spec-board`（两段，满足 CLI 的 `repo = 前两段` 规则）。
- 可见性：`private`；默认分支：`main`；创建时间：2026-11-19；最后活动：2026-11-25。
- `http_url_to_repo`：`http://git.weintdata.cn/devops/weint-spec-board.git`
- `ssh_url_to_repo`：`ssh://git@git.weintdata.cn:1022/devops/weint-spec-board.git`
- 根目录：`.agents/`、`.github/`、`.trellis/`、`.yarn/`、`config/`、`design/`、`docs/`、`packages/`、`plugins/`、`scripts/`、`trellis-kit/`、`README.md`、`package.json` 等；**没有 `index.json`，也没有 `specs/`**。
- README 说明这是 Trellis Board 产品仓库（yarn workspaces monorepo），不是规范 registry。

结论：该仓库本身**不能直接作为 registry**；CLI 会在根目录找 `index.json`，当前不存在。

## 3. 网络与认证

### 3.1 HTTP

```text
curl -L http://git.weintdata.cn/devops/weint-spec-board
→ 最终跳转 http://git.weintdata.cn/users/sign_in（未登录）

curl -L http://git.weintdata.cn/devops/weint-spec-board/-/raw/main/index.json
→ HTTP 200，但 content-type text/html，返回登录页（34KB），不是 JSON

git ls-remote http://git.weintdata.cn/devops/weint-spec-board.git
→ 需要用户名/密码，GCM 弹窗被取消
```

### 3.2 HTTPS

```text
curl -k -L https://git.weintdata.cn/devops/weint-spec-board
→ HTTP 404

curl -k -L https://git.weintdata.cn/devops/weint-spec-board/-/raw/main/index.json
→ HTTP 404
```

该主机当前没有可用的 HTTPS 站点；Trellis CLI 的自托管 GitLab 路径会把 URL 重建成 `https://...`，因此**不能把 `http://...` 直接填进 `feature.json`**。

### 3.3 SSH

```text
ssh -p 1022 -T git@git.weintdata.cn
→ Welcome to GitLab, @yuhaojie!

git ls-remote ssh://git@git.weintdata.cn:1022/devops/weint-spec-board.git
→ 成功列出 refs/heads/main 等分支
```

当前机器的 SSH key 已被 GitLab 接受，无需交互密码。

## 4. Trellis CLI 解析结果

用 CLI 0.6.17 的 `parseRegistrySource` 实测：

| 输入 | provider | repo | sourceKind | preferGit | gitUrl |
|---|---|---|---|---|---|
| `http://git.weintdata.cn/devops/weint-spec-board` | gitlab | `devops/weint-spec-board` | https | true | `https://git.weintdata.cn/devops/weint-spec-board.git` |
| `ssh://git@git.weintdata.cn:1022/devops/weint-spec-board.git` | gitlab | `devops/weint-spec-board` | ssh | true | `ssh://git@git.weintdata.cn:1022/devops/weint-spec-board.git` |
| `ssh://git@git.weintdata.cn:1022/prod-mdp/weint-dev-specs.git`（实际创建的仓库） | gitlab | `prod-mdp/weint-dev-specs` | ssh | true | `ssh://git@git.weintdata.cn:1022/prod-mdp/weint-dev-specs.git` |

对应源码：`node_modules/@mindfoldhq/trellis/dist/utils/template-fetcher.js:96`（自托管 gitUrl 固定 `https://`）、`:217`（rawBaseUrl 固定 `https://`）、`:140-157`（SSH 解析）、`:230`（`preferGit = ssh || host`）。

## 5. 结论与建议

1. 不能直接用 `http://.../weint-spec-board` 作为 registry：
   - 它不是 registry（无 `index.json`/`specs/`）；
   - HTTP URL 会被 CLI 重写成 HTTPS，而 HTTPS 当前 404。
2. 必须使用 SSH URL；已验证当前 key 可用。
3. registry 仓库需要单独创建；已创建：
   - `ssh://git@git.weintdata.cn:1022/prod-mdp/weint-dev-specs.git`（两段路径，独立仓库，project id `1262`，默认分支 `main`）。
   - 不再采用：在 `weint-spec-board` 根下加 `company-spec/` 子目录，会与产品代码混放。
4. 若团队坚持 HTTP，需要额外做以下之一，均不在本任务范围：
   - 给 GitLab 配 HTTPS 反向代理；
   - 给 CLI 打补丁支持 HTTP；
   - 在开发者机器配置 `git config url."http://git.weintdata.cn/".insteadOf "https://git.weintdata.cn/"`（仍需要 Git 凭据，且 raw 探测可能失败）。

## 6. 复现命令

```bash
# 页面/HTTP
curl -sS -L -o /dev/null -w '%{http_code} %{url_effective}\n' http://git.weintdata.cn/devops/weint-spec-board
curl -sS -L -o /tmp/index.json -w '%{http_code} %{content_type}\n' http://git.weintdata.cn/devops/weint-spec-board/-/raw/main/index.json

# HTTPS
curl -k -sS -L -o /dev/null -w '%{http_code}\n' https://git.weintdata.cn/devops/weint-spec-board

# SSH
ssh -p 1022 -o BatchMode=yes -T git@git.weintdata.cn
GIT_SSH_COMMAND='ssh -p 1022 -o BatchMode=yes' git ls-remote ssh://git@git.weintdata.cn:1022/devops/weint-spec-board.git

# CLI 解析
node --input-type=module -e "import { parseRegistrySource } from './node_modules/@mindfoldhq/trellis/dist/utils/template-fetcher.js'; console.log(parseRegistrySource('ssh://git@git.weintdata.cn:1022/devops/weint-spec-board.git'))"
```

## 7. 决策与前置条件

- 当前落点：`prod-mdp/weint-dev-specs`，SSH 地址 `ssh://git@git.weintdata.cn:1022/prod-mdp/weint-dev-specs.git`。用户确认这是**临时验证落点**，后续申请中性组后迁移；新项目改 `feature.json`，已有项目由 helper 在下一次 apply/update 时重写 `registry.spec.source`。
- 创建结果：`POST /api/v4/projects`（`namespace_id=609`）返回 201，project id `1262`，`path_with_namespace=prod-mdp/weint-dev-specs`，默认分支 `main`，`empty_repo=false`（README 初始提交）；`git ls-remote` 返回 `refs/heads/main`（`fe7db2d7065cae426e73dcb8c5ffd49c6774231d`）。Phase 7 提交 `index.json`/`specs/`。
- CLI 探测：`parseRegistrySource('ssh://git@git.weintdata.cn:1022/prod-mdp/weint-dev-specs.git')` → `repo=prod-mdp/weint-dev-specs`、`sourceKind=ssh`、`preferGit=true`；`probeRegistryIndex` → `{"templates":[],"isNotFound":true,"backend":"git"}`。说明 CLI 已能通过 SSH clone，当前只是缺 `index.json`（Phase 7 补齐）。
- **原计划 `devops/weint-dev-specs` 失败**：`GET /api/v4/user` 返回 `can_create_project=false`、`projects_limit=0`；`GET /api/v4/groups/5` 返回 `project_creation_level=maintainer`；`POST /api/v4/projects`（`namespace_id=5`）返回 `400 {"message":{"namespace":["is not valid"]}}`。改用 `prod-mdp`（组 id `609`，`project_creation_level=developer`）后成功。
- 需确认团队开发者 SSH key 可读；当前用户的 SSH 访问已验证。
