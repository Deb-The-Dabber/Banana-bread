'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { PNG } = require('pngjs');
const { ACCESSIBLE_PALETTE, createServer, recolorPngBuffer } = require('../server');

let server;
let baseUrl;

function samplePng() {
  const png = new PNG({ width: 24, height: 12 });
  const colors = [
    [255, 255, 255, 255],
    [196, 92, 80, 255],
    [114, 149, 69, 128],
    [128, 128, 128, 255]
  ];
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const color = colors[x < 6 ? 0 : x < 12 ? 1 : x < 18 ? 2 : 3];
      png.data.set(color, (y * png.width + x) * 4);
    }
  }
  return PNG.sync.write(png);
}

before(async () => {
  server = createServer(new Set(['http://localhost:5500']));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('recolors chromatic chart colors while preserving neutral pixels and alpha', () => {
  const input = samplePng();
  const original = PNG.sync.read(input);
  const output = PNG.sync.read(recolorPngBuffer(input));
  const pixel = (png, x) => [...png.data.subarray(x * 4, x * 4 + 4)];

  assert.deepEqual(pixel(output, 0), [255, 255, 255, 255]);
  assert.deepEqual(pixel(output, 18), [128, 128, 128, 255]);
  assert.deepEqual(pixel(output, 12).slice(3), [128]);
  assert.notDeepEqual(pixel(output, 6).slice(0, 3), pixel(original, 6).slice(0, 3));
  assert.notDeepEqual(pixel(output, 12).slice(0, 3), pixel(original, 12).slice(0, 3));
  assert.equal(ACCESSIBLE_PALETTE.length, 6);
});

test('rejects oversized PNG dimensions before decoding pixel data', () => {
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(100_000, 16);
  header.writeUInt32BE(100_000, 20);
  assert.throws(() => recolorPngBuffer(header), { statusCode: 413 });
});

test('accepts multipart PNGs and returns a same-size image with CORS headers', async () => {
  const body = new FormData();
  body.append('image', new Blob([samplePng()], { type: 'image/png' }), 'chart.png');
  const response = await fetch(`${baseUrl}/api/recolor`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:5500' },
    body
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5500');
  const output = PNG.sync.read(Buffer.from(await response.arrayBuffer()));
  assert.equal(output.width, 24);
  assert.equal(output.height, 12);
});

test('rejects unknown origins and malformed uploads clearly', async () => {
  const blocked = await fetch(`${baseUrl}/api/recolor`, {
    method: 'POST',
    headers: { Origin: 'https://not-allowed.example' }
  });
  assert.equal(blocked.status, 403);

  const empty = await fetch(`${baseUrl}/api/recolor`, { method: 'POST' });
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /multipart\/form-data/);
});

test('exposes a health endpoint', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });

  const sameOrigin = await fetch(`${baseUrl}/health`, {
    headers: { Origin: baseUrl }
  });
  assert.equal(sameOrigin.status, 200);
});

test('serves the standalone page at both local app routes', async () => {
  const app = await fetch(baseUrl);
  assert.equal(app.status, 200);
  const appHtml = await app.text();
  assert.match(appHtml, /A clearer picture\.<br><em>For everyone\./);

  const standalone = await fetch(`${baseUrl}/chartsafe-v2-html.html`);
  assert.equal(standalone.status, 200);
  assert.equal(await standalone.text(), appHtml);
});

test('serves the landing page and its locally installed Anime.js bundle', async () => {
  const landing = await fetch(`${baseUrl}/landing.html`);
  assert.equal(landing.status, 200);
  assert.match(landing.headers.get('content-type'), /text\/html/);
  assert.match(await landing.text(), /src="\/animejs\.js"/);

  const anime = await fetch(`${baseUrl}/animejs.js`);
  assert.equal(anime.status, 200);
  assert.match(anime.headers.get('content-type'), /javascript/);
  assert.ok((await anime.arrayBuffer()).byteLength > 10_000);
});
