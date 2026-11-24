# Tauri 桌面客户端自动更新与内网 Jenkins 集成指南

本文说明如何在内网部署环境下，将 **Tauri 桌面客户端更新源与 Team 服务端集成**，并通过 **内网 Jenkins** 一次构建同时完成 Team 服务端更新与 Windows 客户端绿色包发布。

---

## 1. 工作原理与更新源优先级

Team 服务端内置免登录只读端点 `/client-updates/`，直接托管便携包产物（`latest.json` 与 `TrellisBoard_<version>_x64-portable.zip`），无需单独搭建文件服务器。

Tauri 客户端按以下优先级确定更新源：

1. **构建期显式指定 `TRELLIS_UPDATE_SERVER`（最高优先级）**：
   打包时传入环境变量 `TRELLIS_UPDATE_SERVER`（或 `yarn build --target=desktop --update-server=https://...`），客户端固定向 `<TRELLIS_UPDATE_SERVER>/latest.json` 检查更新。
2. **运行时自动回退到当前 Team 服务端（内网默认推荐）**：
   构建期未设置 `TRELLIS_UPDATE_SERVER` 时，客户端在启动读取本地配置（或登录后）自动拼接当前连接的 Team 服务端根地址：`<serverUrl>/client-updates`。
   - 同一份通用 Windows 安装包可适配任意内网 IP / 域名 / 端口，更换服务端地址无需重新编译客户端；
   - 未登录且未配置构建期地址时，托盘「检查更新」自动置灰且不发起网络请求；登录成功后立即激活并触发一次检查。

客户端检查与安装流程：
1. 启动 5 秒后首次检查，之后每 6 小时检查一次（也可在顶栏客户端版本号或托盘「检查更新」手动触发）。
2. 请求 `GET <base>/latest.json`（上限 64 KiB），按 `x.y.z` 做严格 semver 比较；发现新版本时发系统通知。
3. 用户点击更新后，流式下载 `GET <base>/<file>`，校验 `size`（≤ 512 MiB）与 `sha256`（必须与清单一致），从 ZIP 根目录或单层顶层目录提取唯一 `trellis-board-client.exe`，将旧 EXE 备份为 `.old` 后替换并自动重启。

> 开发模式（`debug` 构建）拒绝执行替换重启；仅正式 release 构建允许自动更新。

---

## 2. Team 服务端托管目录与路由契约

### 2.1 目录配置

| 环境变量 / 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `TRELLIS_BOARD_DATA_DIR` | 平台用户数据目录（Ubuntu 建议 `/var/lib/trellis-board`） | Team 服务端运行数据根目录 |
| `TRELLIS_CLIENT_UPDATES_DIR` / `--client-updates-dir` | `<TRELLIS_BOARD_DATA_DIR>/client-updates` | 客户端更新文件托管目录，可单独指向共享卷或独立磁盘目录 |

在启动时也可通过 CLI 参数覆盖：

```bash
yarn start --data-dir=/var/lib/trellis-board --client-updates-dir=/var/lib/trellis-board/client-updates
```

### 2.2 服务端接口与安全边界

- **端点**：`GET` / `HEAD` `/client-updates/latest.json` 与 `/client-updates/<file>.zip`（免登录 Cookie，登录前亦可检查和下载；其余 HTTP 方法返回 `405`）。
- **缓存策略**：
  - `latest.json` 返回 `Content-Type: application/json; charset=utf-8` 与 `Cache-Control: no-store, no-cache, must-revalidate`；
  - `.zip` 返回 `Content-Type: application/zip`、`Content-Length`、`Content-Disposition: attachment; filename="..."` 与 `Cache-Control: public, max-age=86400`，使用流式读取（`fs.createReadStream`），不占用大内存。
- **路径安全**：仅允许 `latest.json` 或单段 `[A-Za-z0-9._-]+\.zip` 文件名；拒绝 `/..`、反斜杠、嵌套路径、其它扩展名及指向目录外部的符号链接（返回 `400` / `403` / `404`）。

---

