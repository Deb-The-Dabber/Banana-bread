'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const Busboy = require('busboy');
const { PNG } = require('pngjs');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8000);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 8_000_000;
const MAX_DIMENSION = 8192;
const CHROMA_THRESHOLD = 48;
const CLUSTER_SEPARATION = 76;
const COLOR_MATCH_DISTANCE = 170;
const ACCESSIBLE_PALETTE = ['#0072B2', '#E69F00', '#009E73', '#D55E00', '#CC79A7', '#56B4E9'];

/* Loads backend/.env (gitignored) so demo credentials never live in code.
   Lines are KEY=VALUE; comments and quotes are tolerated. */
function loadDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const value = match[2].replace(/^["']|["']$/g, '');
      if (!(match[1] in process.env)) process.env[match[1]] = value;
    }
  } catch { /* no .env — environment-only configuration */ }
}
loadDotEnv();

/* AI analysis provider: any OpenAI-compatible chat/completions endpoint that
   accepts image_url content. Defaults to NVIDIA NIM (build.nvidia.com keys).
   Verified-working free alternative (tested 2026-10): OpenRouter serving
   NVIDIA's own vision model — set CHARTSAFE_AI_KEY/BASE/MODEL accordingly.
   Read per request (never cached) so tests and operators can retarget the
   provider without restarting. The key is never committed, never logged. */
function aiConfig() {
  return {
    key: process.env.CHARTSAFE_AI_KEY || '',
    base: (process.env.CHARTSAFE_AI_BASE || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, ''),
    /* Comma-separated list: tried in order. Capacity errors (503/504) and
       rate limits on one model fall through to the next. */
    models: (process.env.CHARTSAFE_AI_MODEL || 'meta/llama-3.2-11b-vision-instruct,nvidia/nemotron-3-nano-omni-30b-a3b-reasoning')
      .split(',')
      .map(model => model.trim())
      .filter(Boolean),
    timeoutMs: Number(process.env.CHARTSAFE_AI_TIMEOUT_MS || 90_000)
  };
}
/* 768px kept the same reading quality on real charts while trimming
   latency; vision models do not need print-resolution pixels. */
const AI_MAX_IMAGE_DIMENSION = 768;
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/landing.html': ['landing.html', 'text/html; charset=utf-8'],
  '/chartsafe-v2-html.html': ['chartsafe-v2-html.html', 'text/html; charset=utf-8']
};

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function colorFromHex(hex) {
  return [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16));
}

function pixelColorKey(r, g, b) {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

function colorDistanceSquared(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

/* Weighted sRGB distance ("redmean"), a cheap perceptual proxy.
   Used only to decide which palette entry each detected color maps to. */
function redmeanDistanceSquared(a, b) {
  const rm = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
}

/* Assign each detected cluster a distinct palette entry, minimizing total
   redmean distance. The search visits clusters in color order (not pixel-count
   order), so the mapping depends only on the set of detected colors: the same
   chart colors get the same palette entries even when unrelated regions grow
   or shrink, and a red cluster maps to the reddish palette entry, not
   whichever slot its pixel count happens to win. */
function assignPaletteIndices(clusters, palette) {
  const visitOrder = clusters
    .map((cluster, index) => ({ color: cluster.color, index }))
    .sort((a, b) => a.color[0] - b.color[0] || a.color[1] - b.color[1] || a.color[2] - b.color[2] || a.index - b.index)
    .map(entry => entry.index);
  const used = new Array(palette.length).fill(false);
  const current = new Array(clusters.length);
  let best = null;
  let bestCost = Infinity;
  const search = (step, cost) => {
    if (cost >= bestCost) return;
    if (step === visitOrder.length) {
      bestCost = cost;
      best = current.slice();
      return;
    }
    const clusterIndex = visitOrder[step];
    for (let paletteIndex = 0; paletteIndex < palette.length; paletteIndex++) {
      if (used[paletteIndex]) continue;
      const stepCost = redmeanDistanceSquared(clusters[clusterIndex].color, palette[paletteIndex]);
      if (cost + stepCost >= bestCost) continue;
      used[paletteIndex] = true;
      current[clusterIndex] = paletteIndex;
      search(step + 1, cost + stepCost);
      used[paletteIndex] = false;
    }
  };
  search(0, 0);
  return best;
}

function isChromatic(r, g, b) {
  return Math.max(r, g, b) - Math.min(r, g, b) >= CHROMA_THRESHOLD;
}

function detectSeriesColors(pixels) {
  const histogram = new Map();
  let chromaticPixels = 0;

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    if (pixels[i + 3] < 128 || !isChromatic(r, g, b)) continue;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luminance < 24 || luminance > 246) continue;

    const key = pixelColorKey(r, g, b);
    let bucket = histogram.get(key);
    if (!bucket) {
      bucket = { count: 0, r: 0, g: 0, b: 0 };
      histogram.set(key, bucket);
    }
    bucket.count++;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    chromaticPixels++;
  }

  const candidates = [...histogram.entries()]
    .map(([key, bucket]) => ({
      key,
      count: bucket.count,
      color: [
        bucket.r / bucket.count,
        bucket.g / bucket.count,
        bucket.b / bucket.count
      ]
    }))
    .sort((a, b) => b.count - a.count || a.key - b.key);

  const minimumCount = Math.max(3, Math.floor(chromaticPixels * 0.0001));
  const clusters = [];
  for (const candidate of candidates) {
    if (candidate.count < minimumCount) break;
    if (clusters.every(cluster =>
      colorDistanceSquared(cluster.color, candidate.color) >= CLUSTER_SEPARATION ** 2
    )) {
      clusters.push(candidate);
      if (clusters.length === ACCESSIBLE_PALETTE.length) break;
    }
  }
  return clusters;
}

