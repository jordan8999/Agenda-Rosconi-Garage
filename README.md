# Rosconi Garage — sitio web del taller

Sitio estático (una sola página) del taller mecánico **Rosconi Garage**, en Juan Antonio Lavalleja 730,
Artigas, Uruguay. Está pensado para dos objetivos concretos: **posicionar búsquedas locales**
("taller mecánico en Artigas", service, distribución, reprogramación) y **convertir visitas en turnos
reservados** mediante una agenda online externa (Cal.com).

- **Sitio publicado:** https://jordanweb2016.github.io/Rosconi-Garage/
- **Agenda de turnos:** https://cal.com/rosconigarage
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
│  ├─ js/booking.js           # Carga diferida de la agenda de Cal.com
│  ├─ fonts/                  # Bebas Neue auto-hospedada (13 KB, sin Google Fonts en runtime)
│  ├─ icons/                  # favicon set + logo del taller
│  └─ img/                    # Fotos optimizadas (WebP + JPG de respaldo)
└─ tools/
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

## Cambiar los turnos (Cal.com)

`assets/js/booking.js` tiene tres valores que deben coincidir con la cuenta de Cal.com:

```js
usuario: "rosconigarage",
// slugs de los tipos de evento
"rosconigarage/turno-elevador"        // Línea A: trabajos que necesitan el elevador
"rosconigarage/turno-service-rapido"  // Línea B: service, lubricentro y diagnósticos
```

Los botones son **enlaces reales** a `https://cal.com/rosconigarage/<slug>`: si el embed no carga o el
visitante no tiene JavaScript, el turno se puede reservar igual (se abre Cal.com en otra pestaña).

Recomendación de configuración en Cal.com: zona horaria **America/Montevideo**, disponibilidad
lunes a viernes de 08:00 a 12:00 y de 14:00 a 18:00, anticipación mínima de 24 horas y un margen entre
turnos acorde a la duración de cada trabajo.

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
  de portada, y el script de Cal.com se descarga **solo cuando el visitante abre la agenda**.
- **Conversión:** cada servicio y cada sección empujan a la reserva; el WhatsApp queda siempre como
  alternativa de un clic.
