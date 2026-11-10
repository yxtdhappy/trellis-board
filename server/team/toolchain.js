import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ERROR_CODES, teamError } from './errors.js'
import { minimalEnvironment, runProcess } from './process.js'

const DEVELOPER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function regularFileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

export function computeScriptTreeHash(repoPath) {
  const scriptsDir = path.resolve(repoPath, '.trellis', 'scripts')
  if (!fs.existsSync(scriptsDir) || !fs.statSync(scriptsDir).isDirectory()) {
    throw teamError(409, ERROR_CODES.TOOLCHAIN_MISMATCH, '项目缺少 .trellis/scripts 工具链')
  }
  const scriptsRoot = fs.realpathSync(scriptsDir)
  const records = []

  function walk(current) {
    const currentReal = fs.realpathSync(current)
    if (currentReal !== scriptsRoot && !isInside(scriptsRoot, currentReal)) {
      throw teamError(409, ERROR_CODES.TOOLCHAIN_MISMATCH, 'scripts 目录包含越界真实路径')
    }
    const entries = fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      const stat = fs.lstatSync(fullPath)
      if (stat.isSymbolicLink()) {
        throw teamError(409, ERROR_CODES.TOOLCHAIN_MISMATCH, 'scripts 目录不允许符号链接或重解析点')
      }
      if (entry.isDirectory()) {
        if (entry.name === '__pycache__') {
          throw teamError(409, ERROR_CODES.TOOLCHAIN_MISMATCH, 'scripts 目录不允许 __pycache__')
        }
        walk(fullPath)
        continue
      }
      if (!entry.isFile()) {
        throw teamError(409, ERROR_CODES.TOOLCHAIN_MISMATCH, 'scripts 目录只允许普通文件')
      }
      if (/\.(?:pyc|pyo)$/i.test(entry.name)) {
        throw teamError(409, ERROR_CODES.TOOLCHAIN_MISMATCH, 'scripts 目录不允许 Python 字节码')
      }
      const realFile = fs.realpathSync(fullPath)
      if (!isInside(scriptsRoot, realFile)) {
        throw teamError(409, ERROR_CODES.TOOLCHAIN_MISMATCH, 'scripts 文件真实路径越界')
      }
      const relativePath = path.relative(scriptsRoot, realFile).replaceAll('\\', '/')
      records.push(`${relativePath}\0${stat.size}\0${regularFileHash(realFile)}\n`)
    }
  }

  walk(scriptsRoot)
  records.sort()
  const digest = crypto.createHash('sha256')
  records.forEach((record) => digest.update(record))
  return {
    sha256: digest.digest('hex'),
    files: records.length,
  }
}

export async function precheckLifecycleHooks(repoPath) {
  const scriptsDir = path.resolve(repoPath, '.trellis', 'scripts')
  const parserFile = path.join(scriptsDir, 'common', 'trellis_config.py')
  if (!fs.existsSync(parserFile)) {
    throw teamError(
      409,
      ERROR_CODES.TOOLCHAIN_MISMATCH,
      '项目缺少同一配置解析器 common/trellis_config.py',
    )
  }
  const code = [
    'import importlib.util,json,pathlib,sys',
    "spec=importlib.util.spec_from_file_location('trellis_config_check',sys.argv[2])",
    'module=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'config=module.read_trellis_config(pathlib.Path(sys.argv[1]))',
    "hooks=config.get('hooks')",
    "print(json.dumps({'hasHooks':hooks not in (None,{},[])},sort_keys=True))",
  ].join(';')
  const result = await runProcess('python', ['-I', '-B', '-c', code, repoPath, parserFile], {
    cwd: repoPath,
    env: minimalEnvironment({ PYTHONUTF8: '1' }),
    timeoutMs: 60_000,
  })
  let parsed
  try {
    parsed = JSON.parse(result.stdout.trim())
  } catch {
    throw teamError(409, ERROR_CODES.TOOLCHAIN_MISMATCH, '无法解析 lifecycle hooks 预检结果')
  }
  if (parsed.hasHooks) {
    throw teamError(
      409,
      ERROR_CODES.HOOKS_PRESENT,
      '项目配置包含 lifecycle hooks，团队服务拒绝执行仓库脚本',
    )
  }
  return { safe: true }
}

export function validateDeveloperId(value) {
  const developerId = String(value || '').trim()
  if (!DEVELOPER_ID_PATTERN.test(developerId) || developerId === '.' || developerId === '..') {
    throw teamError(
      400,
      ERROR_CODES.INVALID_INPUT,
      'Trellis developer ID 必须是 1 到 64 位字母、数字、点、下划线或中划线',
    )
  }
  return developerId
}

export function resolveDeveloperWorkspace(repoPath, rawDeveloperId) {
  const developerId = validateDeveloperId(rawDeveloperId)
  const workspaceRoot = path.resolve(repoPath, '.trellis', 'workspace')
  if (!fs.existsSync(workspaceRoot) || !fs.statSync(workspaceRoot).isDirectory()) {
    throw teamError(409, ERROR_CODES.PROJECT_NOT_READY, '项目缺少 workspace 目录')
  }
  const rootReal = fs.realpathSync(workspaceRoot)
  const expected = path.join(workspaceRoot, developerId)
  if (!fs.existsSync(expected)) {
    throw teamError(
      400,
      ERROR_CODES.INVALID_INPUT,
      `负责人 ${developerId} 尚未初始化 Trellis workspace`,
    )
  }
  const stat = fs.lstatSync(expected)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '负责人 workspace 必须是真实目录')
  }
  const real = fs.realpathSync(expected)
  if (path.dirname(real) !== rootReal || !isInside(rootReal, real)) {
    throw teamError(
      400,
      ERROR_CODES.INVALID_INPUT,
      '负责人 workspace 必须是 .trellis/workspace 的直接子目录',
    )
  }
  return {
    developerId: path.basename(real),
    path: real,
  }
}
