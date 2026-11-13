import { canonicalizeUrl } from "../../lib/canonical-url";
import { matchesSearchTerms, referenceSearchText, searchTerms } from "../../lib/reference-search.mjs";
import type { CollectionFilter, StashItem } from "../../types";

export function matchesCollection(item: StashItem, filter: CollectionFilter, now = Date.now()) {
  switch (filter) {
    case "recent": return Date.parse(item.createdAt) >= now - 7 * 24 * 60 * 60 * 1000;
    case "web": return item.kind === "web" || item.kind === "repo";
    case "files": return item.kind !== "note" && Boolean(item.assetPath || item.hasFile || ["file", "pdf", "image"].includes(item.kind));
    case "favorites": return Boolean(item.favorite);
    default: return true;
  }
}

export function buildSearchIndex(items: StashItem[]) {
  return new Map(items.map(item => [item.id, referenceSearchText(item)]));
}

export function filterItems(items: StashItem[], index: Map<string, string>, query: string, filter: CollectionFilter, tag: string | null = null, resultIds: Set<string> | null = null) {
  // Same term contract as the Desktop/MCP index, so the immediate local result matches the indexed one.
  const terms = searchTerms(query);
  const searching = terms.length > 0;
  const now = Date.now();
  const byId = searching && resultIds ? new Map(items.map(item => [item.id, item])) : null;
  const candidates = byId && resultIds ? Array.from(resultIds).flatMap(id => { const item = byId.get(id); return item ? [item] : []; }) : items;
  const normalizedTag = tag?.trim().toLocaleLowerCase('en');
  return candidates.filter(item => (!searching || resultIds !== null || matchesSearchTerms(index.get(item.id) ?? '', terms)) && matchesCollection(item, filter, now) && (!normalizedTag || item.tags.some(value => value.toLocaleLowerCase('en') === normalizedTag)));
}

export function summarizeItems(items: StashItem[]) {
  const counts: Record<CollectionFilter, number> = { all: items.length, recent: 0, web: 0, files: 0, favorites: 0 };
  const tags = new Map<string, number>();
  const now = Date.now();
  for (const item of items) {
    for (const filter of ["recent", "web", "files", "favorites"] as const) if (matchesCollection(item, filter, now)) counts[filter]++;
    for (const tag of item.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }
  return { counts, tags: Array.from(tags, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) };
}

export function uniqueImports(items: StashItem[], incoming: StashItem[]) {
  const ids = new Set(items.map(item => item.id));
  const urls = new Set(items.flatMap(item => item.url ? [canonicalizeUrl(item.url)] : []));
  return incoming.filter(item => {
    const url = item.url ? canonicalizeUrl(item.url) : null;
    if (ids.has(item.id) || (url && urls.has(url))) return false;
    ids.add(item.id);
    if (url) urls.add(url);
    return true;
  });
}

export function selectItems(items: StashItem[], ids: string[]) {
  const byId = new Map(items.map(item => [item.id, item]));
  return ids.flatMap(id => { const item = byId.get(id); return item ? [item] : []; });
}
