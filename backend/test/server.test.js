'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const zlib = require('node:zlib');
const { PNG } = require('pngjs');
const {
  ACCESSIBLE_PALETTE,
  assignPaletteIndices,
  createServer,
  recolorPng,
  recolorPngBuffer
} = require('../server');

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

/* PNG with three flat color regions (red, blue, green) of controllable size,
   mimicking a chart with a dominant colored block (e.g. a title) and smaller
   series. */
function threeColorPng({ red, blue, green }) {
  const total = red + blue + green;
  const width = 10;
  const height = Math.ceil(total / width);
  const png = new PNG({ width, height });
  let index = 0;
  const fill = (count, [r, g, b]) => {
    for (let k = 0; k < count; k++) {
      png.data[index * 4] = r;
      png.data[index * 4 + 1] = g;
      png.data[index * 4 + 2] = b;
      png.data[index * 4 + 3] = 255;
      index++;
    }
  };
  fill(red, [196, 60, 40]);
  fill(blue, [40, 90, 200]);
  fill(green, [40, 160, 80]);
  return PNG.sync.write(png);
}

/* Minimal raw-PNG writer for formats pngjs must normalize on read
   (16-bit depth, grayscale, palette). */
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of body) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, crcBuffer]);
}

function rawPng({ width, height, bitDepth, colorType, rows, extraChunks = [] }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    ...extraChunks,
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function multipartUpload(buffer, { field = 'image', type = 'image/png', name = 'chart.png' } = {}) {
  const body = new FormData();
  body.append(field, new Blob([buffer], { type }), name);
  return body;
}

function pixel(png, index) {
  return [...png.data.subarray(index * 4, index * 4 + 4)];
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

test('returns a factual X-ChartSafe-Report computed from the processed image', async () => {
  const response = await fetch(`${baseUrl}/api/recolor`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:5500' },
    body: multipartUpload(samplePng())
  });
  assert.equal(response.status, 200);

  const header = response.headers.get('x-chartsafe-report');
  assert.ok(header, 'report header must be present on recolor responses');
  const report = JSON.parse(header);
  assert.equal(report.version, 1);
  assert.equal(report.color_groups, 2, 'the sample has exactly two chromatic clusters');
  assert.equal(report.mapping.length, 2);
  for (const entry of report.mapping) {
    assert.deepEqual(entry.from, entry.from.map(v => Math.round(v)));
    assert.match(entry.to, /^#[0-9a-f]{6}$/i);
    assert.ok(ACCESSIBLE_PALETTE.includes(entry.to), 'targets must be palette entries');
    assert.equal(typeof report.note, 'string');
  }
  /* The detected source colors must match the fixture's actual pixels. */
  const sources = report.mapping.map(entry => entry.from).sort((a, b) => a[0] - b[0]);
  assert.ok(sources.some(c => Math.abs(c[0] - 196) <= 2 && Math.abs(c[1] - 92) <= 2));
  assert.ok(sources.some(c => Math.abs(c[0] - 114) <= 2 && Math.abs(c[1] - 149) <= 2));
  /* Two clusters must claim two distinct palette entries. */
  assert.notEqual(report.mapping[0].to, report.mapping[1].to);
});

test('maps the same source colors to the same palette entries regardless of region sizes', () => {
  const redDominant = recolorPng(threeColorPng({ red: 10000, blue: 1000, green: 1000 }));
  const blueDominant = recolorPng(threeColorPng({ red: 1000, blue: 10000, green: 1000 }));

  const bySource = report => Object.fromEntries(report.mapping.map(entry => [entry.from.join(','), entry.to]));
  assert.deepEqual(bySource(redDominant.report), bySource(blueDominant.report));

  /* Color identity drives the assignment: red maps to the vermillion entry,
     not to whichever slot its pixel count wins. */
  const expected = {
    '196,60,40': '#D55E00',
    '40,90,200': '#0072B2',
    '40,160,80': '#009E73'
  };
  for (const entry of redDominant.report.mapping) {
    assert.equal(entry.to, expected[entry.from.join(',')]);
  }
  /* Detected clusters are the same three colors in both charts. */
  assert.deepEqual(
    redDominant.report.mapping.map(entry => entry.from.join(',')).sort(),
    blueDominant.report.mapping.map(entry => entry.from.join(',')).sort()
  );
});

test('assignPaletteIndices depends only on the color set, not cluster order', () => {
  const palette = ACCESSIBLE_PALETTE.map(hex => [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)));
  const red = { color: [196, 60, 40], count: 10000 };
  const blue = { color: [40, 90, 200], count: 1000 };
  const green = { color: [40, 160, 80], count: 1000 };
  /* Compare the color -> palette-entry map produced from different cluster
     orderings; positional arrays naturally differ when the input order does. */
  const byColor = (clusters, assignment) =>
    Object.fromEntries(clusters.map((cluster, index) => [cluster.color.join(','), assignment[index]]));
  const one = byColor([red, blue, green], assignPaletteIndices([red, blue, green], palette));
  const two = byColor([blue, green, red], assignPaletteIndices([blue, green, red], palette));
  const three = byColor([green, red, blue], assignPaletteIndices([green, red, blue], palette));
  assert.deepEqual(one, two);
  assert.deepEqual(one, three);
  assert.equal(one['196,60,40'], ACCESSIBLE_PALETTE.indexOf('#D55E00'));
});

test('exposes the report header cross-origin and answers preflights for allowed origins only', async () => {
  const preflight = await fetch(`${baseUrl}/api/recolor`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5500',
      'Access-Control-Request-Method': 'POST'
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5500');
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(preflight.headers.get('access-control-expose-headers'), 'X-ChartSafe-Report');

  const response = await fetch(`${baseUrl}/api/recolor`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:5500' },
    body: multipartUpload(samplePng())
  });
  assert.equal(response.headers.get('access-control-expose-headers'), 'X-ChartSafe-Report');
  assert.equal(response.headers.get('vary'), 'Origin');

  const blockedPreflight = await fetch(`${baseUrl}/api/recolor`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://not-allowed.example',
      'Access-Control-Request-Method': 'POST'
    }
  });
  assert.equal(blockedPreflight.status, 403);
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

test('rejects non-PNG payloads, wrong field names, and multiple files', async () => {
  const notPng = await fetch(`${baseUrl}/api/recolor`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:5500' },
    body: multipartUpload(Buffer.from('definitely not a png'.repeat(100)), { type: 'image/png' })
  });
  assert.equal(notPng.status, 400);
  assert.match((await notPng.json()).error, /not a valid PNG/);

  const wrongField = await fetch(`${baseUrl}/api/recolor`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:5500' },
    body: multipartUpload(samplePng(), { field: 'file' })
  });
  assert.equal(wrongField.status, 400);

  const twoFiles = new FormData();
  twoFiles.append('image', new Blob([samplePng()], { type: 'image/png' }), 'a.png');
  twoFiles.append('image', new Blob([samplePng()], { type: 'image/png' }), 'b.png');
  const duplicated = await fetch(`${baseUrl}/api/recolor`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:5500' },
    body: twoFiles
  });
  assert.equal(duplicated.status, 400);
});

