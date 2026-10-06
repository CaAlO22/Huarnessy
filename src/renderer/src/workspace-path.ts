export function sameWorkspace(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false
  const key = (directory: string): string => {
    const path = directory.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
    return /^(?:[a-z]:|\/\/)/i.test(path) ? path.toLowerCase() : path
  }
  return key(left) === key(right)
}
