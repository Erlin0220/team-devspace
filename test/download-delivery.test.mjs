import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DOWNLOAD_TARGETS, packageName } from '../scripts/download-catalog.mjs';
import { verifyRemote } from '../scripts/publish-downloads.mjs';

const origin = 'https://downloads.example.test';
function fixture({ corrupt = false, ignoreRange = false, shortRange = false } = {}) {
  const bytes = Buffer.alloc(200000, 7);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const catalog = { schema: 1, version: '1.0.0', commit: 'a'.repeat(40), targets: Object.fromEntries(
    DOWNLOAD_TARGETS.map(target => [target, { file: packageName('1.0.0', target), size: bytes.length, sha256 }])) };
  let fullGets = 0, rangeBytes = 0;
  const fetcher = async (url, options = {}) => {
    if (url.endsWith('/catalog.json')) return new Response(`${JSON.stringify(catalog, null, 2)}\n`);
    if (url.endsWith('.sha256')) return new Response(`${sha256}\n`);
    const headers = { ETag: '"fixture-v1"', 'Accept-Ranges': 'bytes', 'Content-Length': String(bytes.length) };
    if (options.method === 'HEAD') return new Response(null, { headers });
    if (options.headers?.Range && !ignoreRange) {
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range).map(Number);
      const part = bytes.subarray(start, shortRange ? end : end + 1);
      rangeBytes += part.length;
      return new Response(part, { status: 206, headers: { ...headers,
        'Content-Length': String(part.length), 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } });
    }
    fullGets++;
    return new Response(corrupt ? Buffer.alloc(bytes.length, 8) : bytes, { headers });
  };
  return { catalog, fetcher, counts: () => ({ fullGets, rangeBytes }) };
}

test('normal public delivery verification is bounded, covers both ends, and performs no full package GET', async () => {
  const f = fixture();
  await verifyRemote(origin, f.catalog, { fetcher: f.fetcher });
  assert.deepEqual(f.counts(), { fullGets: 0, rangeBytes: 4 * 2 * 65536 });
});

test('range rejection or truncation stops publication instead of silently reading a whole package', async () => {
  for (const settings of [{ ignoreRange: true }, { shortRange: true }]) {
    const f = fixture(settings);
    await assert.rejects(verifyRemote(origin, f.catalog, { fetcher: f.fetcher }), /Resumable|Truncated/);
  }
});

test('explicit full HTTPS verification still detects corruption outside the sampled ranges', async () => {
  const healthy = fixture();
  await verifyRemote(origin, healthy.catalog, { fetcher: healthy.fetcher, full: true });
  assert.equal(healthy.counts().fullGets, 4);
  const corrupt = fixture({ corrupt: true });
  await assert.rejects(verifyRemote(origin, corrupt.catalog, { fetcher: corrupt.fetcher, full: true }), /checksum mismatch/);
});
