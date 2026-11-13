import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPluginUpdates } from '../plugins/stashdock/server/plugin-updates.mjs';

const repository = 'owner/stashdock';
const release = (tag, assets, extra = {}) => ({ tag_name: tag, html_url: `https://github.com/${repository}/releases/tag/${tag}`, assets: assets.map(name => ({ name })), ...extra });
const answer = releases => async (url, init) => {
  assert.equal(url, `https://api.github.com/repos/${repository}/releases?per_page=30`);
  assert.equal(init.redirect, 'error');
  return new Response(JSON.stringify(releases), { status: 200 });
};

test('plugin update check finds the newest plugin package among releases', async () => {
  const releases = [
    release('desktop-v0.9.0', ['StashDock_0.9.0_x64-setup.exe']),
    release('plugin-v0.5.1', ['stashdock-plugin-0.5.1-win32-x64.zip'], { prerelease: true }),
    release('plugin-v0.5.0', ['stashdock-plugin-0.5.0-win32-x64.zip']),
    release('plugin-v0.4.30', ['stashdock-plugin-0.4.30-win32-x64.zip']),
    release('plugin-v0.6.0', ['stashdock-plugin-0.6.0-win32-x64.zip'], { draft: true }),
  ];
  assert.deepEqual(await checkPluginUpdates({ repository, current: '0.4.28', target: 'win32-x64', fetchImpl: answer(releases) }),
    { status: 'available', version: '0.5.0', url: `https://github.com/${repository}/releases/tag/plugin-v0.5.0` });
  assert.equal((await checkPluginUpdates({ repository, current: '0.5.0', target: 'win32-x64', fetchImpl: answer(releases) })).status, 'current');
  assert.equal((await checkPluginUpdates({ repository, current: '0.10.0', target: 'win32-x64', fetchImpl: answer(releases) })).status, 'current');
});

test('plugin update check only compares the package built for this computer', async () => {
  const releases = [
    release('plugin-v0.6.0', ['stashdock-plugin-0.6.0-darwin-arm64.zip']),
    release('plugin-v0.5.0', ['stashdock-plugin-0.5.0-win32-x64.zip', 'stashdock-plugin-0.5.0-darwin-arm64.zip']),
  ];
  assert.equal((await checkPluginUpdates({ repository, current: '0.5.0', target: 'win32-x64', fetchImpl: answer(releases) })).status, 'current');
  assert.deepEqual(await checkPluginUpdates({ repository, current: '0.5.0', target: 'darwin-arm64', fetchImpl: answer(releases) }),
    { status: 'available', version: '0.6.0', url: `https://github.com/${repository}/releases/tag/plugin-v0.6.0` });
});

test('DSH checks its own platform asset without treating ChatGPT releases as updates', async () => {
  const releases = [
    release('v1.4.0', ['stashdock-plugin-1.4.0-win32-x64.zip']),
    release('v1.3.0', ['stashdock-dsh-1.3.0-darwin-arm64.tgz']),
    release('v1.2.0', ['stashdock-dsh-1.2.0-win32-x64.tgz']),
  ];
  const options = { repository, current: '1.1.0', target: 'win32-x64', pluginKind: 'dsh' };
  assert.deepEqual(await checkPluginUpdates({ ...options, fetchImpl: answer(releases) }),
    { status: 'available', version: '1.2.0', url: `https://github.com/${repository}/releases/tag/v1.2.0` });
  assert.equal((await checkPluginUpdates({ ...options, fetchImpl: answer(releases.slice(0, 2)) })).status, 'unconfigured');
  assert.equal((await checkPluginUpdates({ ...options, pluginKind: 'chatgpt', fetchImpl: answer(releases) })).version, '1.4.0');
});

test('plugin update check ignores foreign pages and reports no release honestly', async () => {
  const foreign = [{ html_url: 'https://evil.example/releases/x', assets: [{ name: 'stashdock-plugin-9.0.0-win32-x64.zip' }] }];
  assert.equal((await checkPluginUpdates({ repository, current: '0.4.28', fetchImpl: answer(foreign) })).status, 'unconfigured');
  assert.equal((await checkPluginUpdates({ repository, current: '0.4.28', fetchImpl: answer([]) })).status, 'unconfigured');
  assert.deepEqual(await checkPluginUpdates({ repository: '', current: '0.4.28', fetchImpl: () => assert.fail('no request') }), { status: 'unconfigured', version: null, url: null });
});

test('plugin update check failures use the shared desktop copy', async () => {
  await assert.rejects(checkPluginUpdates({ repository, current: '0.4.28', fetchImpl: async () => { throw TypeError('fetch failed'); } }), /Check your connection and try again/);
  await assert.rejects(checkPluginUpdates({ repository, current: '0.4.28', fetchImpl: async () => new Response('', { status: 403 }) }), /Try again later/);
  await assert.rejects(checkPluginUpdates({ repository, current: '0.4.28', fetchImpl: async () => new Response('{', { status: 200 }) }), /could not be read/);
});
