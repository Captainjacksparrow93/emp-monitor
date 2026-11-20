const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  enroll: (serverUrl, code) => ipcRenderer.invoke('enroll', { serverUrl, code }),
  info: () => ipcRenderer.invoke('info'),
  close: () => ipcRenderer.invoke('close-window'),
  openPrivacySettings: (pane) => ipcRenderer.invoke('open-privacy', pane),
});
