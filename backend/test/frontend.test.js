'use strict';

/* Tests for the frontend as shipped in docs/index.html.
   The app is a single self-contained page (inline CSS + JS), so these tests
   extract the relevant pieces of THAT file and exercise them in Node —
   they fail if someone edits the HTML without keeping the script valid.
   No DOM is involved: only the pure logic (simulation math, report
   validation, endpoint defaulting) plus static assertions on the markup. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const htmlPath = path.join(__dirname, '..', '..', 'docs', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

function inlineScript() {
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, 'docs/index.html must contain exactly one inline <script>');
  return match[1];
}

/* Extract `function name(...) { ... }` with naive brace matching. Safe for
   the functions tested here: braces inside their strings/regexes/template
   expressions are balanced pairs. */
function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `function ${name} not found in docs/index.html`);
  let depth = 0;
  let index = source.indexOf('{', start);
  for (; index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  assert.ok(index < source.length, `function ${name} is unbalanced`);
  return source.slice(start, index + 1);
}

function extractSimulationModule(source) {
  const start = source.indexOf('const ChartSafeSimulation = (() => {');
  assert.ok(start !== -1, 'simulation module not found');
  const end = source.indexOf('})();', start);
  assert.ok(end !== -1, 'simulation module terminator not found');
  return source.slice(start, end + 5);
}

function extractModule(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `${marker} not found`);
  const end = source.indexOf('})();', start);
  assert.ok(end !== -1, `${marker} terminator not found`);
  return source.slice(start, end + 5);
}

function runIsolated(code, globals = {}) {
  const context = vm.createContext({ ...globals });
  vm.runInContext(code, context);
  return context;
}

/* Independent transcription of the published simulation math (Machado,
   Oliveira & Fernandes 2009, severity 1.0, linear-light sRGB) used as an
   oracle against the shipped module. */
const MACHADO_MATRICES = {
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881],
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900]
};
function oracleLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function oracleEncode(c) {
  c = Math.max(0, Math.min(1, c));
  return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
}
function oracleSimulate(bytes, mode) {
  const m = MACHADO_MATRICES[mode];
  const out = new Uint8ClampedArray(bytes.length);
  for (let i = 0; i < bytes.length; i += 4) {
    const r = oracleLinear(bytes[i]);
    const g = oracleLinear(bytes[i + 1]);
    const b = oracleLinear(bytes[i + 2]);
    out[i] = oracleEncode(m[0] * r + m[1] * g + m[2] * b);
    out[i + 1] = oracleEncode(m[3] * r + m[4] * g + m[5] * b);
    out[i + 2] = oracleEncode(m[6] * r + m[7] * g + m[8] * b);
    out[i + 3] = bytes[i + 3];
  }
  return out;
}

const script = inlineScript();
/* const bindings do not outlive the script that declares them, so read the
   module back through an appended expression inside the same script. */
const simulation = vm.runInContext(
  `${extractSimulationModule(script)}\nChartSafeSimulation`,
  vm.createContext({})
);

test('the shipped inline script parses as valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(script));
});

test('normal mode is the identity transform', () => {
  const bytes = new Uint8ClampedArray([196, 92, 80, 255, 40, 90, 200, 128, 0, 0, 0, 255]);
  assert.deepEqual([...simulation.simulate(bytes, 'normal')], [...bytes]);
});

test('simulation never mutates the source pixels', () => {
  const bytes = new Uint8ClampedArray([196, 92, 80, 255, 40, 90, 200, 255]);
  const before = [...bytes];
  for (const mode of ['deuteranopia', 'protanopia', 'tritanopia']) {
    simulation.simulate(bytes, mode);
  }
  assert.deepEqual([...bytes], before);
});

test('unknown simulation modes are rejected instead of guessed', () => {
  const bytes = new Uint8ClampedArray([1, 2, 3, 255]);
  assert.throws(() => simulation.simulate(bytes, 'achromatopsia'), /Unknown simulation mode/);
});

test('black and white are preserved by every simulation', () => {
  const white = new Uint8ClampedArray([255, 255, 255, 255]);
  const black = new Uint8ClampedArray([0, 0, 0, 255]);
  for (const mode of ['deuteranopia', 'protanopia', 'tritanopia']) {
    assert.deepEqual([...simulation.simulate(white, mode)], [255, 255, 255, 255], `${mode} white`);
    assert.deepEqual([...simulation.simulate(black, mode)], [0, 0, 0, 255], `${mode} black`);
  }
});

