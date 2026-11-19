export const SCHEMA_V13_SQL = `
  CREATE TABLE IF NOT EXISTS plugin_registry (
    plugin_id     TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    version       TEXT NOT NULL,
    api_version   INTEGER NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    manifest_json TEXT NOT NULL,
    source_path   TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    default_scope TEXT NOT NULL DEFAULT 'user' CHECK (default_scope IN ('user', 'team')),
    discovered_at TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS plugin_team_setting (
    team_id     TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    plugin_id   TEXT NOT NULL REFERENCES plugin_registry(plugin_id) ON DELETE CASCADE,
    enabled     INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    config_json TEXT NOT NULL DEFAULT '{}',
    updated_by  TEXT REFERENCES user_account(id),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (team_id, plugin_id)
  );

  CREATE INDEX IF NOT EXISTS plugin_team_setting_plugin
    ON plugin_team_setting(plugin_id, enabled);

  CREATE TABLE IF NOT EXISTS plugin_user_config (
    user_id     TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    plugin_id   TEXT NOT NULL REFERENCES plugin_registry(plugin_id) ON DELETE CASCADE,
    config_json TEXT NOT NULL DEFAULT '{}',
    status      TEXT NOT NULL DEFAULT 'unconfigured'
      CHECK (status IN ('unconfigured', 'active', 'invalid')),
    last_error  TEXT,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (user_id, plugin_id)
  );

  CREATE TABLE IF NOT EXISTS plugin_project_binding (
    id                    TEXT PRIMARY KEY,
    team_id               TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    plugin_id             TEXT NOT NULL REFERENCES plugin_registry(plugin_id) ON DELETE CASCADE,
    project_id            TEXT REFERENCES team_project(repository_id) ON DELETE CASCADE,
    external_project_id   TEXT NOT NULL,
    external_project_name TEXT,
    created_by            TEXT REFERENCES user_account(id),
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    UNIQUE (team_id, plugin_id, external_project_id)
  );

  CREATE INDEX IF NOT EXISTS plugin_binding_project
    ON plugin_project_binding(project_id);
`
