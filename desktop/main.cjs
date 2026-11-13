const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

function appIndex() {
  if (app.isPackaged) return path.join(process.resourcesPath, "app", "index.html");
  return path.join(__dirname, "..", "dist", "index.html");
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 860,
    minWidth: 390,
    minHeight: 700,
    title: "Print Shop Separator",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(appIndex());
}

ipcMain.handle("save-zip", async (_event, payload) => {
  const name = payload?.name || "print-files.zip";
  const result = await dialog.showSaveDialog({
    defaultPath: name,
    filters: [{ name: "ZIP", extensions: ["zip"] }],
  });
  if (result.canceled || !result.filePath) return false;
  const data = Buffer.from(payload.data);
  fs.writeFileSync(result.filePath, data);
  return true;
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
