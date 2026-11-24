# tauri-plugin-deep-link 在 Windows 的注册与派发

来源：`~/.cargo/registry/src/index.crates.io-*/tauri-plugin-deep-link-2.6.3`、`tauri-plugin-single-instance-2.5.5` 源码，以及本机实机验证（debug 构建）。

## 注册

- `DeepLink::register(protocol)` 在 Windows 写 `HKCU\Software\Classes\<protocol>`：
  - 默认值 `URL:<identifier> protocol`、`URL Protocol=""`、`DefaultIcon="<exe>,0"`、`shell\open\command="<exe>" "%1"`。
- `register_all()` 读 `tauri.conf.json` 的 `plugins.deep-link.desktop.schemes`；`DesktopProtocol` 是 `One|List` untagged，单对象 `{ "schemes": [...] }` 与数组两种写法都接受。
- 只写 HKCU，不需要管理员权限；便携包和安装包走同一路径，卸载不自动清理。
- macOS 上 `register` 返回 `UnsupportedPlatform`，只能靠 bundle 的 Info.plist；本次不做。

## 派发

- 冷启动：插件 `init_deep_link` 在 desktop 上自己调用 `handle_cli_arguments(std::env::args())`，结果写进内存 `current` 并 emit `deep-link://new-url`。该事件早于 setup 里的监听注册，因此必须再读一次 `get_current()`。
- 运行期：`on_open_url(F)` 监听 `deep-link://new-url`，payload 为 `Vec<Url>`。
- 第二实例：`tauri-plugin-single-instance` 开启 `deep-link` feature 后，会先把 argv 交给 `deep_link.handle_cli_arguments(...)`，再执行回调；回调里不需要（也不应该）重复解析 argv。
- `handle_cli_arguments` 只接受**恰好一个**额外参数，且 scheme 必须在配置列表内。

## 实机结果（Windows 11，debug 构建）

- 启动客户端后 `HKCU\Software\Classes\spec-board\shell\open\command` 指向当前 exe，`"%1"` 占位正确。
- 运行中触发链接：第二实例转发 argv，板端收到 `GET /api/tasks/<space>::<task>?taskSpaceId=<space>`。
- 客户端未运行时触发链接：注册表直接拉起 exe，`get_current()` 取到链接，登录后同样打开该任务。
- 非法链接（缺 `task`）只写一条 `WARN 忽略无法识别的任务分享链接`，不改变已暂存的目标。

## 未覆盖

- `GET /api/tasks/<key>` 对归档任务的返回未单独验证：链接指向已归档任务时按"列表未命中 → 单任务接口"路径处理，失败只提示"可能已失效或没有权限"。
