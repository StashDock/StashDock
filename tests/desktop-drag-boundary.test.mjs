import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';

test('grey drag surfaces retain native dragging and exclude interactive controls', async () => {
  const dom = new JSDOM('<div id="grey"><button><span id="control">Control</span></button></div><section id="portal"><div role="menuitem"><span id="menu-label">Rename tag</span></div></section>');
  const names = ['window', 'isTauri'];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'isTauri', { value: true, configurable: true });
  try {
    const built = await build({ entryPoints: ['src/lib/desktopWindows.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['@tauri-apps/api/*'] });
    const module = { exports: {} };
    new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
    const calls = [];
    mockIPC(command => { calls.push(command); }); mockWindows('main');
    let prevented = 0;
    const event = { currentTarget: dom.window.document.getElementById('grey'), target: dom.window.document.getElementById('grey'), button: 0, detail: 1, preventDefault: () => { prevented++; } };
    module.exports.handleTitlebarDrag(event, true);
    await Promise.resolve();
    assert.deepEqual(calls, ['plugin:window|start_dragging']);
    assert.equal(prevented, 1);
    for (const blocked of [{ ...event, target: dom.window.document.getElementById('control') }, { ...event, button: 2 }, { ...event, detail: 2 }]) module.exports.handleTitlebarDrag(blocked, true);
    module.exports.handleTitlebarDrag(event, false);
    await Promise.resolve();
    assert.equal(calls.length, 1);
    // React portal events bubble through the component tree even though the
    // menu is outside the grey chrome in the DOM. They must keep their click.
    const menuEvent = { ...event, target: dom.window.document.getElementById('menu-label') };
    module.exports.handleTitlebarDrag(menuEvent, true);
    module.exports.handleTitlebarDoubleClick(menuEvent, true);
    await Promise.resolve();
    assert.deepEqual(calls, ['plugin:window|start_dragging'], 'a portalled menu must neither drag nor maximize the native window');
    assert.equal(prevented, 1, 'menu pointer events must remain available for selection');
    module.exports.handleTitlebarDoubleClick(event, true);
    await Promise.resolve();
    assert.deepEqual(calls, ['plugin:window|start_dragging', 'plugin:window|toggle_maximize']);
  } finally {
    clearMocks(); dom.window.close();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  }
});
