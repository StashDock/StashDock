// Only match the package built for this plugin host and machine.
const releaseAssets = {
  chatgpt: { prefix: 'stashdock-plugin', extension: 'zip' },
  dsh: { prefix: 'stashdock-dsh', extension: 'tgz' },
};
const parse = value => { const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value)); return match ? match.slice(1).map(Number) : null; };
const newer = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };

export async function checkPluginUpdates({ repository, current, pluginKind = 'chatgpt', target = `${process.platform}-${process.arch}`, fetchImpl = fetch }) {
  const { prefix, extension } = releaseAssets[pluginKind];
  const assetPattern = new RegExp(`^${prefix}-(\\d+)\\.(\\d+)\\.(\\d+)-${target.replace(/[^\w-]/g, '')}\\.${extension}$`);
  if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository)) return { status: 'unconfigured', version: null, url: null };
  const installed = parse(current);
  if (!installed) throw Error('The installed version is invalid.');
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repository}/releases?per_page=30`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `StashDock-plugin/${current}` },
      redirect: 'error', signal: AbortSignal.timeout(12_000),
    });
  } catch { throw Error('Updates could not be checked. Check your connection and try again.'); }
  if (!response.ok) throw Error('Updates could not be checked. Try again later.');
  // Release metadata is untrusted and bounded; only asset names and the page URL are used.
  const raw = await response.text();
  if (raw.length > 2_000_000) throw Error('The update response is too large.');
  let releases;
  try { releases = JSON.parse(raw); } catch { throw Error('The update response could not be read.'); }
  if (!Array.isArray(releases)) throw Error('The update response could not be read.');
  let best = null;
  for (const release of releases) {
    if (!release || release.draft || release.prerelease || !Array.isArray(release.assets)) continue;
    const page = typeof release.html_url === 'string' && release.html_url.startsWith(`https://github.com/${repository}/releases/`) ? release.html_url : null;
    for (const asset of release.assets) {
      const match = assetPattern.exec(asset?.name || '');
      if (!match || !page) continue;
      const version = match.slice(1).map(Number);
      if (!best || newer(version, best.version)) best = { version, url: page };
    }
  }
  if (!best) return { status: 'unconfigured', version: null, url: null };
  const version = best.version.join('.');
  return newer(best.version, installed) ? { status: 'available', version, url: best.url } : { status: 'current', version, url: best.url };
}
