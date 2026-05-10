// ─── Handwriting Recognition Module ─────────────────
import type { HandwritingMode } from "./prompts";
import { recognizeHandwriting, type HandwritingResult } from "./api";
import { escapeHtml, getErrorMessage } from "./utils";

const { invoke } = window.__TAURI__.core;

let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let isDrawing = false;
let hasStrokes = false;
let autoRecognizeTimer: number | null = null;
const AUTO_RECOGNIZE_DELAY = 1500;
let currentMode: HandwritingMode = "kanji";
let isRecognizing = false;
let recognitionRequestId = 0;

// Panel elements
let panel: HTMLDivElement;
let resultArea: HTMLDivElement;
let isOpen = false;

export function initHandwriting(
  _chat: HTMLElement,
  btnHandwriting: HTMLButtonElement,
): void {
  panel = document.getElementById("handwriting-panel") as HTMLDivElement;
  canvas = document.getElementById("handwriting-canvas") as HTMLCanvasElement;
  resultArea = document.getElementById("handwriting-result") as HTMLDivElement;
  const btnRecognize = document.getElementById("hw-recognize") as HTMLButtonElement;
  const btnClear = document.getElementById("hw-clear") as HTMLButtonElement;
  const btnClose = document.getElementById("hw-close") as HTMLButtonElement;

  ctx = canvas.getContext("2d")!;

  btnHandwriting.addEventListener("click", (e: MouseEvent) => {
    if (e.shiftKey) {
      invoke("open_handwriting_overlay").catch((err) => {
        console.error("Failed to open handwriting overlay:", err);
      });
      return;
    }
    if (isOpen) {
      closePanel();
    } else {
      openPanel();
    }
  });

  btnClose.addEventListener("click", closePanel);
  btnClear.addEventListener("click", clearCanvas);
  btnRecognize.addEventListener("click", recognize);

  // Mode tabs
  panel.querySelectorAll<HTMLButtonElement>(".hw-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      panel.querySelectorAll(".hw-mode-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentMode = (btn.dataset.mode as HandwritingMode) || "kanji";
    });
  });

  // Drawing events
  canvas.addEventListener("pointerdown", startDraw);
  canvas.addEventListener("pointermove", draw);
  canvas.addEventListener("pointerup", endDraw);
  canvas.addEventListener("pointerleave", endDraw);

  // Result click → insert into input
  resultArea.addEventListener("click", (e) => {
    const insertBtn = (e.target as HTMLElement).closest(".hw-insert-btn");
    if (insertBtn) {
      const char = insertBtn.getAttribute("data-char") || "";
      if (char) {
        const input = document.getElementById("input-field") as HTMLTextAreaElement;
        input.value += char;
        input.focus();
        input.dispatchEvent(new Event("input"));
      }
    }
  });
}

function openPanel(): void {
  isOpen = true;
  panel.classList.remove("hidden");
  resizeCanvas();
  clearCanvas();
}

function closePanel(): void {
  invalidateRecognition();
  isOpen = false;
  panel.classList.add("hidden");
  clearAutoTimer();
}

function resizeCanvas(): void {
  const rect = canvas.parentElement!.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  ctx.scale(dpr, dpr);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  setupStrokeStyle();
}

function setupStrokeStyle(): void {
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  ctx.strokeStyle = isDark ? "#e8e8e8" : "#1a1a1a";
}

function startDraw(e: PointerEvent): void {
  invalidateRecognition();
  isDrawing = true;
  hasStrokes = true;
  clearAutoTimer();
  ctx.beginPath();
  const pos = getPos(e);
  ctx.moveTo(pos.x, pos.y);
  canvas.setPointerCapture(e.pointerId);
}

function draw(e: PointerEvent): void {
  if (!isDrawing) return;
  const pos = getPos(e);
  ctx.lineTo(pos.x, pos.y);
  ctx.stroke();
}

function endDraw(_e: PointerEvent): void {
  if (!isDrawing) return;
  isDrawing = false;
  scheduleAutoRecognize();
}

function getPos(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  };
}

function clearCanvas(): void {
  invalidateRecognition();
  const rect = canvas.parentElement!.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  hasStrokes = false;
  clearAutoTimer();
  resultArea.innerHTML = `<div class="hw-placeholder">글자를 그려주세요</div>`;
}

function clearAutoTimer(): void {
  if (autoRecognizeTimer !== null) {
    window.clearTimeout(autoRecognizeTimer);
    autoRecognizeTimer = null;
  }
}

function invalidateRecognition(): void {
  recognitionRequestId += 1;
  isRecognizing = false;
}

function scheduleAutoRecognize(): void {
  clearAutoTimer();
  autoRecognizeTimer = window.setTimeout(() => {
    if (hasStrokes) recognize();
  }, AUTO_RECOGNIZE_DELAY);
}

async function recognize(): Promise<void> {
  if (!hasStrokes || isRecognizing) return;
  clearAutoTimer();
  isRecognizing = true;
  const requestId = ++recognitionRequestId;

  resultArea.innerHTML = `<div class="hw-loading">인식 중…</div>`;

  try {
    const base64 = canvasToBase64();
    const result = await recognizeHandwriting(base64, currentMode);
    if (requestId !== recognitionRequestId) return;
    renderResult(result);
  } catch (e) {
    if (requestId !== recognitionRequestId) return;
    resultArea.innerHTML = `<div class="hw-error">인식 실패: ${escapeHtml(getErrorMessage(e))}</div>`;
  } finally {
    if (requestId === recognitionRequestId) {
      isRecognizing = false;
    }
  }
}

function canvasToBase64(): string {
  const dataUrl = canvas.toDataURL("image/png");
  return dataUrl.replace(/^data:image\/png;base64,/, "");
}

function renderResult(r: HandwritingResult): void {
  const examples = r.examples
    .map((ex) => `<span class="hw-example">${escapeHtml(ex)}</span>`)
    .join("");

  resultArea.innerHTML = `
    <div class="hw-result-card">
      <div class="hw-char-row">
        <span class="hw-char">${escapeHtml(r.character)}</span>
        <button class="hw-insert-btn" data-char="${escapeHtml(r.character)}" title="입력 필드에 삽입">+ 입력</button>
      </div>
      <div class="hw-readings">
        ${r.onyomi !== "—" ? `<div class="hw-reading"><span class="hw-label">음독</span> ${escapeHtml(r.onyomi)} <span class="hw-kr">(${escapeHtml(r.onyomiKr)})</span></div>` : ""}
        ${r.kunyomi !== "—" ? `<div class="hw-reading"><span class="hw-label">훈독</span> ${escapeHtml(r.kunyomi)} <span class="hw-kr">(${escapeHtml(r.kunyomiKr)})</span></div>` : ""}
      </div>
      <div class="hw-meaning">${escapeHtml(r.meaning)}</div>
      ${examples ? `<div class="hw-examples">${examples}</div>` : ""}
    </div>
  `;
}