function recolorPngBuffer(buffer) {
  const { png } = recolorPng(buffer);
  return png;
}

/* X-ChartSafe-Report schema (JSON, version 1):
   { "version": 1,
     "color_groups": <int 0..6, number of dominant chromatic clusters detected>,
     "mapping": [{ "from": [r, g, b], "to": "#rrggbb" }, ...],
     "note": <string> }
   Every value is computed from the actual processing of this request.
   This is factual bookkeeping about a pixel heuristic — it is NOT an
   accessibility score or certification. */
function buildReport(clusters, assignment) {
  return {
    version: 1,
    color_groups: clusters.length,
    mapping: clusters.map((cluster, index) => ({
      from: cluster.color.map(Math.round),
      to: ACCESSIBLE_PALETTE[assignment[index]]
    })),
    note: 'Heuristic dominant-color mapping from pixel statistics; not an accessibility certification.'
  };
}

/* A cluster covering more than this share of ALL pixels is almost certainly
   a background (dark-theme canvases, slides, screenshots) rather than a data
   series. It is conservatively left unchanged — the failure mode is "less
   recoloring", never a mangled image — and the fact is surfaced to the user
   instead of being guessed away. Real fills stay far below this: the largest
   series in the repo's own sample charts covers ~16%. */
const BACKGROUND_SHARE_THRESHOLD = 0.6;

function recolorPng(buffer) {
  if (
    buffer.length < 24 ||
    !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    buffer.readUInt32BE(8) !== 13 ||
    buffer.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new HttpError(400, 'The uploaded file is not a valid PNG.');
  }
  const headerWidth = buffer.readUInt32BE(16);
  const headerHeight = buffer.readUInt32BE(20);
  if (!headerWidth || !headerHeight || headerWidth * headerHeight > MAX_PIXELS ||
      headerWidth > MAX_DIMENSION || headerHeight > MAX_DIMENSION) {
    throw new HttpError(413, 'Choose a PNG up to 8 megapixels and 8192 pixels per side.');
  }

  const source = PNG.sync.read(buffer);
  const { width, height, data } = source;
  if (!width || !height || width * height > MAX_PIXELS || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new HttpError(413, 'Choose a PNG up to 8 megapixels and 8192 pixels per side.');
  }
  if (data.length !== width * height * 4) {
    throw new HttpError(400, 'The uploaded PNG uses an unsupported pixel layout. Export it as an 8-bit or 16-bit RGBA PNG and try again.');
  }

  const clusters = detectSeriesColors(data);
  /* Mark probable backgrounds; they keep their pixels and never claim a
     palette slot that a real series needs (e.g. a navy canvas stealing the
     blue entry from an actual blue series). */
  const totalPixels = width * height;
  for (const cluster of clusters) {
    cluster.isBackground = cluster.count > totalPixels * BACKGROUND_SHARE_THRESHOLD;
  }
  const activeClusters = clusters.filter(cluster => !cluster.isBackground);
  const palette = ACCESSIBLE_PALETTE.map(colorFromHex);
  const activeAssignment = assignPaletteIndices(activeClusters, palette);
  activeClusters.forEach((cluster, index) => { cluster.paletteIndex = activeAssignment[index]; });
  const recolored = new PNG({ width, height });
  recolored.data.set(data);

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (data[i + 3] < 128 || !isChromatic(r, g, b)) continue;
    /* Symmetry with detection: the same luminance band applies here, so
       near-black text edges and near-white pixels are never tinted even
       when they sit close to a series color. */
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luminance < 24 || luminance > 246) continue;

    let nearest = -1;
    let nearestDistance = Infinity;
    for (let j = 0; j < clusters.length; j++) {
      const distance = colorDistanceSquared([r, g, b], clusters[j].color);
      if (distance < nearestDistance) {
        nearest = j;
        nearestDistance = distance;
      }
    }
    if (nearest < 0 || clusters[nearest].isBackground || nearestDistance >= COLOR_MATCH_DISTANCE ** 2) continue;

    const confidence = Math.max(0, 1 - Math.sqrt(nearestDistance) / COLOR_MATCH_DISTANCE);
    const target = palette[clusters[nearest].paletteIndex];
    recolored.data[i] = Math.round(r + (target[0] - r) * confidence);
    recolored.data[i + 1] = Math.round(g + (target[1] - g) * confidence);
    recolored.data[i + 2] = Math.round(b + (target[2] - b) * confidence);
  }

  const backgrounds = clusters.filter(cluster => cluster.isBackground);
  return {
    png: PNG.sync.write(recolored),
    report: buildReport(activeClusters, activeAssignment),
    backgrounds: backgrounds.map(cluster => ({ color: cluster.color.map(Math.round), share: cluster.count / totalPixels }))
  };
}

