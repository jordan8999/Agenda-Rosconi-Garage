# Rosconi Garage — sitio web del taller

Sitio estático (una sola página) del taller mecánico **Rosconi Garage**, en Juan Antonio Lavalleja 730,
Artigas, Uruguay. Está pensado para dos objetivos concretos: **posicionar búsquedas locales**
("taller mecánico en Artigas", service, distribución, reprogramación) y **convertir visitas en turnos
reservados** con una agenda propia (Google Calendar + Google Apps Script, sin plataformas de terceros).

- **Sitio publicado:** https://jordanweb2016.github.io/Rosconi-Garage/
- **Agenda de turnos:** propia, sobre el Google Calendar del taller (ver `tools/appsscript/`)
- **WhatsApp / teléfono:** +598 91 317 613
- **Email:** martinrosca12@gmail.com
- **Instagram:** https://www.instagram.com/rosconigarage/

## Estructura

```
.
├─ index.html                 # Todo el sitio: contenido, meta tags y datos estructurados
├─ robots.txt                 # Indexación + referencia al sitemap
├─ sitemap.xml                # Mapa del sitio (con imágenes)
├─ site.webmanifest           # Manifest para "agregar a pantalla de inicio"
├─ assets/
│  ├─ css/styles.css          # Única hoja de estilos (design tokens + componentes)
│  ├─ js/main.js              # Navegación, secciones activas, lightbox de la galería
│  ├─ js/booking.js           # Reserva de turnos: agenda, confirmación, consulta y cancelación
│  ├─ fonts/                  # Bebas Neue auto-hospedada (13 KB, sin Google Fonts en runtime)
│  ├─ icons/                  # favicon set + logo del taller
│  └─ img/                    # Fotos optimizadas (WebP + JPG de respaldo)
└─ tools/
   ├─ appsscript/             # Backend de turnos (Code.gs + appsscript.json + guía)
   ├─ mock-turnos.py          # Backend falso para probar en local (mismo contrato)
   ├─ pruebas-turnos.py       # 32 pruebas del contrato de reservas (mock o producción)
   ├─ pruebas-ui.html         # Pruebas de integración manejando el sitio en un navegador
   ├─ diagnostico-desborde.html # Mide desborde horizontal en 320–1440 px
   ├─ optimize-images.py      # Pipeline de imágenes (Pillow)
   ├─ fetch-font.py           # Descarga la tipografía display una sola vez
   ├─ image-manifest.json     # Anchos reales generados por foto (base de los srcset)
   └─ requirements.txt
```

## Ver el sitio en local

```powershell
python -m http.server 8123
# luego abrir http://127.0.0.1:8123/
```

## Regenerar las imágenes

Los originales (`Foto 1_files/`) **no se publican**: quedan fuera del repositorio. El pipeline los
recorta, corrige la orientación EXIF, elimina metadatos y exporta **WebP + JPG** en los anchos útiles,
nunca ampliando la imagen original.

```powershell
python -m pip install -r tools/requirements.txt
python tools/optimize-images.py            # fotos + portada + imagen Open Graph + favicons
python tools/optimize-images.py --photos   # solo fotos de galería
python tools/optimize-images.py --sheet    # hoja de contactos para clasificar originales
```

Para agregar una foto nueva: subir el original a `Foto 1_files/foto N.png`, registrarla en el
diccionario `PHOTOS` de `tools/optimize-images.py` con su `slug` y su texto `alt`, volver a correr el
script y sumar el `<button class="shot">` correspondiente en la galería de `index.html` usando los
anchos que informa `tools/image-manifest.json`.

## Cómo funciona la agenda de turnos

La reserva es **propia del taller**, no de una plataforma de terceros:

1. El sitio le pide los horarios libres a una **app web de Google Apps Script**
   (`tools/appsscript/Code.gs`), que lee el **Google Calendar** del taller.
2. Cuando el cliente confirma, la reserva se crea como **evento en el calendario**, con nombre,
   teléfono, vehículo y servicio, y el cliente recibe un **código** (`RG-XXXXXXXX`).
3. Con ese código el cliente puede **consultar o cancelar** el turno desde la misma sección de turnos.

La puesta en marcha (5 minutos, una sola vez) está paso a paso en `tools/appsscript/README.md`.

### Conectar el sitio con el backend

