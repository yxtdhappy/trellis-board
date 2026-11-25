# 日志源：本地文件与 Pod

先判断目标服务的日志在哪里，再选对应流程；两种源都要做到「先记位置，再操作，只读增量」。

## A. 本地文件

适用：本机启动的服务、IDE 启动的进程、本地容器挂载出来的日志文件。

1. 确认路径：由用户指定，或从启动命令/配置里读；不要猜。
2. 取偏移：

```powershell
$off = & "<skill>\scripts\read-log-delta.ps1" -Path "D:\logs\app.log" -Marker
```

3. 执行一次操作后读增量（默认只匹配关键行）：

```powershell
& "<skill>\scripts\read-log-delta.ps1" -Path "D:\logs\app.log" -From $off -Filter '请求开始|请求结束|ERROR|WARN|Exception'
```

4. 需要看全量增量时去掉 `-Filter`；输出太长时用 `-MaxLines`。
5. 文件被轮转（长度小于偏移）时脚本会提示并从文件头读取；轮转很快的服务建议记录时间戳而不是字节偏移。
6. 编码：默认 UTF-8；GBK 日志用 `-Encoding gbk`。看到乱码先怀疑编码，不要怀疑业务。

快速查看历史片段（不要求增量时）：

```powershell
Get-Content -LiteralPath "D:\logs\app.log" -Tail 200
Select-String -Path "D:\logs\app.log" -Pattern '关键词' | Select-Object -Last 50
```

## B. Rancher / Kubernetes Pod

适用：服务跑在 K8s 里，日志在容器文件系统（常见 `/logs`）或标准输出。

优先使用本机 `wit-rancher-pod-shell` skill（工具路径、配置与 Token 来源以该 skill 为准）。只读用法：

```powershell
python $tool --config $cfg --env <env> --service <name> --command "ls -la /logs"
python $tool --config $cfg --env <env> --pod <pod> --container <c> --command "date '+%Y-%m-%d %H:%M:%S'"
python $tool --config $cfg --env <env> --pod <pod> --container <c> --command "tail -n 200 /logs/<file>"
python $tool --config $cfg --env <env> --pod <pod> --container <c> --command "grep -n -- '关键词' /logs/<file> | tail -n 100"
```

要点：

- **先 `ls -la /logs`** 确认当前日志文件名（常带日期后缀），不要在名字上猜。
- **增量**：操作前在容器内记一次时间戳或 `wc -l`，操作后只取该时间之后的窗口（`awk '$0 >= "..."'`、`grep` 后 `tail`）。
- **多副本**：Service 后面可能有多个 Pod。要么用准确的 `--pod` 指向处理请求的那个副本（结合 Ingress/LB 日志或逐个核对），要么逐副本各查一次，别只查一个副本就下结论。
- **多容器**：Pod 里有 sidecar 时用 `--container` 指定业务容器。
- 压缩历史日志：先 `ls` 看文件名，再用 `zgrep`/`gzip -cd`，不要整文件输出。
- 若环境有 `kubectl`，等价备选：`kubectl logs <pod> -c <container> --since=5m` / `--since-time=<RFC3339>`；多副本用 `-l app=<name> --tail=200`。凭据与 kubeconfig 由用户环境提供，只读。

## C. 增量读取的判定口径

一次操作后，增量日志里至少要能回答：

1. 这次操作对应的请求/任务**出现了吗**（没有 = 可能没打到此实例，先查路由/副本）
2. 它的结果是**成功还是失败**
3. 失败时是**业务级报错**（可读、带业务码）还是**未处理异常/堆栈**

日志里出现与本操作无关的历史报错时，用时间戳与 traceId/请求路径把范围收窄，只对本操作窗口内的行负责。

