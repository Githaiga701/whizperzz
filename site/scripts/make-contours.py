"""
Draws the topographic contour sheet the public site uses as paper texture (public/textures/contours-*.svg).

The heightfield is periodic, so the tile repeats with no visible seam. Every fifth line is an "index contour",
drawn heavier, like on a Survey of Kenya map sheet. Run once; the SVGs are committed.

    python scripts/make-contours.py
"""

from pathlib import Path

import numpy as np
from skimage import measure

TILE = 960  # px, the size of one repeat
N = 240  # grid cells across the tile
LEVELS = 34
SEED = 1795  # Nairobi's altitude in metres

rng = np.random.default_rng(SEED)
u = np.linspace(0, 1, N, endpoint=False)
X, Y = np.meshgrid(u, u)

# Hills: periodic bumps (wrapped distance), like the Ngong Hills and the shoulders of the Rift.
h = np.zeros((N, N))
for _ in range(9):
    cx, cy = rng.random(2)
    s = rng.uniform(0.07, 0.19)
    a = rng.uniform(-0.6, 1.0)
    dx = np.minimum(abs(X - cx), 1 - abs(X - cx))
    dy = np.minimum(abs(Y - cy), 1 - abs(Y - cy))
    h += a * np.exp(-(dx**2 + dy**2) / (2 * s * s))
# Ridges and folds: integer frequencies keep it periodic.
for _ in range(14):
    fx, fy = rng.integers(-4, 5, 2)
    if fx == 0 and fy == 0:
        continue
    ph = rng.random() * 2 * np.pi
    amp = rng.uniform(0.04, 0.14) / np.hypot(fx, fy) ** 0.6
    h += amp * np.sin(2 * np.pi * (fx * X + fy * Y) + ph)

# Pad with wrapped cells so lines run through the tile edges and meet their partners on the other side.
P = 6
hp = np.pad(h, P, mode='wrap')
levels = np.linspace(h.min(), h.max(), LEVELS + 2)[1:-1]
scale = TILE / N


def simplify(pts: np.ndarray, eps: float) -> np.ndarray:
    """Ramer-Douglas-Peucker, iterative."""
    if len(pts) < 3:
        return pts
    keep = np.zeros(len(pts), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        seg = pts[b] - pts[a]
        n = np.hypot(*seg) or 1.0
        v = pts[a + 1 : b] - pts[a]
        d = np.abs(seg[0] * v[:, 1] - seg[1] * v[:, 0]) / n
        i = int(np.argmax(d))
        if d[i] > eps:
            m = a + 1 + i
            keep[m] = True
            stack += [(a, m), (m, b)]
    return pts[keep]


def paths(level_ids):
    out = []
    for li in level_ids:
        for c in measure.find_contours(hp, levels[li]):
            pts = (c[:, ::-1] - P) * scale  # (row, col) -> (x, y)
            # keep only lines that touch the tile (the padding is just there to carry them over the edge)
            if (pts.max(0) < -scale * 2).any() or (pts.min(0) > TILE + scale * 2).any():
                continue
            # drop specks: tiny closed loops at the top of a hill read as dirt, not as contours
            if np.hypot(*np.diff(pts, axis=0).T).sum() < 24:
                continue
            pts = simplify(pts, 0.9)
            if len(pts) < 2:
                continue
            d = 'M' + ' '.join(f'{x:.0f} {y:.0f}' for x, y in pts)
            out.append(d)
    return out


minor = [i for i in range(LEVELS) if i % 5 != 2]
major = [i for i in range(LEVELS) if i % 5 == 2]


def sheet(stroke: str, minor_w: float, major_w: float, alpha_minor: float, alpha_major: float) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{TILE}" height="{TILE}" viewBox="0 0 {TILE} {TILE}">'
        f'<g fill="none" stroke="{stroke}" stroke-linecap="round" stroke-linejoin="round">'
        f'<path stroke-opacity="{alpha_minor}" stroke-width="{minor_w}" d="{" ".join(paths(minor))}"/>'
        f'<path stroke-opacity="{alpha_major}" stroke-width="{major_w}" d="{" ".join(paths(major))}"/>'
        '</g></svg>'
    )


out = Path(__file__).resolve().parent.parent / 'public' / 'textures'
out.mkdir(parents=True, exist_ok=True)
# Ink on paper, and lion-grass gold for the dark sections.
(out / 'contours-ink.svg').write_text(sheet('#5a4630', 1, 1.6, 0.55, 0.75))
(out / 'contours-gold.svg').write_text(sheet('#e2b765', 1, 1.6, 0.5, 0.7))
for f in sorted(out.glob('contours-*.svg')):
    print(f.name, f.stat().st_size // 1024, 'KB')
