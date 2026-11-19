export const SCHEMA_V4_SQL = `
  CREATE TABLE IF NOT EXISTS team (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS team_member (
    team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (team_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS team_member_user
    ON team_member(user_id, team_id);

  CREATE TABLE IF NOT EXISTS user_account (
    id TEXT PRIMARY KEY,
    username_key TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_params_json TEXT NOT NULL,
    system_admin INTEGER NOT NULL DEFAULT 0 CHECK (system_admin IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
    password_changed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_session (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES user_account(id),
    active_team_id TEXT REFERENCES team(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    ip TEXT,
    user_agent TEXT
  );

  CREATE TABLE IF NOT EXISTS login_attempt (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username_key TEXT NOT NULL,
    ip TEXT NOT NULL,
    succeeded INTEGER NOT NULL DEFAULT 0 CHECK (succeeded IN (0, 1)),
    occurred_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS team_project (
    repository_id TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES team(id),
    workspace_key TEXT NOT NULL,
    remote_url TEXT NOT NULL,
    remote_identity_hash TEXT NOT NULL,
    sync_branch TEXT NOT NULL,
    trusted_task_toolchain_sha256 TEXT,
    sync_status TEXT NOT NULL DEFAULT 'provisioning'
      CHECK (sync_status IN (
        'provisioning', 'current', 'stale', 'pending_push',
        'needs_repair', 'disabled'
      )),
    last_fetch_at TEXT,
    last_push_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (team_id, workspace_key)
  );

  CREATE INDEX IF NOT EXISTS team_project_team
    ON team_project(team_id, sync_status);

  CREATE TABLE IF NOT EXISTS project_member (
    project_id TEXT NOT NULL REFERENCES team_project(repository_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('lead', 'member', 'read_only')),
    trellis_dev_id TEXT COLLATE NOCASE,
    created_by TEXT REFERENCES user_account(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, user_id),
    CHECK (
      role = 'read_only' OR
      (trellis_dev_id IS NOT NULL AND length(trim(trellis_dev_id)) > 0)
    )
  );

  CREATE UNIQUE INDEX IF NOT EXISTS project_member_developer_unique
    ON project_member(project_id, trellis_dev_id COLLATE NOCASE)
    WHERE trellis_dev_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS project_member_user
    ON project_member(user_id, project_id);

  CREATE TABLE IF NOT EXISTS project_scan_cache (
    project_id TEXT PRIMARY KEY REFERENCES team_project(repository_id) ON DELETE CASCADE,
    schema_version INTEGER NOT NULL,
    scanned_content_key TEXT NOT NULL,
    scanned_branch_sha TEXT,
    saved_at TEXT NOT NULL,
    board_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_board_state (
    user_id TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL DEFAULT '',
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, team_id, key)
  );

  CREATE TABLE IF NOT EXISTS task_assignment (
    execution_task_key TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES team_project(repository_id) ON DELETE CASCADE,
    assigned_user_id TEXT NOT NULL REFERENCES user_account(id),
    state TEXT NOT NULL CHECK (state IN ('pending', 'accepted')),
    assigned_by TEXT NOT NULL REFERENCES user_account(id),
    assigned_at TEXT NOT NULL,
    accepted_at TEXT,
    base_task_version TEXT,
    version INTEGER NOT NULL DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS task_assignment_assignee
    ON task_assignment(assigned_user_id, state);
  CREATE INDEX IF NOT EXISTS task_assignment_project
    ON task_assignment(project_id, state);

  CREATE TABLE IF NOT EXISTS audit_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id TEXT REFERENCES user_account(id),
    actor_agent_id TEXT,
    team_id TEXT REFERENCES team(id),
    project_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    result TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS audit_event_project_time
    ON audit_event(project_id, occurred_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS audit_event_team_time
    ON audit_event(team_id, occurred_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS audit_event_actor_time
    ON audit_event(actor_user_id, occurred_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS git_operation (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES team_project(repository_id) ON DELETE CASCADE,
    actor_user_id TEXT NOT NULL REFERENCES user_account(id),
    operation_type TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'prepared', 'committed', 'pending_push', 'pushed', 'applied', 'failed'
    )),
    base_task_version TEXT,
    result_json TEXT NOT NULL,
    error_message TEXT,
    local_commit_sha TEXT,
    remote_commit_sha TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS git_operation_idempotency
    ON git_operation(actor_user_id, project_id, operation_type, idempotency_key);
  CREATE INDEX IF NOT EXISTS git_operation_project_status
    ON git_operation(project_id, status, created_at);

  CREATE TABLE IF NOT EXISTS agent_pairing_code (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES team(id),
    code_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_device (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    device_name TEXT NOT NULL,
    platform TEXT NOT NULL,
    agent_version TEXT NOT NULL,
    protocol_version INTEGER NOT NULL,
    credential_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    last_seen_at TEXT,
    last_heartbeat_json TEXT,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );

  CREATE INDEX IF NOT EXISTS agent_device_user
    ON agent_device(user_id, status);

  CREATE TABLE IF NOT EXISTS agent_project_binding (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agent_device(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES team(id),
    project_id TEXT NOT NULL REFERENCES team_project(repository_id) ON DELETE CASCADE,
    local_repo_key TEXT NOT NULL,
    local_display_name TEXT,
    branch_name TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    last_synced_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(agent_id, project_id)
  );

  CREATE INDEX IF NOT EXISTS agent_binding_project
    ON agent_project_binding(project_id, sync_status);
  CREATE INDEX IF NOT EXISTS agent_binding_team
    ON agent_project_binding(team_id, sync_status);

  CREATE TABLE IF NOT EXISTS agent_command (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agent_device(id) ON DELETE CASCADE,
    binding_id TEXT NOT NULL REFERENCES agent_project_binding(id) ON DELETE CASCADE,
    command_type TEXT NOT NULL CHECK (command_type IN ('sync_branch', 'refresh_status')),
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'pending', 'delivered', 'completed', 'failed', 'cancelled'
    )),
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    lease_expires_at TEXT,
    completed_at TEXT,
    result_json TEXT
  );

  CREATE INDEX IF NOT EXISTS agent_command_pending
    ON agent_command(agent_id, status, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS agent_command_sync_pending
    ON agent_command(agent_id, binding_id, command_type)
    WHERE status IN ('pending', 'delivered') AND command_type = 'sync_branch';

  CREATE TABLE IF NOT EXISTS team_task_index (
    project_id TEXT NOT NULL,
    task_key TEXT NOT NULL,
    execution_task_key TEXT NOT NULL,
    relative_dir TEXT NOT NULL,
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
    PRIMARY KEY (project_id, task_key)
  );

  CREATE INDEX IF NOT EXISTS team_task_assignee
    ON team_task_index(assignee_user_id, archived);
  CREATE INDEX IF NOT EXISTS team_task_stage
    ON team_task_index(derived_stage, archived, last_activity_at);
  CREATE INDEX IF NOT EXISTS team_task_priority
    ON team_task_index(priority, archived, last_activity_at);
  CREATE INDEX IF NOT EXISTS team_task_due
    ON team_task_index(due_date, archived, last_activity_at);
  CREATE INDEX IF NOT EXISTS team_task_order
    ON team_task_index(last_activity_at, task_key);

  CREATE TABLE IF NOT EXISTS team_task_index_tag (
    project_id TEXT NOT NULL,
    task_key TEXT NOT NULL,
    tag_key TEXT NOT NULL,
    PRIMARY KEY (project_id, task_key, tag_key),
    FOREIGN KEY (project_id, task_key)
      REFERENCES team_task_index(project_id, task_key) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS team_task_tag_lookup
    ON team_task_index_tag(tag_key, project_id, task_key);
`
