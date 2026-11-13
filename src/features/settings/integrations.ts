export type IntegrationId = 'chrome' | 'edge' | 'firefox' | 'safari' | 'codex' | 'dsh' | 'claude' | 'desktop';
export type IntegrationState = { id: IntegrationId; detected: boolean; version?: string };
export type IntegrationInfo = { items: IntegrationState[]; platform?: string; links?: Partial<Record<IntegrationId, string | null>>; githubUrl?: string | null };
export const browsers: IntegrationId[] = productLinks.publicBrowserExtensions as IntegrationId[];
export const agents: IntegrationId[] = ['codex', 'dsh', 'claude'];
const browserPurpose = 'Save pages while you browse.';
export const referencePurpose = 'Browse your library and use references as context in conversations.';
const agentPurpose = referencePurpose;
export const integrationCatalog: Record<IntegrationId, { name: string; ready: boolean; purpose: string }> = {
  chrome: { name: 'Chrome', ready: true, purpose: browserPurpose },
  edge: { name: 'Edge', ready: true, purpose: browserPurpose },
  firefox: { name: 'Firefox', ready: true, purpose: browserPurpose },
  safari: { name: 'Safari', ready: false, purpose: browserPurpose },
  codex: { name: 'ChatGPT', ready: true, purpose: agentPurpose },
  dsh: { name: 'DeepSeek Harness', ready: true, purpose: agentPurpose },
  claude: { name: 'Claude', ready: false, purpose: agentPurpose },
  desktop: { name: 'StashDock Desktop', ready: true, purpose: 'Browse and manage your references visually in a standalone desktop app. Bring them into any AI app.' },
};
export function integrationReady(id: IntegrationId, info: IntegrationInfo | null): boolean {
  return integrationCatalog[id].ready || (id === 'safari' && info?.platform === 'macos');
}
export const safariSetupSteps = [
  'Open StashDock Desktop on your Mac.',
  'In Safari, choose Settings → Extensions and enable StashDock Companion.',
  'Open a page and click StashDock in the Safari toolbar.',
] as const;
export const aiSetupSteps = [
  'Copy the GitHub link below.',
  'Paste it into {name} and ask it to install the StashDock plugin for {name}.',
  'After installation, fully quit and reopen {name}.',
  'Open StashDock from the side panel.',
] as const;
export function applicationWebsite(id: IntegrationId): string | null {
  return (productLinks.applications as Record<string, { website: string | null }>)[id]?.website || null;
}
export function githubUrl(info: IntegrationInfo | null): string | null {
  try { const url = new URL(info?.githubUrl || ''); return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && /^\/[\w.-]+\/[\w.-]+\/?$/.test(url.pathname) ? url.href : null; } catch { return null; }
}
type IntegrationGuide = { title: string; description: string; steps: readonly string[] };
const browserGuide = (name: string): IntegrationGuide => ({
  title: `Save pages from ${name}`,
  description: 'Keep useful pages as references for future AI conversations.',
  steps: ['Open a page you want to save.', 'Click the StashDock extension to review its title and content.', 'Add tags if needed, then click Save page.'],
});
export const integrationGuides: Partial<Record<IntegrationId, IntegrationGuide>> = {
  chrome: browserGuide('Chrome'), edge: browserGuide('Edge'), firefox: browserGuide('Firefox'), safari: browserGuide('Safari'),
  codex: {
    title: 'Use references in ChatGPT',
    description: referencePurpose,
    steps: ['Open StashDock from the side panel.', 'Add a reference directly, or select several.', 'Click Add to chat for your selection, then write your question.'],
  },
  dsh: {
    title: 'Use references in DeepSeek Harness',
    description: referencePurpose,
    steps: ['Open a conversation and select StashDock in the right sidebar.', 'Add a reference directly, or select several.', 'Click Add to chat for your selection, then write your question.'],
  },
  desktop: {
    title: 'Use StashDock Desktop',
    description: referencePurpose,
    steps: ['Save links, write notes, or add files.', 'Organize references with tags and favorites.', 'Drag references into your AI app, or use Copy for AI and paste.'],
  },
};
export function installationUrl(info: IntegrationInfo | null, id: IntegrationId): string | null {
  const value = info?.links?.[id];
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
import productLinks from '../../../src-tauri/product-links.json';
