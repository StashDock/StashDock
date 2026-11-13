import type { StashItem } from '../types';
export function buildContext(items: StashItem[]): string;
export function fileSupplement(item: StashItem): string;
export function editorContext(item: StashItem): string;
export function buildNativeContext(items: StashItem[]): string;
export function hasContextFile(item: Pick<StashItem, 'kind' | 'assetPath' | 'hasFile'>): boolean;
export function referenceFileName(item: StashItem): string;
export function contextBody(item: StashItem): { body: string; source: string; label: string };
