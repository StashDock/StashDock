import type { App } from '@modelcontextprotocol/ext-apps';
import { OPENAI_MESSAGE_KEY } from '@openai/mcp-extensions/app';
import { DSH_DRAFT_KEY } from './dsh-draft.mjs';

export type ReferenceAttachment = {
  title: string;
  ids: string[];
  files?: string[];
  content: { type: 'resource'; resource: { uri: string; mimeType: 'text/markdown'; text: string; _meta?: Record<string, unknown> } }[];
};
type DraftHost = Pick<App, 'getHostCapabilities' | 'sendMessage'>;
export function supportsNativeFiles(host: DraftHost): boolean {
  const options = host.getHostCapabilities()?.experimental?.[DSH_DRAFT_KEY];
  return typeof options === 'object' && options !== null && 'files' in options && options.files === true;
}
export const DRAFT_REOPEN_HINT = 'Close the StashDock panel and reopen it.';
export const DRAFT_UNAVAILABLE = 'Adding to chat is unavailable. Close the StashDock panel and reopen it.';

export function supportsDraft(host: DraftHost): boolean {
  const capabilities = host.getHostCapabilities();
  const options = capabilities?.experimental?.[DSH_DRAFT_KEY] ?? capabilities?.experimental?.[OPENAI_MESSAGE_KEY];
  // openai/message: {} is the published extension capability. The extra draft
  // field in some desktop handshakes reflects composer mount timing, not a
  // durable capability: restored panels may never receive it. Let the host
  // accept or reject each explicit send:false request when the user presses Add.
  return typeof options === 'object' && options !== null && !Array.isArray(options) &&
    capabilities?.message?.text !== undefined;
}

export function parseAttachment(raw: unknown): ReferenceAttachment {
  if (!raw || typeof raw !== 'object') throw new Error('The reference attachment could not be prepared. Refresh and retry.');
  const value = raw as ReferenceAttachment;
  if (typeof value.title !== 'string' || !Array.isArray(value.ids) || !value.ids.length ||
    !value.ids.every(id => typeof id === 'string') ||
    (value.files !== undefined && (!Array.isArray(value.files) || new Set(value.files).size !== value.files.length ||
      value.files.some(id => typeof id !== 'string' || !value.ids.includes(id)))) ||
    !Array.isArray(value.content) || value.content.length !== 1 ||
    value.content.some(block => block.type !== 'resource' || !block.resource || typeof block.resource.text !== 'string' ||
      block.resource.mimeType !== 'text/markdown' || !/^stashdock:\/\/snapshot\/[a-f\d]{64}\//.test(block.resource.uri))) {
    throw new Error('The reference attachment is invalid. Refresh and retry.');
  }
  return value;
}

export async function addAttachmentToDraft(host: DraftHost, attachment: ReferenceAttachment): Promise<void> {
  if (!supportsDraft(host)) throw new Error(DRAFT_UNAVAILABLE);
  const checked = parseAttachment(attachment);
  const markdown = checked.content[0].resource.text;
  if (host.getHostCapabilities()?.experimental?.[DSH_DRAFT_KEY]) {
    const params: Parameters<App['sendMessage']>[0] & { _meta: Record<string, unknown> } = {
      role: 'user',
      content: [{ type: 'text', text: markdown }],
      _meta: { [DSH_DRAFT_KEY]: { send: false, title: checked.title,
        ...(checked.files !== undefined && { files: checked.files }) } },
    };
    if (checked.files?.length && !supportsNativeFiles(host)) throw new Error(DRAFT_UNAVAILABLE);
    const result = await host.sendMessage(params, { timeout: checked.files?.length ? 120_000 : 15_000 });
    if (result.isError) throw new Error('The conversation could not accept this draft. Check the input box and retry.');
    return;
  }
  const title = checked.ids.length > 1 ? 'Multiple contexts' : checked.title.trim() || 'Untitled reference';
  const characters = Array.from(title);
  const displayTitle = characters.length > 48 ? characters.slice(0, 47).join('') + '…' : title;
  // The public 0.1 extension wrapper still accepts send:true only; the published
  // message protocol also supports send:false. Pass it through the App bridge,
  // gated on openai/message, and never fall back to the default send operation.
  // Titled text is a removable attachment, not ordinary composer text.
  // The installed Codex host reads openai/title for the entry inside its popover,
  // but groups all content blocks under a localized Context-count outer chip.
  // This metadata cannot override that host-owned label.
  const params: Parameters<App['sendMessage']>[0] & { _meta: Record<string, unknown> } = { role: 'user', content: [{
    type: 'text', text: markdown, _meta: { 'openai/title': displayTitle },
  }],
    _meta: { [OPENAI_MESSAGE_KEY]: { target: 'active', send: false } },
  };
  const result = await host.sendMessage(params, { timeout: 15_000 });
  if (result.isError) throw new Error('The host did not accept this attachment. Check the input box and retry if it is missing.');
}
