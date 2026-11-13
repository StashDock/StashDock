import type { DragEvent } from "react";
import type { StashItem } from "../types";
import { buildContext } from "./context";
import { hasContextFile } from "./context-format.mjs";
import { isTauri } from "@tauri-apps/api/core";
import { dragReferenceFile } from "./reference-drag-native";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]!));

export function referenceDragPayload(items: StashItem[]) {
  const context = buildContext(items);
  return {
    "text/plain": context,
    "text/markdown": context,
    "text/html": `<pre style="white-space:pre-wrap">${escapeHtml(context)}</pre>`,
    "text/uri-list": items.some(item => item.kind === "note") ? "" : items.flatMap(item => item.url ? [item.url] : []).join("\r\n"),
  };
}

export function referenceFileName(title: string, count: number) {
  const cleaned = (count === 1 ? title : "Selected references")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "");
  const name = Array.from(cleaned).slice(0, 64).join("").replace(/[ .]+$/g, "") || "Reference";
  return `StashDock - ${name}.md`;
}

/** Chromium's public drag-out download format; not an Electron/private IPC API. */
export function referenceDownloadPayload(context: string, title: string, count: number) {
  return `text/markdown:${referenceFileName(title, count)}:data:text/markdown;charset=utf-8,${encodeURIComponent(context)}`;
}

let finishActiveDrag: (() => void) | undefined;
let nativeDragPending = false;

const selectionBar = (source: HTMLElement) => source.getAttribute('aria-label') === 'Selected references';

/** Paint this small bar synchronously from its existing layout and Arc tokens.
 * No DOM screenshot, fonts/images fetch, background cache or native overlay. */
function selectionBarPreview(source: HTMLElement) {
  const canvas = document.createElement('canvas');
  canvas.width = source.offsetWidth; canvas.height = source.offsetHeight;
  const painter = canvas.getContext('2d', { willReadFrequently: true });
  if (!painter || !canvas.width || !canvas.height) return null;
  const bounds = source.getBoundingClientRect();
  const style = getComputedStyle(source);
  painter.fillStyle = style.backgroundColor;
  painter.strokeStyle = style.borderColor;
  painter.beginPath();
  painter.roundRect(.5, .5, canvas.width - 1, canvas.height - 1, parseFloat(style.borderTopLeftRadius) || 26);
  painter.fill(); painter.stroke();
  const label = (node: HTMLElement, centered = false, rectangle?: DOMRect, value?: string) => {
    const rect = rectangle ?? node.getBoundingClientRect(), text = value ?? node.textContent?.trim();
    const css = getComputedStyle(node);
    if (!text || !rect.width || css.display === 'none') return;
    painter.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
    painter.fillStyle = css.color;
    painter.textAlign = centered ? 'center' : 'left'; painter.textBaseline = 'middle';
    painter.fillText(text, rect.left - bounds.left + (centered ? rect.width / 2 : 0), rect.top - bounds.top + rect.height / 2);
  };
  const status = source.querySelector<HTMLElement>('[role="status"]');
  if (status) label(status);
  for (const button of source.querySelectorAll('button')) {
    const rect = button.getBoundingClientRect(), css = getComputedStyle(button);
    if (!rect.width || css.display === 'none') continue;
    painter.fillStyle = css.backgroundColor;
    painter.beginPath();
    painter.roundRect(rect.left - bounds.left, rect.top - bounds.top, rect.width, rect.height,
      Math.min(parseFloat(css.borderTopLeftRadius) || 0, rect.height / 2));
    painter.fill();
    // Read the text's real range, not its icon+label wrapper. This retains the
    // existing Arc icon gap and works with normal and changing button labels.
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.textContent?.trim() || text.parentElement?.closest('[aria-hidden="true"]')) continue;
      const range = document.createRange(); range.selectNodeContents(text);
      if (text.parentElement) label(text.parentElement, true, range.getBoundingClientRect(), text.textContent.trim());
    }
  }
  // Reuse the actual installed Lucide SVG geometry, without loading images.
  for (const svg of source.querySelectorAll('svg')) {
    const rect = svg.getBoundingClientRect(), css = getComputedStyle(svg);
    if (!rect.width || css.display === 'none') continue;
    const view = svg.viewBox.baseVal;
    painter.save(); painter.translate(rect.left - bounds.left, rect.top - bounds.top);
    painter.scale(rect.width / (view.width || 24), rect.height / (view.height || 24));
    painter.strokeStyle = css.color; painter.fillStyle = css.color;
    painter.lineWidth = Number(svg.getAttribute('stroke-width')) || 1.75;
    painter.lineCap = 'round'; painter.lineJoin = 'round';
    for (const shape of svg.children) {
      if (shape.tagName === 'path') painter.stroke(new Path2D(shape.getAttribute('d') || ''));
      else if (shape.tagName === 'rect') {
        painter.beginPath(); painter.roundRect(Number(shape.getAttribute('x')), Number(shape.getAttribute('y')),
          Number(shape.getAttribute('width')), Number(shape.getAttribute('height')), Number(shape.getAttribute('rx'))); painter.stroke();
      } else if (shape.tagName === 'circle') {
        painter.beginPath(); painter.arc(Number(shape.getAttribute('cx')), Number(shape.getAttribute('cy')),
          Number(shape.getAttribute('r')), 0, Math.PI * 2); painter.stroke();
      }
    }
    painter.restore();
  }
  return canvas;
}