test('shipped simulation matches the published Machado formulas', () => {
  const colors = [
    [255, 0, 0], [0, 255, 0], [0, 0, 255],
    [255, 255, 0], [0, 255, 255], [255, 0, 255],
    [196, 60, 40], [40, 90, 200], [40, 160, 80],
    [120, 120, 120], [13, 200, 240], [250, 128, 114]
  ];
  const bytes = new Uint8ClampedArray(colors.flat().flatMap(c => [c[0], c[1], c[2], 255]));
  for (const mode of ['deuteranopia', 'protanopia', 'tritanopia']) {
    assert.deepEqual([...simulation.simulate(bytes, mode)], [...oracleSimulate(bytes, mode)], mode);
  }
  /* Spot check a widely known qualitative result: pure red under
     deuteranopia collapses toward an olive/brown tone, not toward blue. */
  const red = new Uint8ClampedArray([255, 0, 0, 255]);
  const deuteranopiaRed = simulation.simulate(red, 'deuteranopia');
  assert.equal(deuteranopiaRed[0], 163);
  assert.equal(deuteranopiaRed[1], 144);
  assert.equal(deuteranopiaRed[2], 0);
});

test('the Original box is never simulated; the right preview carries the selected view', () => {
  /* The original keeps its true colors in every mode; the selected vision
     view is applied only to the right preview, which shows the corrected
     image when one is loaded and otherwise a clearly-labeled simulation of
     the original. */
  assert.match(script, /renderOne\('before','before-empty',state\.original,'normal','Original chart'\)/);
  assert.match(script, /renderOne\('after','after-empty',state\.corrected \|\| \(simulating\?state\.original:null\),state\.mode/);
  assert.match(script, /\$\('corrected-card'\)\.hidden=false/);
  assert.doesNotMatch(script, /renderOne\('before','before-empty',state\.original,state\.mode/);
  assert.match(script, /'Simulation · '/);
  assert.match(script, /'Simulation only'/);
});

test('the shipped UI contains no recoloring service machinery', () => {
  for (const gone of ['id="fix"', 'id="endpoint"', 'Connect recoloring service', 'Recolor chart', 'api/recolor']) {
    assert.ok(!html.includes(gone), `docs/index.html still contains ${gone}`);
  }
});

test('the shipped markup no longer dangles score UI that no backend implements', () => {
  for (const gone of ['lowestGap', 'passes_all', 'series_found', 'Scores appear here', '20+ passes', 'X-ChartSafe-Report']) {
    assert.ok(!html.includes(gone), `docs/index.html still mentions ${gone}`);
  }
  assert.ok(html.includes('not a certification of accessibility'), 'the non-certification disclaimer must stay');
});

test('the in-page recolorer matches the backend algorithm byte for byte', () => {
  const { PNG } = require('pngjs');
  const { recolorPng } = require('../server');
  const RECOLOR = vm.runInContext(
    `${extractModule(script, 'const RECOLOR = (() => {')}\nRECOLOR`,
    vm.createContext({})
  );
  const recolor = RECOLOR.recolor;
  const fixtures = [];

  /* Mixed fixture: white, chromatic red, half-transparent chromatic, neutral gray. */
  {
    const png = new PNG({ width: 24, height: 12 });
    const colors = [[255, 255, 255, 255], [196, 92, 80, 255], [114, 149, 69, 128], [128, 128, 128, 255]];
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        png.data.set(colors[x < 6 ? 0 : x < 12 ? 1 : x < 18 ? 2 : 3], (y * png.width + x) * 4);
      }
    }
    fixtures.push(['mixed sample', PNG.sync.write(png)]);
  }
  /* Three-series chart with a dominant region. */
  {
    const png = new PNG({ width: 10, height: 1400 });
    for (let i = 0; i < 10000; i++) png.data.set([196, 60, 40, 255], i * 4);
    for (let i = 10000; i < 11000; i++) png.data.set([40, 90, 200, 255], i * 4);
    for (let i = 11000; i < 12000; i++) png.data.set([40, 160, 80, 255], i * 4);
    fixtures.push(['three-series', PNG.sync.write(png)]);
  }
  /* No chromatic pixels at all. */
  {
    const png = new PNG({ width: 8, height: 8 });
    for (let i = 0; i < 64; i++) png.data.set([120, 120, 120, 255], i * 4);
    fixtures.push(['all-gray', PNG.sync.write(png)]);
  }
  /* Dark-theme chart: probable background (94% of pixels), two series, and a
     near-black chromatic edge pixel that must not be tinted. */
  {
    const png = new PNG({ width: 200, height: 140 });
    for (let i = 0; i < 200 * 140; i++) png.data.set([25, 42, 90, 255], i * 4);
    for (let x = 20; x < 180; x++) for (let y = 40; y < 60; y++) png.data.set([220, 60, 50, 255], (y * 200 + x) * 4);
    for (let x = 20; x < 180; x++) for (let y = 80; y < 100; y++) png.data.set([60, 180, 70, 255], (y * 200 + x) * 4);
    png.data.set([70, 20, 18, 255], (39 * 200 + 19) * 4);
    fixtures.push(['dark-theme', PNG.sync.write(png)]);
  }
  /* A real chart from the repo (matplotlib colors, anti-aliasing, 2400x1200). */
  const realChart = path.join(__dirname, '..', '..', 'BananaHacks', 'chart_01.png');
  if (fs.existsSync(realChart)) fixtures.push(['real chart', fs.readFileSync(realChart)]);

  assert.ok(fixtures.length >= 3, 'expected several fixtures');

  for (const [name, buffer] of fixtures) {
    const input = PNG.sync.read(buffer);
    const inputPixels = new Uint8ClampedArray(input.data);
    const backendResult = recolorPng(buffer);
    const backend = PNG.sync.read(backendResult.png);
    const backendReport = backendResult.report;

    const before = [...inputPixels];
    const { data: frontend, colorGroups } = recolor(inputPixels);
    assert.equal(inputPixels.length, before.length, `${name}: input length changed`);
    assert.ok(before.every((v, i) => v === inputPixels[i]), `${name}: input pixels were mutated`);

    assert.equal(frontend.length, backend.data.length, `${name}: output length differs`);
    for (let i = 0; i < frontend.length; i++) {
      assert.equal(frontend[i], backend.data[i], `${name}: pixel differs at ${i} (frontend ${frontend[i]} vs backend ${backend.data[i]})`);
    }
    assert.equal(colorGroups, backendReport.color_groups, `${name}: color group count differs`);
  }

  /* The dark-theme fixture locks the luminance-band and background behavior
     on both implementations: background pixel and near-black edge pixel are
     untouched, the series bars are recolored. */
  {
    const dark = fixtures.find(([name]) => name === 'dark-theme');
    const input = PNG.sync.read(dark[1]);
    const backendResult = recolorPng(dark[1]);
    const backendOut = PNG.sync.read(backendResult.png);
    const { data: frontendOut } = recolor(new Uint8ClampedArray(input.data));
    const at = (data, index) => [...data.subarray(index * 4, index * 4 + 4)];
    const bgIndex = 5 * 200 + 5;
    const darkEdge = 39 * 200 + 19;
    assert.deepEqual(at(backendOut.data, bgIndex), [25, 42, 90, 255], 'backend background changed');
    assert.deepEqual([...frontendOut.subarray(bgIndex * 4, bgIndex * 4 + 4)], [25, 42, 90, 255], 'frontend background changed');
    assert.deepEqual(at(backendOut.data, darkEdge), [70, 20, 18, 255], 'backend tinted a near-black pixel');
    assert.deepEqual([...frontendOut.subarray(darkEdge * 4, darkEdge * 4 + 4)], [70, 20, 18, 255], 'frontend tinted a near-black pixel');
    assert.equal(backendResult.backgrounds.length, 1);
    assert.equal(backendResult.report.color_groups, 2);
  }
});

