fn main() {
    println!("cargo:rerun-if-env-changed=TRELLIS_UPDATE_SERVER");
    // headless 构建（`--no-default-features`）不产出桌面壳，跳过 Tauri 上下文生成。
    if std::env::var_os("CARGO_FEATURE_DESKTOP").is_some() {
        tauri_build::build();
    }
}
