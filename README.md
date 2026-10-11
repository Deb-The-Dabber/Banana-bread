# ChartSafe

ChartSafe is a small tool for checking how a PNG chart reads for people with
color-vision deficiencies. Everything runs in your browser: load a PNG,
preview it under approximate deuteranopia/protanopia/tritanopia simulations,
and — if you connect a recoloring service — compare it against a version
whose dominant colors have been remapped to a colorblind-safe palette.

**What it is not:** an accessibility certification. The simulations are
mathematical approximations (Machado, Oliveira & Fernandes 2009, severity
1.0; the "tritanopia" view is a severe-tritanomaly stand-in, not a precise
model), and the recoloring is a pixel-count heuristic with no understanding
of chart semantics. You remain the judge of whether labels, data, and
layout still read correctly.

## Repository layout

| Path | Role |
|------|------|
| `docs/` | The GitHub Pages site (served from this folder on `main`). `index.html` is the app; `landing.html` is the marketing page; `chartsafe-v2-html.html` is a redirect to the app root kept for the old link. |
| `backend/` | Node.js recoloring API (`server.js`), tests, and dependencies. |
| `BananaHacks/` | Sample chart PNGs used during development. |

## Running locally

Prerequisites: Node.js ≥ 18.

```sh
cd backend
npm install
npm start          # serves the app + API at http://127.0.0.1:8000/
```

Open <http://127.0.0.1:8000/> (not the HTML file directly) so the page and
the API share an origin. On that origin the app pre-fills the endpoint as
`http://127.0.0.1:8000/api/recolor`. When `docs/index.html` is opened from
the filesystem, the default is `http://127.0.0.1:8000/api/recolor` as well.

On the public GitHub Pages site the endpoint field starts **empty**:
static hosting cannot run the API, so a same-origin default would silently
point at a dead URL. Frontend-only features (simulations, the prepared
sample pair, loading a corrected PNG by hand, downloading) all work there
without any backend. To recolor automatically, open *Connect recoloring
service* and enter the HTTPS address of a running ChartSafe API. An HTTPS
page cannot call an `http://` endpoint (the app blocks this with a clear
message), so the live site can only use an HTTPS API.

## API contract

`POST /api/recolor` with `multipart/form-data`, one file in the `image`
field (`image/png`).

- 200 → the recolored PNG (`image/png`, same dimensions, alpha preserved)
  plus an `X-ChartSafe-Report` header (JSON, UTF-8):

  ```json
  {
    "version": 1,
    "color_groups": 2,
    "mapping": [
      { "from": [196, 92, 80], "to": "#D55E00" }
    ],
    "note": "Heuristic dominant-color mapping from pixel statistics; not an accessibility certification."
  }
  ```

  `color_groups` is the number of dominant chromatic clusters detected and
  `mapping` lists each cluster's average source color and the palette entry
  it was pulled toward. Every value is computed from this request's actual
  pixels. The report is factual bookkeeping, **not** a score: the frontend
  validates it strictly and renders it as plain facts only.

- 400 not a valid PNG / wrong field name / more than one file
- 403 origin not allowed
- 405 non-POST
- 413 over 10 MB, over 8 megapixels, or over 8192 px per side
- `GET /health` → `{"status":"ok"}`

Limits: 10 MB upload, 8 megapixels, 8192 px per side, one file, one
non-file field (≤ 1 KB), 60 s header timeout, 120 s request timeout.
Grayscale, palette, and 16-bit PNGs are accepted and normalized to 8-bit
RGBA on read. Invalid, truncated, or oversized-but-valid headers are
rejected before pixel decoding where possible.

## CORS

The API never answers `*`. Allowed origins come from `CORS_ORIGINS`
(comma-separated, default
`http://localhost:5500,http://127.0.0.1:5500,http://localhost:3000,http://127.0.0.1:3000`),
e.g.:

```sh
CORS_ORIGINS="https://deb-the-dabber.github.io" npm start
```

Same-origin loopback requests need no configuration. Allowed origins get
`Access-Control-Allow-Origin`, `Vary: Origin`, `POST, OPTIONS` methods, and
`Access-Control-Expose-Headers: X-ChartSafe-Report` so the browser lets the
frontend read the report header cross-origin. Everything else gets 403.

## How recoloring works (and what it cannot do)

The backend builds a histogram of chromatic (saturated, mid-luminance,
sufficiently opaque) pixels, clusters the dominant colors, and pulls each
matched pixel toward the closest entry of a fixed six-color accessible
palette (Okabe–Ito). Cluster → palette assignment is an optimal injective
match by redmean color distance over the *set* of detected colors, so it
does not depend on which region happens to have more pixels: the same chart
colors map to the same palette entries across charts, and red maps toward
the reddish palette entry rather than an arbitrary slot.

Known limits, by design:

- Colored text, titles, and annotations are just chromatic pixels — they
  can be detected as "series" and recolored. The heuristic cannot tell a
  legend swatch from a bar.
- Series with very similar source colors merge into one cluster.
- At most six groups are mapped (palette size); anything beyond that is
  left alone unless it is within the match distance of a kept cluster.
- Semantically identical charts with anti-aliasing or gradient fills can
  produce slightly different cluster sets.
- Neutral pixels (grays, near-black, near-white), transparent pixels, and
  chromatic pixels far from any cluster are left untouched.

Robust series identification would need chart parsing or user-assisted
color selection; neither is implemented.

## Tests

```sh
cd backend
npm test          # node:test — backend API + algorithm + frontend-script tests
```

Coverage: recoloring behavior (neutral/alpha preservation), dimension and
upload limits, malformed/truncated/non-PNG input, multipart field errors,
CORS allowlist + preflight + report-header exposure, report schema and
determinism, palette-assignment stability, grayscale/16-bit normalization,
static routes and the legacy redirect, and — by extracting the inline
script from the shipped `docs/index.html` — the simulation math (against an
independent transcription of the published formulas), report validation,
and the endpoint-default policy. The full UI flow was additionally verified
in a headless Chromium (upload → recolor → mode switching → download
state); those browser checks live outside the repo and are not part of
`npm test`.

## Deploying the recoloring API publicly (not done yet)

The GitHub Pages site is static; it has **no backend deployed**. Hosting the
API for the public site requires, at minimum:

1. A host that runs Node ≥ 18 (Render, Fly.io, Railway, a VPS, …) with the
   API exposed over **HTTPS**.
2. `CORS_ORIGINS="https://deb-the-dabber.github.io"` (exact origin, no
   trailing slash) so only the public page can call it.
3. The server binds to `127.0.0.1` only (loopback, safe by default) and
   takes its port from `process.env.PORT`. Most platforms need the app to
   bind `0.0.0.0`; that change should be made deliberately when a provider
   is chosen, not speculatively.
4. A rate limit at the hosting layer (none is implemented in-process; a
   public API without one is abusable).
5. Privacy consideration: recolored images are processed in memory and
   never stored, but every request transmits the user's PNG to that host —
   say so on any public deployment.

Pushing the frontend changes to GitHub Pages is a normal commit + push to
`main` (Pages serves `docs/`); no other Pages configuration exists in the
repo.
