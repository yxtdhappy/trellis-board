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
const HOST_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIK2mFakeHostKeyMaterialForTestsOnly'

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
      knownHostsText: `[git.weintdata.cn]:1022 ssh-ed25519 ${HOST_KEY}`,
    })
    const https = ctx.service.create(ctx.actor, {
      name: 'GitHub',
      scheme: 'https',
      host: 'github.com',
      port: 443,
      username: 'git-user',
      token: 'ghp_archiveTokenForTests1234567890',
    })
    assert.equal(ssh.origin, 'ssh://git.weintdata.cn:1022')
    assert.equal(https.origin, 'https://github.com:443')
    for (const dto of ctx.service.list()) {
      assert.equal(Object.hasOwn(dto, 'secretCiphertext'), false)
      assert.equal(Object.hasOwn(dto, 'secretTag'), false)
      assert.equal(Object.hasOwn(dto, 'privateKey'), false)
      assert.equal(Object.hasOwn(dto, 'token'), false)
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
    assert.equal(fs.existsSync(path.join(ctx.dataDir, 'archive-git-credentials.key')), true)

    const resolvedSsh = ctx.service.resolveForRemote(
      'ssh://git.weintdata.cn:1022/prod-mdp/repo.git',
    )
    assert.equal(resolvedSsh.credential.id, ssh.id)
    assert.equal(resolvedSsh.origin, ssh.origin)
    assert.equal(
      resolvedSsh.remote.url,
      'ssh://git.weintdata.cn:1022/prod-mdp/repo',
    )
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
  } finally {
    ctx.db.close()
    fs.rmSync(ctx.dataDir, { recursive: true, force: true })
  }
})

test('SSH known_hosts 必须匹配凭据来源的 host 和 port', () => {
  const ctx = setup()
  try {
    assert.throws(
      () =>
        ctx.service.create(ctx.actor, {
          scheme: 'ssh',
          host: 'git.weintdata.cn',
          port: 1022,
          privateKey: PRIVATE_KEY,
          knownHostsText: `git.weintdata.cn ssh-ed25519 ${HOST_KEY}`,
        }),
      /known_hosts 没有匹配 \[git\.weintdata\.cn\]:1022/,
    )
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS count FROM sync_archive_git_credential').get().count,
      0,
    )
  } finally {
    ctx.db.close()
    fs.rmSync(ctx.dataDir, { recursive: true, force: true })
  }
})
