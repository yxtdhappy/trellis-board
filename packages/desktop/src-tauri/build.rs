fn main() {
    println!("cargo:rerun-if-env-changed=TRELLIS_UPDATE_SERVER");
    tauri_build::build()
}
