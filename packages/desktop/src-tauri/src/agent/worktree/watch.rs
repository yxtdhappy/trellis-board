use std::collections::BTreeSet;
use std::path::Path;

use notify::{RecursiveMode, Watcher};

use super::WorktreeService;
use crate::agent::git;
use crate::agent::store::AgentConfig;

pub(super) fn rebuild(
    service: &WorktreeService,
    config: &AgentConfig,
    tx: &tokio::sync::mpsc::UnboundedSender<()>,
) {
    let mut roots: BTreeSet<(String, bool)> = BTreeSet::new();
    for binding in config
        .bindings
        .iter()
        .filter(|binding| binding.sync_status == "approved" && !binding.detach_pending)
    {
        if let Some(common) = git::common_dir(Path::new(&binding.repo_path)) {
            roots.insert((
                common.join("worktrees").to_string_lossy().to_string(),
                false,
            ));
        }
    }
    {
        let registry = service.lock_registry();
        for entry in registry.entries.values() {
            if !entry.common_dir.is_empty() {
                roots.insert((
                    Path::new(&entry.common_dir)
                        .join("worktrees")
                        .to_string_lossy()
                        .to_string(),
                    false,
                ));
            }
            let tasks = Path::new(&entry.path).join(".trellis").join("tasks");
            if tasks.is_dir() {
                roots.insert((tasks.to_string_lossy().to_string(), true));
            }
        }
    }
    let signature = roots
        .iter()
        .map(|(path, recursive)| format!("{recursive}:{path}:{}", Path::new(path).exists()))
        .collect::<Vec<_>>()
        .join("\n");
    {
        let current = service
            .watch_signature
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *current == signature {
            return;
        }
    }
    let mut watchers = Vec::new();
    let mut all_watched = true;
    for (path, recursive) in roots {
        if !Path::new(&path).exists() {
            continue;
        }
        let sender = tx.clone();
        let Ok(mut watcher) =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                let Ok(event) = result else {
                    return;
                };
                if matches!(event.kind, notify::event::EventKind::Access(_)) {
                    return;
                }
                let _ = sender.send(());
            })
        else {
            all_watched = false;
            continue;
        };
        let mode = if recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };
        if watcher.watch(Path::new(&path), mode).is_ok() {
            watchers.push(watcher);
        } else {
            all_watched = false;
        }
    }
    *service
        .watchers
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = watchers;
    *service
        .watch_signature
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = if all_watched {
        signature
    } else {
        String::new()
    };
}