export function referenceDragPreview(source: HTMLElement, items: StashItem[], includeImage = true) {
  if (selectionBar(source)) return selectionBarPreview(source);
  // HTML drag images must have a painted layout object in Chromium. A detached
  // canvas has none; the previous canvas was never painted into a native ghost.
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 112;
  const painter = canvas.getContext("2d", { willReadFrequently: true });
  if (!painter) return null;
  const tokens = getComputedStyle(source);
  painter.fillStyle = tokens.getPropertyValue("--surface-raised").trim();
  painter.beginPath();
  painter.roundRect(1, 1, 318, 110, 26);
  painter.fill();
  painter.strokeStyle = tokens.getPropertyValue("--border-strong").trim();
  painter.stroke();
  const thumbnail = source.querySelector("img") || Array.from(document.querySelectorAll("article"))
    .find(card => card.getAttribute("aria-label") === items[0].title)?.querySelector("img");
  const withImage = includeImage && thumbnail?.complete && thumbnail.naturalWidth > 0;
  if (withImage) {
    painter.save(); painter.beginPath(); painter.roundRect(12, 12, 88, 88, 14); painter.clip();
    const scale = Math.max(88 / thumbnail.naturalWidth, 88 / thumbnail.naturalHeight);
    painter.drawImage(thumbnail, 12, 12, thumbnail.naturalWidth * scale, thumbnail.naturalHeight * scale);
    painter.restore();
  }
  const x = withImage ? 112 : 16, available = canvas.width - x - 16;
  painter.fillStyle = tokens.getPropertyValue("--foreground").trim();
  painter.font = `500 ${tokens.getPropertyValue("--text-sm").trim()} ${tokens.fontFamily}`;
  let rest = items[0].title.slice(0, 300);
  for (let row = 0; row < 2 && rest; row++) {
    let length = 1, upper = rest.length;
    while (length < upper) {
      const candidate = Math.ceil((length + upper) / 2);
      if (painter.measureText(rest.slice(0, candidate)).width <= available - 12) length = candidate;
      else upper = candidate - 1;
    }
    const more = length < rest.length;
    painter.fillText(rest.slice(0, length) + (row === 1 && more ? "…" : ""), x, 34 + row * 20);
    rest = rest.slice(length);
  }
  painter.font = `400 ${tokens.getPropertyValue("--text-xs").trim()} ${tokens.fontFamily}`;
  painter.fillStyle = tokens.getPropertyValue("--text-secondary").trim();
  painter.fillText(items.length === 1 ? "1 reference" : `${items.length} references`, x, 82);
  // No controls: this is the carried card, not an interactive second card.
  return canvas;
}

