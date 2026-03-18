const { listen } = window.__TAURI__.event;

type OverlayCaption = {
  id: string;
  original: string;
  translated: string;
};

const list = document.getElementById("overlay-list") as HTMLDivElement;

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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

render([]);

console.log("[Overlay] listening for zoom-overlay-update");
listen("zoom-overlay-update", event => {
  console.log("[Overlay] received event:", JSON.stringify(event.payload));
  const payload = event.payload as { items?: OverlayCaption[] };
  render(payload.items || []);
});
