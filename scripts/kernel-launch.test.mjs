import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { transformWithEsbuild } from 'vite'

async function importTypeScript(file) {
  const { code } = await transformWithEsbuild(await readFile(new URL(file, import.meta.url), 'utf8'), file, { loader: 'ts', format: 'esm' })
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
}
const { resolveOpencodeBin, commandOnPath, discoverKernels, startServer, stopServer, getServerConnection, redactLog } = await importTypeScript('../src/main/opencode-server.ts')
const { loadKernelPath, saveKernelPath } = await importTypeScript('../src/main/kernel-settings.ts')

const fixture = await mkdtemp(join(tmpdir(), 'huarnessy-kernel-'))
after(async () => {
  stopServer()
  assert.ok(basename(fixture).startsWith('huarnessy-kernel-'))
  await rm(fixture, { recursive: true, force: true })
})

test('手动内核路径持久化，失效路径仍被保留，恢复自动选择', async () => {
  const path = join(fixture, '中文 内核', 'missing.exe')
  await saveKernelPath(fixture, path)
  assert.equal(await loadKernelPath(fixture), path)
  assert.equal((await discoverKernels(path))[0].path, path)
  await saveKernelPath(fixture)
  assert.equal(await loadKernelPath(fixture), undefined)
})

test('显式选择不存在的内核立即失败，状态没有连接凭据', async () => {
  const updates = []
  const info = await startServer(s => updates.push(s), join(fixture, 'missing.exe'))
  assert.equal(info.errorKind, 'not-found')
  assert.equal(updates[0].phase, 'discovering')
  assert.ok(updates.every((s, i) => !i || s.sequence >= updates[i - 1].sequence))
  assert.equal(getServerConnection(), null)
})

test('诊断日志清理 ANSI 和敏感凭据', () => {
  const clean = redactLog('\u001b[31mAuthorization: Basic abc123\npassword=very-secret token: abc\nmy-secret', 'my-secret')
  assert.ok(!/abc123|very-secret|my-secret|\u001b/.test(clean))
})

test('真实子进程验证两版健康接口、鉴权、中文空格路径和退出分类', async () => {
  const dir = join(fixture, '中文 内核')
  await mkdir(dir, { recursive: true })
  const script = join(dir, 'fake.cjs')
  await writeFile(script, `
const http = require('node:http')
const version = process.env.HUI_TEST_VERSION || '1.18.34'
if (process.argv.includes('--version')) { console.log(version); process.exit(0) }
if (process.env.HUI_TEST_EXIT) { console.error('SQLiteError: test schema'); process.exit(7) }
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
http.createServer((req, res) => {
  const v2 = version.startsWith('2.')
  if (req.url !== (v2 ? '/api/info' : '/global/health')) { res.writeHead(404).end(); return }
  if (v2 && req.headers.authorization !== 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_PASSWORD).toString('base64')) { res.writeHead(401).end(); return }
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ version, healthy: true }))
}).listen(port, '127.0.0.1')
`)
  const bin = join(dir, process.platform === 'win32' ? 'opencode.cmd' : 'opencode')
  await writeFile(bin, process.platform === 'win32' ? `@"${process.execPath}" "%~dp0fake.cjs" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 })
  const saved = { version: process.env.HUI_TEST_VERSION, exit: process.env.HUI_TEST_EXIT }
  try {
    for (const version of ['1.18.34', '2.0.32']) {
      process.env.HUI_TEST_VERSION = version
      const info = await startServer(() => {}, bin)
      assert.equal(info.status, 'ready', JSON.stringify(info))
      assert.equal(info.version, version)
      const credentials = getServerConnection()
      assert.equal(credentials.protocol, version.startsWith('2') ? 'v2' : 'v1')
      assert.equal('headers' in info, false)
      if (version.startsWith('2')) assert.ok(credentials.headers.Authorization.startsWith('Basic '))
      stopServer()
    }
    process.env.HUI_TEST_EXIT = '1'
    const info = await startServer(() => {}, bin)
    assert.equal(info.errorKind, 'exited')
    assert.equal(info.exitCode, 7)
    assert.match(info.logs.join('\n'), /SQLiteError/)
  } finally {
    stopServer()
    for (const [key, value] of [['HUI_TEST_VERSION', saved.version], ['HUI_TEST_EXIT', saved.exit]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('commandOnPath 识别存在与不存在的命令', () => {
  assert.equal(commandOnPath(process.platform === 'win32' ? 'cmd' : 'sh'), true)
  assert.equal(commandOnPath('definitely-missing-opencode-xyz-42'), false)
})

test('resolveOpencodeBin 的 OPENCODE_BIN、托管内核与 PATH 回退', async () => {
  const saved = { bin: process.env.OPENCODE_BIN, appdata: process.env.APPDATA, path: process.env.PATH }
  try {
    const fake = join(fixture, 'opencode-fake.exe')
    await writeFile(fake, 'fake')
    process.env.OPENCODE_BIN = fake
    assert.equal(resolveOpencodeBin(), fake)

    // OPENCODE_BIN 指向不存在的文件时回退托管内核；托管与 PATH 都没有时返回 null，
    // 让上层给出“未找到 opencode 内核”而不是误导性的启动超时。
    process.env.OPENCODE_BIN = join(fixture, 'missing.exe')
    process.env.APPDATA = join(fixture, 'no-appdata')
    process.env.PATH = ''
    assert.equal(resolveOpencodeBin(), null)

    // 托管内核存在时优先于 PATH。
    const managed = join(fixture, 'appdata', 'Clonely', 'bin')
    await mkdir(managed, { recursive: true })
    await writeFile(join(managed, 'opencode.exe'), 'fake')
    process.env.APPDATA = join(fixture, 'appdata')
    assert.equal(resolveOpencodeBin(), join(managed, 'opencode.exe'))
  } finally {
    process.env.OPENCODE_BIN = saved.bin
    process.env.APPDATA = saved.appdata
    process.env.PATH = saved.path
  }
})
