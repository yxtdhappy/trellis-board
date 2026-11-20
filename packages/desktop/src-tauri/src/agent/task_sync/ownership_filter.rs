use super::snapshot::task_owner;
use super::*;

impl TaskSync {
    pub(super) async fn local_owner_id(&self, binding: &AgentBinding) -> Option<String> {
        let config = self.store.read_config(true).await.ok().flatten()?;
        crate::agent::worktree::developer_id(
            Path::new(&binding.repo_path),
            &config,
            &binding.remote_identity_key,
        )
        .await
    }

    /// 本地任务分组出口的归属过滤：他人任务整目录丢弃，读不到归属信息一律保留。
    pub(super) async fn retain_owned_groups(
        &self,
        binding: &AgentBinding,
        groups: Vec<SnapshotGroup>,
    ) -> Vec<SnapshotGroup> {
        if binding.read_only || groups.is_empty() {
            return groups;
        }
        let Some(owner_id) = self.local_owner_id(binding).await else {
            return groups;
        };
        self.ensure_task_control_loaded().await;
        let mut kept = Vec::with_capacity(groups.len());
        for group in groups {
            if self.owns_task_dir(binding, &owner_id, &group).await {
                kept.push(group);
            }
        }
        kept
    }

    async fn owns_task_dir(
        &self,
        binding: &AgentBinding,
        owner_id: &str,
        group: &SnapshotGroup,
    ) -> bool {
        if self.task_dir_writable_local(binding, &group.task_dir).await {
            return true;
        }
        let Some(content) = task_json_content(binding, group).await else {
            return true;
        };
        let Some(owner) = task_owner(&content) else {
            return true;
        };
        if owner.eq_ignore_ascii_case(owner_id) {
            return true;
        }
        crate::logging::warn(&format!(
            "跳过他人任务目录 taskSpaceId={} taskDir={} owner={} localOwner={}",
            binding.task_space_id, group.task_dir, owner, owner_id
        ));
        false
    }

    async fn task_dir_writable_local(&self, binding: &AgentBinding, task_dir: &str) -> bool {
        let state = self.task_control_state.lock().await;
        let Some(execution_task_key) =
            state.execution_task_key_for_dir(&binding.local_id, &binding.task_space_id, task_dir)
        else {
            return false;
        };
        state
            .controls
            .get(execution_task_key)
            .is_some_and(|control| TaskControlState::parse(&control.state).is_writable_local())
    }
}

async fn task_json_content(binding: &AgentBinding, group: &SnapshotGroup) -> Option<String> {
    let file = group
        .files
        .iter()
        .find(|file| file.file_path == "task.json" && !file.deleted)?;
    if !file.content.is_empty() {
        return Some(file.content.clone());
    }
    // ownership index 分组不携带正文，按目录补读。
    let path = Path::new(&binding.repo_path)
        .join(&group.task_dir)
        .join("task.json");
    tokio::fs::read_to_string(path).await.ok()
}
