const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("admissionDesktop", {
  openSettings: () => ipcRenderer.send("settings:open")
});
