import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { transformWithEsbuild } from 'vite'

async function importTypeScript(file) {
  const { code } = await transformWithEsbuild(await readFile(new URL(file, import.meta.url), 'utf8'), file, { loader: 'ts', format: 'esm' })
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
}
const { loadWorkspace, saveWorkspace } = await importTypeScript('../src/main/workspace.ts')
const { sameWorkspace } = await importTypeScript('../src/renderer/src/workspace-path.ts')
const tempBase = resolve(tmpdir())
const fixture = await mkdtemp(join(tempBase, 'opencodehui-workspace-'))
const a = join(fixture, '项目 A'), b = join(fixture, '项目 B'), userData = join(fixture, 'settings')
await Promise.all([mkdir(a), mkdir(b)])
after(async () => {
  assert.equal(dirname(fixture), tempBase)
  assert.ok(basename(fixture).startsWith('opencodehui-workspace-'))
  await rm(fixture, { recursive: true, force: true })
})

test('工作空间设置持久化、路径验证和启动回退', async () => {
  assert.equal(await loadWorkspace(userData, a), await realpath(a))
  assert.equal(await saveWorkspace(userData, b), await realpath(b))
  assert.equal(await loadWorkspace(userData, a), await realpath(b))
  const file = join(userData, 'workspace.json')
  const saved = await readFile(file, 'utf8')
  await assert.rejects(saveWorkspace(userData, file), /工作空间必须是文件夹/)
  assert.equal(await readFile(file, 'utf8'), saved)
  await writeFile(file, JSON.stringify({ directory: join(fixture, 'missing') }))
  assert.equal(await loadWorkspace(userData, a), await realpath(a))
  await writeFile(file, '{broken')
  assert.equal(await loadWorkspace(userData, a), await realpath(a))
  await writeFile(file, JSON.stringify({ directory: '' }))
  assert.equal(await loadWorkspace(userData, a), await realpath(a))
})

test('精确目录隔离、Windows 大小写与斜杠兼容', () => {
  assert.ok(sameWorkspace('E:\\工作空间\\项目 A\\', 'e:/工作空间/项目 A'))
  assert.ok(sameWorkspace('\\\\Server\\Share\\Project', '//server/share/project/'))
  assert.ok(sameWorkspace('C:\\', 'c:/'))
  assert.equal(sameWorkspace('E:/Project', 'E:/Project/subfolder'), false)
  assert.equal(sameWorkspace('E:/Project', 'E:/Project-other'), false)
  assert.equal(sameWorkspace('/home/Project', '/home/project'), false)
  assert.equal(sameWorkspace(undefined, 'E:/Project'), false)
})
