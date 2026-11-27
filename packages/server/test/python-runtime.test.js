import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  PYTHON_UNAVAILABLE,
  PythonUnavailableError,
  isUsableExecutable,
  pythonCommandCandidates,
  resolvePython,
  resolvePythonCandidates,
  runPythonScript,
  tryPythonCandidates,
} from '../python.js'

const POSIX_ONLY = { skip: process.platform === 'win32' }

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  fs.chmodSync(file, 0o755)
  return file
}

function writePlainFile(file, content = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

function realPython3() {
  return execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
  }).trim()
}

function hasPython3() {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

test('isUsableExecutable 拒绝目录、0 字节与不可执行文件', POSIX_ONLY, () => {
  const root = tempDir('trellis-python-check-')
  const directory = path.join(root, 'python3')
  fs.mkdirSync(directory)
  const empty = writePlainFile(path.join(root, 'empty', 'python3'))
  const plain = writePlainFile(path.join(root, 'plain', 'python3'), '#!/bin/sh\n')
  fs.chmodSync(plain, 0o644)
  const executable = writeExecutable(path.join(root, 'exec', 'python3'), '#!/bin/sh\n')

  assert.equal(isUsableExecutable(directory), false)
  assert.equal(isUsableExecutable(empty), false, '0 字节是 Windows App Execution Alias')
  assert.equal(isUsableExecutable(plain), false)
  assert.equal(isUsableExecutable(executable), true)
  assert.equal(isUsableExecutable(path.join(root, 'missing', 'python3')), false)
})

test('候选顺序：TRELLIS_PYTHON 最先，PATH 中的绝对路径排在其后', POSIX_ONLY, () => {
  const root = tempDir('trellis-python-order-')
  const bin = path.join(root, 'bin')
  writeExecutable(path.join(bin, 'python3'), '#!/bin/sh\n')
  writeExecutable(path.join(bin, 'python'), '#!/bin/sh\n')

  const explicit = '/opt/custom/python3'
  const candidates = resolvePythonCandidates({
    env: { PATH: bin, TRELLIS_PYTHON: explicit },
    platform: 'linux',
  })

  assert.equal(candidates[0].command, explicit)
  assert.equal(candidates[0].source, 'env')
  assert.equal(candidates[0].label, 'TRELLIS_PYTHON')
  assert.deepEqual(candidates[0].prefixArgs, [])
  // 同一目录内 python3 先于 python。
  assert.deepEqual(
    candidates
      .filter((candidate) => candidate.source === 'path')
      .map((candidate) => candidate.command),
    [path.join(bin, 'python3'), path.join(bin, 'python')],
  )
  // PATH 已解析出可用解释器时不再追加裸名字。
  assert.equal(
    candidates.some((candidate) => candidate.source === 'fallback'),
    false,
  )
})

test('PATH 中 0 字节的 python.exe 被跳过，回落到 python3.exe', POSIX_ONLY, () => {
  const root = tempDir('trellis-python-alias-')
  const alias = writePlainFile(path.join(root, 'python.exe'))
  const real = writeExecutable(path.join(root, 'python3.exe'), '#!/bin/sh\n')

  const candidates = resolvePythonCandidates({
    env: { PATH: root, SystemRoot: '', LOCALAPPDATA: '', ProgramFiles: '', SystemDrive: '' },
    platform: 'win32',
  })

  const pathCommands = candidates
    .filter((candidate) => candidate.source === 'path')
    .map((candidate) => candidate.command)
  assert.deepEqual(pathCommands, [real])
  assert.ok(!pathCommands.includes(alias), '0 字节别名不得作为候选')
})

test('PATH 中不可执行的文件不会被当作候选', POSIX_ONLY, () => {
  const root = tempDir('trellis-python-noexec-')
  const plain = writePlainFile(path.join(root, 'python3'), '#!/bin/sh\n')
  fs.chmodSync(plain, 0o644)

  const candidates = resolvePythonCandidates({ env: { PATH: root }, platform: 'linux' })

  assert.equal(
    candidates.some((candidate) => candidate.source === 'path'),
    false,
  )
  // 没有解析出可用路径时保留裸名字兜底。
  assert.deepEqual(
    candidates.map((candidate) => candidate.command),
    ['python3', 'python'],
  )
})

test('Windows 常见安装目录排在 PATH 之后，并按版本倒序', POSIX_ONLY, () => {
  const root = tempDir('trellis-python-win-dirs-')
  const bin = path.join(root, 'bin')
  const onPath = writeExecutable(path.join(bin, 'python.exe'), '#!/bin/sh\n')
  const older = writeExecutable(
    path.join(root, 'Programs', 'Python', 'Python311', 'python.exe'),
    '#!/bin/sh\n',
  )
  const newer = writeExecutable(
    path.join(root, 'Programs', 'Python', 'Python312', 'python.exe'),
    '#!/bin/sh\n',
  )

  const candidates = resolvePythonCandidates({
    env: {
      PATH: bin,
      LOCALAPPDATA: root,
      ProgramFiles: '',
      SystemDrive: '',
      SystemRoot: '',
    },
    platform: 'win32',
  })

  const pathIndex = candidates.findIndex((candidate) => candidate.command === onPath)
  const newerIndex = candidates.findIndex((candidate) => candidate.command === newer)
  const olderIndex = candidates.findIndex((candidate) => candidate.command === older)
  assert.ok(pathIndex >= 0 && newerIndex > pathIndex && olderIndex > newerIndex)
  assert.equal(candidates[newerIndex].source, 'common-prefix')
})

test('PATH 已解析出可用 python.exe 时不再探测 py -3', POSIX_ONLY, () => {
  const root = tempDir('trellis-python-skip-py-')
  const bin = path.join(root, 'bin')
  writeExecutable(path.join(bin, 'python.exe'), '#!/bin/sh\n')
  const marker = path.join(root, 'py-ran')
  const systemRoot = path.join(root, 'Windows')
  writeExecutable(path.join(systemRoot, 'py.exe'), `#!/bin/sh\ntouch "${marker}"\n`)

  const candidates = resolvePythonCandidates({
    env: { PATH: bin, SystemRoot: systemRoot, LOCALAPPDATA: '', ProgramFiles: '', SystemDrive: '' },
    platform: 'win32',
  })

  assert.equal(
    candidates.some((candidate) => candidate.source === 'py-launcher'),
    false,
  )
  assert.equal(fs.existsSync(marker), false, 'py.exe 不应被同步拉起')
})

test('py -3 反解出的绝对路径优先于裸 py', POSIX_ONLY, () => {
  const root = tempDir('trellis-python-py-')
  const target = writeExecutable(path.join(root, 'real', 'python.exe'), '#!/bin/sh\n')
  const systemRoot = path.join(root, 'Windows')
  writeExecutable(path.join(systemRoot, 'py.exe'), `#!/bin/sh\necho "${target}"\n`)

  const candidates = resolvePythonCandidates({
    env: { PATH: path.join(root, 'empty'), SystemRoot: systemRoot },
    platform: 'win32',
  })

  const launcher = candidates.find((candidate) => candidate.source === 'py-launcher')
  assert.equal(launcher.command, target)
  assert.deepEqual(launcher.prefixArgs, [])
})

test('py 反解失败时保留 py -3 直接执行', POSIX_ONLY, () => {
  const root = tempDir('trellis-python-py-fail-')
  const systemRoot = path.join(root, 'Windows')
  writeExecutable(path.join(systemRoot, 'py.exe'), '#!/bin/sh\nexit 1\n')

  const candidates = resolvePythonCandidates({
    env: { PATH: path.join(root, 'empty'), SystemRoot: systemRoot },
    platform: 'win32',
  })

  const launcher = candidates.find((candidate) => candidate.source === 'py-launcher')
  assert.equal(launcher.command, path.join(systemRoot, 'py.exe'))
  assert.deepEqual(launcher.prefixArgs, ['-3'])
})

test(
  'resolvePython 返回第一个候选，pythonCommandCandidates 保持可用',
  { skip: !hasPython3() },
  () => {
    const explicit = realPython3()
    const env = { PATH: process.env.PATH, TRELLIS_PYTHON: explicit }
    assert.equal(resolvePython({ env }).command, explicit)
    assert.equal(pythonCommandCandidates(env)[0], explicit)
  },
)

test(
  'PATH 首位是不可执行的 python 时回退到可用的 python3',
  { skip: !hasPython3() || process.platform === 'win32' },
  async () => {
    const root = tempDir('trellis-python-fallback-')
    const blocked = path.join(root, 'blocked')
    const usable = path.join(root, 'usable')
    const plain = writePlainFile(path.join(blocked, 'python'), '#!/bin/sh\n')
    fs.chmodSync(plain, 0o644)
    fs.mkdirSync(usable, { recursive: true })
    fs.symlinkSync(realPython3(), path.join(usable, 'python3'))

    const script = path.join(root, 'probe.py')
    fs.writeFileSync(script, 'print("ran")\n')
    const result = await runPythonScript(script, [], {
      cwd: root,
      env: { PATH: `${blocked}:${usable}` },
      platform: 'linux',
    })

    assert.equal(result.stdout.trim(), 'ran')
  },
)

test(
  'TRELLIS_PYTHON 指向不可执行文件时继续下一个候选',
  { skip: !hasPython3() || process.platform === 'win32' },
  async () => {
    const root = tempDir('trellis-python-eacces-')
    const blocked = writePlainFile(path.join(root, 'python'), '#!/bin/sh\n')
    fs.chmodSync(blocked, 0o644)
    const script = path.join(root, 'probe.py')
    fs.writeFileSync(script, 'print("ran")\n')

    const result = await runPythonScript(script, [], {
      cwd: root,
      env: { PATH: process.env.PATH, TRELLIS_PYTHON: blocked },
      platform: 'linux',
    })

    assert.equal(result.stdout.trim(), 'ran')
  },
)

test('全部候选不可启动时抛出 code=1011 的可操作错误', async () => {
  const root = tempDir('trellis-python-unavailable-')
  const script = path.join(root, 'task.py')
  fs.writeFileSync(script, 'print("never")\n')

  const error = await runPythonScript(script, [], {
    cwd: root,
    env: {
      PATH: path.join(root, 'empty'),
      SystemRoot: '',
      TRELLIS_PYTHON: '',
    },
    platform: 'linux',
  }).then(
    () => null,
    (thrown) => thrown,
  )

  assert.ok(error instanceof PythonUnavailableError)
  assert.equal(error.name, 'PythonUnavailableError')
  assert.equal(error.code, PYTHON_UNAVAILABLE)
  assert.equal(PYTHON_UNAVAILABLE, 1011)
  assert.match(error.message.split('\n')[0], /^未找到可执行的 Python/)
  assert.deepEqual(
    error.attempts.map((attempt) => attempt.label),
    ['python3', 'python'],
  )
  assert.deepEqual(
    error.attempts.map((attempt) => attempt.code),
    ['ENOENT', 'ENOENT'],
  )
  for (const attempt of error.attempts) {
    assert.ok(!attempt.label.includes(path.sep), `候选名不应带路径: ${attempt.label}`)
  }
})

test(
  '脚本退出码非 0 时不换候选重试',
  { skip: !hasPython3() || process.platform === 'win32' },
  async () => {
    const root = tempDir('trellis-python-exit-code-')
    const marker = path.join(root, 'marker.txt')
    const failing = writeExecutable(
      path.join(root, 'failing-python'),
      `#!/bin/sh\necho ran >> "${marker}"\nexit 3\n`,
    )
    const script = path.join(root, 'task.py')
    fs.writeFileSync(script, 'print("never")\n')

    await assert.rejects(
      () =>
        runPythonScript(script, [], {
          cwd: root,
          // PATH 里另有可用的 python3：若发生重试就会成功，用例因此能证明没有重试。
          env: { PATH: process.env.PATH, TRELLIS_PYTHON: failing },
          platform: 'linux',
        }),
      /退出码 3/,
    )
    assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').length, 1)
  },
)

test('tryPythonCandidates 对 EFTYPE 等 spawn 失败继续，遇到业务错误立即停止', async () => {
  const root = tempDir('trellis-python-runner-')
  const blocked = writePlainFile(path.join(root, 'python'), '#!/bin/sh\n')
  fs.chmodSync(blocked, 0o644)
  const env = { PATH: path.join(root, 'empty'), TRELLIS_PYTHON: blocked }

  const calls = []
  const first = await tryPythonCandidates(
    (candidate) => {
      calls.push(candidate.command)
      if (calls.length === 1) {
        const error = new Error('spawn EACCES')
        error.code = 'EFTYPE'
        return Promise.reject(error)
      }
      return Promise.resolve('ok')
    },
    { env, platform: 'linux' },
  )
  assert.equal(first.result, 'ok')
  assert.equal(calls.length, 2)

  const businessError = new Error('task.py 退出码 3')
  calls.length = 0
  await assert.rejects(
    () =>
      tryPythonCandidates(
        (candidate) => {
          calls.push(candidate.command)
          return Promise.reject(businessError)
        },
        { env, platform: 'linux' },
      ),
    (error) => error === businessError,
  )
  assert.equal(calls.length, 1, '业务错误不换候选')
})
