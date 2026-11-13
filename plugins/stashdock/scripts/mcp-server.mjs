// Portable, bundled SDK server. Rebuild with `npm run plugin:build` in the repo.
import { registerBrowserHost } from './register-browser-host.mjs';
import { restoreWindowsDataDirectory } from './windows-data-directory.mjs';
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) throw new Error('StashDock requires Node.js 22.13 or newer for its independent local SQLite library.');
restoreWindowsDataDirectory();
await registerBrowserHost();
const { run } = await import('../dist/mcp-server.mjs');
await run(new URL('../web/shelf.html', import.meta.url));
