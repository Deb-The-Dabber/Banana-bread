[README.md](https://github.com/user-attachments/files/33289765/README.md)
# ChartSafe — Banana Hacks frontend

Plain HTML, CSS and JavaScript. No npm install, account, API key or build step.

## Open it in VS Code

1. Unzip this folder and open `ChartSafe` in VS Code.
2. Open `frontend/index.html` in Chrome/Edge/Firefox to use the local previews immediately.
3. For backend integration, use VS Code Live Server (if already installed), or run from this folder:

   ```sh
   python3 -m http.server 5500 --bind 127.0.0.1
   ```

   On Windows, `py -m http.server 5500 --bind 127.0.0.1` also works with Python installed.
4. Visit http://localhost:5500/frontend/ . Use this exact URL when testing CORS.
5. Click **Try the sample chart**, then change the vision mode. This loads a prepared pair, not an AI-generated correction.
6. Upload a clean PNG. Load a matching corrected PNG from Deb to inspect it, or expand **Connect recoloring service**, enter his endpoint, then click **Recolor chart**.

## Included

- PNG upload, drag-and-drop, file and dimension validation (10 MB, 8 MP, 8192 px per side).
- Side-by-side original/corrected canvases and shared color vision controls.
- Linear-light sRGB Machado simulations, preserving alpha.
- Original-resolution download of the corrected PNG, unaffected by simulation controls.
- Prepared sample drawn in the browser; original source fixture images in `samples/`.
- Python service connection with errors, timeout and protection against stale responses.
- Responsive layout, keyboard-operable controls, accessible names and live status messages.

## What is not built yet

This is Ayush's frontend. It does not perform AI analysis, identify series, automatically recolor uploads, compute color distances, verify chart data, or certify accessibility. Deb/Manish's pipeline provides those functions. The prepared sample uses fixed chart data rendered twice with different palettes. It is explicitly labeled and must not be presented as an AI result.

## Backend handoff

See [docs/INTEGRATION.md](docs/INTEGRATION.md). Minimum contract: multipart `POST /api/recolor`, file field `image`, response raw `image/png` with unchanged dimensions. No frontend API keys. Keep model credentials on the backend.

## Team GitHub handoff

The target repository is `Deb-The-Dabber/BananaBread`. It was inaccessible through the available GitHub connection during this build (404); nothing has been pushed or committed there. Put the `frontend/` directory in the repository root, and add the handoff documentation and credits to the team's existing README. Do not overwrite teammates' files. Review, commit, and push during the allowed hacking window. Preserve honest timestamps and document use of AI coding assistance.

## Credits and technical limitations

Simulation based on Machado, G. M., Oliveira, M. M., & Fernandes, L. A. F. (2009), *A Physiologically-based Model for Simulation of Color Vision Deficiency*, IEEE TVCG 15(6), 1291–1298, DOI: 10.1109/TVCG.2009.113.

- Authors' paper: https://profs.ic.uff.br/~laffernandes/content/publications/journal/2009_tvcg_15%286%29/machado_oliveira_fernandes-tvcg-15%286%29-2009-corrected.pdf
- Authors' supplementary matrices: https://www.inf.ufrgs.br/~oliveira/pubs_files/CVD_Simulation/CVD_Simulation.html
- Colour project's method documentation and tritan limitations: https://colour.readthedocs.io/en/latest/generated/colour.matrix_cvd_Machado2009.html
- Colour method source: https://colour.readthedocs.io/en/master/_modules/colour/blindness/machado2009.html

The severity-1.0 matrices operate on linear-light sRGB. Output is clipped to the displayable range, encoded back to sRGB and rounded to bytes. These views are approximations; the blue-yellow endpoint is a severe tritanomaly approximation, not a precise tritanopia model. No Colour package source code is bundled. Alpha is preserved; transparent images are displayed over white. Treat input as sRGB. Color-managed/HDR workflows have not been validated.

Prepared sample palette uses blue `#0072B2` and orange `#E69F00` from Okabe–Ito. Palette reference: https://jfly.uni-koeln.de/color/ . It does not guarantee accessibility for arbitrary charts; add direct labels/patterns as appropriate. Chart values, labels and sample artwork are original fixtures created for this project, not evidence from users.

Runtime dependencies: browser Canvas, Fetch, FormData and createImageBitmap APIs only. No external fonts, scripts, analytics or image assets. Code created with OpenAI ChatGPT/Codex assistance during this session. Add all backend libraries/models/APIs to these credits before submission.

## Deadline reminder

The supplied event rules say October 11, 2026 at 11:59 PM AoE (UTC−12), which is October 12 at 6:59 AM America/Chicago (CDT). The project overview's Sunday 10:59 PM is inconsistent with this. Use the official portal as final authority and aim to submit Sunday evening.
