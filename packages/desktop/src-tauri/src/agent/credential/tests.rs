use super::*;
use crate::agent::store::ConfigStore;

#[tokio::test]
async fn round_trips_credential() {
    let root = std::env::temp_dir().join(format!("trellis-cred-{}", uuid::Uuid::new_v4()));
    let store = ConfigStore::new(root.clone());
    let credentials = CredentialStore::new(&store);
    credentials.self_test().expect("dpapi round trip");
    let secret = "unit-test-fixture-0123456789abcdef";
    credentials.save_credential(secret).await.expect("save");
    assert_eq!(credentials.load_credential().await.expect("load"), secret);
    let _ = tokio::fs::remove_dir_all(root).await;
}
