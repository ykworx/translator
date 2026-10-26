import { COPY_FEEDBACK_MS } from "./constants";

let sequence = 0;
let lifecycle = 0;
let queue: Promise<unknown> = Promise.resolve();
let toastTimer: number | undefined;
const timers = new Set<number>();
const labels = new WeakMap<HTMLButtonElement, string>();
const buttonTimers = new WeakMap<HTMLButtonElement, number>();
const buttonOperations = new WeakMap<HTMLButtonElement, number>();

function later(callback: () => void, delay: number): number {
  const timer = window.setTimeout(() => { timers.delete(timer); callback(); }, delay);
  timers.add(timer);
  return timer;
}

function showToast(success: boolean): void {
  let toast = document.getElementById("copy-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "copy-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);
  }
  toast.textContent = success ? "✓ 클립보드에 복사됨" : "복사하지 못했습니다. 다시 시도해주세요.";
  toast.dataset.kind = success ? "success" : "error";
  toast.classList.add("visible");
  if (toastTimer !== undefined) { window.clearTimeout(toastTimer); timers.delete(toastTimer); }
  toastTimer = later(() => toast?.classList.remove("visible"), success ? 1800 : 4000);
}

/** Serialize explicit copies so a slower first write cannot overwrite a later click. */
export async function copyWithFeedback(write: () => Promise<void>, button?: HTMLButtonElement, copiedLabel = "✓ 복사됨"): Promise<boolean> {
  if (button?.disabled) return false;
  const operation = ++sequence;
  const life = lifecycle;
  document.getElementById("copy-toast")?.classList.remove("visible");
  if (button) {
    if (!labels.has(button)) labels.set(button, button.textContent ?? "복사");
    const previousTimer = buttonTimers.get(button);
    if (previousTimer !== undefined) { window.clearTimeout(previousTimer); timers.delete(previousTimer); }
    buttonOperations.set(button, operation);
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.classList.remove("active");
    button.textContent = copiedLabel === "✓ 복사됨" ? "복사 중…" : `${labels.get(button)} · 복사 중…`;
  }
  const task = queue.then(async () => {
    if (lifecycle !== life) throw new Error("Copy view was disposed");
    await write();
  });
  queue = task.catch(() => {});
  let success = false;
  try { await task; success = true; } catch { /* user-facing failure below */ }
  if (lifecycle !== life) return success;
  if (operation === sequence) showToast(success);
  if (button?.isConnected && buttonOperations.get(button) === operation) {
    button.disabled = false;
    button.setAttribute("aria-busy", "false");
    button.textContent = success ? copiedLabel : copiedLabel === "✓ 복사됨"
      ? "복사 실패 · 재시도" : `${labels.get(button)} · 복사 실패 (다시 시도)`;
    button.classList.toggle("active", success);
    const timer = later(() => {
      if (buttonOperations.get(button) !== operation) return;
      button.textContent = labels.get(button) ?? "복사";
      button.classList.remove("active");
    }, COPY_FEEDBACK_MS);
    buttonTimers.set(button, timer);
  }
  return success;
}

export function disposeCopyFeedback(): void {
  lifecycle++;
  sequence++;
  for (const timer of timers) window.clearTimeout(timer);
  timers.clear();
  document.getElementById("copy-toast")?.classList.remove("visible");
}
