# 本地全链路 E2E 与转发代理

当页面、静态资源、登录态来自环境，而被测后端运行在本机时，浏览器请求通常仍发往环境统一网关。不要因此去环境里测旧后端，也不要为了单次 E2E 永久修改项目代理配置；在中间增加一个最小反向代理即可。

## 1. 先判断运行拓扑

| 前端最新代码在哪里 | 后端最新代码在哪里 | 推荐方式 |
| --- | --- | --- |
| 环境 | 本机 | 优先复用环境前端已有的本地转发；没有时，本地启动前端并接本代理 |
| 本机 | 本机 | 本地前端 + 本代理，只把被测服务路由到本地后端 |
| 环境 | 环境 | 直接测环境，不启动本代理 |
| 本机 | 环境 | 前端使用环境网关，或按需为指定服务配置代理 |

开始操作前确认：

1. 前端 dev server 已加载最新代码，记录 PID、端口和启动时间。
2. 后端已加载最新代码，记录 PID、监听端口和日志路径。
3. 在 dev server 或浏览器请求中确认实际网关路径，例如 `/appgw/<service>`。
4. 只把被测服务指向本地；登录、权限、系统公共接口和静态资源继续去环境。

如果前端 dev server 已能把目标路径直接代理到本地后端，就复用它，不再增加一层。只有它固定指向环境、无法传参或改动成本过高时，才启动本代理。

## 2. 启动代理

脚本无第三方依赖，需要 Node.js 18+：

`scripts/local-gateway-proxy.mjs`

MOM / Data Studio 示例：

```powershell
$proxy = "$env:USERPROFILE\.claude\skills\wit-api-e2e\scripts\local-gateway-proxy.mjs"
node $proxy `
  --listen-port 8099 `
  --remote-url http://mom3.fat.weintdata.cn `
  --route "/appgw/mdp-backend-service=http://127.0.0.1:8855/mdp-backend-service"
```

然后让前端 dev server 的 `/appgw` 代理目标指向 `http://127.0.0.1:8099`，浏览器仍访问前端 dev server 地址。

请求效果：

```text
浏览器 /appgw/mdp-backend-service/api/foo
  -> 本地代理 8099
  -> 本地后端 8855/mdp-backend-service/api/foo

浏览器 /appgw/common-system-service/api/foo
  -> 本地代理 8099
  -> FAT /appgw/common-system-service/api/foo
```

## 3. 动态路由

`--route` 可重复使用，格式为 `前缀=目标基础 URL`。目标 URL 自带的基础路径就是重写后的前缀：

```powershell
node $proxy `
  --listen-port 8099 `
  --remote-url http://fat.example.com `
  --route "/api=http://127.0.0.1:8080/api" `
  --route "/report=http://127.0.0.1:8081/report-service"
```

多个前缀重叠时使用最长前缀，因此 `/report/v2` 可以单独覆盖 `/report`。未匹配前缀统一去 `--remote-url`；不提供远端时返回 404。

`--remote-url` 只填 origin。远端如果有固定基础路径，使用最长前缀的 catch-all `--route /=http://remote.example.com/base` 表达，避免请求路径被重复拼接。

需要固定复用一套配置时使用 JSON：

```json
{
  "listenHost": "127.0.0.1",
  "listenPort": 8099,
  "remoteUrl": "http://mom3.fat.weintdata.cn",
  "healthPath": "/__local_gateway/health",
  "originMode": "target",
  "rewriteCookies": true,
  "headers": {
    "x-e2e-run": "local-proxy"
  },
  "routes": [
    {
      "name": "mdp-backend",
      "prefix": "/appgw/mdp-backend-service",
      "target": "http://127.0.0.1:8855/mdp-backend-service"
    },
    {
      "name": "report-backend",
      "prefix": "/appgw/mdp-report-service",
      "target": "http://127.0.0.1:8866/mdp-report-service",
      "headers": {
        "x-local-service": "report"
      }
    }
  ]
}
```

启动：

```powershell
node $proxy --config D:\e2e\gateway.json
```

命令行参数优先于环境变量和配置文件：

```text
LOCAL_GATEWAY_CONFIG
LOCAL_GATEWAY_HOST
LOCAL_GATEWAY_PORT
LOCAL_GATEWAY_REMOTE_URL
LOCAL_GATEWAY_ROUTES
LOCAL_GATEWAY_HEADERS
LOCAL_GATEWAY_ORIGIN_MODE
LOCAL_GATEWAY_REWRITE_COOKIES
```

完整参数执行：

```powershell
node $proxy --help
```

## 4. 启动后验证

先直接检查代理，不要立刻做页面业务操作：

```powershell
Invoke-RestMethod http://127.0.0.1:8099/__local_gateway/health
```

健康结果必须同时包含：

- 正确的本地路由前缀和目标地址。
- 正确的远端 fallback。
- cookie 重写和 Origin 模式与预期一致。

再记录后端日志偏移，做一次最小请求：

```powershell
$off = & "$env:USERPROFILE\.claude\skills\wit-api-e2e\scripts\read-log-delta.ps1" `
  -Path D:\logs\app.log -Marker
```

然后从页面只触发一个动作，按以下顺序核对：

1. 浏览器 Network：请求仍发往前端 dev server 的 `/appgw/...`。
2. 代理终端：日志显示命中预期的本地路由和目标 URL。
3. 后端日志：同一时间窗出现对应请求和业务结果。
4. 页面响应：最后核对页面或接口返回语义。

任意一层缺失都说明链路没有按预期闭环，不能把页面未报错当成 E2E 通过。

## 5. 常见故障

| 现象 | 首先检查 |
| --- | --- |
| 代理返回 404，提示未配置 remote-url | 前端路径与 `--route` 前缀不一致，且没有远端 fallback |
| 代理返回 502 | 本地目标端口错误、服务未启动或远端网关不可达 |
| 后端日志没有本次请求 | 浏览器仍直连环境网关，或 dev server 没有指向本地代理 |
| 静态资源和公共接口 404 | 远端 fallback 缺失，或前端把全部 `/appgw` 错误改写到了本地 |
| 登录循环、Cookie 不下发 | Cookie 的 Domain/Secure 与 localhost 不兼容；检查 `rewriteCookies`，必要时调整登录入口 |
| 后端校验 Origin 失败 | 尝试 `--origin-mode client`；只有确认安全边界后再关闭 cookie 重写 |
| HTTPS 页面请求混合内容 | 本代理只监听 HTTP，需要由前端 dev server 或本地 TLS 终止层提供 HTTPS |

代理支持普通 HTTP、流式响应和 WebSocket upgrade。日志只打印方法、路径、目标、状态和耗时；查询参数只打印键名（如 `?[token,page]`），不打印值，也不打印请求头。

## 6. 安全与收尾

- 默认绑定 `127.0.0.1`，不要为本机 E2E 暴露到局域网。
- 只配置确实需要本地化的服务前缀；其余保持远端 fallback。
- 不把 token、Cookie、远端完整连接串写进配置文件或报告。
- `rewriteCookies` 会移除 `Domain`、`Secure`，并把 `SameSite=None` 改为 `Lax`，只用于 localhost E2E。
- 测试结束停止代理和本地服务，确认探针数据已清理，再在报告中记录代理 PID、端口、路由和请求日志。

