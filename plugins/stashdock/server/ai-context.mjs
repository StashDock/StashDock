import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalReferenceUrl } from '../../../src/lib/reference-url.mjs';
import { contextBody, hasContextFile, referenceFileName } from '../../../src/lib/context-format.mjs';
import { tagRevision } from './library.mjs';

// Shared contract for model calls and direct library writes. No paths,
// existing IDs, arbitrary origin objects or caller-asserted approval fields.
export const contextSaveSchema = z.object({
  title: z.string().trim().min(1).max(500),
  content: z.string().max(200_000).optional(),
  url: z.string().trim().min(1).max(8192).optional(),
  tags: z.array(z.string().trim().min(1).max(48)).max(12).default([]),
  contentOrigin: z.enum(['provided', 'generated']).default('provided'),
  sourceUrls: z.array(z.string().trim().min(1).max(8192)).max(10).default([]),
}).strict();

export function normalizeContextSave(raw) {
  const parsed = contextSaveSchema.safeParse(raw);
  if (!parsed.success) throw Error('Use a title up to 500 characters, context up to 200,000 characters and at most 12 tags. Only context, links and source URLs can be saved.');
  const value = parsed.data, content = value.content ?? '';
  if (!value.url && !content.trim()) throw Error('Add context text or a web link to save.');
  const url = value.url ? canonicalReferenceUrl(value.url) : undefined;
  const seen = new Set();
  const tags = value.tags.filter(tag => !seen.has(tag.toLowerCase()) && seen.add(tag.toLowerCase()));
  const sourceUrls = [...new Set(value.sourceUrls.map(canonicalReferenceUrl))];
  const kind = url ? new URL(url).hostname === 'github.com' ? 'repo' : 'web' : 'note';
  const input = { title: value.title, content, url, tags, contentOrigin: value.contentOrigin, sourceUrls };
  // Tag/source order is not retry identity. A changed body is a new note, not
  // an implicit edit of an earlier asset.
  const fingerprint = createHash('sha256').update(JSON.stringify({ ...input,
    tags: tags.map(tag => tag.toLowerCase()).sort(), sourceUrls: [...sourceUrls].sort(),
  })).digest('hex');
  return { input, kind, fingerprint };
}

export function tagCatalog(items, { query = '', limit = 50, offset = 0 } = {}) {
  const counts = new Map();
  for (const item of items) for (const name of new Map((item.tags || []).map(name => [name.toLowerCase(), name])).values()) {
    const key = name.toLowerCase(), current = counts.get(key);
    if (current) current.count++; else counts.set(key, { name, count: 1 });
  }
  const matches = [...counts.values()].filter(tag => tag.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  const tags = matches.slice(offset, offset + limit), hasMore = offset + tags.length < matches.length;
  return { tags, total: matches.length, hasMore, nextOffset: hasMore ? offset + tags.length : null };
}

export function readContextBatch(items, ids, maxCharacters = 60_000) {
  const unique = [...new Set(ids)], byId = new Map(items.map(item => [item.id, item]));
  if (unique.some(id => !byId.has(id))) throw Error('A selected reference no longer exists. Search again.');
  const perItem = Math.floor(maxCharacters / unique.length);
  return { items: unique.map(id => {
    const item = byId.get(id), override = typeof item.contextOverride === 'string';
    const described = contextBody(item);
    const hasFile = hasContextFile(item);
    const body = override ? item.contextOverride : described.body;
    let end = Math.min(perItem, body.length);
    if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1] || '')) end--;
    return { id, title: item.title, kind: item.kind, source: item.source, url: item.url,
      tags: item.tags || [], tagRevision: tagRevision(item), hasFile, mimeType: item.mimeType,
      ...(hasFile ? { originalFile: { tool: 'get_stashdock_file', id, filename: referenceFileName(item), contentRead: false } } : {}),
      contentOrigin: item.origin?.contentOrigin, sourceUrls: item.origin?.sourceUrls,
      context: body.slice(0, end), contextSource: override ? 'user_override' : described.source,
      publishedAt: item.origin?.publishedAt, captureMethod: item.origin?.captureMethod,
      availableCharacters: body.length, truncated: end < body.length,
      captureTruncated: item.origin?.truncated === true };
  }), maxCharacters };
}
