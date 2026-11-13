/** Native shells (Capacitor Android, Electron Windows) share the web app. */

export function upscaleProfile() {
  const desktop = typeof window !== "undefined" ? window.desktopPrintShop : null;
  const capacitor = typeof window !== "undefined" ? window.Capacitor : null;
  const native = !!(desktop || capacitor?.isNativePlatform?.());
  return {
    native,
    tile: desktop?.tile || (native ? 192 : 128),
    longEdge: desktop?.longEdge || (native ? 4096 : 3000),
  };
}

export async function captureNativePhoto() {
  const capacitor = window.Capacitor;
  if (!capacitor?.isNativePlatform?.()) return null;
  const { Camera, CameraResultType, CameraSource } = await import("@capacitor/camera");
  const photo = await Camera.getPhoto({
    quality: 92,
    allowEditing: false,
    resultType: CameraResultType.Uri,
    source: CameraSource.Prompt,
    promptLabelHeader: "Artwork photo",
    promptLabelPhoto: "Photo library",
    promptLabelPicture: "Camera",
  });
  const response = await fetch(photo.webPath);
  const blob = await response.blob();
  return new File([blob], "camera.jpg", { type: blob.type || "image/jpeg" });
}

function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Save or share a ZIP. Returns true when a native shell handled it. */
export async function deliverZip(bytes, name) {
  if (window.desktopPrintShop?.saveZip) {
    const saved = await window.desktopPrintShop.saveZip(bytes, name);
    return saved !== false;
  }
  if (window.Capacitor?.isNativePlatform?.()) {
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    const { Share } = await import("@capacitor/share");
    const written = await Filesystem.writeFile({
      path: name,
      data: bytesToBase64(bytes),
      directory: Directory.Cache,
    });
    await Share.share({
      title: name,
      dialogTitle: "Save the print package",
      files: [written.uri],
    });
    return true;
  }
  return false;
}
