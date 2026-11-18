use super::*;
use tokio::sync::mpsc;

#[tokio::test]
async fn coalesces_topics_into_one_event() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let events = DesktopStateEvents::new(Arc::new(move |topics| {
        let _ = tx.send(topics);
    }));
    let runner = events.clone();
    let task = tokio::spawn(async move { runner.run().await });

    events.notify_associations();
    events.notify_sidecar();

    let topics = tokio::time::timeout(Duration::from_secs(1), rx.recv())
        .await
        .expect("state event timeout")
        .expect("state event");
    assert_eq!(topics, vec!["associations", "sidecar"]);
    task.abort();
}
