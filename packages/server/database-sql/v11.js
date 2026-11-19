export const SCHEMA_V11_SQL = `
  CREATE TABLE IF NOT EXISTS sync_project (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    remote_url TEXT NOT NULL,
    remote_identity_hash TEXT NOT NULL UNIQUE,
    baseline_branch TEXT NOT NULL DEFAULT '',
    owner_team_id TEXT NOT NULL REFERENCES team(id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_by_user_id TEXT REFERENCES user_account(id),
    created_by_agent_id TEXT REFERENCES agent_device(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS sync_project_owner_team
    ON sync_project(owner_team_id, status);

  CREATE TABLE IF NOT EXISTS sync_project_team_access (
    project_id TEXT NOT NULL REFERENCES sync_project(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    access_role TEXT NOT NULL CHECK (access_role IN ('owner', 'member')),
    created_by_user_id TEXT REFERENCES user_account(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, team_id)
  );

  CREATE INDEX IF NOT EXISTS sync_project_team_access_team
    ON sync_project_team_access(team_id, project_id);

  CREATE TABLE IF NOT EXISTS sync_project_member (
    project_id TEXT NOT NULL REFERENCES sync_project(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('lead', 'member', 'read_only')),
    trellis_dev_id TEXT COLLATE NOCASE,
    created_by_user_id TEXT REFERENCES user_account(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, user_id),
    CHECK (
      role = 'read_only' OR
      (trellis_dev_id IS NOT NULL AND length(trim(trellis_dev_id)) > 0)
    )
  );

  CREATE UNIQUE INDEX IF NOT EXISTS sync_project_member_developer_unique
    ON sync_project_member(project_id, trellis_dev_id COLLATE NOCASE)
    WHERE trellis_dev_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS sync_project_member_user
    ON sync_project_member(user_id, project_id);

  CREATE TABLE IF NOT EXISTS sync_task_space (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES sync_project(id) ON DELETE CASCADE,
    branch_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'disabled', 'indexing', 'error')),
    revision INTEGER NOT NULL DEFAULT 0,
    indexed_revision INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    retired_at TEXT,
    retired_by_user_id TEXT REFERENCES user_account(id),
    retired_reason TEXT,
    created_by_user_id TEXT REFERENCES user_account(id),
    created_by_agent_id TEXT REFERENCES agent_device(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, branch_name)
  );

  CREATE INDEX IF NOT EXISTS sync_task_space_project
    ON sync_task_space(project_id, status);

  CREATE TABLE IF NOT EXISTS sync_task_space_file (
    task_space_id TEXT NOT NULL REFERENCES sync_task_space(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    revision INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    content_text TEXT,
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    task_id TEXT,
    task_dir TEXT NOT NULL,
    source_agent_id TEXT REFERENCES agent_device(id) ON DELETE SET NULL,
    source_user_id TEXT REFERENCES user_account(id) ON DELETE SET NULL,
    source_client_sequence INTEGER,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (task_space_id, relative_path)
  );

  CREATE INDEX IF NOT EXISTS sync_task_space_file_revision
    ON sync_task_space_file(task_space_id, revision);
  CREATE INDEX IF NOT EXISTS sync_task_space_file_task
    ON sync_task_space_file(task_space_id, task_dir);
  CREATE INDEX IF NOT EXISTS sync_task_space_file_task_id
    ON sync_task_space_file(task_space_id, task_id, deleted);

  CREATE TABLE IF NOT EXISTS sync_task_space_batch (
    batch_id TEXT NOT NULL,
    task_space_id TEXT NOT NULL REFERENCES sync_task_space(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agent_device(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    request_sha256 TEXT NOT NULL,
    client_sequence INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, task_space_id, batch_id)
  );

  CREATE INDEX IF NOT EXISTS sync_task_space_batch_time
    ON sync_task_space_batch(task_space_id, created_at);

  CREATE TABLE IF NOT EXISTS sync_task_merge_evidence (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES sync_project(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    execution_task_key TEXT NOT NULL,
    baseline_task_space_id TEXT NOT NULL REFERENCES sync_task_space(id) ON DELETE CASCADE,
    task_dir TEXT NOT NULL,
    tracked_path TEXT NOT NULL,
    source_branch_name TEXT NOT NULL,
    baseline_branch_name TEXT NOT NULL,
    evidence_type TEXT NOT NULL CHECK (evidence_type = 'tracked-in-head'),
    head_commit TEXT NOT NULL,
    source_agent_id TEXT REFERENCES agent_device(id) ON DELETE SET NULL,
    source_user_id TEXT REFERENCES user_account(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    UNIQUE(project_id, task_id)
  );

  CREATE INDEX IF NOT EXISTS sync_task_merge_evidence_space
    ON sync_task_merge_evidence(baseline_task_space_id, task_id);
  CREATE INDEX IF NOT EXISTS sync_task_merge_evidence_execution
    ON sync_task_merge_evidence(project_id, execution_task_key);

  CREATE TABLE IF NOT EXISTS sync_active_agent (
    user_id TEXT PRIMARY KEY REFERENCES user_account(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL UNIQUE REFERENCES agent_device(id) ON DELETE CASCADE,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_agent_binding (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agent_device(id) ON DELETE CASCADE,
    task_space_id TEXT NOT NULL REFERENCES sync_task_space(id) ON DELETE CASCADE,
    local_repo_key TEXT NOT NULL,
    local_display_name TEXT,
    branch_name TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (sync_status IN ('pending', 'approved', 'rejected', 'revoked')),
    last_synced_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    is_listening INTEGER NOT NULL DEFAULT 0 CHECK (is_listening IN (0, 1)),
    listener_reported_at TEXT,
    last_listener_at TEXT,
    UNIQUE(agent_id, task_space_id)
  );

  CREATE INDEX IF NOT EXISTS sync_agent_binding_task_space
    ON sync_agent_binding(task_space_id, sync_status);
  CREATE INDEX IF NOT EXISTS sync_agent_binding_agent
    ON sync_agent_binding(agent_id, sync_status);

  CREATE TABLE IF NOT EXISTS sync_agent_cursor (
    agent_id TEXT NOT NULL REFERENCES agent_device(id) ON DELETE CASCADE,
    task_space_id TEXT NOT NULL REFERENCES sync_task_space(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, task_space_id)
  );

  CREATE TABLE IF NOT EXISTS sync_task_index (
    task_space_id TEXT NOT NULL REFERENCES sync_task_space(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES sync_project(id) ON DELETE CASCADE,
    task_key TEXT NOT NULL,
    execution_task_key TEXT NOT NULL,
    relative_dir TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    title TEXT NOT NULL,
    search_text TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    archived_at TEXT,
    priority TEXT NOT NULL,
    derived_stage TEXT NOT NULL,
    assignee_dev_id TEXT,
    assignee_user_id TEXT,
    due_date TEXT,
    last_activity_at TEXT,
    is_blocked INTEGER NOT NULL DEFAULT 0 CHECK (is_blocked IN (0, 1)),
    is_unblocked_ready INTEGER NOT NULL DEFAULT 0 CHECK (is_unblocked_ready IN (0, 1)),
    attention_flags_json TEXT NOT NULL,
    group_key TEXT NOT NULL,
    group_role TEXT NOT NULL,
    task_version TEXT NOT NULL,
    board_version TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (task_space_id, task_key)
  );

  CREATE INDEX IF NOT EXISTS sync_task_index_execution
    ON sync_task_index(task_space_id, execution_task_key);
  CREATE INDEX IF NOT EXISTS sync_task_index_project
    ON sync_task_index(project_id, archived, last_activity_at);
  CREATE INDEX IF NOT EXISTS sync_task_index_assignee
    ON sync_task_index(assignee_user_id, archived);
  CREATE INDEX IF NOT EXISTS sync_task_index_stage
    ON sync_task_index(derived_stage, archived, last_activity_at);
  CREATE INDEX IF NOT EXISTS sync_task_index_priority
    ON sync_task_index(priority, archived, last_activity_at);
  CREATE INDEX IF NOT EXISTS sync_task_index_due
    ON sync_task_index(due_date, archived, last_activity_at);
  CREATE INDEX IF NOT EXISTS sync_task_index_archive_order
    ON sync_task_index(archived, archived_at DESC, task_space_id DESC, task_key DESC);

  CREATE TABLE IF NOT EXISTS sync_task_index_tag (
    task_space_id TEXT NOT NULL,
    task_key TEXT NOT NULL,
    tag_key TEXT NOT NULL,
    PRIMARY KEY (task_space_id, task_key, tag_key),
    FOREIGN KEY (task_space_id, task_key)
      REFERENCES sync_task_index(task_space_id, task_key) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS sync_task_index_tag_lookup
    ON sync_task_index_tag(tag_key, task_space_id, task_key);

  CREATE TABLE IF NOT EXISTS sync_task_space_scan_cache (
    task_space_id TEXT PRIMARY KEY REFERENCES sync_task_space(id) ON DELETE CASCADE,
    indexed_revision INTEGER NOT NULL,
    projection_state_json TEXT,
    board_json TEXT NOT NULL,
    saved_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_task_assignment (
    execution_task_key TEXT PRIMARY KEY,
    task_space_id TEXT NOT NULL REFERENCES sync_task_space(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES sync_project(id) ON DELETE CASCADE,
    assigned_user_id TEXT NOT NULL REFERENCES user_account(id),
    state TEXT NOT NULL CHECK (state IN ('pending', 'accepted')),
    assigned_by TEXT NOT NULL REFERENCES user_account(id),
    assigned_at TEXT NOT NULL,
    accepted_at TEXT,
    base_task_version TEXT,
    version INTEGER NOT NULL DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS sync_task_assignment_assignee
    ON sync_task_assignment(assigned_user_id, state);
  CREATE INDEX IF NOT EXISTS sync_task_assignment_task_space
    ON sync_task_assignment(task_space_id, state);

  CREATE TABLE IF NOT EXISTS sync_task_command (
    id TEXT PRIMARY KEY,
    task_space_id TEXT NOT NULL REFERENCES sync_task_space(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES sync_project(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agent_device(id) ON DELETE CASCADE,
    binding_id TEXT NOT NULL REFERENCES sync_agent_binding(id) ON DELETE CASCADE,
    command_type TEXT NOT NULL CHECK (
      command_type IN ('create_task', 'assign_task', 'sync_branch', 'refresh_status')
    ),
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('pending', 'delivered', 'running', 'succeeded', 'failed', 'cancelled')
    ),
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TEXT,
    result_json TEXT,
    error_text TEXT,
    created_by_user_id TEXT NOT NULL REFERENCES user_account(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(created_by_user_id, command_type, idempotency_key)
  );

  CREATE INDEX IF NOT EXISTS sync_task_command_agent_pending
    ON sync_task_command(agent_id, status, created_at);
  CREATE INDEX IF NOT EXISTS sync_task_command_task_space_time
    ON sync_task_command(task_space_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS sync_conflict (
    id TEXT PRIMARY KEY,
    task_space_id TEXT NOT NULL REFERENCES sync_task_space(id) ON DELETE CASCADE,
    task_id TEXT,
    task_dir TEXT,
    files_json TEXT NOT NULL,
    server_revision INTEGER NOT NULL,
    client_sequence INTEGER,
    batch_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
    created_by_user_id TEXT REFERENCES user_account(id),
    created_by_agent_id TEXT REFERENCES agent_device(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE INDEX IF NOT EXISTS sync_conflict_task_space
    ON sync_conflict(task_space_id, status, created_at DESC);

  CREATE TABLE IF NOT EXISTS sync_conflict_backup (
    id TEXT PRIMARY KEY,
    conflict_id TEXT REFERENCES sync_conflict(id) ON DELETE SET NULL,
    task_space_id TEXT NOT NULL REFERENCES sync_task_space(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    old_content TEXT,
    new_content TEXT,
    revision INTEGER NOT NULL,
    created_by_user_id TEXT REFERENCES user_account(id),
    created_by_agent_id TEXT REFERENCES agent_device(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS sync_conflict_backup_task_space
    ON sync_conflict_backup(task_space_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS sync_file_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_space_id TEXT NOT NULL REFERENCES sync_task_space(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    task_id TEXT,
    operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete', 'move-out', 'move-in')),
    old_sha256 TEXT,
    new_sha256 TEXT,
    revision INTEGER NOT NULL,
    source_user_id TEXT REFERENCES user_account(id) ON DELETE SET NULL,
    source_agent_id TEXT REFERENCES agent_device(id) ON DELETE SET NULL,
    occurred_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS sync_file_audit_task_space
    ON sync_file_audit(task_space_id, revision, id);
`
