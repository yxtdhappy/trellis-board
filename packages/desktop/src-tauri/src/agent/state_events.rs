use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;

const ASSOCIATIONS: u8 = 1;
const SIDECAR: u8 = 2;
const COALESCE_WINDOW: Duration = Duration::from_millis(50);

pub type StateSink = Arc<dyn Fn() + Send + Sync>;

pub struct DesktopStateEvents {
    pending: AtomicU8,
    wake: Notify,
    emit: Arc<dyn Fn(Vec<&'static str>) + Send + Sync>,
}

impl DesktopStateEvents {
    pub fn new(emit: Arc<dyn Fn(Vec<&'static str>) + Send + Sync>) -> Arc<Self> {
        Arc::new(Self {
            pending: AtomicU8::new(0),
            wake: Notify::new(),
            emit,
        })
    }

    pub fn associations_sink(self: &Arc<Self>) -> StateSink {
        let events = self.clone();
        Arc::new(move || events.notify(ASSOCIATIONS))
    }

    pub fn notify_associations(&self) {
        self.notify(ASSOCIATIONS);
    }

    pub fn notify_sidecar(&self) {
        self.notify(SIDECAR);
    }

    fn notify(&self, topic: u8) {
        self.pending.fetch_or(topic, Ordering::SeqCst);
        self.wake.notify_one();
    }

    pub async fn run(self: Arc<Self>) {
        loop {
            self.wake.notified().await;
            tokio::time::sleep(COALESCE_WINDOW).await;
            let pending = self.pending.swap(0, Ordering::SeqCst);
            let mut topics = Vec::with_capacity(2);
            if pending & ASSOCIATIONS != 0 {
                topics.push("associations");
            }
            if pending & SIDECAR != 0 {
                topics.push("sidecar");
            }
            if !topics.is_empty() {
                (self.emit)(topics);
            }
        }
    }
}

#[cfg(test)]
mod tests {
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
}
