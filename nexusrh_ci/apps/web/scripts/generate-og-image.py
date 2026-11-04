"""Génère public/og-image.png (1200 x 630), l'image de partage du portail public.

Usage (depuis apps/web) :  python scripts/generate-og-image.py
Dépendance : Pillow seulement (pas de dépendance npm). L'image produite est
versionnée ; ce script ne tourne pas au build, on le relance quand le texte change.

Texte imposé : « NexusRH », « SIRH et paie — Côte d'Ivoire et UEMOA »,
« par OpenLab Consulting ». Couleurs du site (cf. HomePage.tsx).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
INK = (15, 18, 20)        # #0F1214, fond
ORANGE = (240, 78, 16)    # #F04E10, marque
CYAN = (8, 145, 178)      # #0891B2, accent
WHITE = (255, 255, 255)
MUTED = (163, 170, 176)

TITLE = 'NexusRH'
SUBTITLE = "SIRH et paie — Côte d'Ivoire et UEMOA"
BYLINE = 'par OpenLab Consulting'

# Polices cherchées dans l'ordre (Windows, puis Linux, puis macOS).
BOLD = ['arialbd.ttf', 'DejaVuSans-Bold.ttf', 'Arial Bold.ttf']
REGULAR = ['arial.ttf', 'DejaVuSans.ttf', 'Arial.ttf']
FONT_DIRS = [
    Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts',
    Path('/usr/share/fonts/truetype/dejavu'),
    Path('/Library/Fonts'),
    Path('/System/Library/Fonts/Supplemental'),
]


def font(names: list[str], size: int) -> ImageFont.FreeTypeFont:
    for d in FONT_DIRS:
        for n in names:
            p = d / n
            if p.is_file():
                return ImageFont.truetype(str(p), size)
    sys.exit(f'Aucune police trouvée parmi {names}')


def main() -> None:
    out = Path(__file__).resolve().parent.parent / 'public' / 'og-image.png'
    img = Image.new('RGB', (W, H), INK)
    d = ImageDraw.Draw(img)

    # Bandeau orange à gauche et filet cyan en bas : sobres, aux couleurs du site.
    d.rectangle([0, 0, 24, H], fill=ORANGE)
    d.rectangle([0, H - 10, W, H], fill=CYAN)

    x = 110
    title_font = font(BOLD, 150)
    d.text((x, 150), TITLE, font=title_font, fill=WHITE)
    # Point orange après le nom, comme un accent de marque.
    tw = d.textlength(TITLE, font=title_font)
    d.ellipse([x + tw + 14, 270, x + tw + 44, 300], fill=ORANGE)

    d.rectangle([x, 345, x + 120, 351], fill=ORANGE)
    d.text((x, 385), SUBTITLE, font=font(BOLD, 52), fill=WHITE)
    d.text((x, 470), BYLINE, font=font(REGULAR, 36), fill=MUTED)

    img.save(out, 'PNG', optimize=True)
    print(f'{out} ({W}x{H})')


if __name__ == '__main__':
    main()
