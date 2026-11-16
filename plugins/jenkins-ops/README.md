# jenkins-ops

把 Jenkins 接进 Trellis Board：在面板里选 job、填参数、触发构建、看状态与日志、拿产物；
同时以 `jenkins.ops` capability 暴露给其他插件与 agent（例如让 acp-dispatch 下发构建）。

## 命名

- 目录名与 `plugin.json` 的 `id` 都是 `jenkins-ops`，不带 `trellis-board-` 前缀（见 `plugins/README.md`）。
- 若日后独立发布，npm 包名为 `trellis-board-plugin-jenkins-ops`，manifest `id` 保持 `jenkins-ops`。

## 安装

在插件配置目录的 `plugins.json`（默认 `<TrellisBoard>/plugins/plugins.json`）的 `plugins` 数组里加一项：

```json
{
  "id": "jenkins-ops",
  "module": "./plugins/jenkins-ops/index.js",
  "enabled": true,
  "config": {
    "baseUrl": "https://jenkins.example.com",
    "username": "Z0328",
    "jobFilter": [],
    "verifyTls": true
  }
}
```

`plugins.json` 与 secrets 文件都在用户数据目录，不进版本库；真实地址与账号只放本地。

### 两种配置来源

| 来源 | 适合 | 优先级 |
|---|---|---|
| `plugins.json` 的 `config` | 随环境分发的静态配置、CI 里预设 | 低 |
| 面板「设置」写入的 store `settings` | 在 UI 里改地址/账号/过滤 | 高 |

密码只走 secrets（宿主 AES-256-GCM 加密落盘），既不在 store 也不在日志里：
面板保存后写入 `jenkins-ops/password`；也可以在 `config.password` 直接给（优先级低于 secrets）。

## 权限要求

插件只读 job 列表和构建信息，但 Jenkins 的权限模型要求账号至少有：

- **Overall/Read** —— 没有它连 `/api/json`、`/view/<name>/api/json` 都返回 403；
- **Job/Read**（该 job 或所属 view）；
- 触发/中止构建还需要 **Job/Build** 与 **Job/Cancel**。

缺少权限时 Jenkins 会在 403 的 HTML 里直接写出缺哪一项，插件会把这句话解析出来，例如：

```
Jenkins 拒绝访问（403）：账号 z0328 缺少 Overall/Read 权限，需要 Jenkins 管理员在矩阵授权里授予
```

排查时先看「认证身份」再看「权限」。`/whoAmI/api/json` 不需要任何权限，能区分两种情况：

```bash
# 表单登录（插件的用法）：先 GET /login，再 POST 表单，用返回的 JSESSIONID 调 API
curl -c /tmp/jk -s http://ci.example.com/login > /dev/null
curl -b /tmp/jk -c /tmp/jk -s -d 'j_username=<user>&j_password=<password>&from=%2F&Submit=' \
  http://ci.example.com/j_spring_security_check > /dev/null
curl -b /tmp/jk http://ci.example.com/whoAmI/api/json   # 看 name / authorities
curl -b /tmp/jk http://ci.example.com/api/json          # 200 还是 403
```

**SSO / LDAP 环境的重要坑**：同一个账号走 **Basic 认证（API Token）** 和走 **表单登录** 可能拿到
**不同的用户 id**（例如 Basic 被规范化成 `z0328`，表单登录是 `Z0328`），而授权矩阵只给了其中一个。
表现就是「网页能看所有 job，API Token 却处处 403」。本插件固定走表单登录，正是为了拿到与网页一致的身份。

## 认证

只支持一种方式：**账号 + 密码走 Jenkins 表单登录**，换成会话 Cookie 后调 API。

1. 面板「设置」里填 `Jenkins 地址` + `用户名` + `密码`，保存；
2. 插件收到请求时自动 `GET /login` 建立初始会话 → `POST /j_spring_security_check` 提交表单 →
   拿 `Set-Cookie: JSESSIONID` → 后续所有请求带这个 Cookie；
3. 会话过期（Jenkins 返回 401/403 且跳登录页）时自动重新登录一次，无需人工干预。

为什么不用 API Token：在 SSO / LDAP 实例上，Basic 认证拿到的用户 id 常常与网页登录不一致，
导致「网页正常、API 全 403」。表单登录能复用网页用户完全相同的身份与组信息。

插件会自动取 crumb（`GET /crumbIssuer/api/json`，缓存 30 分钟）；CSRF 关闭的实例返回 404 时自动跳过。
`crumb` 设为 `force` 可强制要求，设为 `off` 完全不发。

内网自签证书把 `verifyTls` 设为 `false`（只影响本插件子进程，不动全局 TLS 设置）。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | 空 | Jenkins 根地址，必须 `http://` 或 `https://` |
| `username` | 空 | Jenkins 用户名 |
| `password` | 空（存 secrets `jenkins-ops/password`） | Jenkins 登录密码，只用于表单登录 |
| `jobFilter` | `[]` | job 通配过滤，如 `["deploy-*", "release/*"]`；空表示全部 |
| `views` | `[]` | 只列这些视图下的 job，如 `["标品MOM3-DEV", "标品MOM3-FAT"]`；空表示从站点根拉全部 |
| `verifyTls` | `true` | 是否校验证书 |
| `crumb` | `auto` | `auto` / `force` / `off` |
| `timeoutMs` | `20000` | 单次请求总时长 |
| `retries` | `1` | 仅 GET 与 5xx 重试 |
| `maxLogLines` | `2000` | 日志接口一次性返回的行数上限 |

