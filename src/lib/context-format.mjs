const heading = '# StashDock context\n\n';
const genericSources = new Set(['', 'stashdock', 'local file', 'personal note', 'ai conversation', 'chrome', 'edge', 'firefox', 'safari']);

export function referenceFileName(item) {
  const raw = item.origin?.fileName || item.assetPath || item.title;
  return String(raw).split(/[\\/]/).at(-1)?.replace(/[\r\n]/g, ' ') || 'File';
}

export function hasContextFile(item) {
  return item.kind !== 'note' && Boolean(item.assetPath || item.hasFile);
}

export function contextBody(item) {
  const body = item.content || item.excerpt || '';
  const source = hasContextFile(item) ? 'supplemental'
    : !item.content && item.excerpt ? 'excerpt'
      : item.origin?.captureMethod === 'selection' ? 'selected_text'
        : item.origin?.importMethod === 'browser_extension' ? 'saved_page'
          : item.kind === 'note' ? 'note_text' : 'saved_content';
  const label = { note_text: 'Note text', supplemental: 'Supplemental context', excerpt: 'Summary', selected_text: 'Selected text', saved_page: 'Saved page content', saved_content: 'Saved content' }[source];
  return { body, source, label };
}

function section(item) {
  const origin = item.origin;
  let source = String(item.source || '').trim();
  try { if (item.url && source.toLowerCase() === new URL(item.url).hostname.toLowerCase()) source = ''; } catch { /* Preserve a meaningful source even if its URL is invalid. */ }
  const file = hasContextFile(item);
  const metadata = [
    !genericSources.has(source.toLowerCase()) && `Source: ${source}`,
    item.url && `URL: ${item.url}`,
    file && `File: ${referenceFileName(item)}`,
    origin?.author && `Author: ${origin.author}`,
    origin?.publishedAt && `Published: ${origin.publishedAt}`,
    origin?.contentOrigin === 'generated' && 'Content origin: AI-generated',
    origin?.contentOrigin === 'provided' && 'Content origin: User-provided',
    Array.isArray(origin?.sourceUrls) && origin.sourceUrls.some(value => typeof value === 'string') &&
      `Sources: ${origin.sourceUrls.filter(value => typeof value === 'string').slice(0, 10).join(', ')}`,
    item.tags?.length && `Tags: ${item.tags.join(', ')}`,
  ].filter(Boolean);
  const { body, label } = contextBody(item);
  const characters = [];
  if (item.kind !== 'note') {
    for (const character of body) { characters.push(character); if (characters.length > 20_000) break; }
  }
  const text = item.kind === 'note' ? body : characters.slice(0, 20_000).join('');
  const limitations = [
    !file && origin?.captureMethod === 'selection' && 'Only selected text was saved, not the full page.',
    origin?.truncated === true && 'The saved source content is incomplete.',
    characters.length > 20_000 && 'The exported text was truncated to 20,000 characters.',
    !file && !body && item.url && 'Page content was not saved. Read the URL before making claims about it.',
  ].filter(Boolean);
  return [`## ${item.title}`, ...metadata, ...(text ? ['', `### ${label}`, text] : []), ...(limitations.length ? ['', ...limitations] : [])].join('\n');
}

// A saved override is the final payload, not another captured body to wrap.
// Empty overrides are intentional. Multiple references share one outer heading.
export function buildContext(items) {
  if (items.length === 1 && typeof items[0].contextOverride === 'string') return items[0].contextOverride;
  return heading + items.map(item => typeof item.contextOverride === 'string'
    ? item.contextOverride.startsWith(heading) ? item.contextOverride.slice(heading.length) : item.contextOverride
    : section(item)).join('\n\n---\n\n');
}

// File extraction and MIME/size summaries are searchable library data, not
// user instructions. Preserve explicit edits, including legacy final overrides.
export function fileSupplement(item) {
  if (typeof item.contextOverride === 'string') {
    const baseline = buildContext([{ ...item, contextOverride: undefined }]);
    if (item.contextOverride !== baseline) return item.contextOverride;
  }
  // Older byte imports did not record contentEdited. They never extracted
  // binary bodies, so their nonempty content is a supplied annotation.
  const legacyBinary = item.origin?.contentEdited === undefined && item.origin?.importMethod === 'local_file' &&
    item.mimeType && !item.mimeType.startsWith('text/') &&
    !['application/json', 'application/xml', 'image/svg+xml'].includes(item.mimeType);
  return item.origin?.contentEdited === true || legacyBinary ? item.content || '' : '';
}

export function editorContext(item) {
  return hasContextFile(item) ? fileSupplement(item) : buildContext([item]);
}

// Native file hosts already have names and bytes. Only deliberate annotations
// belong in the accompanying context, grouped by the actual attachment name.
export function buildNativeContext(items) {
  const selected = items.flatMap(item => {
    if (!hasContextFile(item)) return [item];
    const supplement = fileSupplement(item);
    return supplement.trim() ? [{ ...item, contextOverride: `## ${referenceFileName(item)}\n\n${supplement}` }] : [];
  });
  return selected.length ? buildContext(selected) : '';
}
