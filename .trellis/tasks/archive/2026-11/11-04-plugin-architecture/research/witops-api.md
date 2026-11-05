# witops 任务接口事实（实测）

> 采集方式：以只读方式登录平台页面，抓取 XHR 后二次调用同一接口核对入参；凭据按运营规范在内存中
> 获取，未写入任何文件、脚本或日志。采集时间：2026-11-04。

## 1. 站点与路由

占位符约定（本文不写真实域名、账号、任务号，实际值由部署配置提供）：

| 占位符 | 含义 |
| --- | --- |
| `<platform-host>` | 平台域名与端口 |
| `{gw}` | 网关前缀，前端 axios `baseURL` 默认值 |
| `{task-svc}` | 任务/需求/缺陷服务前缀 |
| `{admin-svc}` | 系统管理服务前缀（登录、用户、字典） |
| `<web-root>` | 前端子应用路径 |

- 页面前缀 `#/<web-root>/`；任务详情路由
  `#/<web-root>/commonDetail/nodeTaskDetail/<type>/<businessId>`，实测 `4/10001`。
- 前端 axios `baseURL` 默认 `/{gw}`，因此前端代码里的 `/{task-svc}/...` 实际请求是
  `/{gw}/{task-svc}/...`；`/api/sysUser/login` 经网关映射到
  `/{gw}/{admin-svc}/sysUser/login`。

## 2. 鉴权

| 项 | 值 |
| --- | --- |
| 登录 | `POST /{gw}/{admin-svc}/sysUser/login`，body `{account, password}` |
| 请求头 | `Weareint-Token: <token>` |
| token 落地 | `localStorage["mom.token"]` + cookie `Weareint-Token`（7 天） |
| 业务成功码 | `20000` |
| 登录过期 | 业务码 `40300`（前端据此弹“登录状态已过期”），HTTP `401`/`403` 同域 |
| 辅助头 | 平台标识头（固定值）与当前路由头；实测不带也能调通 |
| 用户信息 | `localStorage["mom.user"]`，含 `id`（示例值 900） |

取用户自己的 token：在已登录的浏览器里读 `localStorage.getItem("mom.token")`（或 cookie
`Weareint-Token`），填进插件配置即可，不需要密码。

## 3. 我的任务

`POST /{gw}/{task-svc}/nodeTask/page`

```json
{ "current": 1, "size": 20, "assignedToUserId": 900, "type": 4, "status": "1,3" }
```

参数语义实测（同一账号，`size=5`）：

| 参数组合 | `total` | 说明 |
| --- | --- | --- |
| `{assignedToUserId}` | 1045 | 名下全部任务 |
| `{assignedToUserId, status:"1,3"}` | 10 | 前端“我的任务”卡片用的就是这组 |
| `{assignedToUserId, status:"1"}` | 10 | 该账号无进行中任务，故与 `"1,3"` 相同 |
| `{assignedToUserId, type:4}` | 989 | `type` 单值 |
| `{assignedToUserId, types:"2,3,4"}` | 1031 | `types` 多值，与 `type` 并存 |
| `{assignedToUserId, status:"1,3", type:4, taskLast:1}` | 6 | `taskLast` 进一步收敛，语义未确认 |

- `status` 是逗号分隔字符串，不是数组。
- 响应是标准分页：`{records, total, pages, current, size}`，前端按 `pages` 做无限滚动。
- 列表项 122 个字段，关键字段见第 5 节。

另一个接口 `POST /{gw}/{task-svc}/nodeTask/oa/page`（body 含
`{assignedToUserId, sourceStatus: 3, types: "6,8,..."}`）用于 OA 待办角标，实测 `total=0`，
与"我的任务"不是同一份数据。

## 4. 详情

`POST /{gw}/{task-svc}/nodeTask/detail`，body `{"id": 10001, "type": 4}`

- `id` 传 **businessId**；传主键（20001）返回 `data: null`。
- 返回 109 个字段。

示例任务（编号为虚构）关键值：

| 字段 | 值 |
| --- | --- |
| id | 20001（主键，非路由参数） |
| businessId | 10001 |
| code | T10001 |
| type / typeName | 4 / 任务 |
| status / statusName | 1 / 待处理 |
| sourceType / sourceStatus | 0 / 1 |
| priorityName | P2 |
| productName | 示例产品 |
| projectName / iterationName | null / null |
| storyId / storyName | 30001 / 与任务同名 |
| parentId / parentName | 30001 / 同上 |
| createTime | 2026-11-04 14:58:53 |
| assignedToUserIdList | [900] |
| description | 12611 字符富文本 HTML |
| annexResps | [] |
| workHour | 0 |

## 5. description 的 HTML 特征

- 每个块带 `style="margin-left: [object Object]px!important"`（前端拼串缺陷，序列化后留下
  `[object Object]`）。