/* Deterministic box-average downscale (no dependencies, integer math). Used
   before sending a chart to the AI provider so huge uploads cannot burn
   quota or latency. Aspect ratio is preserved; small images are untouched. */
function downscalePng(png, maxDimension = AI_MAX_IMAGE_DIMENSION) {
  const scale = Math.min(1, maxDimension / Math.max(png.width, png.height));
  if (scale >= 1) return png;
  const width = Math.max(1, Math.floor(png.width * scale));
  const height = Math.max(1, Math.floor(png.height * scale));
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const sy0 = Math.floor((y * png.height) / height);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * png.height) / height));
    for (let x = 0; x < width; x++) {
      const sx0 = Math.floor((x * png.width) / width);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * png.width) / width));
      let r = 0, g = 0, b = 0, a = 0, samples = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * png.width + sx) * 4;
          const alpha = png.data[i + 3];
          /* Weight semi/fully transparent pixels less so a chart on a huge
             transparent canvas is not washed out by empty pixels. */
          const weight = alpha === 0 ? 0 : alpha < 128 ? 0.5 : 1;
          r += png.data[i] * weight;
          g += png.data[i + 1] * weight;
          b += png.data[i + 2] * weight;
          a += alpha;
          samples += weight;
        }
      }
      const o = (y * width + x) * 4;
      if (samples > 0) {
        out.data[o] = Math.round(r / samples);
        out.data[o + 1] = Math.round(g / samples);
        out.data[o + 2] = Math.round(b / samples);
      }
      out.data[o + 3] = Math.min(255, Math.round(a / ((sy1 - sy0) * (sx1 - sx0))));
    }
  }
  return out;
}

/* The analysis contract the model must answer with. Kept deliberately
   compact: small vision models degrade on long schemas and stop emitting
   JSON. The measured dominant series colors are injected per request so the
   model's recolor_plan "from" values match reality exactly instead of being
   guessed from a downscaled copy. */
const ANALYSIS_PROMPT_HEAD = `Analyze this chart image for color-vision accessibility (deuteranopia, protanopia, tritanopia).
Reply with ONLY a JSON object in this exact format:
{"chart_type":"bar|line|pie|scatter|mixed|other|unclear","summary":"1-2 sentences","findings":[{"severity":"high|medium|low","issue":"one sentence","where":"chart part","suggestion":"concrete fix"}],"color_series":[{"label":"series name","color":"color word or hex"}],"recolor_plan":[{"from":"#RRGGBB series color","to":"#RRGGBB accessible replacement of medium lightness, distinct from all other series in lightness AND hue","label":"the series name from the legend if readable","reason":"few words"}],"uncertainty":"one sentence"}
One recolor_plan entry per distinct series color. If you cannot read the chart, use chart_type "unclear" and empty arrays. No prose, no markdown, JSON only.`;

