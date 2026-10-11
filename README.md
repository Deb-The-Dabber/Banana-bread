# Banana-bread

## Recoloring service

Start the local API from the repository root:

```sh
cd backend
npm install
npm start
```

It serves the app at `http://127.0.0.1:8000/`, the landing page at `http://127.0.0.1:8000/landing.html`, and the standalone page at `http://127.0.0.1:8000/chartsafe-v2-html.html`. The landing page loads its Anime.js bundle locally from the installed npm package. Open one of these URLs rather than opening the HTML file directly; this keeps the page and API on the same origin. The **Recolor chart** button sends the image to the local API. The service maps dominant chart colors to an accessible palette and preserves neutral pixels and transparency. This is a heuristic preview, so inspect chart labels and data after recoloring.

For a frontend served from a different origin, set `CORS_ORIGINS` to a comma-separated origin allowlist before starting the API. The API accepts a PNG as multipart form field `image` and returns a PNG with the original dimensions. You can also load a corrected PNG directly.