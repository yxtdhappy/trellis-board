import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHarness, startHttpServer } from '../../../packages/test-support/plugin-runtime.js'
import {
  SECRETS_KEY_FILENAME,
  decryptSecretValue,
  loadSecretsFile,
  writeSecretRef,
} from '../plugins/secrets.js'

const PLUGIN_ID = 'secrets-writer'
const MODULE = './packages/test-support/fixtures/plugins/secrets-writer/index.js'

async function setup({ secrets = null } = {}) {
  const harness = await createHarness({
    plugins: [{ id: PLUGIN_ID, module: MODULE, enabled: true, config: {} }],
    secrets,
    hostVersion: '0.2.0',
  })
  const http = await startHttpServer(harness.runtime)
  const secretsFile = path.join(harness.workspace.dataDir, 'plugins.secrets.json')
  const keyFile = path.join(harness.workspace.dataDir, SECRETS_KEY_FILENAME)
  return {
    harness,
    http,
    secretsFile,
    keyFile,
    async cleanup() {
      await http.close()
      await harness.cleanup()
    },
  }
}

async function call(http, pathname, options = {}) {
  const response = await fetch(`${http.baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, text, json }
}

test('ctx.secrets.set 加密落盘：密文写入、密钥 0600、可回读', async () => {
  const context = await setup()
  try {
    const written = await call(context.http, `/api/plugins/${PLUGIN_ID}/secret`, {
      method: 'POST',
      body: { key: `${PLUGIN_ID}/password`, value: 's3cret-pass' },
    })
    assert.equal(written.status, 200)
    assert.equal(written.json.stored, true)

    const raw = fs.readFileSync(context.secretsFile, 'utf8')
    assert.doesNotMatch(raw, /s3cret-pass/)
    assert.match(raw, new RegExp(`"${PLUGIN_ID}/password": "enc:v1:`))

    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(context.secretsFile).mode & 0o777, 0o600)
      assert.equal(fs.statSync(context.keyFile).mode & 0o777, 0o600)
    }
    assert.equal(fs.statSync(context.keyFile).size, 32)

    const read = await call(context.http, `/api/plugins/${PLUGIN_ID}/secret?key=${PLUGIN_ID}/password`)
    assert.equal(read.json.value, 's3cret-pass')

    const loaded = loadSecretsFile(context.secretsFile)
    assert.equal(loaded.refs.get(`${PLUGIN_ID}/password`), 's3cret-pass')
    assert.equal(loaded.encrypted, 1)
  } finally {
    await context.cleanup()
  }
})

test('插件不能读写别的插件的 secret', async () => {
  const context = await setup()
  try {
    const response = await call(context.http, `/api/plugins/${PLUGIN_ID}/secret`, {
      method: 'POST',
      body: { key: 'other-plugin/token', value: 'x' },
    })
    assert.equal(response.status, 403)
    assert.match(response.text, /只能访问自己的 secret/)

    const read = await call(context.http, `/api/plugins/${PLUGIN_ID}/secret?key=other-plugin/token`)
    assert.equal(read.status, 403)
  } finally {
    await context.cleanup()
  }
})

test('明文 refs 继续可读，写入后统一加密', async () => {
  const context = await setup({
    secrets: {
      version: 1,
      refs: { [`${PLUGIN_ID}/token`]: 'legacy-plain' },
    },
  })
  try {
    const legacy = await call(context.http, `/api/plugins/${PLUGIN_ID}/secret?key=${PLUGIN_ID}/token`)
    assert.equal(legacy.json.value, 'legacy-plain')

    await call(context.http, `/api/plugins/${PLUGIN_ID}/secret`, {
      method: 'POST',
      body: { key: `${PLUGIN_ID}/password`, value: 'new-pass' },
    })
    const raw = JSON.parse(fs.readFileSync(context.secretsFile, 'utf8'))
    assert.equal(raw.refs[`${PLUGIN_ID}/token`], 'legacy-plain')
    assert.match(raw.refs[`${PLUGIN_ID}/password`], /^enc:v1:/)
  } finally {
    await context.cleanup()
  }
})

test('ctx.secrets.delete 移除条目，未命中返回 false', async () => {
  const context = await setup()
  try {
    await call(context.http, `/api/plugins/${PLUGIN_ID}/secret`, {
      method: 'POST',
      body: { key: `${PLUGIN_ID}/password`, value: 'x' },
    })
    const removed = await call(context.http, `/api/plugins/${PLUGIN_ID}/secret/delete`, {
      method: 'POST',
      body: { key: `${PLUGIN_ID}/password` },
    })
    assert.equal(removed.json.deleted, true)
    const again = await call(context.http, `/api/plugins/${PLUGIN_ID}/secret/delete`, {
      method: 'POST',
      body: { key: `${PLUGIN_ID}/password` },
    })
    assert.equal(again.json.deleted, false)
  } finally {
    await context.cleanup()
  }
})

test('缺少密钥文件时解密报错而不是静默降级', async () => {
  const context = await setup()
  try {
    await call(context.http, `/api/plugins/${PLUGIN_ID}/secret`, {
      method: 'POST',
      body: { key: `${PLUGIN_ID}/password`, value: 'x' },
    })
    fs.rmSync(context.keyFile)
    assert.throws(() => loadSecretsFile(context.secretsFile), /plugins.secrets.key/)
  } finally {
    await context.cleanup()
  }
})

test('ctx.secrets 仍可读进程环境变量（config.env 注入，向后兼容）', async () => {
  const harness = await createHarness({
    plugins: [
      {
        id: PLUGIN_ID,
        module: MODULE,
        enabled: true,
        config: { env: { FIXTURE_ENV_SECRET: 'from-env' } },
      },
    ],
    hostVersion: '0.2.0',
  })
  const http = await startHttpServer(harness.runtime)
  try {
    const response = await call(http, `/api/plugins/${PLUGIN_ID}/env?key=FIXTURE_ENV_SECRET`)
    assert.equal(response.json.value, 'from-env')
  } finally {
    await http.close()
    await harness.cleanup()
  }
})

test('writeSecretRef 生成密钥文件并保持其它条目', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'secrets-ref-'))
  try {
    const file = path.join(dir, 'plugins.secrets.json')
    fs.writeFileSync(file, JSON.stringify({ version: 1, refs: { 'a/b': 'plain' } }), { mode: 0o600 })
    writeSecretRef(file, 'a/c', 'v1')
    writeSecretRef(file, 'a/c', 'v2')
    const loaded = loadSecretsFile(file)
    assert.equal(loaded.refs.get('a/b'), 'plain')
    assert.equal(loaded.refs.get('a/c'), 'v2')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.match(raw.refs['a/c'], /^enc:v1:/)
    assert.equal(decryptSecretValue(raw.refs['a/c'], path.join(dir, SECRETS_KEY_FILENAME)), 'v2')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
