# 实施计划: server HTTP 小工具三合一

## 步骤

1. 新建 `apps/server/http-common.js`：
   - `STATIC_TYPES`（从 `team/http.js:66-79` 迁移 13 项）。
   - `sendJson`：以 `team/http.js:100-140` 为基准，增加 `security`/`headers`/`cacheControl` 选项，默认 `cache-control: no-store`。
   - `readJsonBody`：以 `team/http.js:232-265` 为基准，`maxBytes` 与 `errors` 由调用方注入。
   - `serveStatic`：以 `team/http.js:430-483` 为基准，参数改为对象；`errors` 注入 405/403/404。
2. 改 `apps/server/team/http.js`：删除本地 `sendJson`/`readJsonBody`/`serveStatic`/`STATIC_TYPES`，改为 import；在模块顶部构造 `httpErrors`；所有调用点补第 4 个参数（`{ security: true }`、`{ maxBytes: MAX_JSON_BYTES, errors: httpErrors }`）。
3. 改 `apps/server/index.js`：删除本地三个函数，import 共用实现；调用点传 `{ errors: standaloneHttpErrors }`（普通 `Error` + 状态码映射保持现状）。
4. 逐个核对调用点（`grep -n "sendJson(\|readJsonBody(\|serveStatic(" apps/server`），确保没有遗漏的参数差异。

## 验证

```bash
npm test
node apps/server/index.js &        # standalone 冒烟
curl -sI http://127.0.0.1:4317/ | head -5          # 200 + text/html + content-length
curl -sI -X HEAD http://127.0.0.1:4317/            # 无 body
curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:4317/index.html   # 405
TRELLIS_BOARD_MODE=team node apps/server/index.js &  # team 冒烟
curl -sI http://127.0.0.1:4317/login.html | grep -i "content-security-policy"
curl -s http://127.0.0.1:4317/api/runtime | head -c 200   # 401 + {error, code}
```

## 回滚点

单 commit；三个函数各自独立，可分段提交（common 模块 → team → standalone）。

## 完成标准

- A1–A5 满足；`grep` 确认本地实现已删除；两模式冒烟通过。
