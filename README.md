# ChartSafe

ChartSafe is a small tool for checking how a chart reads for people with
color-vision deficiencies. Everything core runs in your browser: load any
image format (PNG, JPG, WebP, GIF, BMP, AVIF, SVG — decoded locally),
get an automatically generated corrected version (dominant colors remapped
to a colorblind-safe palette), preview both under approximate
deuteranopia/protanopia/tritanopia simulations, and download the corrected
PNG. The **Original** box always keeps its true colors; the selected vision
view is applied to the right preview and the downloaded corrected PNG.
Optionally, a consent-gated **generative AI review** adds model-generated
findings next to pixel-measured color-pair checks, and the model can take
the deciding role in recoloring: it proposes an accessible target color per
series (naming each series), ChartSafe applies that plan pixel-exactly, then
re-measures it — and can draw an AI-named legend onto the corrected chart.

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

## AI chart review (optional, consent-gated)

The studio can send your chart to a vision-capable AI model for a
structured accessibility review: chart type, summary, findings with
severity/suggestions, the series colors the model reads, its stated
uncertainty, and — the generative part — a **recolor plan**: an accessible
target color the model chooses for each measured series color. One click
applies the plan: the deterministic engine remaps exactly those pixels, so
geometry, labels, and data can never change, and the measured ΔE checks
re-run against the model's chosen palette (a bad AI pick gets flagged with
numbers). "Restore heuristic correction" swaps back at any time.

**AI concept image (optional, requires a Cosmos deployment):** "Generate AI
concept image" composes a text prompt from the measured facts (chart type,
series labels, accessible colors) — no image is uploaded — and renders a
decorative concept via NVIDIA Cosmos `text2image` (`POST /api/concept`).
The prompt is shown in the consent dialog before anything is sent, and the
result is framed as AI-generated art: values and labels in it are
fabricated by the image model and it is never treated as chart data.
Cosmos needs its own deployment credentials (`CHARTSAFE_COSMOS_KEY`,
`CHARTSAFE_COSMOS_URL`); until they are set the endpoint answers a clear
503 and the UI explains what is missing.

**AI-directed legend:** when the model names the series it saw, "Add legend
(AI-named)" draws a clean legend box — the AI's labels on the corrected
colors, placed in the emptiest corner of the image — without touching
anything else. The AI decides what the legend says; the app draws it.
"Remove legend" restores the image byte-exactly.

Verified model availability on NVIDIA NIM with the tested key (checked
2026-10, by probing `integrate.api.nvidia.com`): `meta/llama-3.2-11b-vision-instruct`
(reliable, 9–39 s — the default), `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`
(intermittent capacity, reasoning-channel quirk — fallback),
`google/gemma-4-31b-it` (live but ~3 min per request — too slow for the
demo), and `nvidia/llama-3.2-90b-vision-instruct` (hangs). **Not available**
through this API: PaliGemma (404 — not in the hosted catalog at all),
`nvidia/cosmos-reason2-8b` (listed but not entitled for this account), and
`nvidia/cosmos3-nano` (404 on every `ai.api.nvidia.com` route with these
keys — per its quickstart it needs the invocation URL and credentials
supplied with a deployment). No image-generation model is reachable with
the current keys — so no generative image editing; that is exactly why
every AI fix here is applied by the deterministic pixel engine, and why
the concept-image route is built, tested against a stub, and waiting for
entitled Cosmos credentials. The flow is consent-gated — a dialog explains exactly what
will be uploaded before anything leaves the machine, and canceling sends
nothing. Alongside the model's findings, ChartSafe shows **measured
checks** computed deterministically from the image's pixels: every
detected color pair is judged by CIELAB ΔE after applying each color-vision
simulation, so confusable pairs are flagged with numbers, not opinions.
AI findings are interpretations; the measured checks are facts.

The AI request is made only to a ChartSafe backend running on your machine
(`npm start`), which holds the provider key — the browser never sees it.
The public GitHub Pages page shows an honest "run the backend to enable
this" explanation instead of a dead button.

### Provider configuration

