import type { StashItem } from '../types';
import { hasContextFile } from './context-format.mjs';

/** Every file-backed reference uses the same system-file action. */
export function referenceOpenTarget(item: StashItem): 'link' | 'file' | null {
  if (hasContextFile(item)) return 'file';
  if (item.url) return 'link';
  return null;
}
