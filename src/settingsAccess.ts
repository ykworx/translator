type SettingsCommand = "open_settings" | "open_dictation_settings";
const opening = new Map<SettingsCommand, Promise<void>>();

export async function openSettingsFrom(button: HTMLButtonElement, status: HTMLElement, command: SettingsCommand = "open_settings"): Promise<void> {
  button.disabled = true;
  status.textContent = "";
  let pending = opening.get(command);
  if (!pending) {
    pending = window.__TAURI__.core.invoke<void>(command).finally(() => { opening.delete(command); });
    opening.set(command, pending);
  }
  try {
    await pending;
  } catch {
    status.textContent = "설정 창을 열지 못했습니다. 다시 눌러주세요.";
  } finally {
    button.disabled = false;
  }
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
