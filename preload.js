/**
 * 预加载脚本 —— 在渲染进程（界面）里开一扇小门，只放行必要的几个操作。
 * 界面本身拿不到 Node 和文件系统，安全。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  appInfo: () => ipcRenderer.invoke('app:info'),
  appPaths: () => ipcRenderer.invoke('app:paths'),
  saveReport: (data) => ipcRenderer.invoke('report:save', data),
});
