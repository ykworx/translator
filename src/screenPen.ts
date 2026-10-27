import { getErrorMessage } from "./utils";

export function initScreenPen(): () => void {
  const button = document.getElementById("btn-screen-pen") as HTMLButtonElement;
  const status = document.getElementById("screen-pen-status")!;
  let disposed = false;
  const open = async () => {
    if (button.disabled || disposed) return;
    button.disabled = true;
    status.textContent = "";
    try { await window.__TAURI__.core.invoke("open_screen_pen"); }
    catch (error) { if (!disposed) status.textContent = getErrorMessage(error); }
    finally { if (!disposed) button.disabled = false; }
  };
  button.addEventListener("click", open);
  return () => { disposed = true; button.removeEventListener("click", open); };
}
