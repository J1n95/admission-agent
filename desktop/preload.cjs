const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("admissionDesktop", {
  getConfiguration: () => ipcRenderer.invoke("settings:get"),
  testConfiguration: value => ipcRenderer.invoke("settings:test", value),
  testExperimentConfiguration: value => ipcRenderer.invoke("settings:test-experiment", value),
  saveConfiguration: value => ipcRenderer.invoke("settings:save", value),
  saveExperimentConfiguration: value => ipcRenderer.invoke("settings:save-experiment", value),
  runExperiment: () => ipcRenderer.invoke("experiment:run"),
  onExperimentProgress: callback => ipcRenderer.on("experiment:progress", (_event, value) => callback(value))
});
