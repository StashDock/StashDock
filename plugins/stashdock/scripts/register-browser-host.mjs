import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
export async function registerBrowserHost({
  env = process.env,
  platform = process.platform,
  run = exec,
  root = new URL('../', import.meta.url),
  ensure = false,
} = {}) {
  if (!['win32','darwin'].includes(platform) || env.STASHDOCK_NATIVE_HOST_REGISTRATION === 'off') return;
  try {
    const helper = new URL(platform === 'darwin' ? `bin/darwin-${process.arch}/stashdock-browser` : 'bin/win32-x64/stashdock-browser.exe', root);
    await run(fileURLToPath(helper), [ensure ? '--ensure' : '--register', 'plugin'], {
      env, windowsHide: true, timeout: 5000, maxBuffer: 65_536,
    });
  } catch { process.stderr.write('StashDock browser save component registration failed. Reinstall the latest plugin.\n'); }
}
