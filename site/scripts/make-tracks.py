"""
Draws public/textures/tracks.svg: faint animal tracks wandering across the paper, as if a lion, an elephant
and a guineafowl had walked over the guide's journal. The tile repeats seamlessly (prints near an edge are
drawn again on the opposite side). Run once; the SVG is committed.

    python scripts/make-tracks.py
"""

import math
from pathlib import Path

import numpy as np

T = 1400  # tile size
rng = np.random.default_rng(1795)
parts: list[str] = []


def place(x: float, y: float, ang: float, shape: str):
    """Put one print at (x, y), heading `ang` (radians), wrapping round the tile edges."""
    for dx in (-T, 0, T):
        for dy in (-T, 0, T):
            px, py = x + dx, y + dy
            if -60 < px < T + 60 and -60 < py < T + 60:
                parts.append(f'<g transform="translate({px:.1f} {py:.1f}) rotate({math.degrees(ang) + 90:.1f})">{shape}</g>')


# Lion: a three-lobed heel pad and four toes, no claw marks (cats keep them in).
LION = (
    '<path d="M-7 4 C-8 -1 -4 -3 0 -2 C4 -3 8 -1 7 4 C6 8 3 8 0 7 C-3 8 -6 8 -7 4 Z"/>'
    '<ellipse cx="-7.5" cy="-6" rx="2.4" ry="3.2" transform="rotate(-20 -7.5 -6)"/>'
    '<ellipse cx="-2.6" cy="-9.6" rx="2.5" ry="3.4"/>'
    '<ellipse cx="2.8" cy="-9.4" rx="2.5" ry="3.4"/>'
    '<ellipse cx="7.6" cy="-5.6" rx="2.4" ry="3.2" transform="rotate(20 7.6 -5.6)"/>'
)
# Elephant: a big round print with a cracked sole.
ELEPHANT = (
    '<ellipse rx="15" ry="17"/>'
    '<path d="M-9 -4 L-2 1 L6 -3 M-6 7 L1 3 L8 8" fill="none" stroke="#d8ccae" stroke-width="1.2"/>'
)
# Guineafowl: three forward toes from one point.
BIRD = (
    '<path d="M0 6 L0 -7 M0 6 L-5.5 -4 M0 6 L5.5 -4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
)


def trail(start, heading, steps, stride, gait, shape, wander, side=6.0):
    x, y = start
    a = heading
    for i in range(steps):
        a += rng.normal(0, wander)
        x += math.cos(a) * stride
        y += math.sin(a) * stride
        off = side if gait and i % 2 else -side
        nx, ny = -math.sin(a) * off, math.cos(a) * off
        place(x % T + nx, y % T + ny, a, shape)


# A lion walks the long diagonal, an elephant crosses lower down, a guineafowl scratches about.
trail((60, 200), 0.62, 60, 38, True, LION, 0.05, side=9)
trail((1300, 980), 2.95, 16, 70, True, ELEPHANT, 0.03, side=16)
trail((420, 1150), -0.9, 70, 17, True, BIRD, 0.18, side=4)

svg = (
    f'<svg xmlns="http://www.w3.org/2000/svg" width="{T}" height="{T}" viewBox="0 0 {T} {T}" '
    f'color="#5a4630" fill="#5a4630" opacity=".085">'
    + ''.join(parts)
    + '</svg>'
)
out = Path(__file__).resolve().parent.parent / 'public' / 'textures' / 'tracks.svg'
out.write_text(svg)
print(out.name, len(svg) // 1024, 'KB')
