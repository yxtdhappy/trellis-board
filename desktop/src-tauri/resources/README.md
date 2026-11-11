# Tauri 运行时资源

`build-sidecar.ps1` 会把固定版本的 Node 与 `@mindfoldhq/trellis` 依赖复制到
`resources/trellis-runtime/`。该目录体积较大且属于构建产物，不提交到仓库。

生成后 `tauri.conf.json` 会把整个 `trellis-runtime/` 打入安装包，客户端可在不依赖系统
`node`、`trellis` 或 `npx` 的情况下完成项目初始化。
