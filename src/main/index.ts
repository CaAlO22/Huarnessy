import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { startServer, stopServer, getServerInfo, type ServerInfo } from './opencode-server'
import { loadWorkspace, saveWorkspace } from './workspace'

let mainWindow: BrowserWindow | null = null
let workspace = process.cwd()

if (process.env.REMOTE_DEBUGGING_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.REMOTE_DEBUGGING_PORT)
}

function broadcast(info: ServerInfo): void {
  mainWindow?.webContents.send('server:status', info)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#07070c',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.on('console-message' as any, (...args: any[]) => {
    const second = args[1]
    const message =
      second && typeof second === 'object' && 'message' in second ? second.message : args[2]
    console.log('[renderer]', message)
  })

  mainWindow.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error('[renderer] did-fail-load', code, desc)
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  workspace = await loadWorkspace(app.getPath('userData'), process.cwd())
  ipcMain.handle('workspace:get', () => workspace)
  ipcMain.handle('workspace:choose', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '切换工作空间',
      defaultPath: workspace,
      buttonLabel: '选择工作空间',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    workspace = await saveWorkspace(app.getPath('userData'), result.filePaths[0])
    return workspace
  })
  ipcMain.handle('server:get', () => getServerInfo())
  ipcMain.handle('server:restart', async () => {
    stopServer()
    return startServer(broadcast)
  })
  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.handle('window:close', () => mainWindow?.close())

  createWindow()
  startServer(broadcast)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => stopServer())