function mountPreview(canvas: HTMLCanvasElement, source: HTMLElement) {
  const box = source.getBoundingClientRect();
  canvas.dataset.referenceDragPreview = "true";
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, { position: "fixed", zIndex: "2147483647", pointerEvents: "none",
    width: `${canvas.width}px`, height: `${canvas.height}px`, borderRadius: "var(--radius-panel)", boxShadow: "var(--shadow-floating)",
    left: `${Math.max(0, Math.min(box.x, innerWidth - canvas.width))}px`,
    top: `${Math.max(0, Math.min(box.y, innerHeight - canvas.height))}px` });
  document.body.append(canvas);
  // Force a real, viewport-visible layout before Chromium snapshots the node.
  canvas.getBoundingClientRect();
}

export function endReferenceDrag() { finishActiveDrag?.(); }

export function startReferenceDrag(event: DragEvent<HTMLElement>, items: StashItem[]) {
  if (!items.length || (event.target instanceof Element && event.target.closest("button, a, input, textarea"))) {
    event.preventDefault();
    return;
  }
  finishActiveDrag?.();
  const source = event.currentTarget;
  const preview = referenceDragPreview(source, items);
  if (isTauri()) {
    event.preventDefault();
    if (nativeDragPending) return;
    let png: string;
    try {
      try { png = preview?.toDataURL('image/png') || ''; }
      catch { png = referenceDragPreview(source, items, false)?.toDataURL('image/png') || ''; }
      if (!png) throw new Error('Could not prepare the reference preview.');
    } catch (error) {
      window.dispatchEvent(new CustomEvent('reference-drag-error', { detail: String(error) }));
      return;
    }
    nativeDragPending = true;
    source.dataset.dragging = 'true';
    const bounds = source.getBoundingClientRect();
    const hotspot = selectionBar(source) ? { x: Math.round(event.clientX - bounds.left), y: Math.round(event.clientY - bounds.top) } : undefined;
    void dragReferenceFile(items.map(item => item.id), png, hotspot).catch(error => {
      window.dispatchEvent(new CustomEvent("reference-drag-error", {detail: error instanceof Error ? error.message : String(error)}));
    }).finally(() => { nativeDragPending = false; delete source.dataset.dragging; });
    return;
  }
  // The browser owns this gesture and its OS drag image. Cancelling it then
  // starting DoDragDrop in a background process loses the source input queue.
  // Do not hand a live gesture off through HTTP, even if an older bridge offers it.
  event.dataTransfer.items.clear();
  event.dataTransfer.effectAllowed = "copy";
  for (const [format, value] of Object.entries(referenceDragPayload(items))) {
    if (value) event.dataTransfer.setData(format, value);
  }
  // DownloadURL is a separate compatibility hint for drag-out file targets.
  // Browser sidebars have no source-owned native bridge; file receipt is not promised.
  if (!items.some(item => item.kind === "note") || items.some(hasContextFile)) {
    event.dataTransfer.setData("DownloadURL", referenceDownloadPayload(buildContext(items), items[0].title, items.length));
  }
  if (preview) {
    mountPreview(preview, source);
    event.dataTransfer.setDragImage(preview, 24, 24);
    // Snapshot happens after dragstart, before timers. The OS carries it outside
    // the panel; no in-page mouse follower can escape a WebView's clipping.
    window.setTimeout(() => preview.remove(), 0);
  }
  source.dataset.dragging = "true";
  const finish = () => {
    delete source.dataset.dragging;
    preview?.remove();
    window.clearTimeout(timeout);
    window.removeEventListener("dragend", finish, true);
    window.removeEventListener("drop", finish, true);
    window.removeEventListener("pagehide", finish);
    if (finishActiveDrag === finish) finishActiveDrag = undefined;
  };
  const timeout = window.setTimeout(finish, 30_000);
  finishActiveDrag = finish;
  window.addEventListener("dragend", finish, true);
  window.addEventListener("drop", finish, true);
  window.addEventListener("pagehide", finish);
}
