"""
ChartSafe starter backend (Pillow + numpy only).

Usage:
    pip install pillow numpy
    python chartsafe.py input.png output.png

What it does:
  1. Finds the "data" colors in a chart (the saturated ones; grays/white/black are ignored).
  2. Simulates 3 kinds of colorblindness and scores how different the data colors still look.
  3. If any view fails, swaps the data colors for a colorblind-safe palette (Okabe-Ito)
     and re-scores.

Assumptions (say these honestly in the write-up):
  - Clean PNG bar/line chart, white background, 2-7 colored series.
  - Black/gray series are not treated as data (they would need the vision model's labels).
"""
import itertools
import json
import sys

import numpy as np
from PIL import Image

# ---------- colorblindness simulation (Machado et al. 2009, full severity) ----------
CVD = {
    "protanopia": np.array([[0.152286, 1.052583, -0.204868],
                            [0.114503, 0.786281, 0.099216],
                            [-0.003882, -0.048116, 1.051998]]),
    "deuteranopia": np.array([[0.367322, 0.860646, -0.227968],
                              [0.280085, 0.672501, 0.047413],
                              [-0.011820, 0.042940, 0.968881]]),
    "tritanopia": np.array([[1.255528, -0.076749, -0.178779],
                            [-0.078411, 0.930809, 0.147602],
                            [0.004733, 0.691367, 0.303900]]),
}

# Okabe-Ito palette (minus black), designed to stay distinguishable for colorblind viewers
SAFE_PALETTE = np.array([
    [230, 159, 0],    # orange
    [86, 180, 233],   # sky blue
    [0, 158, 115],    # bluish green
    [240, 228, 66],   # yellow
    [0, 114, 178],    # blue
    [213, 94, 0],     # vermillion
    [204, 121, 167],  # reddish purple
], dtype=float)

PASS_THRESHOLD = 20.0  # min color distance (Lab) between any two series; ~20 = clearly different


# ---------- color math ----------
def srgb_to_linear(rgb):
    c = np.asarray(rgb, dtype=float) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(lin):
    c = np.clip(lin, 0, 1)
    out = np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)
    return out * 255.0


def rgb_to_lab(rgb):
    lin = srgb_to_linear(rgb)
    m = np.array([[0.4124564, 0.3575761, 0.1804375],
                  [0.2126729, 0.7151522, 0.0721750],
                  [0.0193339, 0.1191920, 0.9503041]])
    xyz = lin @ m.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16,
                     500 * (f[..., 0] - f[..., 1]),
                     200 * (f[..., 1] - f[..., 2])], axis=-1)


def simulate(rgb, kind):
    """What a colorblind viewer sees for rgb colors (N x 3, 0-255)."""
    if kind == "normal":
        return np.asarray(rgb, dtype=float)
    lin = srgb_to_linear(rgb)
    return linear_to_srgb(lin @ CVD[kind].T)


def min_pair_distance(colors, kind):
    if len(colors) < 2:
        return 999.0
    labs = rgb_to_lab(simulate(colors, kind))
    return min(float(np.linalg.norm(labs[i] - labs[j]))
               for i, j in itertools.combinations(range(len(labs)), 2))


def score(colors):
    result = {k: round(min_pair_distance(colors, k), 1) for k in ["normal", *CVD]}
    result["passes_all"] = all(v >= PASS_THRESHOLD for v in result.values())
    return result


