# HTTP 与文件边界

## API 路由

[server/index.js](../../../server/index.js) 当前路由：

| 方法与路径 | 用途 | 成功状态 |
| --- | --- | --- |
| `GET /api/board` | 优先返回本地缓存，必要时后台刷新 | 200 |
| `GET /api/board/status` | 刷新、队列和监听状态 | 200 |
| `GET /api/health` | 健康检查与进程 ID | 200 |
| `POST /api/board/refresh/start` | 后台启动完整扫描 | 202 |
| `POST /api/board/refresh` | 同步等待完整扫描 | 200 |
| `GET /api/repositories` | 白名单项目 | 200 |
| `POST /api/repositories/pick-folders` | 调用桌面文件夹选择 | 200 |
| `POST /api/repositories` | 批量加入白名单 | 201 |
| `DELETE /api/repositories` | 从白名单移除，不删除源目录 | 200 |
| `POST /api/task` | 获取任务详情 | 200 |
| `POST /api/tasks` | 通过目标仓库 `task.py` 创建任务 | 201 |
| `POST /api/tasks/assign` | 更新 `task.json.assignee` | 200 |
| `PUT /api/tasks/stage` | 记录人工阶段 | 200 |

未知 `/api/*` 返回 404 `{ "error": "接口不存在" }`。

## JSON 协议

- `sendJson()` 统一返回 `application/json; charset=utf-8` 和 `cache-control: no-store`。
- `readJsonBody()` 上限为 `1MB`。无请求体视为 `{}`；超限返回“请求体过大”；非法 JSON 返回“请求体不是合法 JSON”。
- API 处理异常在主路由统一捕获，返回 400 和 `{ "error": message }`。
- 前端依赖 `payload.error`，不要改成嵌套错误结构而不更新 `public/app.js` 的 `api()`。

## 仓库白名单

白名单存放在 SQLite `repositories` 表。首次建库且 `data/repos.json` 不存在时，使用 [server/config.js](../../../server/config.js) 的默认仓库一次性导入。API 返回每项 `id`、`name`、`path`，路径使用 `/`。

[server/repositories.js](../../../server/repositories.js) 的规则：

- 同一路径去重；Windows 路径比较不区分大小写。
- ID 从目录名派生，冲突追加 `-2`、`-3`。
- 新增一个仓库或批量新增前都要确认目标包含 `.trellis`。
- 批量新增任一无效时不写入任何项目。
- 批量插入、删除和删除后的位置重排都在 SQLite 事务中完成。
- 移除项目只改白名单，不删除仓库目录。

## 写操作边界

### 创建任务

[server/actions.js](../../../server/actions.js) 先校验：

- 标题、描述、负责人和最大长度。
- 优先级仅允许 `P0`、`P1`、`P2`、`P3`。
- slug 使用 [public/slug.js](../../../public/slug.js) 的同一规则。
- 仓库在白名单且包含 `.trellis`。
- 负责人来自目标仓库 `.trellis/workspace`。

校验全部通过后，用参数数组调用目标仓库自己的 `.trellis/scripts/task.py create ... --no-start`。不启用 shell，避免字符串拼接和命令注入。

### 更新负责人

任务目录解析为 `.trellis/tasks` 内的真实路径，并确认没有越出根目录。读取 `task.json`、只替换 `assignee`，再用临时文件加 rename 原子写回。

### 记录人工阶段

`PUT /api/tasks/stage` 会校验阶段 ID 并写入 SQLite `task_stage` 表，不会修改 Trellis 的正式任务状态。当前路由直接用请求中的 `projectId` 与 `taskPath` 拼 `task_stage.task_key`，没有像详情和负责人更新那样重新验证项目白名单、任务根和路径存在性；这是已知边界缺口。新增或调整该接口前，应先补同样的运行时路径校验和回归测试。

## 路径安全

- 仓库路径先 `path.resolve()`，再做白名单匹配。
- 消费任务路径的接口必须以目标 `.trellis/tasks` 为父根，不能靠字符串前缀误判兄弟目录；当前人工阶段路由是待补校验的例外。
- 静态资源把 URL 映射到 `public/` 后检查最终绝对路径仍在 `public/` 内。
- 浏览器传入的名称、slug、负责人和阶段都要做运行时字符串/枚举校验；不能因前端当前只发送相对路径就省略后端路径校验。

## 持久化写入

Board 的仓库、人工阶段、扫描缓存和刷新状态只通过 SQLite facade 写入。单个逻辑操作涉及多行时必须由 `withTransaction()` 包住，不能逐条自动提交。

任务 `task.json` 等目标仓库 JSON 仍使用临时文件加 rename：

```js
const tempFile = `${targetFile}.${process.pid}.tmp`;
fs.writeFileSync(tempFile, payload, "utf8");
fs.renameSync(tempFile, targetFile);
```

目标仓库的新写入点必须有自己的临时路径并确保目标目录存在。不要在目标文件上直接截断后分多次写。

## 静态资源

`public/` 由原生 HTTP 服务托管。`.html` 使用 `no-store`，其他静态文件缓存 `60` 秒。API 之外的未知文件返回 404。当前 `serveStatic()` 没有单独限制 HTTP 方法，并只用 `filePath.startsWith(publicDir)` 做路径前缀检查；修改静态边界时应补真实路径关系判断和越界测试，不要把这个前缀比较当成通用安全守卫。

## 反模式

- 接受任意绝对路径后直接 `readFile` 或 `writeFile`。
- 用 `exec()` 拼接标题、slug 或路径。
- 在路由里直接把 `task.json` 部分写坏。
- 删除项目时删除源仓库。
- 把用户输入原样放进响应头或 HTML。
- `/api/board` 返回详情正文导致首屏响应膨胀。
