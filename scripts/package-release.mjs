import { cpSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

const outDir = join(repoRoot, 'out')
if (!existsSync(join(outDir, 'main', 'index.js')) || !existsSync(join(outDir, 'renderer', 'index.html'))) {
  console.error('缺少生产构建，请先运行: npm run build')
  process.exit(1)
}

const electronDist = join(repoRoot, 'node_modules', 'electron', 'dist')
if (!existsSync(join(electronDist, 'electron.exe'))) {
  console.error('未找到 Electron 运行时: node_modules/electron/dist')
  process.exit(1)
}

const appName = 'Huarnessy'
const releaseRoot = join(repoRoot, 'release')
const target = join(releaseRoot, `${appName}-v${pkg.version}-win-x64`)

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

cpSync(electronDist, target, {
  recursive: true,
  filter: (src) => !src.endsWith('default_app.asar')
})
renameSync(join(target, 'electron.exe'), join(target, `${appName}.exe`))

const appDir = join(target, 'resources', 'app')
mkdirSync(appDir, { recursive: true })
writeFileSync(
  join(appDir, 'package.json'),
  JSON.stringify({ name: 'huarnessy', productName: appName, version: pkg.version, main: 'out/main/index.js' }, null, 2)
)
cpSync(outDir, join(appDir, 'out'), { recursive: true })

writeFileSync(join(target, 'README.txt'), [
  `${appName} v${pkg.version}（Windows x64 便携版）`,
  '',
  '运行方式：双击 Huarnessy.exe。',
  '',
  '前置条件：需要本机已安装 opencode 内核（PATH 中可用 opencode 命令），',
  '或存在 %APPDATA%\\Clonely\\bin\\opencode.exe，或设置 OPENCODE_BIN 指向内核可执行文件。',
  '未安装时应用会显示“未找到 opencode 内核”及安装指引。',
  '',
  `打包时间: ${new Date().toISOString()}`,
  ''
].join('\r\n'))

console.log(`发行版已生成: ${target}`)