- 表格 `colspan` / `rowspan` 恒为 1，`<colgroup>` 只有 `<col>` 计数，没有表头语义标记。
- 标题 `h2` / `h3`，段落 `p`（空段落写作 `<p></p>`），强调 `strong`。
- 链接指向 wiki：`https://<wiki-host>/pages/viewpage.action?pageId=...`。

结论：转换器必须容错上述脏属性，并按 `th` 行与 `td` 列数生成 GFM 表格。

### 5.1 转换原型实测

在 `T10001` 上跑了一版无依赖转换器（标签遍历 + 表格缓冲 + 链接栈）：

| 指标 | 值 |
| --- | --- |
| 输入 HTML | 12,611 字符 |
| 输出 Markdown | 2,788 字符 |
| 标题 / 表格 / 链接 | 7 / 4 / 1 |
| `[object Object]` 与 `style=` 残留 | 0 / 0 |
| 结构校验（围栏闭合、表格列数） | 0 错误 |

两个必须避开的实现坑：

1. `a` 的 `href` 在开标签上，需用栈保存；且必须取捕获组 `[1]`，直接 push `exec` 返回值会拼出
   `href="...",...` 这样的 URL。
2. 表头按 `tr` 内是否含 `th` 判定；首个 `tr` 用 `th`、后续行用 `td`，把所有 `tr` 当数据行会
   生成空表头。

## 6. 字典（实测）

字典接口：`POST /{gw}/{admin-svc}/sysDicConfig/getListByKey`，body `{type, status:1, size:100}`，
返回 `records[].{code,name,value}`。

`taskStatus`（7 项）：

| code | name |
| --- | --- |
| 0 | 草稿中 |
| 1 | 待处理 |
| 2 | 已完成 |
| 3 | 进行中 |
| 4 | 已取消 |
| 97 | 待提交 |
| 99 | 已关闭 |

`priority`（4 项）：`1`→P0、`2`→P1、`3`→P2、`4`→P3。

`systemEnv`（5 项）：`0` DEV、`1` FAT、`2` UAT、`3` PRO、`4` SIT。

`taskCategory`（24 项，节选）：`0` 产品设计、`1` 后端开发、`2` 前端开发、`3` 测试任务、
`4` 功能测试、`5` 性能测试、`6` 产品部署、`20` 其他、`30` 方案设计、`31` 数据探索分析、
`32` 算法建模、`33` 设计文档编写。

`nodeTaskStatus` / `sourceStatus` 两个键返回 0 条，说明状态字典键名就是 `taskStatus`。

## 7. 结论

- 无需浏览器即可对接：登录、列表、详情都是普通 JSON 接口。
- 幂等键用 `businessId`（类型内唯一）；`code`（如 `T10001`）可读，放 meta 便于人查。
- 任务链接可由 `type` + `businessId` 拼出，作为回链写入 prd 与 meta。
- 平台限流未验证，实现按串行 + 间隔 + 退避处理。

## 8. 前端源码佐证

拿到平台前端备份后核对，以下几点直接影响插件实现：

| 事实 | 位置/表现 |
| --- | --- |
| 请求封装 | header 名 `Weareint-Token`，值取 `localStorage[VUE_APP_TOKEN_KEY]`；另有 `Weareint-Platform`、`Weareint-Path`；`baseURL` 默认 `/{gw}` |
| 登录持久化 | `setAuthorization` 写 localStorage + cookie 7 天 |
| 过期信号 | 响应拦截器对 `code === 40300` 弹“登录状态已过期”，不是 HTTP 401 |
| 详情路由 | `#/<web-root>/commonDetail/<pageMark>/<type>/<businessId>`，任务页 `pageMark = nodeTaskDetail` |
| 类型码 | `0` 工单、`1` 发版单、`2` 缺陷、`3` 需求、`4` 任务、`5` 合理化建议、`6` 采购单、`7` 工时 |
| 详情入参 | `{id: sourceId, type}`，`sourceId = businessId`（缺失时回退 `sourceId`） |
| 描述渲染 | 直接 `v-html="detailInfo.description"`，平台不做 Markdown 转换 |
| 父需求描述 | `parentStoryId` 存在且 `type ∈ {3,4}` 时，另外请求 `story/detail {id: parentStoryId, type:3}` 放在折叠区，与任务自身描述是两份内容 |
| 附件字段 | 请求侧 `annexReqList`，响应侧 `annexResps` |
| 我的任务卡片 | `nodeTask/page` 传 `{assignedToUserId, status:"1,3", type, size, current}` |

## 9. 结论补充

- 凭据优先用 `token` 模式（用户自己的 token，7 天），无人值守再用 `account/password`；两者都不需要
  浏览器。
- 状态、优先级、环境、任务类型都走字典接口，不在插件里硬编码枚举。
- 描述取任务自身 `description`，为空再回退父需求；转换器只处理 HTML，不假设 Markdown。