test('auto-generation is wired into the chart load flow', () => {
  assert.match(script, /recolorItem\(item\)/);
  assert.match(script, /RECOLOR\.recolor\(data/);
  assert.match(script, /'Generated in browser'/);
  assert.match(script, /state\.generated=true/);
  /* The generated blob must flow into the download path unchanged. */
  assert.match(script, /let blob=state\.corrected\.blob/);
});

test('any image format is accepted and decoded safely', () => {
  assert.match(html, /accept="image\/\*"/);
  assert.match(script, /async function decodeImage\(/);
  assert.ok(!html.includes('accept="image/png"'), 'inputs must not be PNG-only');
  assert.ok(!script.includes('async function decodePNG'), 'the PNG-only decoder is gone');
  /* PNG dimension caps are checked BEFORE decoding (memory safety). */
  assert.match(script, /view\.getUint32\(16\)/);
  /* Undecodable files fail with an honest message. */
  assert.match(script, /could not be decoded as an image/);
});

test('AI-directed legend machinery is present and honest', () => {
  assert.match(script, /async function applyLegend\(/);
  assert.match(script, /function removeLegend\(/);
  assert.match(script, /function emptiestCorner\(/);
  assert.match(script, /function legendEntries\(/);
  assert.match(html, /Add legend \(AI-named\)/);
  assert.match(html, /Remove legend/);
  assert.match(script, /AI named the series, the app drew the box/);
  assert.match(script, /state\.legendOn/);
});

test('matchPlan maps AI hexes to detected groups within tolerance, injectively', () => {
  const context = vm.createContext({});
  vm.runInContext(
    `${extractModule(script, 'const RECOLOR = (() => {')}\n${extractFunction(script, 'matchPlan')}\nmatchPlan`,
    context
  );
  const matchPlan = vm.runInContext('matchPlan', context);
  const groups = [
    { from: [255, 127, 14], to: [0, 0, 0] },
    { from: [31, 119, 180], to: [0, 0, 0] }
  ];
  /* Approximate hexes (off by a few units, as a model reading a downscaled
     copy would produce) must still match; a third entry targets nothing. */
  const plan = [
    { from: '#fb8212', to: '#0072b2', reason: 'blue is safe' },
    { from: '#1c74b0', to: '#e69f00', reason: 'contrast with blue' },
    { from: '#994499', to: '#112233', reason: 'no such series' }
  ];
  const labeled = [{ from: '#fb8212', to: '#0072b2', label: 'Mobile', reason: '' }, { from: '#1c74b0', to: '#e69f00', label: 'Desktop', reason: '' }];
  const labeledResult = matchPlan(groups, labeled);
  assert.equal(labeledResult.labels[0], 'Mobile');
  assert.equal(labeledResult.labels[1], 'Desktop');
  const result = matchPlan(groups, plan);
  assert.equal(result.matched, 2);
  assert.equal(result.unmatched, 1);
  assert.deepEqual([...result.overrides[0]], [0, 114, 178]);
  assert.deepEqual([...result.overrides[1]], [230, 159, 0]);
  /* Plan colors too far from any group are not applied. */
  const far = matchPlan(groups, [{ from: '#994499', to: '#112233' }]);
  assert.equal(far.matched, 0);
  assert.deepEqual(Object.keys(far.overrides), []);
});

test('RECOLOR honors AI overrides byte-exactly at the series color', () => {
  const RECOLOR = vm.runInContext(
    `${extractModule(script, 'const RECOLOR = (() => {')}\nRECOLOR`,
    vm.createContext({})
  );
  /* Two solid series: red (45 px — wins the count sort, so it is group 0)
     and blue (35 px). */
  const pixels = new Uint8ClampedArray(80 * 4);
  for (let i = 0; i < 45; i++) pixels.set([220, 60, 50, 255], i * 4);
  for (let i = 45; i < 80; i++) pixels.set([40, 90, 200, 255], i * 4);
  const custom = { 0: [10, 200, 120] };
  const result = RECOLOR.recolor(pixels, custom);
  /* Group 0 (red) must be pulled to the AI's custom green, not the palette. */
  assert.deepEqual([...result.groups[0].to], [10, 200, 120]);
  assert.deepEqual([...result.data.subarray(0, 3)], [10, 200, 120], 'pixel at the cluster color reaches the custom target');
  /* Group 1 (blue) keeps the palette target. */
  assert.equal(result.groups[1].to.join(','), RECOLOR.recolor(pixels).groups[1].to.join(','));
  /* The default (no-override) path keeps red on the palette target. */
  assert.notEqual(RECOLOR.recolor(pixels).groups[0].to.join(','), custom[0].join(','));
});

test('escapeHtml neutralizes markup from untrusted model output', () => {
  const context = runIsolated(`${extractFunction(script, 'escapeHtml')}`);
  const escape = context.escapeHtml;
  const E = c => '\x26' + c + ';';  /* build entities without literal & */
  const scripty = '<' + 'script>alert("x")</' + 'script>';
  const escapedScripty = E('lt') + 'script' + E('gt') + 'alert(' + E('quot') + 'x' + E('quot') + ')' + E('lt') + '/script' + E('gt');
  assert.equal(escape(scripty), escapedScripty);
  assert.equal(escape("a & b 'c'"), 'a ' + E('amp') + ' b ' + E('#39') + 'c' + E('#39'));
  assert.equal(escape('plain text'), 'plain text');
  assert.notEqual(escape(scripty), scripty);
});

test('measured color checks flag confusable pairs and clear the safe palette', () => {
  const context = vm.createContext({});
  /* CVD_CHECKS depends on ChartSafeSimulation; provide both in one script. */
  vm.runInContext(`${extractSimulationModule(script)}\n${extractModule(script, 'const CVD_CHECKS = (() => {')}\nCVD_CHECKS`, context);
  const checks = vm.runInContext('CVD_CHECKS', context);
  const { pairReport, deltaE, LIKELY_ALIKE, MAY_LOOK_SIMILAR } = checks;
  assert.ok(deltaE, 'module exports deltaE');

  /* Realistic red/green chart pair collapses under deuteranopia. */
  const confusable = pairReport([[220, 30, 30], [30, 160, 40]]);
  assert.equal(confusable.pairs.length, 1);
  assert.ok(confusable.pairs[0].minDeltaE < LIKELY_ALIKE, `expected < ${LIKELY_ALIKE}, got ${confusable.pairs[0].minDeltaE}`);
  assert.equal(confusable.pairs[0].minMode, 'deuteranopia');

  /* Okabe-Ito blue/orange stays clearly different everywhere. */
  const safe = pairReport([[0, 114, 178], [230, 159, 0]]);
  assert.ok(safe.pairs[0].minDeltaE > MAY_LOOK_SIMILAR, `expected > ${MAY_LOOK_SIMILAR}, got ${safe.pairs[0].minDeltaE}`);

  /* Normal vision distinguishes red and green (sanity of the metric itself). */
  assert.ok(deltaE([255, 0, 0], [0, 255, 0]) > MAY_LOOK_SIMILAR);
});

test('AI review UI is consent-gated and statically honest', () => {
  assert.match(html, /<dialog id="ai-consent"/);
  assert.match(html, /id="analyze"/);
  assert.match(html, /Nothing is uploaded until you approve/);
  assert.match(html, /AI findings are model interpretations, not verified facts/);
  /* Static hosting must get an explanation, not a dead button. */
  assert.match(script, /location\.hostname\.endsWith\('\.github\.io'\)/);
  assert.match(script, /cannot call the AI provider/);
  /* No key material may ever appear in the shipped page. */
  for (const secret of ['nvapi-', 'sk-or-v1', 'Bearer ', 'CHARTSAFE_AI_KEY=']) {
    assert.ok(!html.includes(secret), `docs/index.html must not contain ${secret}`);
  }
});

test('frontend assets are consolidated: no orphaned duplicates, legacy route redirects', () => {
  const docs = path.join(__dirname, '..', '..', 'docs');
  for (const gone of ['app.js', 'simulation.js', 'styles.css']) {
    assert.ok(!fs.existsSync(path.join(docs, gone)), `docs/${gone} should no longer exist`);
    assert.ok(!html.includes(gone), `docs/index.html should not reference ${gone}`);
  }
  const redirect = fs.readFileSync(path.join(docs, 'chartsafe-v2-html.html'), 'utf8');
  assert.match(redirect, /http-equiv="refresh"/);
  assert.match(redirect, /url=\.\/"/);
  assert.doesNotMatch(redirect, /<canvas/);
});
