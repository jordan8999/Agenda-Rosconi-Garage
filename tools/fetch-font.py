"""Descarga la tipografia display (Bebas Neue) para auto-hospedarla.

Se ejecuta una sola vez; el .woff2 queda versionado en assets/fonts/.
Requiere conexion a internet (Google Fonts CSS API -> woff2 latin).
"""
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "assets" / "fonts"
CSS_API = "https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def main() -> int:
    css = fetch(CSS_API).decode("utf-8")
    bloques = re.findall(r"@font-face\s*\{(.*?)\}", css, re.S)
    elegido = None
    for bloque in bloques:
        if "U+0000-00FF" in bloque or "latin" in bloque:
            url = re.search(r"url\((https://[^)]+\.woff2)\)", bloque)
            if url:
                elegido = url.group(1)
                break
    if not elegido and bloques:
        elegido = re.search(r"url\((https://[^)]+\.woff2)\)", bloques[-1]).group(1)
    if not elegido:
        print("No se encontro un archivo woff2 en la respuesta de Google Fonts.")
        return 1

    DEST.mkdir(parents=True, exist_ok=True)
    salida = DEST / "bebas-neue-400-latin.woff2"
    salida.write_bytes(fetch(elegido))
    print("Origen:", elegido)
    print("Guardado:", salida, f"({salida.stat().st_size / 1024:.1f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
