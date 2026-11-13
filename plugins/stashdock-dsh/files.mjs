import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';

export const MAX_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_BATCH_BYTES = 1024 * 1024 * 1024;

function validIds(ids) {
  return Array.isArray(ids) && ids.length > 0 && ids.length <= 30 && new Set(ids).size === ids.length &&
    ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200);
}

// Paths come exclusively from the shared library's original-file resolver.
// These fixed routes inherit DSH's authenticated, local-owner connection.
export function registerFiles(ctx, connect, isClosed) {
  const resolve = async (id, signal) => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'get_stashdock_file', arguments: { id } }, undefined, { signal });
    const file = result.structuredContent;
    if (result.isError || !file || file.id !== id || typeof file.path !== 'string' ||
        typeof file.filename !== 'string' || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) {
      throw Error('The original file is unavailable.');
    }
    if (file.sizeBytes > MAX_FILE_BYTES) throw Error('The file exceeds the 512 MB attachment limit.');
    return file;
  };
  for (const endpoint of ['files', 'file']) ctx.connection.fetch.register({
    path: `/api/stashdock/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      if (isClosed()) return new Response(null, { status: 503 });
      if (request.headers.get('content-type') !== 'application/json') return new Response(null, { status: 415 });
      const payload = await request.json().catch(() => null);
      const ids = endpoint === 'files' ? payload?.ids : [payload?.id];
      if (!validIds(ids)) return new Response(null, { status: 400 });
      let handle;
      try {
        const files = [];
        for (const id of ids) files.push(await resolve(id, request.signal));
        if (files.reduce((sum, file) => sum + file.sizeBytes, 0) > MAX_BATCH_BYTES) {
          throw Error('The selection exceeds the 1 GB attachment limit.');
        }
        request.signal.throwIfAborted();
        if (endpoint === 'files') return Response.json(files.map(({ id, filename, mimeType, sizeBytes }) =>
          ({ id, filename, mimeType, sizeBytes })), { headers: { 'cache-control': 'no-store' } });
        const file = files[0];
        handle = await open(file.path, 'r');
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== file.sizeBytes) throw Error('The file changed. Retry adding it.');
        const stream = handle.createReadStream({ signal: request.signal, start: 0, end: Math.max(0, stat.size - 1) });
        handle = undefined; // The stream owns and closes the descriptor, including cancellation.
        return new Response(Readable.toWeb(stream), { headers: {
          'content-type': 'application/octet-stream', 'content-length': String(stat.size),
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        } });
      } catch (error) {
        await handle?.close();
        if (request.signal.aborted) return new Response(null, { status: 408 });
        return Response.json({ error: error.code ? 'The original file is unavailable.' : error.message },
          { status: 422, headers: { 'cache-control': 'no-store' } });
      }
    },
  });
}
