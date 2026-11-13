# 项目 PRD 检查报告

## 检查范围

- 正式文档：`docs/product-prd.md`
- 规划与证据：`prd.md`、`design.md`、`implement.md`、`research/evidence-index.md`
- 事实基线：当前源码、测试、README、团队运维手册和已归档任务

## 结论

通过。正式 PRD 已覆盖任务要求的产品域、设计思路、核心交互、权限边界、异常处理、
非功能要求和非目标。

## 已修正问题

- 修正团队、团队管理员、项目负责人和项目角色的现行权限表述。
- 修正任务卡复制任务目录名与详情目录定位的行为差异。
- 补充父任务继承真实验证、规范回写和工作提交阶段的条件。
- 修正桌面 HTTP/HTTPS、NSIS 与绿色版升级表述。
- 证据索引补充 Gitless Board、任务空间授权和同步索引源码。

## 自动检查

- 文档存在，共 999 行，12 个主章节。
- 44 个内部链接全部可解析。
- 未发现 `TBD`、`待补充`、`TODO`、`FIXME` 或 `pending_push`。
- Markdown 表格列数一致，代码围栏成对。
- 服务端 Git 模式、Node SEA sidecar 仅作为历史替代关系出现。
- Team 模式插件明确写为禁用；多团队明确写为默认聚合。
- lint、typecheck、构建和 E2E 不适用：本次未修改运行时代码。

## 范围外风险

1. `apps/server/team/http.js` 的项目审计和 Agent 绑定接口只调用通用项目读取，
   非项目管理角色可能通过直接请求读取管理数据，建议补能力校验和越权测试。
2. `apps/server/team/task-space-service.js` 的共享团队邀请与移除权限不对称，
   需要产品确认后统一。
3. 当前没有任务空间或项目重新启用入口，但接入向导仍有恢复提示；
   已从 PRD 的当前能力承诺中移除，功能是否补齐需另行决策。
4. `docs/team-operations.md` 仍描述安装包内含固定 Node runtime 和 Trellis CLI，
   与当前单 EXE 环境门不一致，建议另行同步。
