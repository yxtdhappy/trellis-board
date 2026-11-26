# 修复归档 SSH 同步丢失登录用户名

## Goal

生产容器重建后，归档 Git SSH 同步无需依赖容器内 `/root/.ssh/config` 等临时文件即可继续使用已配置私钥，并兼容已丢失 SSH 登录用户名的存量项目和凭据。

## Background

- 本地 Board 能同步，是因为本机 `C:\Users\yuhaojie\.ssh\config` 为 `git.weintdata.cn` 配置了 `User git`；生产日志实际显示 `root@git.weintdata.cn: Permission denied (publickey)`。
- 当前共享远端规范化只保留 SSH 的 host、port、path，生成 Git 地址时不保留 `git@` 用户名；生产进程以 `root` 运行且容器内 SSH 配置会随部署重置，因此认证用户错误。
- 管理页按 `scheme + host + port` 保存归档只读凭据；同一来源只允许一份凭据，重复创建返回 `CONFLICT`。
- 凭据表已有 `username` 列，HTTPS 使用该列，SSH 当前固定写 `null`。

## Requirements

- 归档 SSH 同步必须使用持久化在 Board SQLite 数据中的 SSH 登录用户名，不依赖容器内的 `~/.ssh/config`、系统 SSH 配置或部署后手工改文件。
- 新建 SSH 凭据时允许配置 SSH 用户名；默认值应为 `git`，以覆盖 GitLab/GitHub 常见配置。
- 已存在的 SSH 凭据即使 `username` 为空，也必须在无需重新录入私钥和无需数据库手工修复的情况下恢复正常同步。
- 同一 `scheme + host + port` 仍只允许一份凭据；不得因本修复放宽来源隔离或私钥加密边界。
- 用户输入和管理页展示不得回显私钥；SSH 用户名不属于秘密，可按普通公开字段持久化和展示。
- 修复必须同时覆盖凭据创建/编辑、归档同步和凭据测试链路，确保三者使用同一个 SSH 用户名。

## Acceptance Criteria

- [ ] 新建 SSH 凭据时用户名默认 `git`，也可保存其他合法用户名；保存后重新读取仍返回同一用户名。
- [ ] 已有 `username` 为空的 SSH 凭据可直接通过“测试”和“立即同步”，不再连接成服务器进程用户 `root`。
- [ ] 容器重建后不创建、不挂载 `/root/.ssh/config`，凭据测试和归档同步仍成功。
- [ ] 生成的服务端 SSH 认证上下文明确使用持久化用户名，同时继续使用严格主机匹配和临时私钥文件。
- [ ] `ssh://git@host:port/path`、`git@host:path` 和既有无用户名的已保存项目地址不会产生不同项目身份或重复 taskSpace。
- [ ] 自动化测试覆盖 SSH 用户名默认值、自定义值、存量空值兼容和实际 SSH 命令参数。
- [ ] 管理页完成一次真实测试和同步验收，失败日志不再出现 `Permission denied (publickey)`。

## Out of Scope

- 不把 SSH 私钥写入容器文件系统或镜像。
- 不新增系统级 `/etc/ssh` 配置，也不要求修改生产部署脚本注入 SSH 用户。
- 不改变归档同步只读、不 checkout、不 commit、不 push 的安全边界。
- 不轮换或迁移 GitLab 上的实际 Deploy Key；密钥泄露处置由用户单独完成。

## Decisions

- SSH 用户名作为来源凭据的可编辑字段，新建 SSH 凭据默认 `git`。
- 存量 SSH 凭据的 `username` 为空时按 `git` 兼容，不要求重新录入私钥。
- 登录用户只保存在 Board SQLite 凭据记录中，不写入镜像或依赖容器内 SSH 配置。
