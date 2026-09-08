"""Generate PNG icons from icon.svg for the PWA manifest.

The PWA manifest references four PNG icons:
  - /icon-192.png         (192x192, any purpose)
  - /icon-512.png         (512x512, any purpose)
  - /icon-maskable-192.png (192x192, maskable)
  - /icon-maskable-512.png (512x512, maskable)

The "any" icons render the SVG as-is onto a transparent background
(except for the rounded square background baked into the SVG).

The "maskable" icons add extra padding so that Android's adaptive-icon
masking doesn't crop the bell. Android's safe zone for maskable icons
is a circle with radius = 80 / 192 ≈ 41.7% of the icon width, centered.
We place the bell content within the inner 66% of the icon, leaving a
~17% safe padding on every side.

Usage:
    python3 scripts/generate-icons.py
"""

import os
import sys
from pathlib import Path

import cairosvg
from PIL import Image

# Repo root (parent of scripts/)
REPO_ROOT = Path(__file__).resolve().parent.parent
ICONS_DIR = REPO_ROOT / "public" / "assets" / "aistudio" / "icons"
SVG_PATH = ICONS_DIR / "icon.svg"


def render_svg_to_png(svg_path: Path, output_path: Path, size: int) -> None:
    """Render an SVG file to a PNG of the given size."""
    cairosvg.svg2png(
        url=str(svg_path),
        write_to=str(output_path),
        output_width=size,
        output_height=size,
    )


def make_maskable_icon(svg_path: Path, output_path: Path, size: int) -> None:
    """Create a maskable icon by placing the SVG bell content in the
    inner 66% of the canvas, leaving ~17% padding on each side so
    Android adaptive-icon masking doesn't crop the bell.
    """
    # Render the SVG at the inner content size (66% of the target).
    inner_size = int(size * 0.66)
    temp_path = output_path.with_suffix(".tmp.png")
    render_svg_to_png(svg_path, temp_path, inner_size)

    # Paste it centered onto a solid teal background matching the
    # icon's gradient midpoint.
    bg_color = (15, 118, 110, 255)  # #0f766e at full opacity
    canvas = Image.new("RGBA", (size, size), bg_color)
    inner = Image.open(temp_path).convert("RGBA")
    offset = ((size - inner_size) // 2, (size - inner_size) // 2)
    canvas.paste(inner, offset, inner)
    canvas.save(output_path, "PNG")
    temp_path.unlink(missing_ok=True)


def main() -> int:
    if not SVG_PATH.exists():
        print(f"ERROR: SVG file not found at {SVG_PATH}", file=sys.stderr)
        return 1

    ICONS_DIR.mkdir(parents=True, exist_ok=True)

    targets = [
        ("icon-192.png", 192, "any"),
        ("icon-512.png", 512, "any"),
        ("icon-maskable-192.png", 192, "maskable"),
        ("icon-maskable-512.png", 512, "maskable"),
    ]

    for name, size, purpose in targets:
        output = ICONS_DIR / name
        if purpose == "maskable":
            make_maskable_icon(SVG_PATH, output, size)
        else:
            render_svg_to_png(SVG_PATH, output, size)
        # Verify the file size
        actual = output.stat().st_size
        print(f"  ✓ {name} ({size}x{size}, {purpose}) — {actual} bytes")

    print("\nAll PWA icons generated successfully.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
