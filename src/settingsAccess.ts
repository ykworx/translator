let opening: Promise<void> | null = null;

export async function openSettingsFrom(button: HTMLButtonElement, status: HTMLElement): Promise<void> {
  if (opening) return opening;
  button.disabled = true;
  status.textContent = "";
  opening = window.__TAURI__.core.invoke("open_settings").then(() => {}, () => {
    status.textContent = "설정 창을 열지 못했습니다. 다시 눌러주세요.";
  }).finally(() => { button.disabled = false; opening = null; });
  return opening;
}

export function initSettingsAccess(onConnectionChanged?: () => void): void {
  const button = document.getElementById("btn-settings") as HTMLButtonElement | null;
  const status = document.getElementById("settings-access-status");
  button?.addEventListener("click", () => { if (status) void openSettingsFrom(button, status); });
  let disposed = false;
  let unlisten: (() => void) | undefined;
  if (onConnectionChanged) {
    window.__TAURI__.event.listen("connection-settings-changed", () => { if (!disposed) onConnectionChanged(); })
      .then(stop => { if (disposed) stop(); else unlisten = stop; })
      .catch(error => console.warn("Could not listen for connection changes:", error));
  }
  window.addEventListener("beforeunload", () => { disposed = true; unlisten?.(); }, { once: true });
}