# ---------- step 1: find the data colors ----------
def find_series_colors(pixels, max_series=7, min_share=0.002, merge_dist=18.0):
    """pixels: N x 3 uint8. Returns list of series colors (float RGB)."""
    p = pixels.astype(int)
    saturation = p.max(axis=1) - p.min(axis=1)
    colored = p[saturation > 45]  # drops white, black, grays
    if len(colored) == 0:
        return []
    bins = (colored // 16) * 16 + 8  # group similar colors
    keys, counts = np.unique(bins, axis=0, return_counts=True)
    order = np.argsort(-counts)
    total = len(p)
    clusters = []  # each: [sum_of_rgb, count]
    for idx in order:
        if counts[idx] / total < min_share:
            break
        center = keys[idx].astype(float)
        lab = rgb_to_lab(center)
        for c in clusters:
            if np.linalg.norm(rgb_to_lab(c[0] / c[1]) - lab) < merge_dist:
                c[0] += center * counts[idx]
                c[1] += counts[idx]
                break
        else:
            clusters.append([center * counts[idx], counts[idx]])
    clusters.sort(key=lambda c: -c[1])
    colors = [c[0] / c[1] for c in clusters]
    # Drop "fake" colors: faded edge pixels that are just a real series blended with white
    kept = []
    for c in colors:
        is_blend = False
        for s in kept:
            ink_s, ink_c = 255.0 - s, 255.0 - c
            alpha = float(ink_c @ ink_s / (ink_s @ ink_s))
            residual = float(np.linalg.norm(ink_c - alpha * ink_s))
            if 0.05 < alpha < 0.95 and residual < 20.0:
                is_blend = True
                break
        if not is_blend:
            kept.append(c)
    return kept[:max_series]


# ---------- step 2: choose replacement colors ----------
def safe_distance(colors):
    return min(min_pair_distance(colors, k) for k in ["normal", *CVD])


def choose_replacements(series):
    """Pick the safe-palette subset that is most distinguishable, then assign it so each
    series changes as little as possible."""
    n = len(series)
    best_subset, best_val = None, -1
    for subset in itertools.combinations(range(len(SAFE_PALETTE)), n):
        val = safe_distance(SAFE_PALETTE[list(subset)])
        if val > best_val:
            best_subset, best_val = subset, val
    chosen = SAFE_PALETTE[list(best_subset)]
    s_lab = rgb_to_lab(np.array(series))
    c_lab = rgb_to_lab(chosen)
    best_perm, best_cost = None, 1e18
    for perm in itertools.permutations(range(n)):
        cost = sum(np.linalg.norm(s_lab[i] - c_lab[perm[i]]) for i in range(n))
        if cost < best_cost:
            best_perm, best_cost = perm, cost
    return np.array([chosen[best_perm[i]] for i in range(n)])


# ---------- step 3: recolor pixels (keeps smooth edges) ----------
def recolor(img_rgb, series, replacements, residual_limit=28.0):
    h, w, _ = img_rgb.shape
    px = 255.0 - img_rgb.reshape(-1, 3).astype(float)  # "ink" amount on a white background
    best_res = np.full(len(px), 1e9)
    best_alpha = np.zeros(len(px))
    best_idx = np.full(len(px), -1)
    for i, s in enumerate(series):
        ink = 255.0 - s
        alpha = np.clip(px @ ink / (ink @ ink), 0, 1)
        residual = np.linalg.norm(px - alpha[:, None] * ink, axis=1)
        better = residual < best_res
        best_res = np.where(better, residual, best_res)
        best_alpha = np.where(better, alpha, best_alpha)
        best_idx = np.where(better, i, best_idx)
    flat = img_rgb.reshape(-1, 3).astype(int)
    has_color = (flat.max(axis=1) - flat.min(axis=1)) >= 6  # skip gray gridlines, text, white
    hit = (best_res < residual_limit) & (best_alpha > 0.03) & has_color
    out = img_rgb.reshape(-1, 3).astype(float).copy()
    target_ink = 255.0 - replacements[best_idx.clip(0)]
    new_vals = 255.0 - best_alpha[:, None] * target_ink
    out[hit] = new_vals[hit]
    return np.clip(out, 0, 255).astype(np.uint8).reshape(h, w, 3)


# ---------- main entry point ----------
def load_rgb(img):
    """Open as RGB; transparent areas become white so they are not read as black."""
    img = img.convert("RGBA")
    background = Image.new("RGBA", img.size, (255, 255, 255, 255))
    return np.array(Image.alpha_composite(background, img).convert("RGB"))


def process_image(pil_img):
    """Takes a PIL image. Returns (fixed PIL image, report dict). Same size as the input."""
    img = load_rgb(pil_img)
    series = find_series_colors(img.reshape(-1, 3))
    report = {"series_found": len(series),
              "series_colors": [[int(v) for v in c] for c in series]}
    if len(series) < 2:
        report["note"] = "Fewer than 2 colored series found; nothing to fix."
        return Image.fromarray(img), report
    report["before"] = score(np.array(series))
    if report["before"]["passes_all"]:
        report["note"] = "Already colorblind-safe; image unchanged."
        report["after"] = report["before"]
        return Image.fromarray(img), report
    repl = choose_replacements(series)
    fixed = recolor(img, series, repl)
    report["new_colors"] = [[int(v) for v in c] for c in repl]
    report["after"] = score(repl)
    return Image.fromarray(fixed), report


def process(path_in, path_out):
    out, report = process_image(Image.open(path_in))
    out.save(path_out)
    return report


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: python chartsafe.py input.png output.png")
        sys.exit(1)
    print(json.dumps(process(sys.argv[1], sys.argv[2]), indent=2))