function analysisPromptFor(measuredHexes) {
  const line = measuredHexes.length
    ? ` The measured dominant series colors in this image are: ${measuredHexes.join(', ')}. Use these exact hex values as every recolor_plan "from".
Good candidate targets (optional suggestions, you may choose others): #0072B2 blue, #E69F00 orange, #009E73 bluish green, #D55E00 vermillion, #CC79A7 reddish purple, #56B4E9 sky blue. Never propose pure saturated primaries like #FF0000, #00FF00, #0000FF, #FFFF00.`
    : '';
  return ANALYSIS_PROMPT_HEAD + line;
}

const SEVERITIES = new Set(['high', 'medium', 'low']);

/* Validates and normalizes the model's parsed JSON. Unknown fields are
   dropped; malformed entries are skipped rather than trusted. Returns null
   when the payload is not usable at all. */
function validateAnalysis(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const chartType = typeof payload.chart_type === 'string' ? payload.chart_type : 'unclear';
  const summary = typeof payload.summary === 'string' ? payload.summary : '';
  if (!summary) return null;

  const findings = [];
  if (Array.isArray(payload.findings)) {
    for (const entry of payload.findings) {
      if (typeof entry !== 'object' || entry === null) continue;
      const issue = typeof entry.issue === 'string' ? entry.issue : '';
      if (!issue) continue;
      findings.push({
        severity: SEVERITIES.has(entry.severity) ? entry.severity : 'medium',
        issue: issue.slice(0, 500),
        where: typeof entry.where === 'string' ? entry.where.slice(0, 200) : '',
        suggestion: typeof entry.suggestion === 'string' ? entry.suggestion.slice(0, 500) : ''
      });
    }
  }

  const colorSeries = [];
  if (Array.isArray(payload.color_series)) {
    for (const entry of payload.color_series) {
      if (typeof entry !== 'object' || entry === null) continue;
      const color = typeof entry.color === 'string' ? entry.color.slice(0, 40) : '';
      if (!color) continue;
      colorSeries.push({
        label: typeof entry.label === 'string' ? entry.label.slice(0, 120) : '',
        color
      });
    }
  }

  /* The generative part of the correction: the model chooses an accessible
     target color per series. Strictly validated — only well-formed, distinct
     hex pairs survive; anything malformed is dropped, never trusted. */
  const recolorPlan = [];
  if (Array.isArray(payload.recolor_plan)) {
    for (const entry of payload.recolor_plan) {
      if (typeof entry !== 'object' || entry === null) continue;
      const from = typeof entry.from === 'string' ? entry.from.trim().toLowerCase() : '';
      const to = typeof entry.to === 'string' ? entry.to.trim().toLowerCase() : '';
      if (!/^#[0-9a-f]{6}$/.test(from) || !/^#[0-9a-f]{6}$/.test(to) || from === to) continue;
      recolorPlan.push({
        from,
        to,
        label: typeof entry.label === 'string' ? entry.label.slice(0, 60) : '',
        reason: typeof entry.reason === 'string' ? entry.reason.slice(0, 200) : ''
      });
    }
  }

  return {
    chart_type: chartType.slice(0, 20),
    summary: summary.slice(0, 1000),
    findings: findings.slice(0, 12),
    color_series: colorSeries.slice(0, 12),
    recolor_plan: recolorPlan.slice(0, 8),
    uncertainty: typeof payload.uncertainty === 'string' ? payload.uncertainty.slice(0, 500) : ''
  };
}

/* Extracts the first JSON object from a model reply, tolerating the common
   ```json fences and stray prose that small models add. */
function extractJsonFromModelReply(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* Calls the configured OpenAI-compatible vision model with the chart PNG.
   Only the model name and upstream status codes are ever logged. */
async function analyzeChart(buffer) {
  const { key: AI_KEY, base: AI_BASE, models: AI_MODELS, timeoutMs: AI_TIMEOUT_MS } = aiConfig();
  if (!AI_KEY) {
    throw new HttpError(503, 'AI analysis is not configured. Set CHARTSAFE_AI_KEY (see README) and restart the backend.');
  }
  if (
    buffer.length < 24 ||
    !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    buffer.readUInt32BE(8) !== 13 ||
    buffer.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new HttpError(400, 'The uploaded file is not a valid PNG.');
  }
  const headerWidth = buffer.readUInt32BE(16);
  const headerHeight = buffer.readUInt32BE(20);
  if (!headerWidth || !headerHeight || headerWidth * headerHeight > MAX_PIXELS ||
      headerWidth > MAX_DIMENSION || headerHeight > MAX_DIMENSION) {
    throw new HttpError(413, 'Choose a PNG up to 8 megapixels and 8192 pixels per side.');
  }
  let source;
  try {
    source = PNG.sync.read(buffer);
  } catch {
    throw new HttpError(400, 'The uploaded file is not a valid PNG.');
  }
  /* Measured dominant colors, computed from the actual pixels so the model's
     recolor plan targets real series colors instead of guesses. */
  const measuredHexes = detectSeriesColors(source.data)
    .slice(0, 6)
    .map(cluster => '#' + cluster.color.map(Math.round).map(v => v.toString(16).padStart(2, '0')).join(''));
  const image = downscalePng(source);
  const encoded = PNG.sync.write(image).toString('base64');

  /* Try each configured model in order: capacity errors (503/504), missing
     model entitlements (404), rate limits (429), network faults, and even
     unparseable replies fall through to the next model. Only key-level
     rejections (401/403) abort the whole request. */
  let lastError = null;
  for (const model of AI_MODELS) {
    let response;
    try {
      response = await fetch(`${AI_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${AI_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: analysisPromptFor(measuredHexes) },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${encoded}` } }
            ]
          }],
          max_tokens: 1200,
          temperature: 0.2
        }),
        signal: AbortSignal.timeout(AI_TIMEOUT_MS)
      });
    } catch (error) {
      if (error && error.name === 'TimeoutError') {
        lastError = new HttpError(504, 'The AI provider timed out. Try again.');
      } else {
        lastError = new HttpError(502, `Could not reach the AI provider (${error && error.message ? error.message : 'network error'}).`);
      }
      continue;
    }
    if (!response.ok) {
      console.error(`[chartsafe] AI provider returned HTTP ${response.status} for model ${model}`);
      if (response.status === 401 || response.status === 403) {
        throw new HttpError(502, 'The AI provider rejected the configured key. Check CHARTSAFE_AI_KEY.');
      }
      lastError = response.status === 429
        ? new HttpError(429, 'The AI provider is rate-limiting requests. Wait a moment and try again.')
        : new HttpError(502, `The AI provider returned HTTP ${response.status} for every configured model.`);
      continue;
    }
    let data;
    try {
      data = await response.json();
    } catch {
      lastError = new HttpError(502, 'The AI provider returned a malformed response.');
      continue;
    }
    const message = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message : {};
    /* Reasoning-style models can put the answer (or the only parseable text)
       in reasoning_content; try both. */
    const content = String(message.content || '') || String(message.reasoning_content || '');
    const analysis = validateAnalysis(extractJsonFromModelReply(content));
    if (analysis) return { model, analysis };
    lastError = new HttpError(502, 'The AI reply did not contain a usable analysis. Try again or switch CHARTSAFE_AI_MODEL.');
  }
  throw lastError || new HttpError(502, 'No AI models are configured.');
}

