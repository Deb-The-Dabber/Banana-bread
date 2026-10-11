# ChartSafe

ChartSafe is a small tool for checking how a PNG chart reads for people with
color-vision deficiencies. Everything runs in your browser: load a PNG,
get an automatically generated corrected version (dominant colors remapped
to a colorblind-safe palette), preview both under approximate
deuteranopia/protanopia/tritanopia simulations, and download the corrected
PNG. The **Original** box always keeps its true colors; the selected vision
view is applied to the right preview and the downloaded corrected PNG.

The page is fully client-side — decoding, recoloring, and the download are
all local, no image is ever uploaded, and it makes no network requests.
There is no recoloring button: the corrected copy is generated automatically
when a chart is loaded. You can override it with your own corrected PNG via
the *Load corrected PNG* input, and the prepared sample pair remains a
curated demonstration.

**What it is not:** an accessibility certification. The simulations are
mathematical approximations (Machado, Oliveira & Fernandes 2009, severity
1.0; the "tritanopia" view is a severe-tritanomaly stand-in, not a precise
model), and a recolored image is not automatically an accessible chart. You
remain the judge of whether labels, data, and layout still read correctly.

## Repository layout

| Path | Role |
|------|------|
| `docs/` | The GitHub Pages site (served from this folder on `main`). `index.html` is the app; `landing.html` is the marketing page; `chartsafe-v2-html.html` is a redirect to the app root kept for the old link. |
| `backend/` | Optional Node.js recoloring API (`server.js`), tests, and dependencies. Serves `docs/` locally and exposes `POST /api/recolor` for scripts. |
| `BananaHacks/` | Sample chart PNGs used during development. |

## Running locally

Prerequisites: Node.js ≥ 18.

```sh
cd backend
npm install
npm start          # serves the app at http://127.0.0.1:8000/
```

Open <http://127.0.0.1:8000/>. The page works from any static host (or even
`docs/index.html` opened directly); the local server is a convenience and
also exposes the API below for producing corrected PNGs with a script.

## Standalone recoloring API (optional)

The page UI never calls the API. It exists so you can produce a corrected
PNG programmatically, then load it into the Recolored panel in the browser.

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
  pixels. The report is factual bookkeeping, **not** a score.

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

Example:

```sh
curl -X POST -F "image=@chart.png" http://127.0.0.1:8000/api/recolor \
  -o chart-corrected.png
```

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
`Access-Control-Expose-Headers: X-ChartSafe-Report` so cross-origin scripts
can read the report header. Everything else gets 403.

## How the recoloring works (and what it cannot do)

The same heuristic ships twice — in the page (so it works with no backend)
and in the optional API — and `backend/test/frontend.test.js` asserts both
implementations produce byte-identical pixels for the same input, so they
cannot drift apart. It builds a histogram of chromatic (saturated,
mid-luminance, sufficiently opaque) pixels, clusters the dominant colors,
and pulls each matched pixel toward the closest entry of a fixed six-color
accessible palette (Okabe–Ito). Cluster → palette assignment is an optimal
injective match by redmean color distance over the *set* of detected
colors, so it does not depend on which region happens to have more pixels:
the same chart colors map to the same palette entries across charts, and
red maps toward the reddish palette entry rather than an arbitrary slot.

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
independent transcription of the published formulas), the in-page recolorer
(byte-identical to the backend algorithm, including on a real chart from
`BananaHacks/`), the rule that the Original box is never simulated, and the
absence of any recoloring-service UI. The full UI flow was additionally
verified in a headless Chromium (upload → automatic generation → vision
tabs → actual captured download of the corrected PNG, including byte-exact
constancy of the Original box across all tabs); those browser checks live
outside the repo and are not part of `npm test`.

## Privacy

Images never leave the browser: decoding, simulation, and downloads all
happen locally, and the page makes no network requests. If you run the
optional API yourself and send it a PNG, that request transmits the image
to wherever the API runs — the API processes it in memory and stores
nothing.
