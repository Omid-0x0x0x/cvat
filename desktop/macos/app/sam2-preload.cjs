"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sam2", {
  context: () => ipcRenderer.invoke("sam2:context"),
  status: () => ipcRenderer.invoke("sam2:status"),
  install: (model) => ipcRenderer.invoke("sam2:install", { model }),
  listObjects: (job, frame) => ipcRenderer.invoke("sam2:list", { job, frame }),
  track: (params) => ipcRenderer.invoke("sam2:track", params),
  cancel: () => ipcRenderer.invoke("sam2:cancel"),
  reloadMain: () => ipcRenderer.invoke("sam2:reload-main"),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("sam2:event", listener);
    return () => ipcRenderer.removeListener("sam2:event", listener);
  },
});