Copy `backend/.env.example` to `backend/.env` (gitignored) and set:

- `CHARTSAFE_AI_KEY` — provider API key (required to enable `/api/analyze`)
- `CHARTSAFE_AI_BASE` — OpenAI-compatible base URL
- `CHARTSAFE_AI_MODEL` — a vision-capable chat model

Two verified configurations:

| Option | Base | Model(s) | Cost |
|--------|------|----------|------|
| NVIDIA NIM (default, tested 2026-10) | `https://integrate.api.nvidia.com/v1` | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning,meta/llama-3.2-11b-vision-instruct` | free `nvapi-` key from build.nvidia.com |
| OpenRouter (tested 2026-10) | `https://openrouter.ai/api/v1` | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | free tier, rate-limited |

`CHARTSAFE_AI_MODEL` accepts a comma-separated list tried in order: capacity
errors (503/504), missing entitlements (404), rate limits (429), and unusable
replies fall through to the next model, so a saturated fast model does not
break the demo. Measured latency on real 2400x1200 charts: 9-35 s typically
(occasionally up to ~75 s on the fallback model).

`POST /api/analyze` accepts the same multipart PNG as `/api/recolor`
(≤ 10 MB, ≤ 8 megapixels; the image is downscaled to ≤ 768 px before the
provider call, and the measured dominant colors are injected into the
prompt so the model's recolor plan targets real series colors) and returns
`{ model, analysis }` with the validated schema
`{ chart_type, summary, findings: [{severity, issue, where, suggestion}],
color_series: [{label, color}], recolor_plan: [{from, to, reason}],
uncertainty }`. Unconfigured → 503;
provider failure → 502/429/504 with an honest message; unusable model
output → 502. The provider's reply is strictly validated and truncated;
it is never executed or rendered as HTML.

**Limitations, honestly:** the model can misread charts, hallucinate
series, or miss real problems — that is why every AI finding ships next to
pixel-measured checks and the disclaimer. The measured ΔE checks are a
perceptual heuristic, not a simulation of any individual's vision.

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

- A cluster covering more than 60% of all pixels (dark-theme canvases,
  slides, screenshots) is treated as a probable background and left
  unchanged — the fact is surfaced in the status line and the measured
  checks instead of being guessed away. A legitimate series that large
  would stay unrecolored; that trade-off favors never mangling an image.
- Colored text, titles, and annotations are just chromatic pixels — they
  can be detected as "series" and recolored. The heuristic cannot tell a
  legend swatch from a bar.
- Series with very similar source colors merge into one cluster.
- At most six groups are mapped (palette size); anything beyond that is
  left alone unless it is within the match distance of a kept cluster.
- Semantically identical charts with anti-aliasing or gradient fills can
  produce slightly different cluster sets.
- Neutral pixels (grays, near-black, near-white), transparent pixels,
  pixels outside the mid-luminance band, and chromatic pixels far from any
  cluster are left untouched.

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
static routes and the legacy redirect, the AI analyze endpoint (503
unconfigured, stubbed-provider happy path, junk-output rejection, upstream
error mapping, PNG validation before the provider call, request downscale),
and — by extracting the inline script from the shipped `docs/index.html` —
the simulation math (against an independent transcription of the published
formulas), the in-page recolorer (byte-identical to the backend algorithm,
including on a real chart), the measured color-pair checks with calibrated
ΔE thresholds, HTML escaping of model output, the rule that the Original
box is never simulated, and the consent-gated AI UI. The full UI flow was
additionally verified in a headless Chromium (upload → automatic
generation → vision tabs → actual captured download, and the complete
AI flow: consent dialog, cancel-sends-nothing, findings rendering,
measured-checks rendering, stale-result clearing, provider-failure
fallback); those browser checks live outside the repo and are not part of
`npm test`.

## Privacy

Images never leave the browser by default: decoding (any common format,
including SVG), recoloring, the measured ΔE checks, and downloads all
happen locally, and the page makes no network requests. The optional AI review uploads the chart PNG — only
after explicit consent — to the configured provider via your local
backend; the backend processes it in memory and stores nothing.
