import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const outMain = join(repoRoot, 'out', 'main', 'index.js')
const outIndex = join(repoRoot, 'out', 'renderer', 'index.html')
if (!existsSync(outMain) || !existsSync(outIndex)) {
  console.error('缺少生产构建，请先运行: npm run build')
  process.exit(1)
}

const baseDir =
  process.env.LOCALAPPDATA ||
  process.env.XDG_DATA_HOME ||
  join(process.env.HOME || process.env.USERPROFILE || repoRoot, '.local', 'share')
const appDir = join(baseDir, 'Huarnessy', 'standalone')

rmSync(appDir, { recursive: true, force: true })
mkdirSync(appDir, { recursive: true })
cpSync(join(repoRoot, 'out'), join(appDir, 'out'), { recursive: true })
writeFileSync(
  join(appDir, 'package.json'),
  JSON.stringify({ name: 'huarnessy', version: '0.1.0', main: 'out/main/index.js' }, null, 2)
)

const electronPath = require('electron')
const child = spawn(electronPath, [appDir], {
  cwd: repoRoot,
  detached: true,
  stdio: 'ignore'
})
child.unref()

console.log('已从独立快照启动，源码改动不会影响该窗口。')
console.log(`快照目录: ${appDir}`)
console.log(`初始工作空间: ${repoRoot}`)