En `assets/js/booking.js`:

```js
ENDPOINT: "https://script.google.com/macros/s/XXXX/exec",  // URL de la app web
CLAVE: "rosconi-cambiar-esta-clave-2026",                  // igual a CONFIG.CLAVE del script
```

Si `ENDPOINT` queda vacío, el sitio ofrece la reserva por WhatsApp en lugar de mostrar un
calendario roto: nunca hay un callejón sin salida.

### Reglas de capacidad (ocultas para el cliente)

| Concepto | Valor |
|---|---|
| Cupos simultáneos | 2 (1 elevador + 1 lugar en piso como desborde) |
| Anticipación mínima | 24 h |
| Agenda abierta | 30 días |
| Intervalo entre turnos | 30 min |
| Cerrar un día (feriado) | evento de todo el día en el calendario |

El cliente **nunca** elige línea ni herramienta: ve "varios horarios" o "último lugar". La línea que
corresponde queda anotada en el título del evento (`Turno ELEVADOR · Golf`) solo para uso interno.

Todos los caminos abren el **mismo** cuadro de reserva: el botón del hero, el del menú, el de la
sección de turnos y el `data-servicio="..."` de cada tarjeta de servicio (que además preselecciona
el trabajo).

### Duraciones por servicio

`CONFIG.SERVICIOS` de `tools/appsscript/Code.gs` guarda los minutos estimados de cada trabajo y son
**provisionales**: hay que ajustarlos con los tiempos reales del taller (tabla en
`tools/appsscript/README.md`). Se usan para calcular los horarios ofrecidos y el largo del evento.

### Probar sin tocar la agenda real

```powershell
python tools/mock-turnos.py        # backend falso en http://127.0.0.1:8130
python tools/pruebas-turnos.py     # 32 pruebas del contrato (cupos, horarios, cancelación)
python -m http.server 8125         # sitio; después abrir tools/pruebas-ui.html
```

`tools/pruebas-ui.html` maneja el sitio real dentro de un iframe (abrir la agenda, elegir día y
hora, confirmar, consultar y cancelar) contra el mock. Para apuntar el sitio al mock, agregar
`?turnos=http://127.0.0.1:8130` a la URL (por seguridad solo se aceptan direcciones locales).

## Lo que hay que mantener al día

- **Horarios:** si cambian, actualizarlos en `index.html` (sección Contacto, FAQ y footer) y en
  `openingHoursSpecification` de los datos estructurados.
- **Datos estructurados:** hay dos bloques JSON-LD en `index.html`: `AutoRepair` (negocio local) y
  `FAQPage` (preguntas frecuentes). Deben reflejar el texto visible.
- **Datos desde el móvil:** el botón flotante de WhatsApp y el de "cómo llegar" usan las coordenadas
  `-30.4066293,-56.4605533`.
- **URL canónica:** si algún día se usa un dominio propio, hay que reemplazar
  `https://jordanweb2016.github.io/Rosconi-Garage/` en `index.html` (canonical, Open Graph, JSON-LD),
  `sitemap.xml` y `robots.txt`, y crear el archivo `CNAME`.

## Decisiones de implementación

- **Sin dependencias en runtime:** no hay Google Fonts, ni Font Awesome, ni jQuery. La tipografía se
  auto-hospeda y todos los iconos son SVG inline.
- **Imágenes:** `loading="lazy"` + `decoding="async"` en todo lo que no es la portada, `srcset` con los
  anchos reales disponibles y `width`/`height` declarados para evitar saltos de layout (CLS).
- **Accesibilidad (WCAG 2.1 AA):** contraste mínimo 4.5:1 en texto, `:focus-visible` visible en todo el
  sitio, enlace "saltar al contenido", landmarks semánticos, jerarquía de encabezados sin saltos,
  acordeones con `<details>` nativos, galería ampliable con `<dialog>` y `prefers-reduced-motion`
  respetado en todas las animaciones.
- **Rendimiento:** hoja de estilos y scripts locales con `defer`, precarga de la fuente y de la imagen
  de portada, y la agenda se **precarga en un momento libre** del navegador (una sola consulta para
  30 días, con caché de 60 s) para que el cuadro de reserva abra al instante.
- **Conversión:** cada servicio y cada sección empujan a la reserva; el WhatsApp queda siempre como
  alternativa de un clic.
