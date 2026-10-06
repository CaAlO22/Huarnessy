import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

async function existingDirectory(directory: string): Promise<string> {
  const absolute = await realpath(resolve(directory))
  if (!(await stat(absolute)).isDirectory()) throw new Error('工作空间必须是文件夹')
  return absolute
}

export async function loadWorkspace(userData: string, fallback: string): Promise<string> {
  try {
    const saved = JSON.parse(await readFile(join(userData, 'workspace.json'), 'utf8'))
    if (typeof saved.directory === 'string' && saved.directory) return await existingDirectory(saved.directory)
  } catch {
    // A deleted folder or invalid preference must not block startup.
  }
  return existingDirectory(fallback)
}

export async function saveWorkspace(userData: string, directory: string): Promise<string> {
  const absolute = await existingDirectory(directory)
  await mkdir(userData, { recursive: true })
  await writeFile(join(userData, 'workspace.json'), JSON.stringify({ directory: absolute }, null, 2), 'utf8')
  return absolute
}
