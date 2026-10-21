import { cpSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const targetRelative = relative(releaseRoot, target)
if (!targetRelative || targetRelative.startsWith('..') || isAbsolute(targetRelative)) {
  throw new Error('发行目录必须位于 release 目录内')
}

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
for (const directory of ['main', 'preload', 'renderer']) {
  cpSync(join(outDir, directory), join(appDir, 'out', directory), { recursive: true })
}
cpSync(join(repoRoot, 'RELEASE_NOTES.md'), join(target, 'RELEASE_NOTES.md'))

writeFileSync(join(target, 'README.txt'), [
  `${appName} v${pkg.version}（Windows x64 便携版）`,
  '',
  '运行方式：双击 Huarnessy.exe。',
  '',
  '前置条件：本机安装 OpenCode 1.x 或 2.x 内核（已验证 1.18.29 和 2.0.32）。',
  '默认从用户选择、OPENCODE_BIN、Clonely 托管目录及 PATH 依次查找。',
  '未加入 PATH 时，可设置 OPENCODE_BIN 指向内核可执行文件，或在界面中选择内核。',
  '启动期间会显示当前阶段；失败后可查看原因、重试、选择内核或恢复自动选择。',
  '点击标题栏的连接状态可查看内核路径、版本、请求状态和脱敏日志，并复制诊断报告。',
  '手动选择保存在应用设置中；不会自动安装、升级或降级内核。',
  '其他 2.x 版本会检查协议后尝试连接，不代表所有版本均已验证。',
  '',
  `打包时间: ${new Date().toISOString()}`,
  ''
].join('\r\n'))

console.log(`发行版已生成: ${target}`)
