// Guards the monorepo boundary rules: runtime packages must reference shared code
// through explicit repo-relative paths, never workspace names or pre-move paths.
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const scanRoots = ['apps/server', 'plugins', 'scripts', 'packages/test-support']
const extensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx'])
const skipDirs = new Set(['node_modules', 'public', 'target'])

const forbidden = [
  {
    pattern: /from\s+['"]@trellis-board\//,
    reason: 'workspace 包名不能在运行时解析（零安装部署）',
  },
  {
    pattern: /from\s+['"]shared\//,
    reason: 'shared 不是顶层目录，使用 packages/shared 的相对路径',
  },
  { pattern: /from\s+['"]\.\.\/(?:\.\.\/)*server\//, reason: '旧 server/ 路径，改用 apps/server' },
  {
    pattern: /from\s+['"]\.\.\/(?:\.\.\/)*shared\//,
    reason: '旧 shared/ 路径，改用 packages/shared',
  },
  {
    pattern: /from\s+['"]\.\.\/(?:\.\.\/)*tests\//,
    reason: '旧 tests/ 路径，改用 packages/test-support',
  },
  { pattern: /from\s+['"]\.\.\/(?:\.\.\/)*agent\//, reason: '旧 agent/ 路径，已删除' },
  {
    pattern: /import\s*\(\s*['"]@trellis-board\//,
    reason: 'workspace 包名不能在运行时解析（零安装部署）',
  },
]

const violations = []

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(abs)
      continue
    }
    if (!extensions.has(path.extname(entry.name))) continue
    const rel = path.relative(root, abs).split(path.sep).join('/')
    const lines = fs.readFileSync(abs, 'utf8').split('\n')
    lines.forEach((line, index) => {
      for (const rule of forbidden) {
        if (rule.pattern.test(line)) {
          violations.push(`${rel}:${index + 1} ${rule.reason}\n    ${line.trim()}`)
        }
      }
    })
  }
}

for (const dir of scanRoots) {
  const abs = path.join(root, dir)
  if (fs.existsSync(abs)) walk(abs)
}

if (violations.length) {
  console.error(`边界检查失败：${violations.length} 处违规`)
  for (const violation of violations) console.error('  ' + violation)
  process.exit(1)
}

console.log(`边界检查通过（${scanRoots.join(', ')}）`)
