import type { StashItem } from '../types';
import fileTypeRules from '../../shared/reference-file-types.json';
type FileVisual = 'image' | 'pdf' | 'document' | 'spreadsheet' | 'presentation' | 'archive' | 'video' | 'audio' | 'data' | 'markdown' | 'code' | 'text' | 'file';
type FileTypeRule = { visual: FileVisual; label: string; kinds?: string[]; extensions?: string[]; mimeStarts?: string[]; mimeIncludes?: string[]; mimeEquals?: string[] };

export type FileReferencePayload = { name: string; mimeType: string; base64: string; title: string; content: string; preview?: string };
/** A file chosen in the system dialog: saved as a reference to its original, identified by a short-lived token. */
export type ChosenFile = { token: string; name: string; size: number; mimeType: string; content: string };
export type ChosenFileDraft = { token: string; title: string; content: string; preview?: string };
export const FILE_REFERENCE_LIMIT = 5_000_000;
export function fileReferenceType(item: Pick<StashItem, 'kind' | 'title' | 'mimeType' | 'origin' | 'assetPath'>) {
  const name = item.origin?.fileName || item.assetPath || item.title;
  const extension = name.split('.').pop()?.toLowerCase() || '';
  const mime = item.mimeType || '';
  for (const rule of fileTypeRules as FileTypeRule[]) {
    if (rule.kinds?.includes(item.kind) || rule.extensions?.includes(extension) ||
      rule.mimeStarts?.some(prefix => mime.startsWith(prefix)) || rule.mimeIncludes?.some(part => mime.includes(part)) || rule.mimeEquals?.includes(mime)) {
      return { label: rule.label, visual: rule.visual };
    }
  }
  return { label: 'File', visual: 'file' as const };
}
export function isFileReference(item: Pick<StashItem, 'kind'>) { return ['file', 'pdf', 'image'].includes(item.kind); }
export async function stageFileContent(file: File) {
  if (file.size > FILE_REFERENCE_LIMIT) throw Error('Choose a file under 5 MB.');
  return file.type.startsWith('text/') || /\.(txt|md|mdx|csv|log|json|html|css|js|jsx|ts|tsx|py|rs|yaml|yml|toml|xml|sql)$/i.test(file.name)
    ? Array.from(await file.text()).slice(0, 50_000).join('') : '';
}
export async function fileReferencePayload(file: File, title: string, content: string): Promise<FileReferencePayload> {
  if (file.size > FILE_REFERENCE_LIMIT) throw Error('Choose a file under 5 MB.');
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(Error('The file could not be read. Choose it again.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file);
  });
  return { name: file.name, mimeType: file.type, base64, title: title.trim() || file.name, content };
}
