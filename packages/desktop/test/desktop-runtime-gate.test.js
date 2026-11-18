import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('client config tolerates pre-login runtime documents', () => {
  const config = read('packages/desktop/src-tauri/src/config.rs')
  assert.match(config, /#\[serde\(default\)]\s+pub server_url: String/)
  assert.match(config, /pub python_runtime: Option<serde_json::Value>/)
  assert.doesNotMatch(config, /alias = "schema_version"/)

  const main = read('packages/desktop/src-tauri/src/main.rs')
  assert.match(main, /python_runtime: previous_config/)
})

test('runtime install reuses detected runtimes and only installs missing pieces', () => {
  const install = read('packages/desktop/src-tauri/src/agent/env/install.rs')
  assert.match(install, /resolve_node\(data_dir, config\)/)
  assert.match(install, /resolve_trellis\(data_dir, config\)/)
  assert.match(install, /resolve_python\(config\)/)
  assert.match(install, /install_plan\(&node_status, &trellis_status, &python_status\)/)
  assert.doesNotMatch(install, /fn write_runtime_flags/)
})

test('probe covers npm/pnpm/python prefixes and skips empty aliases', () => {
  const probe = read('packages/desktop/src-tauri/src/agent/env/probe.rs')
  assert.match(probe, /join\("npm"\)/)
  assert.match(probe, /join\("pnpm"\)/)
  assert.match(probe, /fn python_dirs_in\(/)
  assert.match(probe, /meta\.len\(\) > 0/)
})

test('login page shows detected versions and can re-check', () => {
  const login = read('packages/web/src/desktop/LoginApp.tsx')
  assert.match(login, /已检测到/)
  assert.match(login, /setInstallVisible\(true\)\s+setRetryVisible\(true\)\s+return/)
  assert.doesNotMatch(login, /active: 'node:download'/)
})

test('runtime status writes a diagnosis summary and normalizes the schema key', () => {
  const commands = read('packages/desktop/src-tauri/src/runtime_commands.rs')
  assert.match(commands, /logging::info/)
  assert.match(commands, /运行环境检查 state=/)
  assert.match(commands, /fn normalize_schema_key/)
  assert.match(commands, /remove\("schema_version"\)/)
})
