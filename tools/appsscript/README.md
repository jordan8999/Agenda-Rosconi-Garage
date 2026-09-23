# Backend de turnos (Google Apps Script)

Este backend es el motor de reservas del sitio: no usa ninguna plataforma de
turnos de terceros. La web pide los horarios libres y manda la reserva; el
turno queda como evento en el **Google Calendar** del taller.

- Archivo principal: `Code.gs`
- Manifest: `appsscript.json` (zona horaria `America/Montevideo`)

## Instalación (una sola vez, ~5 minutos)

1. Entrar a <https://script.new> con la cuenta de Google del taller
   (`martinrosca12@gmail.com`) y ponerle un nombre al proyecto, por ejemplo
   `Turnos Rosconi Garage`.
2. Borrar el contenido de `Code.gs` y pegar **todo** el contenido de
   `tools/appsscript/Code.gs`.
3. En el panel izquierdo, ⚙️ **Configuración del proyecto**: marcar
   *Mostrar el archivo de manifiesto `appsscript.json`* y reemplazar su
   contenido por el de `tools/appsscript/appsscript.json`.
4. Ajustar el bloque `CONFIG` de arriba de todo:
   - `CLAVE`: cambiar por una cadena propia (y copiar el mismo valor en
     `assets/js/booking.js`).
   - `SERVICIOS`: revisar los minutos de cada trabajo (ver más abajo).
   - `ATENCION`: horarios de atención por día.
5. Ejecutar la función `instalar` (botón ▶). La primera vez Google pide
   autorizar el acceso al calendario: aceptar con la cuenta del taller.
6. Ejecutar `probar`. En el registro (Ver > Registros) tiene que aparecer:
   días revisados, primer turno libre, la reserva creada y la reserva de
   prueba borrada.
7. **Implementar > Nueva implementación > Aplicación web**:
   - *Ejecutar como*: **Yo** (`martinrosca12@gmail.com`)
   - *Quién tiene acceso*: **Cualquier persona**
   - Copiar la **URL de la aplicación web** (termina en `/exec`).
8. Pegar esa URL en `assets/js/booking.js`, en la constante `ENDPOINT`.

Listo: desde ese momento las reservas de la web caen solas en el calendario.

## Cómo funciona la capacidad

| Concepto | Valor | Dónde se cambia |
|---|---|---|
| Cupos simultáneos | 2 (1 elevador + 1 en piso de desborde) | `CONFIG.CUPOS` |
| Anticipación mínima | 24 h | `CONFIG.ANTICIPACION_MIN` |
| Agenda abierta | 30 días | `CONFIG.DIAS_VISTA` |
| Intervalo entre turnos | 30 min | `CONFIG.PASO_MIN` |
| Máximo de reservas web por día | 12 | `CONFIG.MAX_RESERVAS_POR_DIA` |
| Máximo por teléfono | 2 (el cupo se libera al cancelar) | `CONFIG.MAX_RESERVAS_POR_TELEFONO` |

El cliente ve **"libre"** o **"último lugar"**. Nunca ve elevador ni piso: la
línea que corresponde queda anotada en el título del evento
(`Turno ELEVADOR · Golf`) solo para uso interno del taller.

## Cómo se ofrecen los horarios

Cada servicio de `CONFIG.SERVICIOS` tiene sus minutos y, si corresponde, la marca
`deja: true`:

| Servicio | Minutos | Modalidad |
|---|---|---|
| Service completo y lubricentro | 60 | por horario |
| Diagnóstico con scanner | 30 | por horario |
| Mecánica general | 120 | por horario |
| Reprogramación electrónica | 120 | por horario |
| Otro trabajo / no estoy seguro | 60 | por horario |
| Distribución y cadena | 480 | **deja el auto** |
| Mecánica integral | 480 | **deja el auto** |

- **Por horario:** el cliente elige día y hora, y el trabajo tiene que entrar
  completo dentro de una franja de atención (08:00–12:00 o 14:00–18:00). Con 60
  minutos, el último horario de la mañana es 11:00.
- **Deja el auto** (`deja: true`): el cliente elige **a qué hora lo trae**, y solo
  se ofrecen las 08:00 y las 14:00 (el comienzo de cada franja). El auto ocupa un
  lugar **hasta el cierre del día**, porque el trabajo puede llevar de unas horas a
  un día completo y muchas veces queda para el día siguiente por repuestos o
  herramientas. No se promete una duración exacta: el cuadro de reserva lo explica
  ("el auto queda en el taller, lo retirás cuando esté listo") y los minutos de la
  tabla quedan solo como referencia.

En el calendario esos turnos aparecen como
`⚠️ Turno ELEVADOR · Golf 2015 (deja el auto)` y llegan hasta las 18:00. **Si el
auto sigue en el taller al día siguiente, estirá el fin del evento** hasta el
momento en que sale: así la agenda deja de ofrecer ese lugar.

Para pasar otro servicio a esta modalidad alcanza con agregarle `deja: true`.

Cualquier trabajo de 240 minutos o más se marca con ⚠️ en el título del evento
para que el taller lo revise.

## Cerrar un día (feriado, vacaciones, taller lleno)

Cargar en el calendario un **evento de todo el día** en esa fecha. El día deja
de ofrecerse automáticamente.

## Cambiar algo después

Si se edita `Code.gs`, hay que volver a implementar: **Implementar > Administrar
implementaciones > editar (lápiz) > Versión: Nueva versión > Implementar**. La
URL `/exec` no cambia.

## Reintentos y turnos duplicados

Si el cliente toca dos veces "Confirmar" o se le corta la conexión justo después
de confirmar, el segundo envío **no** crea otro turno: el backend reconoce el
mismo teléfono en el mismo horario y devuelve el turno que ya existe, con su
código y la marca `repetido`. Un reintento nunca ocupa el segundo lugar ni deja
un evento duplicado en el calendario. La web, además, reintenta sola una vez
cuando una petición falla.

## Limpiar turnos de prueba

`limpiarPruebas()` borra los turnos que hayan quedado de las verificaciones
automáticas (clientes con nombres de prueba: `Prueba automatica`,
`Cliente de prueba`, `Ana Perez`, `Bruno Diaz`, `Carla Sosa`). **Nunca toca
turnos reales.** Se ejecuta a mano desde el editor, igual que `instalar`: elegir
`limpiarPruebas` en el desplegable y ▶ Ejecutar; en el registro informa qué
borró.

## Verificar la conexión

```
GET https://script.google.com/macros/s/..../exec?action=ping&clave=TU_CLAVE
-> {"ok":true,"mensaje":"Servicio de turnos activo","zona":"America/Montevideo"}
```

## Prueba local sin Google

`tools/mock-turnos.py` implementa el mismo contrato en memoria. Sirve para
probar el sitio sin tocar el calendario:

```powershell
python tools/mock-turnos.py          # http://127.0.0.1:8130
```

Apuntando `ENDPOINT` de `assets/js/booking.js` a esa dirección se puede probar
todo el flujo (agenda, reserva, consulta y cancelación) sin ensuciar la agenda
real.