function readUploadedPng(request) {
  return new Promise((resolve, reject) => {
    let upload;
    let failure;
    let settled = false;
    const finish = (error, buffer) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(buffer);
    };

    let parser;
    try {
      parser = Busboy({
        headers: request.headers,
        limits: { files: 1, fields: 1, fieldSize: 1024, fileSize: MAX_UPLOAD_BYTES }
      });
    } catch {
      finish(new HttpError(400, 'Send a multipart/form-data request with an image field.'));
      return;
    }

    parser.on('file', (field, stream, info) => {
      if (upload || field !== 'image') {
        failure = new HttpError(400, 'Send exactly one PNG in the image field.');
        stream.resume();
        return;
      }
      upload = [];
      if (info.mimeType !== 'image/png') failure = new HttpError(400, 'The uploaded file must be a PNG.');
      stream.on('limit', () => {
        failure = new HttpError(413, 'Choose a PNG up to 10 MB.');
      });
      stream.on('data', chunk => upload.push(chunk));
      stream.on('error', error => {
        failure = error;
      });
      stream.on('end', () => {
        if (stream.truncated) failure = new HttpError(413, 'Choose a PNG up to 10 MB.');
      });
    });
    parser.on('filesLimit', () => {
      failure = new HttpError(400, 'Send exactly one PNG in the image field.');
    });
    parser.on('error', error => finish(error));
    parser.on('finish', () => {
      if (failure) return finish(failure);
      if (!upload) return finish(new HttpError(400, 'The image field is required.'));
      finish(null, Buffer.concat(upload));
    });
    request.pipe(parser);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function createServer(allowedOrigins = new Set(
  (process.env.CORS_ORIGINS || 'http://localhost:5500,http://127.0.0.1:5500,http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
)) {
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const staticFile = STATIC_FILES[pathname];
    if (request.method === 'GET' && pathname === '/animejs.js') {
      response.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(path.join(__dirname, 'node_modules/animejs/dist/bundles/anime.umd.min.js')).pipe(response);
      return;
    }
    if (request.method === 'GET' && staticFile) {
      response.writeHead(200, {
        'Content-Type': staticFile[1],
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(path.join(__dirname, '..', 'docs', staticFile[0])).pipe(response);
      return;
    }

    const origin = request.headers.origin;
    const requestHost = request.headers.host || '';
    const loopbackHost = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(requestHost);
    const sameOrigin = loopbackHost && origin === `http://${requestHost}`;
    if (origin && allowedOrigins.has(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      /* The frontend reads the X-ChartSafe-Report header on recolor responses;
         without this line browsers hide it from cross-origin JavaScript. */
      response.setHeader('Access-Control-Expose-Headers', 'X-ChartSafe-Report');
      if (request.headers['access-control-request-private-network'] === 'true') {
        response.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
    } else if (origin && !sameOrigin) {
      sendJson(response, 403, { error: 'This page origin is not allowed. Configure CORS_ORIGINS and restart the API.' });
      return;
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (pathname === '/health' && request.method === 'GET') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (pathname !== '/api/recolor' && pathname !== '/api/analyze') {
      sendJson(response, 404, { error: 'Not found.' });
      return;
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Use POST with a PNG in the image field.' });
      return;
    }

    if (pathname === '/api/analyze') {
      /* The user's chart leaves this machine ONLY on this route, after the
         frontend has shown an explicit consent dialog. The key never leaves
         the server; images are processed in memory and not stored. */
      try {
        const input = await readUploadedPng(request);
        if (input.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Choose a PNG up to 10 MB.');
        const result = await analyzeChart(input);
        sendJson(response, 200, result);
      } catch (error) {
        if (!(error instanceof HttpError)) {
          console.error('[chartsafe] analyze request failed:', error && error.message ? error.message : error);
        }
        sendJson(response, error instanceof HttpError ? error.statusCode : 500, {
          error: error instanceof HttpError ? error.message : 'The analysis request failed.'
        });
      }
      return;
    }

    try {
      const input = await readUploadedPng(request);
      if (input.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Choose a PNG up to 10 MB.');
      let result;
      try {
        result = recolorPng(input);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        /* Unexpected decoder failures are operational errors worth logging;
           only the error message is logged, never image data. */
        console.error('[chartsafe] recolor failed:', error && error.message ? error.message : error);
        throw new HttpError(400, 'The uploaded file is not a valid PNG.');
      }
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': result.png.length,
        'Cache-Control': 'no-store',
        'X-ChartSafe-Report': JSON.stringify(result.report)
      });
      response.end(result.png);
    } catch (error) {
      if (!(error instanceof HttpError)) {
        console.error('[chartsafe] request failed:', error && error.message ? error.message : error);
      }
      sendJson(response, error instanceof HttpError ? error.statusCode : 500, {
        error: error instanceof HttpError ? error.message : 'The recoloring request failed.'
      });
    }
  });
  /* Deterministic socket limits: a client that opens a connection but never
     finishes headers or a body cannot hold a socket beyond these bounds.
     requestTimeout (120s) comfortably exceeds the frontend's 90s abort. */
  server.headersTimeout = 60_000;
  server.requestTimeout = 120_000;
  return server;
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`ChartSafe recoloring API listening at http://${HOST}:${PORT}`);
    const { key, models, base } = aiConfig();
    console.log(key
      ? `AI analysis enabled: ${models.join(' → ')} via ${base}`
      : 'AI analysis disabled — set CHARTSAFE_AI_KEY (see README) to enable /api/analyze');
  });
}

module.exports = {
  ACCESSIBLE_PALETTE,
  analyzeChart,
  assignPaletteIndices,
  createServer,
  downscalePng,
  extractJsonFromModelReply,
  recolorPng,
  recolorPngBuffer,
  validateAnalysis
};
