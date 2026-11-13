import { useEffect, useSyncExternalStore } from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { deleteItem, getItems, loadItems, saveItems, setItemFavorite } from "../../lib/storage";
import { createLibraryStore, type ImportSummary } from "./store";
import type { ReferenceSort } from '../../lib/reference-sort.mjs';

export const libraryStore = createLibraryStore({
  load: loadItems,
  ...(isTauri() ? { loadSort: () => invoke<ReferenceSort>('get_library_sort'), saveSort: (sort: ReferenceSort) => invoke<void>('set_library_sort', { sort }) } : {}),
  ...(isTauri() ? { loadSome: (ids: string[]) => getItems(ids) } : {}),
  add: async (items, next) => {
    await saveItems(isTauri() ? items : next);
    return isTauri() ? loadItems() : next;
  },
  remove: (id, next) => isTauri() ? deleteItem(id) : saveItems(next),
  replace: async (item, next) => {
    if (isTauri()) { await invoke('replace_saved_link', { item }); return loadItems(); }
    await saveItems(next); return next;
  },
  removeMany: async (ids, next) => { if (isTauri()) await invoke('delete_items', { ids }); else await saveItems(next); },
  favorite: (id, value, next) => isTauri() ? setItemFavorite(id, value) : saveItems(next),
  edit: async (id, title, tags, next, cover) => {
    if (isTauri()) return invoke('edit_item', { id, title, tags, ...(cover ? { cover } : {}) });
    await saveItems(next); return next;
  },
  changeTag: async (name, replacement, next) => {
    if (isTauri()) return invoke('change_library_tag', { name, replacement });
    await saveItems(next); return next;
  },
  editContent: async (id, content, next) => {
    if (isTauri()) return invoke('edit_item_content', { id, content });
    await saveItems(next); return next;
  },
});

// One listener lifetime for all mounted desktop consumers.
let consumers = 0;
let disconnect: (() => void) | undefined;
function connect() {
  if (consumers++ === 0) {
    let cancelled = false;
    const stops: UnlistenFn[] = [];
    // A hidden panel (folder mode, minimized) does not reload for external
    // changes; it reloads once when it is shown or focused again.
    const refresh = () => { if (!document.hidden) void libraryStore.invalidate(); };
    if (isTauri()) {
      // Background cover/icon work names the references it changed. Coalesce a
      // burst into one small read instead of reloading the whole library.
      let changed = new Set<string>(), flush: number | undefined;
      const patch = (ids: string[]) => {
        ids.forEach(id => changed.add(id));
        flush ??= window.setTimeout(() => { const ids = [...changed]; changed = new Set(); flush = undefined; if (!cancelled) void libraryStore.patch(ids); }, 120);
      };
      stops.push(() => { if (flush !== undefined) window.clearTimeout(flush); });
      for (const name of ["extension-imported", "extension-deleted", "reference-preview-updated", "reference-usage-updated"]) {
        void listen<unknown>(name, event => {
          if (cancelled) return;
          const ids = (event.payload as { ids?: unknown } | null)?.ids;
          if ((name === "reference-preview-updated" || name === "reference-usage-updated") && Array.isArray(ids) && ids.every(id => typeof id === "string")) patch(ids);
          else refresh();
          if (name === "extension-imported") libraryStore.announceImport(event.payload as ImportSummary);
        }).then(stop => {
          if (cancelled) stop(); else stops.push(stop);
        }).catch(console.warn);
      }
    }
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    disconnect = () => {
      cancelled = true;
      stops.forEach(stop => stop());
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
    void libraryStore.refresh();
  }
  return () => { if (--consumers === 0) { disconnect?.(); disconnect = undefined; } };
}

export function useLibrary() {
  const snapshot = useSyncExternalStore(libraryStore.subscribe, libraryStore.getSnapshot);
  useEffect(connect, []);
  return { ...snapshot, refresh: libraryStore.refresh, setSort: libraryStore.setSort };
}
