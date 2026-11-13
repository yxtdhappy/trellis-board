# WitOps 核心能力（witops-core）

给其他插件提供 业务系统 标准能力的 provider。该目录不进入 Git，按需手动复制/打包分发。

## 能力

| capability | 方法 | 说明 |
| --- | --- | --- |
| `witops.workitems` | `mine` | 当前用户的需求 + 任务，附带 Trellis 关联任务 |
| `witops.workitems` | `requirement.get` / `requirement.query` | 需求详情 |
| `witops.workitems` | `requirement.resolve` | 按 `REQ-xxxx` 编号或标题解析 需求 |
| `witops.workitems` | `requirement.tree` | 需求下的任务树、负责人、工时 |
| `witops.workitems` | `task.listByRequirement` | 按需求批量取任务 |
| `witops.workitems` | `task.get` | 任务详情 |
| `witops.worklogs` | `summary` | 批量汇总需求总工时 |
| `witops.actions` | `requirement.updateStatus` / `task.updateStatus` / `task.assign` | 状态与负责人写操作 |

读能力可以被其他插件消费；写能力需要 consumer 在 `requires` 中显式声明。Trellis 关联读取 `task.json` 的 `meta.witops`（由 `witops-intake` 写入）。

## 配置

```json
{
  "id": "witops-core",
  "module": "./plugins/witops-core/index.js",
  "enabled": true,
  "config": {
    "baseUrl": "http://witops.weintdata.cn",
    "gatewayPrefix": "/appgw",
    "taskServicePrefix": "/weint-witops-service",
    "adminServicePrefix": "/system-mng",
    "platform": "MOM_WEB",
    "path": "/weint-witops-web/dashboard/mine",
    "userId": 123,
    "credentials": {
      "mode": "token",
      "token": "<token>",
      "account": "",
      "password": ""
    }
  }
}
```

- `credentials.mode` 支持 `token` 或 `password`。`password` 模式会调用 `/system-mng/sysUser/login`，并把 token 存在插件 store 中。
- `userId` 不填时依次从登录响应、JWT 的 `account.id`、`GET /api/sysUser/findUser` 推断。
- `baseUrl` 只填站点根地址，不要带 `/appgw`；路径前缀由 `gatewayPrefix` 等配置拼接。
- 真实 业务系统接口需要 `Weareint-Token`、`Weareint-Platform`、`Weareint-Path` 三个头；后两个默认 `MOM_WEB` / 工作台路径，可按环境覆盖。
- 面板入口 `/panel`，宿主通过 `/api/panels` 加载。

## 本地校验

```bash
node --test tests/witops-plugins.test.js
```
