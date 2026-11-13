const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopPrintShop", {
  quality: "full",
  tile: 256,
  longEdge: 4096,
  saveZip(bytes, name) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return ipcRenderer.invoke("save-zip", { name, data });
  },
});
