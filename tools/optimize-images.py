#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pipeline de imagenes del sitio Rosconi Garage.

Toma los PNG originales de ``Foto 1_files/`` y genera los assets optimizados
que usa el sitio (WebP + JPG de respaldo), ademas del favicon set y la
imagen de Open Graph.

Salidas
-------
assets/img/<slug>-<ancho>.webp|.jpg      fotos de galeria (1600 / 800 / 400)
assets/img/hero-<ancho>.webp|.jpg        portada recortada 16:9
assets/img/og-1200x630.jpg               Open Graph / Twitter Card
assets/icons/*                           favicon set (logo real del taller)

Uso
---
    python tools/optimize-images.py            # todo: fotos + hero + og + iconos
    python tools/optimize-images.py --photos   # solo fotos de galeria
    python tools/optimize-images.py --sheet    # hoja de contactos para revisar

Requisitos: Pillow (``python -m pip install Pillow``)
"""
from __future__ import annotations

import argparse
import io
import json
import math
import tempfile
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "Foto 1_files"
IMG_DIR = ROOT / "assets" / "img"
ICON_DIR = ROOT / "assets" / "icons"

WIDTHS = (1600, 800, 400)
WEBP_QUALITY = 82
JPG_QUALITY = 82

LOGO_URL = "https://i.imgur.com/gMzC2BF.png"
HERO_PHOTO = 10
HERO_WIDTHS = (640, 400)
OG_SIZE = (1200, 630)
ACCENT = (255, 107, 0, 255)
DARK = (10, 10, 10)

# ---------------------------------------------------------------------------
# Mapa de fotos: numero -> (slug de salida, texto alternativo en espanol).
# El alt alimenta el atributo alt= de la galeria (accesibilidad + SEO local).
# ---------------------------------------------------------------------------
PHOTOS: dict[int, tuple[str, str]] = {
    1: ("taller-cartel-rosconi-garage", "Golf GTI rojo bajo el cartel de Rosconi Garage en Artigas"),
    2: ("golf-sobre-elevador-service", "Volkswagen Golf azul elevado durante un service en Rosconi Garage"),
    3: ("reparacion-caja-de-cambios", "Caja de cambios desarmada en reparacion en Rosconi Garage"),
    4: ("motor-desarmado-distribucion", "Motor desarmado con arbol de levas y cadena de distribucion a la vista"),
    5: ("cambio-de-aceite-liqui-moly", "Cambio de aceite con Liqui Moly Top Tec 4200 5W-40"),
    6: ("audi-tt-capo-abierto", "Audi TT naranja con el capo abierto en el box del taller"),
    7: ("mecanico-trabajando-en-motor", "Mecanico trabajando con herramientas sobre el motor de un auto"),
    8: ("aditivo-blue-chem-injection", "Aplicacion de aditivo Blue Chem Injection Cleaner en el motor"),
    9: ("audi-capo-abierto-en-box", "Audi rojo con el capo abierto durante una reparacion"),
    10: ("mercedes-benz-en-taller", "Mercedes-Benz oscuro en el interior del taller Rosconi Garage"),
    11: ("promo-blue-chem-fuel-system-cleaner", "Promocion Blue Chem Fuel System Cleaner para limpiar el sistema de gasolina"),
    12: ("promo-blue-chem-nano-engine", "Promocion Blue Chem powerX Nano Engine Super Protection"),
    13: ("piezas-de-motor-desmontadas", "Piezas y culata desmontadas durante una reparacion de motor"),
    14: ("carter-sellado-px-black", "Carter desmontado y sellado con silicona Blue Chem PX Black"),
    15: ("arbol-de-levas-y-cadena", "Arbol de levas y cadena de distribucion a la vista durante la reparacion"),
    16: ("amarok-v6-reprogramacion", "Volkswagen Amarok V6 durante una reprogramacion electronica CSR"),
    17: ("frente-desarmado-reparacion", "Frente desarmado de una camioneta durante una reparacion mayor"),
}


# ---------------------------------------------------------------------------
# Utilidades de imagen
# ---------------------------------------------------------------------------
def source_path(number: int) -> Path:
    """Devuelve la ruta del original aceptando variaciones de mayusculas."""
    for path in SRC_DIR.glob(f"[Ff]oto {number}.png"):
        return path
    raise FileNotFoundError(f"No se encontro 'foto {number}.png' en {SRC_DIR}")


def open_source(path: Path) -> Image.Image:
    """Abre el PNG, corrige orientacion EXIF y lo aplana sobre fondo oscuro."""
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            canvas = Image.new("RGB", im.size, DARK)
            canvas.paste(im, mask=im.split()[-1])
            return canvas
        return im.convert("RGB")


def save_variants(im: Image.Image, slug: str) -> list[Path]:
    """Guarda la imagen en los anchos pedidos, en WebP y JPG (sin ampliar)."""
    written: list[Path] = []
    # Nunca se amplia: se usan los anchos pedidos que entren y, siempre,
    # el ancho nativo del original (es el mejor que puede dar la fuente).
    widths = sorted({w for w in WIDTHS if w <= im.width} | {im.width})
    skipped = [w for w in WIDTHS if w > im.width]
    if skipped:
        print(f"    ! original de {im.width}px: se omiten {skipped}, se agrega {im.width}px nativo")
    for width in widths:
        height = round(im.height * width / im.width)
        resized = im.resize((width, height), Image.LANCZOS)
        webp = IMG_DIR / f"{slug}-{width}.webp"
        jpg = IMG_DIR / f"{slug}-{width}.jpg"
        resized.save(webp, "WEBP", quality=WEBP_QUALITY, method=6)
        resized.save(
            jpg,
            "JPEG",
            quality=JPG_QUALITY,
            optimize=True,
            progressive=True,
            subsampling="4:2:0",
        )
        written.extend((webp, jpg))
    return written


def cover_crop(im: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Recorta tipo ``object-fit: cover`` centrando un poco arriba (0.45)."""
    return ImageOps.fit(im, size, method=Image.LANCZOS, centering=(0.5, 0.45))


def human(path: Path) -> str:
    return f"{path.stat().st_size / 1024:.0f} KB"
# ---------------------------------------------------------------------------
# Etapas del pipeline
# ---------------------------------------------------------------------------
def build_photos() -> dict[str, dict]:
    print("\n[1/3] Fotos de galeria")
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    total = 0
    manifest: dict[str, dict] = {}
    for number in sorted(PHOTOS):
        slug, alt = PHOTOS[number]
        src = source_path(number)
        im = open_source(src)
        print(f"  {src.name} {im.width}x{im.height} ({human(src)}) -> {slug}")
        written = save_variants(im, slug)
        total += sum(p.stat().st_size for p in written)
        widths = sorted(
            {int(p.stem.rsplit("-", 1)[-1]) for p in written if p.suffix == ".webp"}
        )
        manifest[slug] = {
            "alt": alt,
            "origen": src.name,
            "ancho": im.width,
            "alto": im.height,
            "variantes": widths,
        }
        biggest = max(written, key=lambda p: p.stat().st_size)
        print(f"    {len(written)} archivos {widths} | mas pesado: {biggest.name} {human(biggest)}")
    print(f"  Subtotal galeria: {total / 1024 / 1024:.2f} MB")
    return manifest


def build_hero_and_og() -> dict:
    print("\n[2/3] Portada 4:5 + Open Graph")
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    for stale in IMG_DIR.glob("hero-*"):
        stale.unlink()
    im = open_source(source_path(HERO_PHOTO))
    # El original es vertical (~660x875). Se recorta 4:5 y NUNCA se amplia:
    # el hero usa un layout partido, asi la foto se ve nitida.
    portrait = cover_crop(im, (im.width, round(im.width * 5 / 4)))
    widths: list[int] = []
    for width in HERO_WIDTHS:
        if width >= portrait.width:
            continue
        height = round(portrait.height * width / portrait.width)
        resized = portrait.resize((width, height), Image.LANCZOS)
        resized.save(IMG_DIR / f"hero-{width}.webp", "WEBP", quality=WEBP_QUALITY, method=6)
        resized.save(
            IMG_DIR / f"hero-{width}.jpg",
            "JPEG",
            quality=JPG_QUALITY,
            optimize=True,
            progressive=True,
            subsampling="4:2:0",
        )
        widths.append(width)
        print(f"  hero-{width}.webp: {human(IMG_DIR / f'hero-{width}.webp')}")
    og = cover_crop(im, OG_SIZE).filter(
        ImageFilter.UnsharpMask(radius=1.6, percent=110, threshold=3)
    )
    og.save(IMG_DIR / "og-1200x630.jpg", "JPEG", quality=84, optimize=True, progressive=True)
    print(f"  og-1200x630.jpg: {human(IMG_DIR / 'og-1200x630.jpg')} (desde {im.width}x{im.height})")
    return {
        "origen": source_path(HERO_PHOTO).name,
        "recorte": "4:5",
        "variantes": widths,
        "og": "og-1200x630.jpg",
    }


def load_logo() -> Image.Image:
    request = urllib.request.Request(
        LOGO_URL, headers={"User-Agent": "RosconiGarage-build/1.0"}
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read()
    with Image.open(io.BytesIO(data)) as im:
        return im.convert("RGBA")


def _icon_canvas(logo: Image.Image, size: int, background, padding: float) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), background)
    inner = max(1, int(size * (1 - 2 * padding)))
    mark = logo.copy()
    mark.thumbnail((inner, inner), Image.LANCZOS)
    canvas.alpha_composite(mark, ((size - mark.width) // 2, (size - mark.height) // 2))
    return canvas


def build_icons() -> None:
    print("\n[3/3] Favicon set")
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    logo = load_logo()
    transparent = (0, 0, 0, 0)
    for name, size, padding in (
        ("apple-touch-icon-180.png", 180, 0.16),
        ("icon-192.png", 192, 0.16),
        ("icon-512.png", 512, 0.16),
        ("maskable-512.png", 512, 0.22),
    ):
        _icon_canvas(logo, size, ACCENT, padding).convert("RGB").save(
            ICON_DIR / name, "PNG", optimize=True
        )
        print(f"  {name}: {human(ICON_DIR / name)}")
    _icon_canvas(logo, 32, transparent, 0.06).save(ICON_DIR / "favicon-32.png", "PNG", optimize=True)
    _icon_canvas(logo, 256, transparent, 0.06).save(
        ICON_DIR / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)]
    )
    for name in ("favicon-32.png", "favicon.ico"):
        print(f"  {name}: {human(ICON_DIR / name)}")


def build_sheet(cell: int = 420, cols: int = 4) -> Path:
    """Hoja de contactos numerada: sirve para clasificar las fotos de una sola vez."""
    numbers = sorted(PHOTOS)
    rows = math.ceil(len(numbers) / cols)
    label_h = 36
    sheet = Image.new("RGB", (cols * cell, rows * (cell + label_h)), (26, 26, 26))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("arial.ttf", 26)
    except OSError:
        font = ImageFont.load_default()
    for index, number in enumerate(numbers):
        row, col = divmod(index, cols)
        x, y = col * cell, row * (cell + label_h)
        im = open_source(source_path(number))
        sheet.paste(ImageOps.fit(im, (cell - 8, cell - 8), method=Image.LANCZOS), (x + 4, y + 4))
        draw.text(
            (x + 10, y + cell + 4),
            f"#{number}  {im.width}x{im.height}",
            fill=(255, 255, 255),
            font=font,
        )
    out = Path(tempfile.gettempdir()) / "rosconi-contact-sheet.jpg"
    sheet.save(out, "JPEG", quality=88, optimize=True)
    return out


def write_manifest(photos: dict[str, dict], hero: dict) -> None:
    """Deja los anchos reales en disco: la base para escribir los srcset exactos."""
    payload = {
        "generado_por": "tools/optimize-images.py",
        "hero": hero,
        "fotos": photos,
    }
    path = ROOT / "tools" / "image-manifest.json"
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"\nManifiesto: {path}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Optimiza las imagenes de Rosconi Garage.")
    parser.add_argument("--photos", action="store_true", help="solo fotos de galeria")
    parser.add_argument("--sheet", action="store_true", help="solo hoja de contactos")
    args = parser.parse_args()

    if args.sheet:
        print(f"Hoja de contactos: {build_sheet()}")
        return 0

    photos = build_photos()
    hero: dict = {}
    if not args.photos:
        hero = build_hero_and_og()
        build_icons()
    write_manifest(photos, hero)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
