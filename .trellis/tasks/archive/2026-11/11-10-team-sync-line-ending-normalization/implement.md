# 实时同步换行规范化实施计划

## 1. 共享规则

- [ ] 新增 `shared/live-text.js`，只实现 `CRLF -> LF` 规范化。
- [ ] 服务端、Agent 和测试统一复用该函数，不复制正则。

## 2. 服务端

- [ ] 在 `server/team/live-sync.js` 的 `normalizeFiles` 中保留原始 SHA 校验。
- [ ] 校验成功后规范化 `content` 并重新计算存储 SHA。
- [ ] 调整 `requestHash` 输入，使规范化后的 CRLF/LF 请求具有相同语义摘要。
- [ ] 在 `applyChanges` 中查询现有内容，过滤规范化后相同的 `upsert` 和重复 `delete`。
- [ ] 全批 no-op 不增加 revision、不重投影、不广播。
- [ ] `convergeGit` 对 Git 文本先规范化再计算 SHA。
- [ ] `listFiles` 返回数据库中的规范内容和 SHA。

## 3. 新客户端

- [ ] 在 `agent/live-sync.js` 增加复用共享函数的换行等价判断。
- [ ] 本地 CRLF、远端相同文本 LF 时不创建备份、不生成冲突事件。
- [ ] 仍原子写回远端 LF，并记录正确的 self-write suppression。
- [ ] 实质差异保持原冲突处理。

## 4. 自动化测试

- [ ] 服务端上传 CRLF 后存储为 LF，返回 SHA 与 LF 内容一致。
- [ ] 先 CRLF 后 LF 上传同一文本不增加 revision。
- [ ] 同批全 no-op 不广播 `live.changed`。
- [ ] 真实内容变化仍增加 revision。
- [ ] 原始内容 SHA 不匹配仍报错。
- [ ] Git CRLF 工作区与 LF 实时内容能够收敛。
- [ ] Agent 拉取仅换行差异时无 backup/control，写入 LF。
- [ ] Agent 遇到实质差异仍有 backup/control。

验证：

```powershell
node --test tests/team-realtime-sync.test.js
node --test tests/desktop-realtime-apply.test.js
npm run format:check
npm test
```

## 5. 验收

- [ ] 使用两个新客户端验证 CRLF 写入后其余客户端只收到 LF。
- [ ] 验证仅换行上传不增加服务端 revision。
- [ ] 验证 Git 提交 LF 后实时覆盖行能够收敛。
- [ ] 验证真实内容冲突的提示和一键复原未回归。

## 6. 风险点

- `server/team/live-sync.js`：内容、幂等和 revision 主链路，改动必须放在事务和现有摘要校验之后。
- `agent/live-sync.js`：不得绕过路径、符号链接和 UTF-8 安全校验。
- `shared/live-text.js`：只处理 CRLF，不扩大为通用空白忽略。
