const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cvatDesktop", {
  onStatus(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("cvat:status", listener);
    return () => ipcRenderer.removeListener("cvat:status", listener);
  },
});
