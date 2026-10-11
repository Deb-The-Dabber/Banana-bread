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
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/landing.html': ['landing.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/simulation.js': ['simulation.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
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

  const clusters = detectSeriesColors(data);
  const recolored = new PNG({ width, height });
  recolored.data.set(data);
  const palette = ACCESSIBLE_PALETTE.map(colorFromHex);

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (data[i + 3] < 128 || !isChromatic(r, g, b)) continue;

    let nearest = -1;
    let nearestDistance = Infinity;
    for (let j = 0; j < clusters.length; j++) {
      const distance = colorDistanceSquared([r, g, b], clusters[j].color);
      if (distance < nearestDistance) {
        nearest = j;
        nearestDistance = distance;
      }
    }
    if (nearest < 0 || nearestDistance >= COLOR_MATCH_DISTANCE ** 2) continue;

    const confidence = Math.max(0, 1 - Math.sqrt(nearestDistance) / COLOR_MATCH_DISTANCE);
    const target = palette[nearest];
    recolored.data[i] = Math.round(r + (target[0] - r) * confidence);
    recolored.data[i + 1] = Math.round(g + (target[1] - g) * confidence);
    recolored.data[i + 2] = Math.round(b + (target[2] - b) * confidence);
  }

  return PNG.sync.write(recolored);
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
  return http.createServer(async (request, response) => {
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
    if (pathname !== '/api/recolor') {
      sendJson(response, 404, { error: 'Not found.' });
      return;
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Use POST with a PNG in the image field.' });
      return;
    }

    try {
      const input = await readUploadedPng(request);
      if (input.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Choose a PNG up to 10 MB.');
      let output;
      try {
        output = recolorPngBuffer(input);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, 'The uploaded file is not a valid PNG.');
      }
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': output.length,
        'Cache-Control': 'no-store'
      });
      response.end(output);
    } catch (error) {
      sendJson(response, error instanceof HttpError ? error.statusCode : 500, {
        error: error instanceof HttpError ? error.message : 'The recoloring request failed.'
      });
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`ChartSafe recoloring API listening at http://${HOST}:${PORT}`);
  });
}

module.exports = { ACCESSIBLE_PALETTE, createServer, recolorPngBuffer };
