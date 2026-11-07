// Bridge between the viewer page and the desktop app (see main.js).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  initialFolder: () => ipcRenderer.invoke("initial-folder"),
  conversionBegin: () => ipcRenderer.invoke("conversion-begin"),
  conversionWrite: (name, data) => ipcRenderer.invoke("conversion-write", name, data),
  conversionFinish: () => ipcRenderer.invoke("conversion-finish"),
  conversionCancel: () => ipcRenderer.invoke("conversion-cancel"),
  mobileExport: (parts) => ipcRenderer.invoke("mobile-export", parts),
  objBegin: (name) => ipcRenderer.invoke("obj-begin", name),
  objWrite: (text) => ipcRenderer.invoke("obj-write", text),
  objFinish: () => ipcRenderer.invoke("obj-finish"),
  objCancel: () => ipcRenderer.invoke("obj-cancel"),
});
