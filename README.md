# Rosconi Garage — sitio web del taller

Sitio estático (una sola página) del taller mecánico **Rosconi Garage**, en Juan Antonio Lavalleja 730,
Artigas, Uruguay. Está pensado para dos objetivos concretos: **posicionar búsquedas locales**
("taller mecánico en Artigas", service, distribución, reprogramación) y **convertir visitas en turnos
reservados** con una agenda propia (Google Calendar + Google Apps Script, sin plataformas de terceros).

- **Sitio publicado:** https://jordan8999.github.io/Agenda-Rosconi-Garage/
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
├─ panel.html                 # Panel privado del taller (agenda del día, WhatsApp, anotar)
├─ assets/
│  ├─ css/styles.css          # Única hoja de estilos (design tokens + componentes)
│  ├─ css/panel.css           # Estilos del panel del taller (incluye versión para imprimir)
│  ├─ js/main.js              # Navegación, secciones activas, lightbox de la galería
│  ├─ js/booking.js           # Reserva de turnos: agenda, confirmación, consulta y cancelación
│  ├─ js/panel.js             # Panel del taller: día, próximos 14 días, buscar, anotar, listo
│  ├─ fonts/                  # Bebas Neue auto-hospedada (13 KB, sin Google Fonts en runtime)
│  ├─ icons/                  # favicon set + logo del taller
│  └─ img/                    # Fotos optimizadas (WebP + JPG de respaldo)
└─ tools/
   ├─ appsscript/             # Backend de turnos (Code.gs + appsscript.json + guía)
   ├─ mock-turnos.py          # Backend falso para probar en local (mismo contrato)
   ├─ pruebas-turnos.py       # 106 pruebas del contrato (reservas + panel del taller)
   ├─ pruebas-ui.html         # Pruebas de integración manejando el sitio en un navegador
   ├─ pruebas-panel.html      # Pruebas de integración del panel (clave, agenda, anotar, listo)
   ├─ pruebas-sintaxis.html   # Compila los scripts con el parser del navegador
   ├─ diagnostico-endpoint.html # Consulta el backend real desde el navegador
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
4. El taller ve cada turno en su **Google Calendar**: el auto, el cliente con teléfono y **link a
   WhatsApp**, el trabajo, la línea interna (elevador o piso) y el aviso cuando el auto queda en el
   taller. Además recibe **un mail con el resumen del día** a las 7:30 y un **recordatorio** 60
   minutos antes de cada turno (detalle en `tools/appsscript/README.md`).

La puesta en marcha (5 minutos, una sola vez) está paso a paso en `tools/appsscript/README.md`.

### Conectar el sitio con el backend

En `assets/js/booking.js` ya están puestos los datos de la app web del taller:

```js
ENDPOINT: "https://script.google.com/macros/s/..../exec",  // app web publicada
CLAVE: "rosconi-artigas-turnos-2026-k72b",                 // igual a CONFIG.CLAVE del script
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
| Trabajos por horario | Entran completos en una franja (08:00–12:00 o 14:00–18:00) |
| Trabajos que dejan el auto | Entrega a las 08:00 o 14:00; ocupan el lugar hasta el cierre |
| Límite antiabuso | 2 reservas por teléfono y 12 por día (se libera al cancelar) |
| Cerrar un día (feriado) | evento de todo el día en el calendario |

El cliente **nunca** elige línea ni herramienta: ve "varios horarios" o "último lugar". La línea que
corresponde queda anotada en el título del evento (`Turno ELEVADOR · Golf`) solo para uso interno.

Si un cliente toca dos veces "Confirmar" (o se le corta la conexión justo al confirmar), el backend
reconoce el mismo teléfono en el mismo horario y devuelve **el turno que ya existe**: un reintento
nunca duplica el evento ni ocupa el segundo lugar. Para verificar a mano el backend desplegado:

```powershell
python tools/pruebas-turnos.py --url https://script.google.com/macros/s/XXXX/exec --clave TU_CLAVE
```

Todos los caminos abren el **mismo** cuadro de reserva: el botón del hero, el del menú, el de la
sección de turnos y el `data-servicio="..."` de cada tarjeta de servicio (que además preselecciona
el trabajo).

### Cómo se ofrecen los horarios

Hay dos modalidades, definidas por servicio en `CONFIG.SERVICIOS` de `tools/appsscript/Code.gs`:

- **Por horario** (`minutos`): el cliente elige día y hora, y el trabajo tiene que entrar completo
  dentro de una franja de atención. Hoy: service completo (60), diagnóstico (30), mecánica general
  (120), reprogramación electrónica (120) y "otro trabajo" (60).
- **Deja el auto** (`deja: true`): el cliente elige **a qué hora lo trae** (solo 08:00 o 14:00) y el
  auto ocupa un lugar **hasta el cierre del día**. Es el caso de mecánica integral y distribución,
  que pueden llevar de unas horas a un día completo y a veces quedan para el día siguiente por
  repuestos o herramientas. El cuadro de reserva lo explica y el evento del calendario queda marcado
  `(deja el auto)`.

Si el auto sigue en el taller al día siguiente, se estira el fin del evento en el calendario para que
la agenda no ofrezca ese lugar de más. Para pasar otro servicio a esta modalidad alcanza con
agregarle `deja: true`.

### Probar sin tocar la agenda real

```powershell
python tools/mock-turnos.py        # backend falso en http://127.0.0.1:8130
python tools/pruebas-turnos.py     # 106 pruebas del contrato (reservas, límites, panel del taller)
python -m http.server 8125         # sitio; después abrir tools/pruebas-ui.html
```

`tools/pruebas-ui.html` maneja el sitio real dentro de un iframe (abrir la agenda, elegir día y
hora, confirmar, consultar y cancelar) contra el mock. Para apuntar el sitio al mock, agregar
`?turnos=http://127.0.0.1:8130` a la URL (por seguridad solo se aceptan direcciones locales).

