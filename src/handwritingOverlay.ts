// ─── Handwriting Overlay (fullscreen) ───────────────
import type { HandwritingMode } from "./prompts";
import { recognizeHandwriting, type HandwritingResult } from "./api";
import { getErrorMessage } from "./utils";

const { emit } = window.__TAURI__.event;

const canvas = document.getElementById("hw-overlay-canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const statusEl = document.getElementById("hw-overlay-status") as HTMLDivElement;
const resultEl = document.getElementById("hw-overlay-result") as HTMLDivElement;
const srLiveEl = document.getElementById("hw-overlay-sr-live") as HTMLDivElement;
const hintEl = document.getElementById("hw-overlay-hint") as HTMLDivElement;
const clearBtn = document.getElementById("ov-clear-btn") as HTMLButtonElement;
const modeBtns = document.querySelectorAll<HTMLButtonElement>(".ov-mode-btn[data-mode]");

let isDrawing = false;
let hasStrokes = false;
let currentMode: HandwritingMode = "kanji";
let isRecognizing = false;
let recognitionRequestId = 0;
let autoTimer: number | null = null;
let lastResult: HandwritingResult | null = null;
const AUTO_DELAY = 1500;

function resizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 5;
  ctx.strokeStyle = "#d8e8ff";
}

resizeCanvas();
window.addEventListener("resize", () => {
  resizeCanvas();
  clearCanvas(false);
});

// Mode tabs
modeBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    modeBtns.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentMode = (btn.dataset.mode as HandwritingMode) || "kanji";
  });
});

clearBtn.addEventListener("click", () => clearCanvas(true));
document.getElementById("ov-close-btn")?.addEventListener("click", closeOverlay);

// ─── Drawing ─────────────────────────────────────────
function getPos(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

canvas.addEventListener("pointerdown", (e: PointerEvent) => {
  invalidateRecognition();
  isDrawing = true;
  hasStrokes = true;
  clearAutoTimer();
  ctx.beginPath();
  const pos = getPos(e);
  ctx.moveTo(pos.x, pos.y);
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", (e: PointerEvent) => {
  if (!isDrawing) return;
  const pos = getPos(e);
  ctx.lineTo(pos.x, pos.y);
  ctx.stroke();
});

canvas.addEventListener("pointerup", (_e: PointerEvent) => {
  if (!isDrawing) return;
  isDrawing = false;
  scheduleAutoRecognize();
});

canvas.addEventListener("pointerleave", (_e: PointerEvent) => {
  if (!isDrawing) return;
  isDrawing = false;
  scheduleAutoRecognize();
});

// ─── Keyboard ────────────────────────────────────────
window.addEventListener("keydown", async (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    e.preventDefault();
    await closeOverlay();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    await recognizeAndClose();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "Backspace") {
    e.preventDefault();
    clearCanvas(true);
    return;
  }
});

// ─── Helpers ─────────────────────────────────────────
function clearAutoTimer(): void {
  if (autoTimer !== null) {
    window.clearTimeout(autoTimer);
    autoTimer = null;
  }
}

function invalidateRecognition(): void {
  recognitionRequestId += 1;
  isRecognizing = false;
  lastResult = null;
  resultEl.innerHTML = "";
  statusEl.textContent = "";
  srLiveEl.textContent = "";
  hintEl.style.display = "";
}

function clearCanvas(resetResult: boolean): void {
  invalidateRecognition();
  ctx.clearRect(0, 0, canvas.width / (window.devicePixelRatio || 1), canvas.height / (window.devicePixelRatio || 1));
  hasStrokes = false;
  clearAutoTimer();
  if (resetResult) {
    resultEl.innerHTML = "";
    statusEl.textContent = "";
  }
}

function scheduleAutoRecognize(): void {
  clearAutoTimer();
  autoTimer = window.setTimeout(() => {
    if (hasStrokes) runRecognize();
  }, AUTO_DELAY);
}

