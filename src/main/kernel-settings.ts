import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'

export async function loadKernelPath(userData: string): Promise<string | undefined> {
  try {
    const data = JSON.parse(await readFile(join(userData, 'kernel.json'), 'utf8'))
    // Keep missing files selected so the user sees why their explicit choice failed.
    return typeof data.path === 'string' && isAbsolute(data.path) ? data.path : undefined
  } catch { return undefined }
}
export async function saveKernelPath(userData: string, path?: string): Promise<void> {
  if (path && !isAbsolute(path)) throw new Error('内核路径必须是绝对路径')
  await mkdir(userData, { recursive: true })
  await writeFile(join(userData, 'kernel.json'), JSON.stringify({ path: path ?? null }, null, 2), 'utf8')
}
