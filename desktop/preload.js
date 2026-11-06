// Bridge between the viewer page and the desktop app (see main.js).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  initialFolder: () => ipcRenderer.invoke("initial-folder"),
});
