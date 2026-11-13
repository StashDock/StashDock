import { createElement as h, useEffect, useRef, useState } from 'react';
import { DSH_DRAFT_KEY } from '../../src/features/mcp-app/dsh-draft.mjs';
import { ROUTE, PANEL_ID } from './protocol.mjs';
import { addDraft, supportsFiles } from './draft.mjs';
import icon from '../stashdock/assets/icon.png';

export const name = PANEL_ID;
export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'conversation', 'theme'];

const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'";
const frameStyle = { display: 'block', border: 0, width: '100%', height: '100%' };

async function requestShelf(endpoint, signal, payload) {
  const response = await fetch(`${ROUTE}/${endpoint}`, {
    signal,
    ...(payload && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  });
  if (!response.ok) throw Error('StashDock could not complete the request.');
  return response.json();
}

function hostContext(ctx) {
  return {
    theme: ctx.theme.getTheme().active.colorScheme === 'dark' ? 'dark' : 'light',
    locale: document.documentElement.lang || navigator.language,
    displayMode: 'inline',
    availableDisplayModes: ['inline'],
  };
}

function Shelf({ ctx, sessionId, useTabInfo }) {
  const { tab } = useTabInfo();
  const currentTab = useRef(tab);
  currentTab.current = tab;
  const iframe = useRef(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const frame = iframe.current;
    const lifetime = new AbortController();
    let adding = false;
    const send = value => {
      if (!lifetime.signal.aborted) frame.contentWindow?.postMessage({ jsonrpc: '2.0', ...value }, '*');
    };
    const onMessage = async event => {
      const request = event.data;
      if (event.source !== frame.contentWindow || event.origin !== 'null' || request?.jsonrpc !== '2.0' ||
          !['string', 'number'].includes(typeof request.id)) return;
      try {
        const { method, params } = request;
        let result;
        switch (method) {
          case 'ui/initialize':
            result = {
              protocolVersion: params.protocolVersion,
              hostInfo: { name: 'DeepSeek Harness', version: '0.2.2' },
              hostContext: hostContext(ctx),
              hostCapabilities: { serverTools: {}, openLinks: {}, message: { text: {} }, experimental: { [DSH_DRAFT_KEY]: { files: supportsFiles(ctx) } } },
            };
            break;
          case 'ui/request-display-mode':
            result = { mode: 'inline' };
            break;
          case 'tools/call':
            result = await requestShelf('tool', lifetime.signal, { name: params.name, arguments: params.arguments });
            break;
          case 'ui/message':
            if (adding) { result = { isError: true }; break; }
            adding = true;
            try {
              result = await addDraft(ctx, sessionId, () => currentTab.current, params,
                AbortSignal.any([lifetime.signal, AbortSignal.timeout(110_000)]));
            } finally { adding = false; }
            break;
          case 'ui/open-link': {
            const url = new URL(params.url);
            if (!currentTab.current.visible || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
              result = { isError: true };
            } else {
              window.open(url.href, '_blank', 'noopener,noreferrer');
              result = {};
            }
            break;
          }
          default:
            send({ id: request.id, error: { code: -32601, message: 'Method unavailable' } });
            return;
        }
        send({ id: request.id, result });
      } catch (error) {
        send({ id: request.id, error: { code: -32603, message: error.message } });
      }
    };
    window.addEventListener('message', onMessage);
    const update = () => send({ method: 'ui/notifications/host-context-changed', params: hostContext(ctx) });
    const stopTheme = ctx.on('theme/change', update);
    const locale = new MutationObserver(update);
    locale.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    void requestShelf('shelf', AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)])).then(html => {
      if (!lifetime.signal.aborted) frame.srcdoc = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${policy}">`);
    }).catch(() => {
      if (!lifetime.signal.aborted) setLoadError(true);
    });
    return () => {
      lifetime.abort();
      window.removeEventListener('message', onMessage);
      stopTheme();
      locale.disconnect();
    };
  }, [ctx, sessionId, attempt]);

  const zh = document.documentElement.lang.startsWith('zh');
  return h('div', { style: { position: 'relative', height: '100%', minHeight: 0 } },
    // allow-forms permits React's submit event. CSP form-action:none still
    // forbids navigation/submission; mutations use the authenticated bridge.
    h('iframe', { ref: iframe, title: 'StashDock', sandbox: 'allow-scripts allow-forms', style: frameStyle, hidden: loadError }),
    loadError && h('div', { role: 'alert', style: { position: 'absolute', inset: 0, display: 'grid', placeContent: 'center', gap: 12, textAlign: 'center' } },
      zh ? '无法打开 StashDock。' : 'StashDock could not open.',
      h('button', { type: 'button', onClick: () => { setLoadError(false); setAttempt(value => value + 1); } }, zh ? '重试' : 'Retry'),
    ),
  );
}

export function apply(ctx) {
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: PANEL_ID,
    kind: PANEL_ID,
    title: () => 'StashDock',
    guide: [{
      id: 'open',
      order: 40,
      title: () => 'StashDock',
      icon: () => h('img', { src: icon, width: 32, height: 32, alt: '' }),
    }],
  }));
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: PANEL_ID,
    inject: sessionId => ({ ctx, sessionId }),
  }, Shelf)));
}
