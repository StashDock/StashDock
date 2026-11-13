export type ReferenceSort = 'newest' | 'oldest' | 'most-used';
export const referenceSorts: readonly ReferenceSort[];
export function normalizeReferenceSort(value: unknown): ReferenceSort;
export function sortReferences<T extends { createdAt: string; useCount?: number }>(items: T[], mode?: ReferenceSort): T[];
