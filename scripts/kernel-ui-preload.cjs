const { ipcRenderer } = require('electron')
window.api = {
  getWorkspacePath: () => ipcRenderer.invoke('test:workspace'),
  chooseWorkspacePath: () => ipcRenderer.invoke('test:choose-workspace'),
  getServerInfo: () => ipcRenderer.invoke('test:server'),
  getServerConnection: () => ipcRenderer.invoke('test:connection'),
  restartServer: () => ipcRenderer.invoke('test:restart'),
  chooseKernel: () => ipcRenderer.invoke('test:choose-kernel'),
  resetKernel: () => ipcRenderer.invoke('test:reset-kernel'),
  onServerStatus: callback => { const listener = (_, value) => callback(value); ipcRenderer.on('test:status', listener); return () => ipcRenderer.removeListener('test:status', listener) },
  window: { getState: async () => ({ maximized: false, fullScreen: false }), onState: () => () => {}, minimize() {}, maximize() {}, close() {} }
}
window.testClipboard = ''
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.testClipboard = text } } })