## 3. 内网 Jenkins 一体化构建与发布

### 3.1 推荐流水线拓扑

由于 Windows 桌面客户端（MSVC + WebView2）必须在 Windows 节点构建，而 Team 服务端通常运行在 Linux（Docker / systemd）节点上，内网 Jenkins 推荐采用**同一条 Pipeline 协同两类 Agent**（或 Linux 服务端节点 + Windows 构建 Agent）：

1. **阶段 1 — 构建并更新 Team 服务端**：
   - `yarn install --immutable`
   - `yarn build`（生成 `packages/server/public/`）
   - `yarn test`（验证服务端与公共脚本）
   - 构建容器镜像或更新服务端部署目录并重启 Team 服务（确保 `TRELLIS_BOARD_DATA_DIR` 或 `TRELLIS_CLIENT_UPDATES_DIR` 挂载持久化）。
2. **阶段 2 — 构建 Windows 客户端便携包（Windows Jenkins Agent）**：
   - 环境要求：Node.js 24+、Yarn 3.5（`corepack enable`）、Rust stable（MSVC toolchain）、VS Build Tools C++、Tauri CLI v2。
   - 若服务端版本与客户端版本需要保持同步，可在构建前确认 `package.json` / `packages/desktop/src-tauri/tauri.conf.json` / `Cargo.toml` 版本已通过 `yarn release:desktop` 递增或由流水线统一对齐。
   - 执行构建与打包（不传 `TRELLIS_UPDATE_SERVER` 即可启用「自动跟随当前登录 Team 服务端 `/client-updates`」）：
     ```powershell
     yarn install --immutable
     yarn build --target=desktop-ui
     yarn test --scope=rust
     yarn build --target=desktop --skip-ui
     yarn build --target=portable
     ```
   - 产物位于 `packages\desktop\src-tauri\target\release\bundle\portable\`：
     - `TrellisBoard_<version>_x64-portable.zip`
     - `TrellisBoard_<version>_x64-portable.zip.sha256`
     - `latest.json`
3. **阶段 3 — 原子投放到 Team 服务端托管目录**：
   - **发布顺序铁律**：**先上传 `.zip`（与 `.sha256`），校验完整后再原子替换 `latest.json`**，避免客户端读到新版清单时下载 `.zip` 返回 `404`。

### 3.2 Jenkins Pipeline 原子发布示例

```groovy
pipeline {
  agent none
  environment {
    TEAM_SERVER_HOST = 'deploy@10.0.0.10'
    CLIENT_UPDATES_DIR = '/var/lib/trellis-board/client-updates'
  }
  stages {
    stage('Build & Deploy Server') {
      agent { label 'linux-node24' }
      steps {
        sh '''
          corepack enable
          yarn install --immutable
          yarn build
          yarn test
          # 在此执行你的服务端镜像构建 / 服务重启命令
        '''
      }
    }
    stage('Build Windows Client') {
      agent { label 'windows-rust' }
      steps {
        powershell '''
          $ErrorActionPreference = 'Stop'
          corepack enable
          yarn install --immutable
          yarn build --target=desktop-ui
          yarn test --scope=rust
          yarn build --target=desktop --skip-ui
          yarn build --target=portable
        '''
        stash name: 'portable-bundle',
              includes: 'packages/desktop/src-tauri/target/release/bundle/portable/*.zip,packages/desktop/src-tauri/target/release/bundle/portable/*.zip.sha256,packages/desktop/src-tauri/target/release/bundle/portable/latest.json'
      }
    }
    stage('Publish Client Updates to Team Server') {
      agent { label 'linux-node24' }
      steps {
        unstash 'portable-bundle'
        sh '''
          DIR="packages/desktop/src-tauri/target/release/bundle/portable"
          ZIP=$(ls "$DIR"/*.zip | head -n 1)
          SHA=$(ls "$DIR"/*.zip.sha256 | head -n 1)
          LATEST="$DIR/latest.json"

          ssh "$TEAM_SERVER_HOST" "mkdir -p '$CLIENT_UPDATES_DIR'"
          scp "$ZIP" "$SHA" "$TEAM_SERVER_HOST:$CLIENT_UPDATES_DIR/"
          scp "$LATEST" "$TEAM_SERVER_HOST:$CLIENT_UPDATES_DIR/latest.json.tmp"
          ssh "$TEAM_SERVER_HOST" "mv -f '$CLIENT_UPDATES_DIR/latest.json.tmp' '$CLIENT_UPDATES_DIR/latest.json'"
        '''
      }
    }
  }
}
```

> 若服务端与构建在同一宿主机或通过共享存储卷挂载，只需把 `scp` 替换为 `cp` + 同目录 `mv -f latest.json.tmp latest.json`（`rename` 原子替换）。如需在 `latest.json` 中展示本次发版说明，可在 `mv` 前写入 `notes` 字段，但不得改动 `version`、`file`、`sha256` 和 `size`。

---

## 4. Docker 与反向代理配置

### 4.1 Docker 挂载卷

确保容器把 `TRELLIS_BOARD_DATA_DIR`（默认包含 `client-updates/`）或显式的 `TRELLIS_CLIENT_UPDATES_DIR` 挂载到宿主机持久化目录，Jenkins 发布后无需重建容器即可生效：

```bash
docker run -d --name trellis-board \
  -p 4317:4317 \
  -e TRELLIS_BOARD_DATA_DIR=/data/server \
  -v /var/lib/trellis-board:/data/server \
  trellis-board:latest