// ─── Canvas → base64 (resized to 1024px wide) ────────
function canvasToBase64(): string {
  const dpr = window.devicePixelRatio || 1;
  const srcW = canvas.width / dpr;
  const srcH = canvas.height / dpr;

  const TARGET_W = 1024;
  const scale = TARGET_W / srcW;
  const targetH = Math.round(srcH * scale);

  const offscreen = document.createElement("canvas");
  offscreen.width = TARGET_W;
  offscreen.height = targetH;
  const octx = offscreen.getContext("2d")!;
  octx.drawImage(canvas, 0, 0, srcW * dpr, srcH * dpr, 0, 0, TARGET_W, targetH);

  const dataUrl = offscreen.toDataURL("image/png");
  return dataUrl.replace(/^data:image\/png;base64,/, "");
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ─── Recognition ─────────────────────────────────────
async function runRecognize(): Promise<HandwritingResult | null> {
  if (!hasStrokes || isRecognizing) return null;
  clearAutoTimer();
  isRecognizing = true;
  const requestId = ++recognitionRequestId;

  hintEl.style.display = "none";
  statusEl.textContent = "인식 중…";
  resultEl.innerHTML = `<div class="ov-loading">인식 중…</div>`;

  try {
    const base64 = canvasToBase64();
    const result = await recognizeHandwriting(base64, currentMode);
    if (requestId !== recognitionRequestId) return null;
    lastResult = result;
    renderResult(result);
    statusEl.textContent = "";
    return result;
  } catch (e) {
    if (requestId !== recognitionRequestId) return null;
    resultEl.innerHTML = `<div class="ov-error">인식 실패: ${escapeHtml(getErrorMessage(e))}</div>`;
    statusEl.textContent = "";
    return null;
  } finally {
    if (requestId === recognitionRequestId) {
      isRecognizing = false;
    }
  }
}

async function recognizeAndClose(): Promise<void> {
  if (isRecognizing) return;

  let result = lastResult;
  if (!result) {
    result = await runRecognize();
    if (!result) return;
  }

  await emit("handwriting-overlay-result", { result });
  await closeOverlay();
}

async function closeOverlay(): Promise<void> {
  const { getCurrentWindow } = window.__TAURI__.window;
  const win = getCurrentWindow();
  await win.close();
}

// ─── Render result ────────────────────────────────────
function renderResult(r: HandwritingResult): void {
  hintEl.style.display = "none";
  srLiveEl.textContent = `${r.character}, ${r.meaning}`;

  const readings = [
    r.onyomi !== "—" ? `<div class="ov-reading"><span class="ov-reading-label">음독</span>${escapeHtml(r.onyomi)} <span class="ov-reading-kr">(${escapeHtml(r.onyomiKr)})</span></div>` : "",
    r.kunyomi !== "—" ? `<div class="ov-reading"><span class="ov-reading-label">훈독</span>${escapeHtml(r.kunyomi)} <span class="ov-reading-kr">(${escapeHtml(r.kunyomiKr)})</span></div>` : "",
  ].filter(Boolean).join("");

  const examples = r.examples
    .map(ex => `<span class="ov-example">${escapeHtml(ex)}</span>`)
    .join("");

  resultEl.innerHTML = `
    <div class="ov-result-card">
      <div class="ov-char-row">
        <span class="ov-char">${escapeHtml(r.character)}</span>
        <span class="ov-insert-hint">↵ 를 눌러 삽입</span>
      </div>
      ${readings ? `<div class="ov-readings">${readings}</div>` : ""}
      <div class="ov-meaning">${escapeHtml(r.meaning)}</div>
      ${examples ? `<div class="ov-examples">${examples}</div>` : ""}
      <div class="ov-card-hint">↵ 입력&nbsp;&nbsp;ESC 취소</div>
    </div>
  `;

  const card = resultEl.querySelector<HTMLElement>(".ov-result-card");
  card?.addEventListener("click", recognizeAndClose);
}