## 面板

`placement: view`，出现在视图区。功能：

- 左侧 job 列表（按 `jobFilter` 过滤，支持文件夹里嵌套的 job）
- 顶部连接状态（Jenkins 版本 / 未配置 / 连接异常，悬停看原因）
- 选中 job 后：状态、最近构建、下次构建号、参数表单（字符串 / 布尔 / 下拉）；
  动态参数（如 List Git Branches 的 `Branch`）用统一账号面板提供的可搜索下拉框
  `TrellisCombo`（`/plugin-ui/v1/combo.js`）
- 操作：开始构建、中止最近构建、控制台日志（最后 500 行）、产物列表（复制下载链接）
- 队列：查看排队项、取消
- 构建中每 4 秒自动刷新一次

面板跑在 `sandbox="allow-scripts allow-forms"` 的 iframe 里，所有请求经 `postMessage` 桥转发，
所以**不要**在 `panel/app.js` 里直接 `fetch`，用 `rpc(method, path, body)`。
产物下载受 sandbox 限制（没有 `allow-downloads`），因此只提供「复制原始 URL」。

## HTTP 路由

挂在 `/api/plugins/jenkins-ops/*` 下：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/panel`、`/panel/app.js`、`/panel/app.css` | 面板资源 |
| GET | `/status` | 配置状态 + 连接测试（含 Jenkins 版本） |
| POST | `/settings` | 保存 `baseUrl` / `username` / `verifyTls` / `jobFilter` |
| POST | `/password` | 保存密码到 secrets 并重建客户端 |
| POST | `/password/clear` | 清除密码 |
| GET | `/jobs` | job 列表，支持 `?view=` `?folder=` `?filter=` `?all=1`（`all=1` 忽略 views 列全站） |
| GET | `/job?name=` | job 详情（含参数定义、最近构建） |
| POST | `/build` | `{ job, parameters, wait, waitTimeoutMs }` |
| GET | `/build?job=&number=` | 构建状态，`number` 省略取 `lastBuild` |
| GET | `/log?job=&number=&tail=` | 控制台输出（截取尾部 N 行） |
| POST | `/build/stop` | `{ job, number }` 中止构建 |
| GET | `/queue` | 构建队列 |
| POST | `/queue/cancel` | `{ id }` 取消排队项 |
| GET | `/artifacts?job=&number=` | 产物列表（含 `downloadPath`） |
| GET | `/artifact?job=&number=&path=` | 产物内容（base64） |

> **保留路径陷阱**：宿主把 `/api/plugins/<id>/(start|stop|logs|runs|audit)` 当作插件管理端点
> （见 `packages/server/plugins/runtime.js` 的 `pluginAdminMatch`）。插件自己的 `POST /stop`
> 会被静默解释成「停止插件并返回 200」。所以中止构建的路径是 `/build/stop`，
> 同理不要占用 `start`、`logs`、`runs`、`audit`。

## capability `jenkins.ops`

清单在 `plugin.json` 的 `provides`，方法必须在 `onStart` 里真实注册，否则握手失败。

| 方法 | access | 参数 |
|---|---|---|
| `jobs.list` | read | `{ views?, folder?, filter?, recursive? }` |
| `job.get` | read | `{ job }` |
| `build.trigger` | write | `{ job, parameters?, wait?, waitTimeoutMs? }` |
| `build.status` | read | `{ job, number? }` |
| `build.log` | read | `{ job, number?, tail? }` |
| `build.stop` | write | `{ job, number? }` |
| `queue.list` | read | — |
| `queue.cancel` | write | `{ id }` |
| `artifacts.list` | read | `{ job, number? }` |
| `artifact.fetch` | read | `{ job, number?, path }` |

调用方需要在 manifest 的 `requires` 里声明同名 capability 与具体方法，
否则宿主直接以 `capability 未声明` 拒绝（见 `supervisor.js` 的 `capability/call` 分支）。

## 测试

```bash
node --test plugins/jenkins-ops/test/*.test.js   # 本插件
npm run test:plugins                             # 全部插件
```

`test/fake-jenkins.js` 是一个只实现用到的端点的假 Jenkins：表单登录（`/login` + `/j_spring_security_check`）、crumb、构建触发的
`201 + Location`、队列项 `executable.number`、consoleText、artifact。用它而不是 mock fetch，
因为客户端最容易出错的就是这些协议细节。

## 版本库

`.gitignore` 默认忽略 `plugins/*`，只白名单内置/参考插件。要让 jenkins-ops 进版本库，
在 `.gitignore` 里补：

```gitignore
!plugins/jenkins-ops/
!plugins/jenkins-ops/**
```