test('enforces the 10 MB multipart upload limit', async () => {
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 4096);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversized);
  const response = await fetch(`${baseUrl}/api/recolor`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:5500' },
    body: multipartUpload(oversized)
  });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /10 MB/);
});

test('rejects a PNG header with truncated pixel data as a client error', async () => {
  const full = samplePng();
  const truncated = full.subarray(0, 40);
  const response = await fetch(`${baseUrl}/api/recolor`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:5500' },
    body: multipartUpload(truncated)
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /not a valid PNG/);
});

test('leaves charts without dominant chromatic colors unchanged and reports zero groups', async () => {
  const png = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data.set([120, 120, 120, 255], i);
  }
  const input = PNG.sync.write(png);
  const response = await fetch(`${baseUrl}/api/recolor`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:5500' },
    body: multipartUpload(input)
  });
  assert.equal(response.status, 200);
  const report = JSON.parse(response.headers.get('x-chartsafe-report'));
  assert.equal(report.color_groups, 0);
  assert.deepEqual(report.mapping, []);
  const output = PNG.sync.read(Buffer.from(await response.arrayBuffer()));
  assert.deepEqual([...output.data], [...png.data]);
});

test('normalizes grayscale and 16-bit PNG variants without breaking recoloring', async () => {
  const gray = rawPng({
    width: 4, height: 4, bitDepth: 8, colorType: 0,
    rows: [0, 40, 90, 140, 190, 240, 20, 70, 120, 170, 220, 10, 60, 110, 160, 210, 100]
      .reduce((rows, value, index) => {
        const rowIndex = Math.floor(index / 5);
        rows[rowIndex] = rows[rowIndex] || [0];
        rows[rowIndex].push(value);
        return rows;
      }, [])
      .map(values => Buffer.from(values.slice(0, 5)))
  });
  const grayResponse = await fetch(`${baseUrl}/api/recolor`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:5500' },
    body: multipartUpload(gray)
  });
  assert.equal(grayResponse.status, 200);
  const grayOut = PNG.sync.read(Buffer.from(await grayResponse.arrayBuffer()));
  assert.equal(grayOut.width, 4);
  assert.equal(grayOut.height, 4);

  const samples = Buffer.alloc(2 * 4 * 2);
  for (let i = 0; i < samples.length; i += 8) {
    samples[i] = 0xC4; samples[i + 2] = 0x5C; samples[i + 4] = 0x50; samples[i + 6] = 0xFF;
  }
  const sixteenBit = rawPng({
    width: 2, height: 1, bitDepth: 16, colorType: 6,
    rows: [Buffer.concat([Buffer.from([0]), samples])]
  });
  const deepResponse = await fetch(`${baseUrl}/api/recolor`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:5500' },
    body: multipartUpload(sixteenBit)
  });
  assert.equal(deepResponse.status, 200);
  const deepOut = PNG.sync.read(Buffer.from(await deepResponse.arrayBuffer()));
  assert.equal(deepOut.width, 2);
  assert.equal(deepOut.height, 1);
  /* The red pixel family must survive the 16-bit -> 8-bit normalization. */
  const red = pixel(deepOut, 0).slice(0, 3);
  assert.ok(Math.abs(red[0] - 213) <= 45 && Math.abs(red[1] - 94) <= 45, `unexpected red mapping: ${red}`);
});

test('produces deterministic output for identical input', () => {
  const input = samplePng();
  assert.deepEqual(recolorPngBuffer(input), recolorPngBuffer(input));
});

test('sets explicit socket timeouts', () => {
  assert.equal(server.headersTimeout, 60_000);
  assert.equal(server.requestTimeout, 120_000);
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

test('serves the app at the root and a redirect at the legacy standalone route', async () => {
  const app = await fetch(baseUrl);
  assert.equal(app.status, 200);
  const appHtml = await app.text();
  assert.match(appHtml, /A clearer picture\.<br><em>For everyone\./);
  assert.match(appHtml, /id="download"/);

  const legacy = await fetch(`${baseUrl}/chartsafe-v2-html.html`);
  assert.equal(legacy.status, 200);
  const legacyHtml = await legacy.text();
  assert.match(legacyHtml, /http-equiv="refresh"/);
  assert.match(legacyHtml, /content="0; url=\.\/"/);
  assert.match(legacyHtml, /site root/);
  assert.doesNotMatch(legacyHtml, /<canvas/);
});

test('no longer serves the removed legacy assets', async () => {
  for (const path of ['/app.js', '/simulation.js', '/styles.css']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, `${path} should be gone`);
  }
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