`tools/pruebas-panel.html` hace lo mismo con el panel del taller: ingresa con la clave, revisa
la agenda del día, los botones de contacto, marca un trabajo como listo, anota un turno por
teléfono, recorre los próximos 14 días y busca un cliente. Usa el mock en el puerto 8131.

Otros dos verificadores de desarrollo, también desde el servidor local:

- `tools/pruebas-sintaxis.html` — compila `main.js`, `booking.js` y `Code.gs` con el parser del
  navegador (útil porque `Code.gs` no se puede ejecutar en local).
- `tools/diagnostico-endpoint.html` — consulta el backend desde el navegador (igual que el sitio)
  y muestra la respuesta cruda: sirve para confirmar que la app web quedó accesible desde internet.
- `tools/diagnostico-desborde.html` — mide desborde horizontal del sitio en 320 a 1440 px.

Con `tools/pruebas-ui.html?real` la prueba de integración corre contra el **backend desplegado**
en vez del mock: crea un turno real en el calendario del taller y lo cancela al final.

## El panel del taller (para el dueño)

Además del calendario, el sitio incluye una **página privada** para el taller:

**https://jordan8999.github.io/Agenda-Rosconi-Garage/panel.html**

- Entra con la **clave del panel** (la muestra `instalar` en el registro de Apps Script; es
  distinta de la clave pública del sitio y queda guardada solo en ese dispositivo).
- **Día**: la agenda real del día, un auto por tarjeta: hora, auto, trabajo, cliente,
  **botón de WhatsApp y de llamar**, la línea interna (elevador o piso) y el comentario de
  qué hay que hacer. Incluye "lugares libres" y un botón para imprimir la hoja del día.
- **Próximos 14 días**: una línea por día con los autos agendados, para ver la carga de
  trabajo de un vistazo.
- **Buscar**: por cliente, teléfono, auto o código.
- **Anotar un turno**: para los clientes que llaman por teléfono (sin la anticipación de
  24 h ni los límites antiabuso de la web, que existen solo para la reserva pública), y
  **Marcar listo para retirar** en cada tarjeta.

La página no se indexa (`noindex` + `robots.txt`) y el acceso está protegido con una clave
propia que **no vive en el repositorio**: se genera al ejecutar `instalar` y se guarda en las
propiedades del script.

## Lo que hay que mantener al día

- **Horarios:** si cambian, actualizarlos en `index.html` (sección Contacto, FAQ y footer) y en
  `openingHoursSpecification` de los datos estructurados.
- **Datos estructurados:** hay dos bloques JSON-LD en `index.html`: `AutoRepair` (negocio local) y
  `FAQPage` (preguntas frecuentes). Deben reflejar el texto visible.
- **Datos desde el móvil:** el botón flotante de WhatsApp y el de "cómo llegar" usan las coordenadas
  `-30.4066293,-56.4605533`.
- **Backend de turnos:** si se edita `tools/appsscript/Code.gs`, hay que pegar el archivo en el
  proyecto de Apps Script y **reimplementar** (*Implementar > Administrar implementaciones > nueva
  versión*); la URL `/exec` no cambia. Si quedaron turnos de prueba, se borran ejecutando
  `limpiarPruebas` desde el editor.
- **URL canónica:** si algún día se usa un dominio propio, hay que reemplazar
  `https://jordan8999.github.io/Agenda-Rosconi-Garage/` en `index.html` (canonical, Open Graph, JSON-LD),
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
