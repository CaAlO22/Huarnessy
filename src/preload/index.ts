import { contextBridge, ipcRenderer } from 'electron'
import type { ServerInfo } from '../main/opencode-server'

export interface WindowState {
  maximized: boolean
  fullScreen: boolean
}

const api = {
  getWorkspacePath: (): Promise<string> => ipcRenderer.invoke('workspace:get'),
  chooseWorkspacePath: (): Promise<string | null> => ipcRenderer.invoke('workspace:choose'),
  getServerInfo: (): Promise<ServerInfo> => ipcRenderer.invoke('server:get'),
  restartServer: (): Promise<ServerInfo> => ipcRenderer.invoke('server:restart'),
  onServerStatus: (cb: (info: ServerInfo) => void): (() => void) => {
    const listener = (_e: unknown, info: ServerInfo): void => cb(info)
    ipcRenderer.on('server:status', listener)
    return () => ipcRenderer.removeListener('server:status', listener)
  },
  window: {
    getState: (): Promise<WindowState> => ipcRenderer.invoke('window:state'),
    onState: (cb: (state: WindowState) => void): (() => void) => {
      const listener = (_e: unknown, state: WindowState): void => cb(state)
      ipcRenderer.on('window:state', listener)
      return () => ipcRenderer.removeListener('window:state', listener)
    },
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    maximize: (): Promise<void> => ipcRenderer.invoke('window:maximize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close')
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
