import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runProcess, sanitizeProcessOutput } from '../team/process.js'

test('子进程输出按字节截断并按已知秘密脱敏', async () => {
  const secret = 'credential-output-secret'
  const result = await runProcess(
    process.execPath,
    [
      '-e',
      `process.stdout.write(${JSON.stringify(secret + 'x'.repeat(64))}); process.stderr.write(${JSON.stringify(secret)})`,
    ],
    {
      cwd: process.cwd(),
      maxOutputBytes: 24,
      redact: [secret],
    },
  )
  assert.equal(result.truncated, true)
  assert.equal(result.stdout.includes(secret), false)
  assert.equal(result.stderr.includes(secret), false)
  assert.match(result.stdout, /\[redacted\]/)
  assert.equal(
    sanitizeProcessOutput(`prefix ${secret} suffix`, { redact: [secret] }),
    'prefix [redacted] suffix',
  )
})

test('子进程超时后等待进程树退出并保留超时错误', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-process-timeout-'))
  const pidFile = path.join(root, 'child.pid')
  const grandchildPidFile = path.join(root, 'grandchild.pid')
  t.after(() =>
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    }),
  )
  const script = [
    "const fs = require('node:fs')",
    "const { spawn } = require('node:child_process')",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
    ...(process.platform === 'win32'
      ? [
          `const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })`,
          `fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid))`,
        ]
      : []),
    'setInterval(() => {}, 1000)',
  ].join(';')

  await assert.rejects(
    runProcess(process.execPath, ['-e', script], {
      cwd: root,
      timeoutMs: 500,
    }),
    /执行超过 500ms，已终止/,
  )

  assert.equal(fs.existsSync(pidFile), true)
  const pid = Number(fs.readFileSync(pidFile, 'utf8'))
  assert.ok(Number.isInteger(pid) && pid > 0)
  await waitForProcessExit(pid)
  if (process.platform === 'win32') {
    assert.equal(fs.existsSync(grandchildPidFile), true)
    const grandchildPid = Number(fs.readFileSync(grandchildPidFile, 'utf8'))
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0)
    await waitForProcessExit(grandchildPid)
  }
})

async function waitForProcessExit(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail(`子进程 ${pid} 在 ${timeoutMs}ms 内未退出`)
}
