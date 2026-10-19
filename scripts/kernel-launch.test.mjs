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
const { resolveOpencodeBin, commandOnPath } = await importTypeScript('../src/main/opencode-server.ts')

const fixture = await mkdtemp(join(tmpdir(), 'huarnessy-kernel-'))
after(async () => {
  assert.ok(basename(fixture).startsWith('huarnessy-kernel-'))
  await rm(fixture, { recursive: true, force: true })
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
