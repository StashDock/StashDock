import type { StashItem } from "../../types";
import { uniqueImports } from "./selectors";
import { canonicalizeUrl } from "../../lib/canonical-url";
import { reconcileReferences } from '../../lib/reconcileReferences';
import { normalizeReferenceSort, type ReferenceSort } from '../../lib/reference-sort.mjs';
import { editReferenceCover, type ReferenceCoverEdit } from '../../lib/referenceCover';

export type LibraryRepository = {
  load: () => Promise<StashItem[]>;
  loadSort?: () => Promise<ReferenceSort>;
  saveSort?: (sort: ReferenceSort) => Promise<void>;
  /** The listed references that still exist; ones it leaves out were deleted. */
  loadSome?: (ids: string[]) => Promise<StashItem[]>;
  add: (items: StashItem[], next: StashItem[]) => Promise<void | StashItem[]>;
  replace?: (item: StashItem, next: StashItem[]) => Promise<void | StashItem[]>;
  remove: (id: string, next: StashItem[]) => Promise<void>;
  removeMany?: (ids: string[], next: StashItem[]) => Promise<void>;
  favorite: (id: string, value: boolean, next: StashItem[]) => Promise<void>;
  edit?: (id: string, title: string, tags: string[], next: StashItem[], cover?: ReferenceCoverEdit) => Promise<StashItem[]>;
  editContent?: (id: string, content: string, next: StashItem[]) => Promise<StashItem[]>;
  changeTag?: (name: string, replacement: string | null, next: StashItem[]) => Promise<StashItem[]>;
};
export type ImportSummary = { imported: number; updated: number; skipped: number };
export type LibrarySnapshot = { items: StashItem[]; sort: ReferenceSort; ready: boolean; error: string | null; importNotice: { message: string } | null };

export function cleanReferenceTags(tags: string[]) {
  if (tags.length > 12 || tags.some(tag => tag.trim().length > 48)) throw new Error('Use at most 12 tags, each up to 48 characters.');
  const seen = new Set<string>();
  return tags.map(tag => tag.trim()).filter(tag => tag && !seen.has(tag.toLowerCase()) && seen.add(tag.toLowerCase()));
}

export function contentExcerpt(content: string) {
  return Array.from(content.trim().split(/\s+/).join(' ')).slice(0, 180).join('');
}

