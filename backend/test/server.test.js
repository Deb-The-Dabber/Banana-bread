'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const http = require('node:http');
const zlib = require('node:zlib');
const { PNG } = require('pngjs');
const {
  ACCESSIBLE_PALETTE,
  analyzeChart,
  assignPaletteIndices,
  createServer,
  downscalePng,
  extractJsonFromModelReply,
  recolorPng,
  recolorPngBuffer,
  validateAnalysis
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
   series. Padded with white so no region trips the probable-background rule
   (>60% of all pixels) the way a real series never would. */
function threeColorPng({ red, blue, green }) {
  const total = Math.max(red + blue + green, Math.ceil((red + blue + green) / 0.4));
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
  for (let i = index; i < width * height; i++) {
    png.data[i * 4] = 255; png.data[i * 4 + 1] = 255; png.data[i * 4 + 2] = 255; png.data[i * 4 + 3] = 255;
  }
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

/* ---------------- AI analysis endpoint ---------------- */

const CANNED_ANALYSIS = {
  chart_type: 'bar',
  summary: 'A bar chart with red and green series that may confuse red-green deficient viewers.',
  findings: [
    { severity: 'high', issue: 'Red and green bars are hard to tell apart', where: 'the two series', suggestion: 'Use blue and orange instead.' },
    { severity: 'nonsense-severity', issue: 'Truncated ' + 'x'.repeat(600), where: 42, suggestion: null }
  ],
  color_series: [
    { label: 'Workshop A', color: 'red' },
    { label: 'Workshop B', color: 'green' },
    { label: 7, color: '' }
  ],
  recolor_plan: [
    { from: '#DC2B32', to: '#0072B2', label: 'Workshop A', reason: 'blue survives all three deficiency types' },
    { from: '#2CA02C', to: '#E69F00', label: 42, reason: 'label must be a string to survive' },
    { from: 'not-a-hex', to: '#123456', reason: 'dropped: malformed from' },
    { from: '#ABCDEF', to: 'blue', reason: 'dropped: malformed to' },
    { from: '#112233', to: '#112233', reason: 'dropped: no-op' }
  ],
  uncertainty: 'Cannot read exact values.'
};

function stubUpstream(handler) {
  return new Promise(resolve => {
    const stub = http.createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        try { handler(request, response, body); }
        catch (error) { response.writeHead(500); response.end(String(error)); }
      });
    });
    stub.listen(0, '127.0.0.1', () => resolve({ stub, url: `http://127.0.0.1:${stub.address().port}` }));
  });
}

function completion(content) {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });
}

function withAiEnv(overrides, run) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  return run().finally(() => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

test('analyze: reports clear 503 when no AI key is configured', async () => {
  await withAiEnv({ CHARTSAFE_AI_KEY: '' }, async () => {
    const response = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:5500' },
      body: multipartUpload(samplePng())
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /CHARTSAFE_AI_KEY/);
  });
});

test('analyze: GET is rejected with 405 like the recolor route', async () => {
  const response = await fetch(`${baseUrl}/api/analyze`);
  assert.equal(response.status, 405);
});

