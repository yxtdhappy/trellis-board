import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openDatabase } from '../database.js'
import { createArchiveGitCredentialService } from '../team/archive-git-credentials.js'

const PRIVATE_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ==',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n')

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-archive-credentials-'))
  const db = openDatabase({
    databaseFile: ':memory:',
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
  })
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO user_account(
      id, username_key, username, display_name, password_hash, password_params_json,
      system_admin, status, must_change_password, password_changed_at, created_at, updated_at
    ) VALUES ('user-1', 'user-1', 'user-1', '管理员', 'x', '{}', 1, 'active', 0, ?, ?, ?)
  `).run(now, now, now)
  return {
    dataDir,
    db,
    actor: { userId: 'user-1' },
    service: createArchiveGitCredentialService({ db, dataDir }),
  }
}

test('归档凭据按精确来源加密保存且 API 不回显秘密', async () => {
  const ctx = setup()
  try {
    const ssh = ctx.service.create(ctx.actor, {
      name: '公司 Git',
      scheme: 'ssh',
      host: 'git.weintdata.cn',
      port: 1022,
      privateKey: PRIVATE_KEY,
    })
    const https = ctx.service.create(ctx.actor, {
      name: 'GitHub',
      scheme: 'https',
      host: 'github.com',
      port: 443,
      username: 'git-user',
      token: 'ghp_archiveTokenForTests1234567890',
    })
    const customSsh = ctx.service.create(ctx.actor, {
      name: '自定义 SSH',
      scheme: 'ssh',
      host: 'ssh.example.com',
      port: 22,
      username: 'deploy',
      privateKey: PRIVATE_KEY,
    })
    assert.equal(ssh.origin, 'ssh://git.weintdata.cn:1022')
    assert.equal(ssh.username, 'git')
    assert.equal(https.origin, 'https://github.com:443')
    assert.equal(customSsh.username, 'deploy')
    for (const dto of ctx.service.list()) {
      assert.equal(Object.hasOwn(dto, 'secretCiphertext'), false)
      assert.equal(Object.hasOwn(dto, 'secretTag'), false)
      assert.equal(Object.hasOwn(dto, 'privateKey'), false)
      assert.equal(Object.hasOwn(dto, 'token'), false)
      assert.equal(Object.hasOwn(dto, 'knownHostsConfigured'), false)
      assert.equal(Object.hasOwn(dto, 'knownHostsFingerprints'), false)
      assert.equal(Object.hasOwn(dto, 'knownHostsText'), false)
    }

    const stored = ctx.db
      .prepare(`
        SELECT secret_ciphertext, secret_tag, known_hosts_text
        FROM sync_archive_git_credential
        ORDER BY scheme
      `)
      .all()
    assert.ok(stored.every((row) => row.secret_ciphertext && row.secret_tag))
    assert.ok(stored.every((row) => !row.secret_ciphertext.includes(PRIVATE_KEY)))
    assert.ok(stored.every((row) => !row.secret_ciphertext.includes('ghp_archiveToken')))
    assert.ok(stored.every((row) => !row.known_hosts_text))
    assert.equal(fs.existsSync(path.join(ctx.dataDir, 'archive-git-credentials.key')), true)

    const resolvedSsh = ctx.service.resolveForRemote(
      'ssh://git.weintdata.cn:1022/prod-mdp/repo.git',
    )
    assert.equal(resolvedSsh.credential.id, ssh.id)
    assert.equal(resolvedSsh.origin, ssh.origin)
    assert.equal(resolvedSsh.remote.url, 'ssh://git.weintdata.cn:1022/prod-mdp/repo')
    assert.throws(
      () => ctx.service.resolveForRemote('ssh://github.com:22/acme/repo.git'),
      (error) => error.status === 409 && error.code === 'ARCHIVE_CREDENTIAL_MISSING',
    )
    assert.equal(
      ctx.service.resolveForRemote('https://github.com/other/repo.git').credential.id,
      https.id,
    )
    assert.equal(
      ctx.service.resolveForRemote('https://example.com/public/repo.git').credential,
      null,
    )
    assert.equal(
      ctx.service.resolveForRemote('ssh://ssh.example.com/acme/repo.git').credential.username,
      'deploy',
    )
    const updatedCustomSsh = ctx.service.update(ctx.actor, customSsh.id, {
      username: 'release+ci@example.com',
    })
    assert.equal(updatedCustomSsh.username, 'release+ci@example.com')
    assert.equal(
      ctx.service.resolveForRemote('https://github.com:8443/other/repo.git').credential,
      null,
    )

    const retained = ctx.service.update(ctx.actor, https.id, { name: 'GitHub 轮换前' })
    assert.equal(retained.secretVersion, 1)
    const rotated = ctx.service.update(ctx.actor, https.id, {
      token: 'ghp_rotatedArchiveToken123456789',
    })
    assert.equal(rotated.secretVersion, 2)

    let authDirectory = null
    await ctx.service.withAuth(
      ctx.service.resolveForRemote('https://github.com/repo.git').credential,
      async (auth) => {
        authDirectory = auth.dir
        assert.equal(fs.existsSync(authDirectory), true)
        assert.ok(auth.redact.includes('ghp_rotatedArchiveToken123456789'))
      },
    )
    assert.equal(fs.existsSync(authDirectory), false)
    await ctx.service.withAuth(
      ctx.service.resolveForRemote('ssh://ssh.example.com/acme/repo.git').credential,
      async (auth) => {
        const scriptPath = auth.env.GIT_SSH_COMMAND.slice(1, -1)
        const script = fs.readFileSync(scriptPath, 'utf8')
        assert.match(
          script,
          /-o User=(?:"release\+ci@example\.com"|'release\+ci@example\.com'|release\+ci@example\.com)/,
        )
      },
    )
    assert.throws(
      () =>
        ctx.service.create(ctx.actor, {
          scheme: 'ssh',
          host: 'invalid-user.example.com',
          port: 22,
          username: '-invalid',
          privateKey: PRIVATE_KEY,
        }),
      /SSH 用户名格式无效/,
    )
  } finally {
    ctx.db.close()
    fs.rmSync(ctx.dataDir, { recursive: true, force: true })
  }
})

test('SSH 凭据只使用私钥且不校验主机密钥', async () => {
  const ctx = setup()
  try {
    const ssh = ctx.service.create(ctx.actor, {
      scheme: 'ssh',
      host: 'git.weintdata.cn',
      port: 1022,
      privateKey: PRIVATE_KEY,
    })
    let authDirectory = null
    await ctx.service.withAuth(
      ctx.service.resolveForRemote('ssh://git.weintdata.cn:1022/prod-mdp/repo.git').credential,
      async (auth) => {
        authDirectory = auth.dir
        const scriptPath = auth.env.GIT_SSH_COMMAND.slice(1, -1)
        const script = fs.readFileSync(scriptPath, 'utf8')
        assert.match(script, /-o User=(?:"git"|'git'|git)/)
        assert.match(script, /StrictHostKeyChecking=no/)
        assert.doesNotMatch(script, /StrictHostKeyChecking=yes/)
      },
    )
    assert.equal(fs.existsSync(authDirectory), false)

    ctx.db
      .prepare('UPDATE sync_archive_git_credential SET username = NULL WHERE id = ?')
      .run(ssh.id)
    await ctx.service.withAuth(
      ctx.service.resolveForRemote('ssh://git.weintdata.cn:1022/prod-mdp/repo.git').credential,
      async (auth) => {
        const scriptPath = auth.env.GIT_SSH_COMMAND.slice(1, -1)
        const script = fs.readFileSync(scriptPath, 'utf8')
        assert.match(script, /-o User=(?:"git"|'git'|git)/)
      },
    )

    const rotated = ctx.service.update(ctx.actor, ssh.id, { privateKey: PRIVATE_KEY })
    assert.equal(rotated.secretVersion, 2)
    assert.equal(rotated.username, 'git')
  } finally {
    ctx.db.close()
    fs.rmSync(ctx.dataDir, { recursive: true, force: true })
  }
})