```

### 4.2 Nginx 反向代理

若 Team 看板通过 Nginx 暴露 HTTP/HTTPS（支持根路径或通过 `TRELLIS_BOARD_BASE_PATH` 挂载到子路径如 `/weint-spec-board`），确保 `/client-updates/`（或 `<basePath>/client-updates/`）透传到 Node 服务端且关闭大文件缓冲与清单缓存：

```nginx
location /client-updates/ {
    proxy_pass http://127.0.0.1:4317;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 300s;
}
```

> 当服务端配置 `TRELLIS_BOARD_BASE_PATH=/weint-spec-board` 时，客户端登录 `http://spec-board.weintdata.cn/weint-spec-board` 会自动向 `http://spec-board.weintdata.cn/weint-spec-board/client-updates/latest.json` 检查更新；服务端同时兼容 Nginx 透传 `/weint-spec-board/client-updates/...` 与剥离前缀后转发 `/client-updates/...`。

---

## 5. 验收与排障

### 5.1 发布后冒烟检查

```bash
# 1. 验证清单可读且禁缓存
curl -i https://<team-server>/client-updates/latest.json

# 2. 验证便携包 HEAD 返回正确 Content-Length 且无需登录 Cookie
FILE=$(curl -fsS https://<team-server>/client-updates/latest.json | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.file)")
curl -I "https://<team-server>/client-updates/$FILE"
```

### 5.2 客户端排障与紧急回滚

- **客户端更新日志**：查看 `%LOCALAPPDATA%\TrellisBoard\data\logs\desktop.log`，启动或登录后会记录 `自动更新已启用：<url>` 或 `自动更新源已切换：<url>`。
- **临时目录与去重状态**：
  - 下载暂存目录：`%LOCALAPPDATA%\TrellisBoard\data\updates\<version>\`
  - 通知去重文件：`%LOCALAPPDATA%\TrellisBoard\data\update-state.json`
- **常见问题**：
  - 托盘「检查更新」置灰：未配置 `TRELLIS_UPDATE_SERVER` 且尚未登录 Team 服务端；登录一次或配置 `client.json` 中的 `serverUrl` 后自动启用。
  - 更新失败「SHA-256 校验失败」或 `404`：确认是否先上传了 `latest.json` 后上传 `.zip`，或两者版本不匹配。
- **紧急止血回滚**：删除或重命名服务端托管目录中的 `latest.json`（例如改为 `latest.json.disabled`），或将其回退为旧版本清单；已运行中的客户端不会受影响。
