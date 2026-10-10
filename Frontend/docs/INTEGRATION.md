# Deb ↔ Ayush integration agreement (proposed)

Send Deb:

> I'm building the frontend in plain HTML/CSS/JavaScript. Does your Python code currently take an image file and save a recolored PNG, or do you already have a web API? I suggest POST /api/recolor accepting a PNG in a form field named image and returning the corrected PNG. Can you support that? We can add scores afterward.

## Minimum API contract

```
POST http://localhost:8000/api/recolor
Content-Type: multipart/form-data; boundary=<browser-generated>
image: <original PNG file>

200 OK
Content-Type: image/png
<raw corrected PNG bytes>
```

The frontend sets the multipart boundary automatically. Return an actual PNG, not JSON, a base64 string or a filesystem path. Keep width/height unchanged. On validation or pipeline failure return an appropriate 4xx/5xx response; do not return the original and report success.

The UI accepts up to 10 MB, 8 million pixels, and 8192 px per side. Backend must independently validate file contents, decoded size and allowed types. Generate a unique temporary directory for each request and clean it up. Do not use a single shared output.png for concurrent requests. Never use an uploaded filename as an arbitrary server path.

## CORS / running separately

Frontend: http://localhost:5500/frontend/
Backend: http://localhost:8000/api/recolor

Allow the exact frontend origins used by the team, e.g. http://localhost:5500 and http://127.0.0.1:5500. The frontend does not send cookies or authorization headers. Do not use a wildcard with credentials. Serve over HTTP locally; use HTTPS for both sides when hosted. Another person's localhost is not Deb's computer: all users need a reachable hosted API or their own local backend.

If Deb only has a Python function/script, wrap it with Flask or FastAPI. He owns the real pipeline call and can choose the framework. The browser expects image bytes after the call finishes. There is a 90-second frontend timeout, with errors shown in the UI. Canceling the browser request does not necessarily stop backend computation.

## If the backend isn't ready

Deb can send Ayush original.png + corrected.png with matching dimensions. Upload the original and choose Load corrected PNG. The UI simulation and download flow work without an API. This is a frontend integration test, not an end-to-end AI demo.

## Adding metrics later

Do not invent scores in the frontend. First agree on a versioned response schema or a separate analysis endpoint that includes:
- Color distance formula (e.g. CIEDE2000), before/after values per simulation.
- Exact simulation model and severity.
- Series labels and source/replacement colors.
- Threshold and its rationale; label it a heuristic, not a universal accessibility pass.
- Structure-check method and result, distinct from pixel-dimension equality.
- Warnings / unsupported inputs / model uncertainty.

The current frontend intentionally accepts PNG only. Changing to JSON requires updating app.js and the contract together.

## Integration acceptance check

1. Submit a real clean PNG; confirm Deb's pipeline executes.
2. Confirm response is image/png, not a preview page or JSON error.
3. Inspect axes, labels, values, bar heights/line paths and legend correspondence.
4. Cycle every simulation for both images.
5. Download and reopen the corrected PNG. It must retain original dimensions and unsimulated colors.
6. Stop the API and try again. A clear error should appear, with no stale corrected image.
7. Upload another chart during a slow request. The old response must not replace the new chart.

No public deployment, GitHub push or competition submission has been performed by this package.
