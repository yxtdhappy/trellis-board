// 发版：按 patch/minor/major 递增（或指定版本）写回根 package.json、所有 workspace 包、
// tauri.conf.json 与 Cargo 版本文件，提交、打 tag、推送；CI 按 tag 版本号构建绿色包并发布 Release。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const JSON_VERSION = /"version"\s*:\s*"[^"]+"/
const TAURI_CONF = 'packages/desktop/src-tauri/tauri.conf.json'
const VERSION_FILES = [
  { path: 'package.json', pattern: JSON_VERSION },
  ...['packages'].flatMap((dir) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${dir}/${entry.name}/package.json`)
      .filter((path) => fs.existsSync(path))
      .map((path) => ({ path, pattern: JSON_VERSION })),
  ),
  { path: TAURI_CONF, pattern: JSON_VERSION },
  { path: 'packages/desktop/src-tauri/Cargo.toml', pattern: /^version = "[^"]+"/m },
  {
    path: 'packages/desktop/src-tauri/Cargo.lock',
    pattern: /name = "trellis-board-client"\r?\nversion = "[^"]+"/,
  },
]
const KINDS = ['patch', 'minor', 'major']

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const target = args.find((arg) => !arg.startsWith('--'))
  const current = readVersion()
  const version = resolveVersion(target, current)
  const tag = `v${version}`

  if (git(['status', '--porcelain'])) throw new Error('工作区有未提交改动，先提交再发布')
  if (tagExists(tag)) throw new Error(`tag ${tag} 已存在`)

  try {
    git(['fetch', '--quiet', 'origin', 'main'])
  } catch (error) {
    throw new Error(`git fetch 失败：${stderrOf(error) || error.message}`)
  }

  const head = git(['rev-parse', 'HEAD'])
  const origin = git(['rev-parse', 'origin/main'])
  if (head !== origin) {
    throw new Error(
      `HEAD ${head.slice(0, 7)} 与 origin/main ${origin.slice(0, 7)} 不一致，先 push 或 pull`,
    )
  }

  if (dryRun) {
    console.log(`[dry-run] 版本 ${current} -> ${version}，写入 ${VERSION_FILES.length} 个文件`)
    console.log(`[dry-run] git commit -am "chore(release): ${version}"`)
    console.log(`[dry-run] git push origin main`)
    console.log(`[dry-run] git tag -a ${tag} -m "Trellis Board ${tag}"`)
    console.log(`[dry-run] git push origin ${tag}`)
    return
  }

  for (const update of staged(version)) fs.writeFileSync(update.path, update.text)
  git(['commit', '-am', `chore(release): ${version}`])
  git(['push', 'origin', 'main'])
  git(['tag', '-a', tag, '-m', `Trellis Board ${tag}`])
  git(['push', 'origin', tag])
  console.log(`已发布 ${tag}：CI 将构建 ${version} 并发布 Release`)
  console.log(`${remoteUrl()}/releases/tag/${tag}`)
}

function resolveVersion(target, current) {
  if (!target) return bump(current, 'patch')
  if (KINDS.includes(target)) return bump(current, target)
  if (!/^\d+\.\d+\.\d+$/.test(target)) {
    throw new Error(`参数必须是 patch|minor|major 或 x.y.z，收到 ${target}`)
  }
  if (compare(target, current) <= 0) {
    throw new Error(`版本号 ${target} 必须大于当前 ${current}`)
  }
  return target
}

function bump(current, kind) {
  const [major, minor, patch] = current.split('.').map(Number)
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

function compare(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

function readVersion() {
  const config = JSON.parse(fs.readFileSync(TAURI_CONF, 'utf8'))
  if (!/^\d+\.\d+\.\d+$/.test(config.version)) {
    throw new Error(`${TAURI_CONF} 的 version 不是 x.y.z：${config.version}`)
  }
  return config.version
}

function staged(version) {
  return VERSION_FILES.map((file) => {
    const text = fs.readFileSync(file.path, 'utf8')
    const text2 = text.replace(file.pattern, (match) => match.replace(/"[^"]*"$/, `"${version}"`))
    if (text2 === text && !text.includes(`"${version}"`)) {
      throw new Error(`${file.path} 里找不到版本号字段`)
    }
    return { path: file.path, text: text2 }
  })
}

function git(gitArgs) {
  return execFileSync('git', gitArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function tagExists(name) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${name}`], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

function remoteUrl() {
  const url = git(['remote', 'get-url', 'origin'])
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(url)
  return ssh ? `https://${ssh[1]}/${ssh[2]}` : url.replace(/\.git$/, '')
}

function stderrOf(error) {
  return error.stderr ? String(error.stderr).trim() : ''
}
