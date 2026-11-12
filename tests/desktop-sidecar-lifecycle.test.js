import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isParentAlive, startParentWatchdog } from '../desktop/sidecar/parent-watchdog.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fakeScheduler() {
  let callback = null
  const cleared = []
  const intervals = []
  return {
    setIntervalFn(next, intervalMs) {
      callback = next
      intervals.push(intervalMs)
      return 7
    },
    clearIntervalFn(timer) {
      cleared.push(timer)
    },
    tick() {
      callback()
    },
    cleared,
    intervals,
  }
}

async function waitForCondition(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!predicate()) throw new Error(message)
}

test('父进程存活时 watchdog 不误退出，停止后清理定时器', () => {
  const scheduler = fakeScheduler()
  let exits = 0
  const stop = startParentWatchdog({
    parentPid: 42,
    isAlive: () => true,
    onParentExit: () => {
      exits += 1
    },
    setIntervalFn: scheduler.setIntervalFn,
    clearIntervalFn: scheduler.clearIntervalFn,
  })

  scheduler.tick()
  scheduler.tick()
  assert.equal(exits, 0)
  assert.deepEqual(scheduler.intervals, [1000])

  stop()
  scheduler.tick()
  assert.equal(exits, 0)
  assert.deepEqual(scheduler.cleared, [7])
})

test('父进程不存在时 watchdog 只触发一次退出', () => {
  const scheduler = fakeScheduler()
  let exits = 0
  startParentWatchdog({
    parentPid: 42,
    isAlive: () => false,
    onParentExit: () => {
      exits += 1
    },
    setIntervalFn: scheduler.setIntervalFn,
    clearIntervalFn: scheduler.clearIntervalFn,
  })

  scheduler.tick()
  scheduler.tick()
  assert.equal(exits, 1)
  assert.deepEqual(scheduler.cleared, [7])
})

test('父进程探测只在明确不存在时返回退出', () => {
  assert.equal(
    isParentAlive(42, () => {}),
    true,
  )
  assert.equal(
    isParentAlive(42, () => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' })
    }),
    true,
  )
  assert.equal(
    isParentAlive(42, () => {
      throw Object.assign(new Error('missing'), { code: 'ESRCH' })
    }),
    false,
  )
  assert.equal(
    isParentAlive(42, () => {
      throw Object.assign(new Error('unknown'), { code: 'EIO' })
    }),
    true,
  )
})

test('真实父子进程：父进程退出后 watchdog 子进程在 3 秒内退出', { timeout: 12000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-parent-watchdog-'))
  const startedFile = path.join(root, 'child-started.txt')
  const markerFile = path.join(root, 'parent-exited.txt')
  const pidFile = path.join(root, 'child.pid')
  const moduleUrl = pathToFileURL(path.join(ROOT, 'desktop', 'sidecar', 'parent-watchdog.js')).href
  const childFile = path.join(root, 'child.mjs')
  const parentFile = path.join(root, 'parent.mjs')
  let childPid = 0
  let parentProcess = null

  fs.writeFileSync(
    childFile,
    [
      "import fs from 'node:fs'",
      `import { startParentWatchdog } from ${JSON.stringify(moduleUrl)}`,
      'startParentWatchdog({',
      '  intervalMs: 100,',
      '  onParentExit() {',
      "    fs.writeFileSync(process.env.WATCHDOG_MARKER, 'parent-exited')",
      '    process.exit(6)',
      '  },',
      '})',
      'setInterval(() => {}, 1000)',
      "fs.writeFileSync(process.env.WATCHDOG_STARTED, 'started')",
    ].join('\n'),
  )
  fs.writeFileSync(
    parentFile,
    [
      "import { spawn } from 'node:child_process'",
      "import fs from 'node:fs'",
      'const child = spawn(process.execPath, [process.env.WATCHDOG_CHILD], {',
      "  stdio: 'ignore',",
      '  detached: true,',
      '  windowsHide: true,',
      '  env: process.env,',
      '})',
      "child.once('spawn', () => {",
      '  fs.writeFileSync(process.env.WATCHDOG_PID_FILE, String(child.pid))',
      '  child.unref()',
      '})',
      "child.once('error', () => process.exit(1))",
      'setInterval(() => {}, 1000)',
    ].join('\n'),
  )

  try {
    parentProcess = spawn(process.execPath, [parentFile], {
      cwd: ROOT,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        WATCHDOG_CHILD: childFile,
        WATCHDOG_STARTED: startedFile,
        WATCHDOG_MARKER: markerFile,
        WATCHDOG_PID_FILE: pidFile,
      },
    })
    await waitForCondition(
      () => fs.existsSync(pidFile) && fs.existsSync(startedFile),
      5000,
      'watchdog 子进程未完成启动',
    )
    childPid = Number(fs.readFileSync(pidFile, 'utf8'))
    assert.ok(Number.isInteger(childPid) && childPid > 0)
    const parentExit = once(parentProcess, 'exit')
    process.kill(parentProcess.pid, 'SIGKILL')
    await parentExit
    assert.equal(isParentAlive(parentProcess.pid), false)

    await waitForCondition(
      () => fs.existsSync(startedFile) && fs.existsSync(markerFile) && !isParentAlive(childPid),
      3000,
      `父进程退出后 watchdog 子进程仍未退出：started=${fs.existsSync(startedFile)} marker=${fs.existsSync(markerFile)} alive=${isParentAlive(childPid)}`,
    )
    assert.equal(fs.readFileSync(markerFile, 'utf8'), 'parent-exited')
  } finally {
    if (childPid === 0 && fs.existsSync(pidFile)) {
      childPid = Number(fs.readFileSync(pidFile, 'utf8'))
    }
    if (parentProcess?.pid && isParentAlive(parentProcess.pid)) {
      try {
        process.kill(parentProcess.pid, 'SIGKILL')
      } catch {}
    }
    if (childPid === 0) {
      for (let attempt = 0; attempt < 20 && !fs.existsSync(pidFile); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      if (fs.existsSync(pidFile)) {
        childPid = Number(fs.readFileSync(pidFile, 'utf8'))
      }
    }
    if (childPid > 0 && isParentAlive(childPid)) {
      try {
        process.kill(childPid, 'SIGKILL')
      } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
})
