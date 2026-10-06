import { contextBridge, ipcRenderer } from 'electron'
import type { ServerInfo } from '../main/opencode-server'

const api = {
  getServerInfo: (): Promise<ServerInfo> => ipcRenderer.invoke('server:get'),
  restartServer: (): Promise<ServerInfo> => ipcRenderer.invoke('server:restart'),
  onServerStatus: (cb: (info: ServerInfo) => void): (() => void) => {
    const listener = (_e: unknown, info: ServerInfo): void => cb(info)
    ipcRenderer.on('server:status', listener)
    return () => ipcRenderer.removeListener('server:status', listener)
  },
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    maximize: (): Promise<void> => ipcRenderer.invoke('window:maximize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close')
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
