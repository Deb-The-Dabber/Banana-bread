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

test('parseReportHeader accepts the documented backend report and rejects everything else', () => {
  const context = runIsolated(`${extractFunction(script, 'parseReportHeader')}`);
  const parse = context.parseReportHeader;
  const valid = JSON.stringify({
    version: 1,
    color_groups: 2,
    mapping: [
      { from: [196, 92, 80], to: '#D55E00' },
      { from: [114, 149, 69], to: '#009E73' }
    ],
    note: 'Heuristic dominant-color mapping from pixel statistics; not an accessibility certification.'
  });
  const parsed = parse(valid);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.color_groups, 2);
  assert.equal(parsed.mapping.length, 2);

  assert.equal(parse(null), null);
  assert.equal(parse(''), null);
  assert.equal(parse('not json'), null);
  assert.equal(parse('"a string"'), null);
  assert.equal(parse('[1,2,3]'), null);
  assert.equal(parse('{"version":2,"color_groups":1}'), null);
  assert.equal(parse('{"version":1,"color_groups":"2"}'), null);
  assert.equal(parse('{"version":1,"color_groups":-1}'), null);
  assert.equal(parse('{"version":1,"color_groups":10}'), null);
  assert.equal(parse('{"version":1,"color_groups":2.5}'), null);
  assert.equal(parse('{"version":1,"color_groups":2,"mapping":[]}'), null, 'mapping length must match color_groups');
  assert.equal(parse('{"version":1,"color_groups":1,"mapping":[{"from":[1,2],"to":"#000000"}]}'), null);
  assert.equal(parse('{"version":1,"color_groups":1,"mapping":[{"from":[1,2,300],"to":"#000000"}]}'), null);
  assert.equal(parse('{"version":1,"color_groups":1,"mapping":[{"from":[1,2,3],"to":"black"}]}'), null);
  /* mapping is optional: a bare group count is still a valid report. */
  assert.equal(parse('{"version":1,"color_groups":0}').color_groups, 0);
});

test('describeReport states facts without inventing accessibility scores', () => {
  const context = runIsolated(`${extractFunction(script, 'describeReport')}`);
  const describe = context.describeReport;
  const zero = describe({ color_groups: 0 });
  assert.match(zero, /No dominant chart colors were detected, so the image was left unchanged/);
  assert.match(zero, /heuristic/);
  assert.match(describe({ color_groups: 1 }), /1 dominant color group was mapped/);
  assert.match(describe({ color_groups: 3 }), /3 dominant color groups were mapped/);
  for (const groups of [0, 1, 3]) {
    assert.doesNotMatch(describe({ color_groups: groups }), /pass|score|certif/i);
  }
});

test('defaultEndpoint never points a GitHub Pages host at a nonexistent same-origin API', () => {
  const cases = [
    [{ protocol: 'https:', hostname: 'deb-the-dabber.github.io', origin: 'https://deb-the-dabber.github.io' }, ''],
    [{ protocol: 'https:', hostname: 'user.github.io', origin: 'https://user.github.io' }, ''],
    [{ protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1:8000' }, 'http://127.0.0.1:8000/api/recolor'],
    [{ protocol: 'https:', hostname: 'chartsafe.example', origin: 'https://chartsafe.example' }, 'https://chartsafe.example/api/recolor'],
    [{ protocol: 'file:', hostname: '', origin: 'null' }, 'http://127.0.0.1:8000/api/recolor']
  ];
  for (const [location, expected] of cases) {
    const context = runIsolated(`${extractFunction(script, 'defaultEndpoint')}`, { location });
    assert.equal(context.defaultEndpoint(), expected, `${location.protocol}//${location.hostname}`);
  }
});

test('the shipped markup applies the vision mode to both panels and keeps the recolored panel visible', () => {
  /* Normal mode shows both images side by side in true colors; every other
     mode applies the same simulation to both panels; the corrected card is
     never hidden by mode switching. */
  assert.match(script, /renderOne\('before','before-empty',state\.original,state\.mode,'Original chart'\)/);
  assert.match(script, /renderOne\('after','after-empty',state\.corrected,state\.mode,'Recolored chart'\)/);
  assert.match(script, /\$\('corrected-card'\)\.hidden=false/);
  assert.doesNotMatch(script, /corrected-card'\)\.hidden=!simulating/);
  assert.doesNotMatch(script, /renderOne\('before','before-empty',state\.original,'normal'/);
});

test('the shipped markup no longer dangles score UI that no backend implements', () => {
  for (const gone of ['lowestGap', 'passes_all', 'series_found', 'Scores appear here', '20+ passes']) {
    assert.ok(!html.includes(gone), `docs/index.html still mentions ${gone}`);
  }
  for (const present of ['parseReportHeader', 'X-ChartSafe-Report', 'defaultEndpoint', 'not a certification of accessibility']) {
    assert.ok(html.includes(present), `docs/index.html is missing ${present}`);
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
