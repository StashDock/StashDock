import { DSH_DRAFT_KEY } from '../../src/features/mcp-app/dsh-draft.mjs';
import { ROUTE } from './protocol.mjs';

const images = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const frozen = phase => ['adjudicating', 'submitting', 'sending'].includes(phase);

// DSH 0.2.2 exposes these on ConversationController, but not yet IConversation.
// Keep the version-specific dependency here; never substitute DOM file events.
export function supportsFiles(ctx) {
  return ['createDrafts', 'releaseDraftAttachments', 'resolveDraftAttachments']
    .every(name => typeof ctx.conversation[name] === 'function');
}

export async function addDraft(ctx, sessionId, getTab, params, signal, fetchFile = fetch) {
  const downloads = new AbortController();
  signal = AbortSignal.any([signal, downloads.signal]);
  const [block] = Array.isArray(params?.content) ? params.content : [];
  const draft = params?._meta?.[DSH_DRAFT_KEY];
  if (params?.role !== 'user' || draft?.send !== false || params.content?.length !== 1 ||
      block?.type !== 'text' || typeof block.text !== 'string' ||
      (!block.text.trim() && !draft.files?.length) || block.text.length > 2_000_000) {
    return { isError: true };
  }
  const binding = ctx.sessions.binding(sessionId);
  const shell = binding && ctx.conversation.input.for(binding.ctx);
  const active = () => !signal.aborted && getTab().visible && ctx.sidebarRight.mounted.getSnapshot() === sessionId &&
    ctx.sessions.binding(sessionId) === binding && shell && !frozen(shell.state.getSnapshot().phase);
  if (!active()) return { isError: true };
  const sessionReady = () => {
    const state = binding.session.getSnapshot();
    return !state.removed && state.subagent === null &&
      ctx.conversation.blocks.storeFor(sessionId).getSnapshot() === undefined;
  };
  const ids = draft.files ?? [];
  if (!Array.isArray(ids) || ids.length > 30 || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== 'string' || !id || id.length > 200) || (ids.length && !supportsFiles(ctx))) {
    return { isError: true };
  }
  const title = typeof draft.title === 'string' ? draft.title.replace(/\s+/gu, ' ').trim().slice(0, 180) : '';
  const quote = block.text.trim() ? title ? `${title}\n\n${block.text}` : block.text : '';
  if (!ids.length) return { isError: !shell.insertQuote(quote) };
  if (!sessionReady()) return { isError: true };
  const json = async (endpoint, payload) => {
    const response = await fetchFile(`${ROUTE}/${endpoint}`, {
      method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw Error(error.error || 'The original file could not be added.');
    }
    return response;
  };
  const manifest = await (await json('files', { ids })).json();
  if (!Array.isArray(manifest) || manifest.length !== ids.length || manifest.some((file, index) =>
    file.id !== ids[index] || typeof file.filename !== 'string' || !Number.isSafeInteger(file.sizeBytes) ||
    file.sizeBytes < 0 || file.sizeBytes > 512 * 1024 * 1024) ||
    manifest.reduce((sum, file) => sum + file.sizeBytes, 0) > 1024 * 1024 * 1024) throw Error('Invalid original files.');
  const checkImages = additions => {
    const state = shell.state.getSnapshot();
    const limits = binding.session.projections.faceOf('imageLimits').getSnapshot();
    const existing = ctx.conversation.resolveDraftAttachments(state.attachmentIds);
    const imageFiles = [...existing.map(item => item.file), ...additions].filter(file => images.has(file.type));
    if (limits && (imageFiles.length > limits.maxImagesPerMessage ||
        imageFiles.some(file => file.size > limits.maxImageBytes || !limits.mediaTypes.includes(file.type)) ||
        imageFiles.reduce((sum, file) => sum + file.size, 0) > limits.maxMessageImageBytes)) {
      throw Error('The selected images exceed this conversation’s attachment limits.');
    }
  };
  checkImages(manifest.map(file => ({ type: file.mimeType, size: file.sizeBytes })));
  const files = new Array(manifest.length);
  let next = 0;
  // Two reads at a time; never turn originals into base64 or iframe messages.
  try { await Promise.all(Array.from({ length: Math.min(2, manifest.length) }, async () => {
    while (next < manifest.length) {
      const index = next++;
      const file = manifest[index];
      const response = await json('file', { id: file.id });
      // DSH may compress the HTTP response. Content-Length describes that
      // encoding; validate the decoded original bytes, not the wire length.
      const blob = await response.blob();
      if (blob.size !== file.sizeBytes) throw Error('The original file could not be read completely.');
      files[index] = new File([blob], file.filename.replace(/[\\/\x00-\x1f]/g, '-'), { type: file.mimeType || 'application/octet-stream' });
    }
  })); } catch (error) { downloads.abort(); throw error; }
  if (!active() || !sessionReady()) return { isError: true };
  checkImages(files);
  const drafts = ctx.conversation.createDrafts(sessionId, files, binding.session.getSnapshot().subagent === null);
  const attachmentIds = drafts.map(item => item.id);
  // Both admissions are synchronous. Roll back only our attachments if the
  // editor refuses the quote; existing text, references and files stay intact.
  let committed = false;
  try {
    if (!shell.addAttachments(attachmentIds) || (quote && !shell.insertQuote(quote))) return { isError: true };
    committed = true;
    return {};
  } finally {
    if (!committed) {
      for (const id of attachmentIds) shell.removeAttachment(id);
      ctx.conversation.releaseDraftAttachments(drafts);
    }
  }
}