/** One source of truth per WebView. All reads and mutations share an ordered queue. */
export function createLibraryStore(repository: LibraryRepository) {
  let snapshot: LibrarySnapshot = { items: [], sort: 'newest', ready: false, error: null, importNotice: null };
  const listeners = new Set<() => void>();
  let queue: Promise<unknown> = Promise.resolve();
  let refreshFlight: Promise<void> | null = null;
  let invalidated = false;
  const publish = (items: StashItem[], error: string | null = null, sort = snapshot.sort) => {
    const reconciled = reconcileReferences(snapshot.items, items);
    const unchanged = reconciled === snapshot.items;
    if (snapshot.ready && unchanged && error === snapshot.error && sort === snapshot.sort) return;
    snapshot = { ...snapshot, sort, items: unchanged ? snapshot.items : reconciled, ready: true, error };
    listeners.forEach(listener => listener());
  };
  const enqueue = <T,>(operation: () => Promise<T>): Promise<T> => {
    const task = queue.then(operation);
    queue = task.catch(() => {});
    return task;
  };
  const refresh = (): Promise<void> => {
    if (refreshFlight) return refreshFlight;
    refreshFlight = enqueue(async () => {
      do {
        invalidated = false;
        try {
          const [items, sort] = await Promise.all([repository.load(), repository.loadSort?.() ?? snapshot.sort]);
          publish(items, null, normalizeReferenceSort(sort));
        }
        catch (error) { publish(snapshot.items, error instanceof Error ? error.message : "The library could not be opened."); }
      } while (invalidated);
    }).finally(() => { refreshFlight = null; });
    return refreshFlight;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    setSort: (sort: ReferenceSort) => enqueue(async () => {
      await repository.saveSort?.(sort);
      publish(snapshot.items, null, sort);
    }),
    invalidate: () => { invalidated = true; return refresh(); },
    /** Re-read only these references (for example after a background cover update). */
    patch: (ids: string[]) => {
      const wanted = [...new Set(ids)];
      if (!repository.loadSome || !wanted.length) { invalidated = true; return refresh(); }
      return enqueue(async () => {
        if (!snapshot.ready) return;
        const fresh = new Map((await repository.loadSome!(wanted)).map(item => [item.id, item]));
        const known = new Set(snapshot.items.map(item => item.id));
        // A reference this shelf has not loaded yet needs the full, ordered list.
        if ([...fresh.keys()].some(id => !known.has(id))) { invalidated = true; void refresh(); return; }
        const gone = new Set(wanted.filter(id => !fresh.has(id)));
        publish(snapshot.items.flatMap(item => gone.has(item.id) ? [] : [fresh.get(item.id) ?? item]));
      }).catch(() => { invalidated = true; return refresh(); });
    },
    announceImport: ({ imported, updated, skipped }: ImportSummary) => {
      const message = imported
        ? "Page saved from browser."
        : updated ? "Saved page updated from browser."
        : skipped ? "This page is already in StashDock."
        : "Browser save completed.";
      snapshot = { ...snapshot, importNotice: { message } };
      listeners.forEach(listener => listener());
    },
    add: (incoming: StashItem[], persisted = false) => enqueue(async () => {
      const unique = uniqueImports(snapshot.items, incoming);
      if (unique.length) {
        const next = [...unique, ...snapshot.items];
        const saved = !persisted ? await repository.add(unique, next) : undefined;
        publish(saved ?? next);
      }
      return { imported: unique.length, skipped: incoming.length - unique.length };
    }),
    // Confirmed Replace writes the new reference through an explicit adapter.
    replaceLink: (incoming: StashItem) => enqueue(async () => {
      const url = incoming.url ? canonicalizeUrl(incoming.url) : null;
      const existing = url ? snapshot.items.find(item => item.url && canonicalizeUrl(item.url) === url) : undefined;
      if (!existing) throw new Error('The reference changed. Save the page again.');
      if (!repository.replace) throw new Error('Reference replacement is unavailable.');
      const item = { ...incoming, id: existing.id, createdAt: existing.createdAt, favorite: false, content: incoming.content ?? '', contextOverride: undefined };
      const next = snapshot.items.map(current => current.id === existing.id ? item : current);
      publish(await repository.replace(item, next) ?? next);
    }),
    remove: (id: string) => enqueue(async () => {
      const next = snapshot.items.filter(item => item.id !== id);
      await repository.remove(id, next);
      publish(next);
    }),
    removeMany: (ids: string[]) => enqueue(async () => {
      const unique = [...new Set(ids)];
      if (!unique.length) return;
      if (!repository.removeMany) throw new Error('Reference deletion is unavailable.');
      const deleted = new Set(unique);
      const next = snapshot.items.filter(item => !deleted.has(item.id));
      await repository.removeMany(unique, next);
      publish(next);
    }),
    toggleFavorite: (id: string) => enqueue(async () => {
      const item = snapshot.items.find(item => item.id === id);
      if (!item) return;
      const favorite = !item.favorite;
      const next = snapshot.items.map(item => item.id === id ? { ...item, favorite } : item);
      await repository.favorite(id, favorite, next);
      publish(next);
    }),
    edit: (id: string, title: string, tags: string[], cover?: ReferenceCoverEdit) => enqueue(async () => {
      title = title.trim(); tags = cleanReferenceTags(tags);
      if (!title || title.length > 500) throw new Error('Use a title between 1 and 500 characters.');
      if (!snapshot.items.some(item => item.id === id)) throw new Error('This reference no longer exists.');
      if (!repository.edit) throw new Error('Reference editing is unavailable.');
      const next = snapshot.items.map(item => item.id === id ? editReferenceCover({ ...item, title, tags }, cover) : item);
      publish(await repository.edit(id, title, tags, next, cover));
    }),
    editContent: (id: string, content: string) => enqueue(async () => {
      if (content.length > 200_000) throw new Error('Use at most 200,000 characters.');
      if (!snapshot.items.some(item => item.id === id)) throw new Error('This reference no longer exists.');
      if (!repository.editContent) throw new Error('Content editing is unavailable.');
      const next = snapshot.items.map(item => item.id === id ? { ...item, contextOverride: content } : item);
      publish(await repository.editContent(id, content, next));
    }),
    changeTag: (name: string, replacement: string | null) => enqueue(async () => {
      name = name.trim(); replacement = replacement === null ? null : replacement.trim();
      if (!name || replacement !== null && !replacement) throw new Error('Enter a tag name.');
      if (replacement !== null) cleanReferenceTags([replacement]);
      if (!repository.changeTag) throw new Error('Tag editing is unavailable.');
      const next = snapshot.items.map(item => ({ ...item, tags: cleanReferenceTags(item.tags.flatMap(tag => tag.toLowerCase() === name.toLowerCase() ? replacement ? [replacement] : [] : [tag])) }));
      publish(await repository.changeTag(name, replacement, next));
    }),
  };
}
