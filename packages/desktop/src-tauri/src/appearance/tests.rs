use super::*;

#[test]
fn appearance_normalises_and_round_trips() {
    let _env = crate::config::test_env_lock();
    let directory = std::env::temp_dir().join(format!(
        "trellis-desktop-appearance-test-{}",
        std::process::id()
    ));
    std::env::set_var("TRELLIS_DESKTOP_HOME", &directory);
    let _ = std::fs::remove_dir_all(&directory);

    assert_eq!(load(), Appearance::default());

    let stored = Appearance {
        theme: "dark".to_string(),
        font_size: "xl".to_string(),
    };
    save(&stored).expect("save appearance");
    assert_eq!(load(), stored);
    let payload = std::fs::read_to_string(appearance_path()).unwrap();
    assert!(payload.contains("\"fontSize\": \"xl\""));

    std::fs::write(appearance_path(), r#"{"theme":"neon","fontSize":"huge"}"#).unwrap();
    assert_eq!(load(), Appearance::default());

    std::fs::write(appearance_path(), "{ not json").unwrap();
    assert_eq!(load(), Appearance::default());

    let _ = std::fs::remove_dir_all(directory);
}