test('analyze: full happy path through a stubbed upstream provider', async () => {
  const { stub, url } = await stubUpstream((request, response, body) => {
    assert.equal(request.url, '/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer test-key');
    const payload = JSON.parse(body);
    assert.equal(payload.model, 'test/vision-model');
    const content = payload.messages[0].content;
    assert.equal(content[0].type, 'text');
    assert.match(content[0].text, /color-vision accessibility/);
    assert.match(content[0].text, /recolor_plan/);
    /* The prompt must carry the measured cluster hexes of the sample image
       so the model's plan targets real colors. */
    assert.match(content[0].text, /#c45c50/);
    assert.match(content[0].text, /#729545/);
    assert.equal(content[1].type, 'image_url');
    assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(completion('```json\n' + JSON.stringify(CANNED_ANALYSIS) + '\n```'));
  });
  try {
    await withAiEnv({
      CHARTSAFE_AI_KEY: 'test-key',
      CHARTSAFE_AI_BASE: url,
      CHARTSAFE_AI_MODEL: 'test/vision-model'
    }, async () => {
      const response = await fetch(`${baseUrl}/api/analyze`, {
        method: 'POST',
        headers: { Origin: 'http://localhost:5500' },
        body: multipartUpload(samplePng())
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.model, 'test/vision-model');
      assert.equal(payload.analysis.chart_type, 'bar');
      assert.match(payload.analysis.summary, /red and green/);
      /* The validator must have coerced the bad severity and dropped junk. */
      assert.equal(payload.analysis.findings.length, 2);
      assert.ok(payload.analysis.findings.every(f => ['high', 'medium', 'low'].includes(f.severity)));
      assert.ok(payload.analysis.findings.every(f => f.issue.length <= 500));
      assert.equal(payload.analysis.findings[1].severity, 'medium');
      assert.equal(payload.analysis.findings[1].where, '');
      assert.equal(payload.analysis.color_series.length, 2);
      /* Only the two well-formed, distinct hex pairs survive validation. */
      assert.equal(payload.analysis.recolor_plan.length, 2);
      assert.equal(payload.analysis.recolor_plan[0].from, '#dc2b32');
      assert.equal(payload.analysis.recolor_plan[0].to, '#0072b2');
      assert.equal(payload.analysis.recolor_plan[0].label, 'Workshop A');
      assert.equal(payload.analysis.recolor_plan[1].label, '', 'non-string labels are dropped, entry kept');
      assert.equal(payload.analysis.uncertainty, 'Cannot read exact values.');
    });
  } finally {
    await new Promise(resolve => stub.close(resolve));
  }
});

test('analyze: rejects non-PNG uploads before calling the provider', async () => {
  const { stub, url } = await stubUpstream(() => { throw new Error('upstream must not be called'); });
  try {
    await withAiEnv({ CHARTSAFE_AI_KEY: 'k', CHARTSAFE_AI_BASE: url }, async () => {
      const response = await fetch(`${baseUrl}/api/analyze`, {
        method: 'POST',
        headers: { Origin: 'http://localhost:5500' },
        body: multipartUpload(Buffer.from('not a png at all'), { type: 'image/png' })
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /not a valid PNG/);
    });
  } finally {
    await new Promise(resolve => stub.close(resolve));
  }
});

test('analyze: upstream failures surface as honest 502 errors', async () => {
  const cases = [
    { status: 500, expect: /HTTP 500/ },
    { status: 401, expect: /rejected the configured key/ },
    /* Upstream rate limits pass through as 429 — honest, not masked as 502. */
    { status: 429, expectedStatus: 429, expect: /rate-limiting/ },
    { status: 200, body: completion('I cannot answer that.'), expect: /did not contain a usable analysis/ },
    { status: 200, body: completion('{"summary": ""}'), expect: /did not contain a usable analysis/ },
    { status: 200, body: 'not json at all', expect: /malformed response/ }
  ];
  for (const scenario of cases) {
    const { stub, url } = await stubUpstream((request, response) => {
      response.writeHead(scenario.status, { 'Content-Type': 'application/json' });
      response.end(scenario.body || JSON.stringify({ error: 'upstream broke' }));
    });
    try {
      await withAiEnv({ CHARTSAFE_AI_KEY: 'k', CHARTSAFE_AI_BASE: url }, async () => {
        const response = await fetch(`${baseUrl}/api/analyze`, {
          method: 'POST',
          headers: { Origin: 'http://localhost:5500' },
          body: multipartUpload(samplePng())
        });
        assert.equal(response.status, scenario.expectedStatus || 502, `scenario ${JSON.stringify(scenario.status)}`);
        assert.match((await response.json()).error, scenario.expect);
      });
    } finally {
      await new Promise(resolve => stub.close(resolve));
    }
  }
});

test('analyze: CORS preflight works for the analyze route', async () => {
  const preflight = await fetch(`${baseUrl}/api/analyze`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5500', 'Access-Control-Request-Method': 'POST' }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5500');
});

test('downscalePng preserves aspect ratio and uniform colors', () => {
  const png = new PNG({ width: 2400, height: 1200 });
  for (let y = 0; y < 1200; y++) {
    for (let x = 0; x < 2400; x++) {
      const i = (y * 2400 + x) * 4;
      if (x < 1200) png.data.set([220, 30, 30, 255], i);
      else png.data.set([255, 255, 255, 255], i);
    }
  }
  const out = downscalePng(PNG.sync.read(PNG.sync.write(png)));
  assert.ok(Math.max(out.width, out.height) <= 1024);
  assert.equal(Math.round(out.width / out.height), 2);
  /* Uniform regions keep their color through the box average. */
  const left = [...out.data.subarray(0, 4)];
  const right = [...out.data.subarray((out.width - 1) * 4, (out.width - 1) * 4 + 4)];
  assert.ok(Math.abs(left[0] - 220) <= 2 && Math.abs(left[1] - 30) <= 2, `left=${left}`);
  assert.deepEqual(right, [255, 255, 255, 255]);

  const small = PNG.sync.read(samplePng());
  assert.equal(downscalePng(small), small, 'small images must pass through untouched');
});

test('validateAnalysis drops junk and refuses empty payloads', () => {
  assert.equal(validateAnalysis(null), null);
  assert.equal(validateAnalysis('string'), null);
  assert.equal(validateAnalysis({ summary: '' }), null);
  const good = validateAnalysis(CANNED_ANALYSIS);
  assert.equal(good.findings.length, 2);
  assert.equal(good.findings[1].severity, 'medium');
  assert.equal(good.findings[1].where, '');
  assert.equal(good.color_series.length, 2);
  assert.equal(good.recolor_plan.length, 2, 'malformed and no-op plan entries are dropped');
});

test('extractJsonFromModelReply tolerates fences and prose', () => {
  const payload = { summary: 'ok' };
  assert.deepEqual(extractJsonFromModelReply('```json\n' + JSON.stringify(payload) + '\n```'), payload);
  assert.deepEqual(extractJsonFromModelReply('Sure! ' + JSON.stringify(payload)), payload);
  assert.deepEqual(extractJsonFromModelReply(JSON.stringify(payload)), payload);
  assert.equal(extractJsonFromModelReply('no json here'), null);
});

test('recoloring leaves probable backgrounds and out-of-band dark pixels unchanged', () => {
  /* Dark-theme chart: navy canvas covering ~94% of the image plus two small
     series and a near-black saturated edge pixel beside the red bar. */
  const png = new PNG({ width: 600, height: 400 });
  for (let i = 0; i < 600 * 400; i++) png.data.set([25, 42, 90, 255], i * 4);
  for (let x = 60; x < 560; x++) for (let y = 100; y < 140; y++) png.data.set([220, 60, 50, 255], (y * 600 + x) * 4);
  for (let x = 60; x < 560; x++) for (let y = 200; y < 240; y++) png.data.set([60, 180, 70, 255], (y * 600 + x) * 4);
  png.data.set([70, 20, 18, 255], (99 * 600 + 59) * 4); /* near-black, chromatic, next to the red bar */
  const raw = PNG.sync.write(png);
  const { png: outPng, report, backgrounds } = recolorPng(raw);
  const out = PNG.sync.read(outPng);

  /* The background must stay untouched and not appear in the report. */
  assert.deepEqual([...out.data.subarray(0, 4)], [25, 42, 90, 255]);
  assert.equal(report.color_groups, 2, 'only the two series are mapped');
  assert.equal(backgrounds.length, 1);
  assert.ok(backgrounds[0].share > 0.6);

  /* The series bars are recolored… */
  const redBefore = [...png.data.subarray((100 * 600 + 60) * 4, (100 * 600 + 60) * 4 + 3)];
  const redAfter = [...out.data.subarray((100 * 600 + 60) * 4, (100 * 600 + 60) * 4 + 3)];
  assert.notDeepEqual(redBefore, redAfter);

  /* …but the near-black edge pixel is NOT tinted (luminance band applies to
     mapping too, symmetric with detection). */
  const darkIndex = (99 * 600 + 59) * 4;
  assert.deepEqual([...out.data.subarray(darkIndex, darkIndex + 4)], [70, 20, 18, 255]);
});

test('analyze: falls through to the next model on capacity errors', async () => {
  let calls = 0;
  const { stub, url } = await stubUpstream((request, response, body) => {
    calls++;
    if (calls === 1) {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'capacity' }));
      return;
    }
    const payload = JSON.parse(body);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(completion(JSON.stringify({ ...CANNED_ANALYSIS, summary: `answered by ${payload.model}` })));
  });
  try {
    await withAiEnv({
      CHARTSAFE_AI_KEY: 'k',
      CHARTSAFE_AI_BASE: url,
      CHARTSAFE_AI_MODEL: 'first/model,second/model'
    }, async () => {
      const response = await fetch(`${baseUrl}/api/analyze`, {
        method: 'POST',
        headers: { Origin: 'http://localhost:5500' },
        body: multipartUpload(samplePng())
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.model, 'second/model', 'must report the model that actually answered');
      assert.match(payload.analysis.summary, /answered by second\/model/);
      assert.equal(calls, 2, 'exactly one attempt per model');
    });
  } finally {
    await new Promise(resolve => stub.close(resolve));
  }
});

test('analyze: model that returns unusable JSON falls through too', async () => {
  const { stub, url } = await stubUpstream((request, response, body) => {
    const payload = JSON.parse(body);
    if (payload.model === 'prose/model') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(completion('I looked at the chart and it seemed fine.'));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(completion(JSON.stringify(CANNED_ANALYSIS)));
  });
  try {
    await withAiEnv({
      CHARTSAFE_AI_KEY: 'k',
      CHARTSAFE_AI_BASE: url,
      CHARTSAFE_AI_MODEL: 'prose/model,json/model'
    }, async () => {
      const response = await fetch(`${baseUrl}/api/analyze`, {
        method: 'POST',
        headers: { Origin: 'http://localhost:5500' },
        body: multipartUpload(samplePng())
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).model, 'json/model');
    });
  } finally {
    await new Promise(resolve => stub.close(resolve));
  }
});

/* ---------------- AI concept image (nano banana + cosmos) ---------------- */

const TINY_PNG_B64 = PNG.sync.write((() => {
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < 16; i++) png.data.set([200, 60, 60, 255], i * 4);
  return png;
})()).toString('base64');

const ISOLATED_CREDENTIALS = '/nonexistent-credentials-for-tests.json';

const VERTEX_RESPONSE = JSON.stringify({
  candidates: [{ content: { parts: [
    { text: 'here is your chart' },
    { inlineData: { mimeType: 'image/png', data: TINY_PNG_B64 } }
  ] } }]
});

function withImageEnv(overrides, run) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  return run().finally(() => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

test('concept: reports clear 503 when no image provider is configured', async () => {
  await withImageEnv({
    CHARTSAFE_IMAGE_CREDENTIALS: ISOLATED_CREDENTIALS,
    CHARTSAFE_IMAGE_TOKEN: '',
    CHARTSAFE_COSMOS_KEY: ''
  }, async () => {
    const response = await fetch(`${baseUrl}/api/concept`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:5500', 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'a nice chart' })
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /application default credentials|not configured/);
  });
});

test('concept: nano-banana happy path through a stubbed Vertex upstream', async () => {
  const { stub, url } = await stubUpstream((request, response, body) => {
    assert.match(request.url, /\/v1\/projects\/banana-bread-db\/locations\/us-central1\/publishers\/google\/models\/gemini-3.1-flash-image:generateContent$/);
    assert.equal(request.headers.authorization, 'Bearer stub-image-token');
    const payload = JSON.parse(body);
    assert.equal(payload.contents[0].role, 'user');
    assert.equal(payload.contents[0].parts[0].text, 'a nice chart');
    assert.deepEqual(payload.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(VERTEX_RESPONSE);
  });
  try {
    await withImageEnv({
      CHARTSAFE_IMAGE_TOKEN: 'stub-image-token',
      CHARTSAFE_IMAGE_BASE: url,
      CHARTSAFE_COSMOS_KEY: ''
    }, async () => {
      const response = await fetch(`${baseUrl}/api/concept`, {
        method: 'POST',
        headers: { Origin: 'http://localhost:5500', 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'a nice chart' })
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.match(payload.image, /^data:image\/png;base64,/);
      assert.equal(payload.model, 'gemini-3.1-flash-image');
    });
  } finally {
    await new Promise(resolve => stub.close(resolve));
  }
});

test('concept: falls back to cosmos when the Google login is unavailable', async () => {
  const { stub, url } = await stubUpstream((request, response, body) => {
    const payload = JSON.parse(body);
    assert.equal(payload.model_mode, 'text2image', 'fallback must use the cosmos contract');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ b64_image: TINY_PNG_B64 }));
  });
  try {
    await withImageEnv({
      CHARTSAFE_IMAGE_CREDENTIALS: ISOLATED_CREDENTIALS,
      CHARTSAFE_IMAGE_TOKEN: '',
      CHARTSAFE_COSMOS_KEY: 'cosmos-key',
      CHARTSAFE_COSMOS_URL: url
    }, async () => {
      const response = await fetch(`${baseUrl}/api/concept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'a nice chart' })
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.model, 'cosmos3-nano');
    });
  } finally {
    await new Promise(resolve => stub.close(resolve));
  }
});

test('concept: rejects bad prompts and upstream failures honestly', async () => {
  await withImageEnv({
    CHARTSAFE_IMAGE_TOKEN: 'stub-image-token',
    CHARTSAFE_IMAGE_BASE: 'http://127.0.0.1:1',
    CHARTSAFE_COSMOS_KEY: ''
  }, async () => {
    for (const [prompt, expect] of [['', 400], ['x'.repeat(1001), 400]]) {
      const response = await fetch(`${baseUrl}/api/concept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      });
      assert.equal(response.status, expect);
    }
    /* Stubbed Vertex endpoint that answers like a broken upstream. */
    const { stub, url } = await stubUpstream((request, response) => {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'no route' }));
    });
    try {
      await withImageEnv({
        CHARTSAFE_IMAGE_TOKEN: 'stub-image-token',
        CHARTSAFE_IMAGE_BASE: url,
        CHARTSAFE_COSMOS_KEY: ''
      }, async () => {
        const response = await fetch(`${baseUrl}/api/concept`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'a nice chart' })
        });
        assert.equal(response.status, 502);
        assert.match((await response.json()).error, /HTTP 404/);
      });
    } finally {
      await new Promise(resolve => stub.close(resolve));
    }
  });
});

test('concept: CORS preflight works', async () => {
  const preflight = await fetch(`${baseUrl}/api/concept`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5500', 'Access-Control-Request-Method': 'POST' }
  });
  assert.equal(preflight.status, 204);
});
