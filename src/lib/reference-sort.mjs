export const referenceSorts = ['newest', 'oldest', 'most-used'];
export const normalizeReferenceSort = value => referenceSorts.includes(value) ? value : 'newest';

/** Stable ties preserve the library's insertion order, including a single import batch. */
export function sortReferences(items, mode = 'newest') {
  const sort = normalizeReferenceSort(mode);
  return [...items].sort((a, b) => {
    if (sort === 'most-used') {
      const used = (b.useCount || 0) - (a.useCount || 0);
      if (used) return used;
    }
    const added = String(b.createdAt).localeCompare(String(a.createdAt));
    return sort === 'oldest' ? -added : added;
  });
}
