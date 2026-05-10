import type { OverlayCaption } from "./types";

const { listen } = window.__TAURI__.event;

const list = document.getElementById("overlay-list") as HTMLDivElement;
let unlistenOverlayUpdate: (() => void) | null = null;

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function render(items: OverlayCaption[]): void {
  if (items.length === 0) {
    list.innerHTML = `<div class="overlay-empty">회의 자막을 기다리는 중…</div>`;
    return;
  }

  list.innerHTML = items.map(item => `
    <div class="overlay-item">
      <div class="overlay-original">${escapeHtml(item.original)}</div>
      <div class="overlay-translation">${escapeHtml(item.translated)}</div>
    </div>
  `).join("");
}

function parseOverlayItems(payload: unknown): OverlayCaption[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { items?: unknown }).items)) {
    return [];
  }

  return (payload as { items: unknown[] }).items.filter((item): item is OverlayCaption => {
    return !!item
      && typeof item === "object"
      && typeof (item as OverlayCaption).id === "string"
      && typeof (item as OverlayCaption).original === "string"
      && typeof (item as OverlayCaption).translated === "string";
  });
}

render([]);

console.log("[Overlay] listening for zoom-overlay-update");
listen("zoom-overlay-update", event => {
  console.log("[Overlay] received event:", JSON.stringify(event.payload));
  render(parseOverlayItems(event.payload));
}).then((unlisten) => {
  unlistenOverlayUpdate = unlisten;
}).catch((error) => {
  console.error("[Overlay] failed to attach listener:", error);
});

window.addEventListener("beforeunload", () => {
  unlistenOverlayUpdate?.();
  unlistenOverlayUpdate = null;
});
