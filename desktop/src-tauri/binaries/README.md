# Sidecar 二进制目录

`tauri.conf.json` 的 `bundle.externalBin` 指向 `binaries/trellis-agent`，Tauri 会按目标三元组
查找 `trellis-agent-<target-triple>.exe`。真实二进制由以下命令生成，不提交到仓库：

```powershell
npm --prefix desktop install
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\sidecar\build-sidecar.ps1
```

Windows x64 输出：`trellis-agent-x86_64-pc-windows-msvc.exe`、`VERSION.txt`、`SHA256SUMS.txt`。
在生成该文件之前 `tauri build` 会失败，这是预期行为。
