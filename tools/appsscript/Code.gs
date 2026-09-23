/**
 * Rosconi Garage — backend de turnos sobre Google Calendar
 * =========================================================
 * Este script vive en Google Apps Script (gratis) y es el motor de reservas
 * del sitio. La web le pide los horarios libres y le manda las reservas; el
 * turno queda como evento en el Google Calendar del taller.
 *
 * Contrato de la API (todo JSON)
 * ------------------------------
 * GET  ?action=agenda&clave=...&servicio=...&dias=30
 *      -> { ok, zona, actualizado, servicios[], dias[ { fecha, etiqueta,
 *           estado, turnos[ { hora, estado, cuposLibres } ] } ] }
 *
 * POST (body JSON, Content-Type text/plain)
 *      { accion: "crear",     clave, fecha, hora, nombre, telefono, vehiculo,
 *        servicio, email, comentario, empresa (honeypot) }
 *      { accion: "consultar", clave, codigo }
 *      { accion: "cancelar",  clave, codigo }
 *
 * Reglas del taller que implementa
 * --------------------------------
 *  - 1 elevador como norma y 1 lugar en piso como desborde: se traduce en
 *    2 cupos simultaneos. El cliente NUNCA ve esa distincion: solo ve "libre"
 *    o "ultimo lugar". La linea que corresponde queda anotada en el evento
 *    para uso interno del taller (ELEVADOR / PISO).
 *  - Turnos con 24 h de anticipacion como minimo y hasta 30 dias a futuro.
 *  - Para cerrar un dia (feriado, vacaciones) alcanza con cargar un evento de
 *    todo el dia en el calendario.
 *
 * Instalacion: ver tools/appsscript/README.md
 */

// ===========================================================================
// CONFIGURACION — lo unico que hay que tocar para ajustar el taller
// ===========================================================================
var CONFIG = {
  // Calendario donde se guardan los turnos. 'primary' = el principal de la
  // cuenta que despliega el script.
  CALENDARIO: 'primary',

  // Zona horaria del taller (tambien hay que fijarla en appsscript.json)
  ZONA: 'America/Montevideo',

  // Clave que viaja en cada pedido desde la web. Frena bots casuales.
  // Si la cambias aca, cambiala igual en assets/js/booking.js
  CLAVE: 'rosconi-artigas-turnos-2026-k72b',

  // Franjas de atencion por dia de la semana (0 = domingo ... 6 = sabado)
  ATENCION: {
    1: [['08:00', '12:00'], ['14:00', '18:00']],
    2: [['08:00', '12:00'], ['14:00', '18:00']],
    3: [['08:00', '12:00'], ['14:00', '18:00']],
    4: [['08:00', '12:00'], ['14:00', '18:00']],
    5: [['08:00', '12:00'], ['14:00', '18:00']]
  },

  PASO_MIN: 30,            // cada cuantos minutos puede empezar un turno
  ANTICIPACION_MIN: 1440,  // 24 h de anticipacion minima
  DIAS_VISTA: 30,          // hasta 30 dias para adelante
  CUPOS: 2,                // 1 elevador + 1 piso de desborde

  // Servicios del taller.
  //   minutos: duracion estimada del trabajo. Define que horarios se ofrecen
  //            y cuanto ocupa el evento en el calendario.
  //   deja:    true = el cliente DEJA EL AUTO en el taller. Elige solo la hora
  //            de entrega (el comienzo de cada franja) y el auto ocupa un lugar
  //            hasta el cierre. No se promete una duracion exacta: el trabajo
  //            puede llevar de 4 a 24 horas, y si el auto sigue en el taller al
  //            dia siguiente se estira el evento a mano en el calendario.
  SERVICIOS: [
    { nombre: 'Service completo y lubricentro', minutos: 60 },
    { nombre: 'Diagnóstico con scanner', minutos: 30 },
    { nombre: 'Mecánica general', minutos: 120 },
    { nombre: 'Distribución y cadena', minutos: 480, deja: true },
    { nombre: 'Mecánica integral', minutos: 480, deja: true },
    { nombre: 'Reprogramación electrónica', minutos: 120 },
    { nombre: 'Otro trabajo / no estoy seguro', minutos: 60 }
  ],
  SERVICIO_PREDETERMINADO: 'Service completo y lubricentro',
  AVISO_LARGO_MIN: 240,    // a partir de aca el evento se marca como largo

  MAX_RESERVAS_POR_DIA: 12,
  MAX_RESERVAS_POR_TELEFONO: 2,
  LOCK_MS: 15000,

  // Clave del panel del taller: DISTINTA de la clave publica del sitio.
  // OJO: esta clave es solo un respaldo. Al ejecutar `instalar` se genera una
  // clave aleatoria que se guarda en las PROPIEDADES DEL SCRIPT (no en este
  // archivo), asi no queda publicada en el repositorio. Para verla, ejecutar
  // `instalar` y leer el registro.
  CLAVE_ADMIN: 'rg-panel-cambiar-con-instalar',

  // --- Avisos para el taller -------------------------------------------------
  // Recordatorio emergente en el calendario, minutos antes del turno (0 = no).
  AVISO_MINUTOS_ANTES: 60,
  // Resumen diario por mail con los turnos del dia.
  RESUMEN_HORA: 7,
  RESUMEN_MINUTO: 30,
  RESUMEN_EMAIL: ''       // vacio = la cuenta de Google que desplego el script
};

// ===========================================================================
// Panel del taller
// ===========================================================================
// Acciones que solo funcionan con la clave de administracion.
var ACCIONES_ADMIN = ['panel', 'buscar', 'anotar', 'listo', 'estado'];
// Se muestra en el panel para saber que version del backend esta desplegada.
var VERSION_BACKEND = '2026-09-23-panel-1';

// ===========================================================================
// Puntos de entrada HTTP
// ===========================================================================
function doGet(e) {
  try {
    var parametros = (e && e.parameter) || {};
    exigirClave_(parametros.clave);

    var accion = parametros.action || 'agenda';
    if (accion === 'agenda') {
      return respuesta_(leerAgenda_(parametros));
    }
    if (accion === 'ping') {
      return respuesta_({ ok: true, mensaje: 'Servicio de turnos activo', zona: CONFIG.ZONA });
    }
    return respuesta_({ ok: false, error: 'accion_desconocida', mensaje: 'Accion no valida.' });
  } catch (error) {
    return respuesta_({ ok: false, error: 'error', mensaje: String((error && error.message) || error) });
  }
}

function doPost(e) {
  try {
    var cuerpo = {};
    if (e && e.postData && e.postData.contents) {
      cuerpo = JSON.parse(e.postData.contents);
    }
    exigirClave_(cuerpo.clave);

    var accion = cuerpo.accion || '';

    // Acciones del panel del taller: van con la clave de administracion.
    if (ACCIONES_ADMIN.indexOf(accion) > -1) {
      exigirClaveAdmin_(cuerpo.claveAdmin);
      return respuesta_(accionAdmin_(cuerpo));
    }

    if (accion === 'crear') {
      return respuesta_(crearReserva_(cuerpo));
    }
    if (accion === 'consultar') {
      return respuesta_(consultarReserva_(cuerpo));
    }
    if (accion === 'cancelar') {
      return respuesta_(cancelarReserva_(cuerpo));
    }
    return respuesta_({ ok: false, error: 'accion_desconocida', mensaje: 'Accion no valida.' });
  } catch (error) {
    return respuesta_({ ok: false, error: 'error', mensaje: String((error && error.message) || error) });
  }
}

function respuesta_(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto))
    .setMimeType(ContentService.MimeType.JSON);
}

function exigirClave_(clave) {
  if (String(clave || '') !== CONFIG.CLAVE) {
    throw new Error('Clave de instalacion invalida.');
  }
}

function exigirClaveAdmin_(clave) {
  if (String(clave || '') !== claveAdmin_()) {
    throw new Error('Clave del panel invalida.');
  }
}

/** Clave del panel: vive en las propiedades del script (no en el codigo).
 *  La genera `instalar`; si todavia no se ejecuto, usa el respaldo de CONFIG. */
function claveAdmin_() {
  var guardada = PropertiesService.getScriptProperties().getProperty('claveAdmin');
  return guardada || CONFIG.CLAVE_ADMIN;
}

/** Genera (o devuelve) la clave del panel y la deja en las propiedades. */
function prepararClaveAdmin_() {
  var propiedades = PropertiesService.getScriptProperties();
  var clave = propiedades.getProperty('claveAdmin');
  if (!clave) {
    clave = 'rg-panel-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
    propiedades.setProperty('claveAdmin', clave);
  }
  return clave;
}

// ===========================================================================
// Calendario y fechas
// ===========================================================================
function calendario_() {
  if (CONFIG.CALENDARIO === 'primary') {
    return CalendarApp.getDefaultCalendar();
  }
  return CalendarApp.getCalendarById(CONFIG.CALENDARIO);
}

/** Date a partir de 'yyyy-MM-dd' y 'HH:mm' en la zona del taller. */
function momento_(fechaTexto, horaTexto) {
  var partesFecha = String(fechaTexto).split('-');
  var partesHora = String(horaTexto || '00:00').split(':');
  return new Date(
    Number(partesFecha[0]),
    Number(partesFecha[1]) - 1,
    Number(partesFecha[2]),
    Number(partesHora[0]),
    Number(partesHora[1] || 0),
    0,
    0
  );
}

function claveFecha_(fecha) {
  return Utilities.formatDate(fecha, CONFIG.ZONA, 'yyyy-MM-dd');
}

function sumarMinutos_(fecha, minutos) {
  return new Date(fecha.getTime() + minutos * 60000);
}

/** Minutos entre dos momentos (lo que ocupa el turno en la agenda). */
function duracionEnMinutos_(inicio, fin) {
  return Math.round((fin.getTime() - inicio.getTime()) / 60000);
}

function minutosDelDia_(horaTexto) {
  var partes = String(horaTexto).split(':');
  return Number(partes[0]) * 60 + Number(partes[1] || 0);
}

/** Etiquetas de fecha en español, sin depender del idioma del sistema. */
var DIAS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
var DIAS_CORTOS_ES = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
var MESES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function capitalizar_(texto) {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/** "Jueves 24 de septiembre" */
function etiquetaDia_(fecha) {
  return capitalizar_(
    DIAS_ES[fecha.getDay()] + ' ' + fecha.getDate() + ' de ' + MESES_ES[fecha.getMonth()]
  );
}

/** "jue 24" (para los botones del calendario en la web) */
function etiquetaCorta_(fecha) {
  return DIAS_CORTOS_ES[fecha.getDay()] + ' ' + fecha.getDate();
}

/** Duracion configurada para un servicio (o la predeterminada). */
function servicio_(nombre) {
  var buscado = String(nombre || CONFIG.SERVICIO_PREDETERMINADO).trim();
  for (var i = 0; i < CONFIG.SERVICIOS.length; i++) {
    if (CONFIG.SERVICIOS[i].nombre === buscado) {
      return CONFIG.SERVICIOS[i];
    }
  }
  return null;
}

// ===========================================================================
// Agenda disponible
// ===========================================================================
function leerAgenda_(parametros) {
  var elegido = servicio_(parametros.servicio) || servicio_(CONFIG.SERVICIO_PREDETERMINADO);
  var dias = Math.min(Math.max(Number(parametros.dias) || CONFIG.DIAS_VISTA, 1), CONFIG.DIAS_VISTA);

  var cache = CacheService.getScriptCache();
  var claveCache = 'agenda:v' + versionAgenda_() + ':' + elegido.nombre + ':' + dias;
  var guardado = cache.get(claveCache);
  if (guardado) {
    return JSON.parse(guardado);
  }

  var ahora = new Date();
  var limite = sumarMinutos_(ahora, CONFIG.ANTICIPACION_MIN);
  var primerDia = momento_(claveFecha_(ahora), '00:00');
  var ultimoDia = sumarDias_(primerDia, dias + 1);

  // Una sola lectura del calendario para todo el rango (rendimiento).
  var eventos = calendario_().getEvents(primerDia, ultimoDia);

  var lista = [];
  for (var i = 0; i < dias; i++) {
    lista.push(armarDia_(sumarDias_(primerDia, i), eventos, elegido, limite));
  }

  var respuesta = {
    ok: true,
    zona: CONFIG.ZONA,
    actualizado: Utilities.formatDate(ahora, CONFIG.ZONA, "yyyy-MM-dd HH:mm"),
    servicio: elegido.nombre,
    duracionMinutos: elegido.minutos,
    modalidad: elegido.deja ? 'dejar' : 'horario',
    anticipacionMinutos: CONFIG.ANTICIPACION_MIN,
    cupos: CONFIG.CUPOS,
    servicios: CONFIG.SERVICIOS,
    dias: lista
  };

  cache.put(claveCache, JSON.stringify(respuesta), 60);
  return respuesta;
}

function sumarDias_(fecha, cantidad) {
  return new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate() + cantidad, 0, 0, 0, 0);
}

function rellenar_(numero) {
  return (numero < 10 ? '0' : '') + numero;
}

/** Cuantos eventos reales (no de todo el dia) se solapan con el intervalo. */
function ocupacion_(eventos, inicio, fin) {
  var ocupados = 0;
  for (var i = 0; i < eventos.length; i++) {
    var evento = eventos[i];
    if (evento.isAllDayEvent()) {
      continue;
    }
    if (evento.getStartTime().getTime() < fin.getTime() &&
        evento.getEndTime().getTime() > inicio.getTime()) {
      ocupados++;
    }
  }
  return ocupados;
}

/** Cierra el dia si hay un evento de todo el dia (feriado o vacaciones). */
function esDiaCerrado_(eventos, fecha) {
  var clave = claveFecha_(fecha);
  for (var i = 0; i < eventos.length; i++) {
    if (eventos[i].isAllDayEvent() && claveFecha_(eventos[i].getStartTime()) === clave) {
      return true;
    }
  }
  return false;
}

/** Minutos de inicio posibles dentro de una franja.
 *  Los trabajos en los que el cliente deja el auto se entregan al comienzo de
 *  cada franja (08:00 y 14:00); el resto empieza cada PASO_MIN. */
function iniciosDeFranja_(desde, hasta, elegido) {
  if (elegido.deja) {
    return [desde];
  }
  var inicios = [];
  for (var minuto = desde; minuto + elegido.minutos <= hasta; minuto += CONFIG.PASO_MIN) {
    inicios.push(minuto);
  }
  return inicios;
}

/** Fin del turno. Los trabajos de dejar el auto ocupan el lugar hasta el cierre:
 *  el auto queda en el taller aunque el trabajo termine antes, y si sigue al dia
 *  siguiente se estira el evento a mano en el calendario. */
function finDeTurno_(inicio, elegido) {
  if (!elegido.deja) {
    return sumarMinutos_(inicio, elegido.minutos);
  }
  var franjas = CONFIG.ATENCION[inicio.getDay()] || [];
  var cierre = 0;
  for (var i = 0; i < franjas.length; i++) {
    cierre = Math.max(cierre, minutosDelDia_(franjas[i][1]));
  }
  if (!cierre) {
    return sumarMinutos_(inicio, elegido.minutos);
  }
  return new Date(
    inicio.getFullYear(), inicio.getMonth(), inicio.getDate(),
    Math.floor(cierre / 60), cierre % 60, 0, 0
  );
}

function armarDia_(fecha, eventos, elegido, limite) {
  var franjas = CONFIG.ATENCION[fecha.getDay()] || [];
  var cerrado = franjas.length === 0 || esDiaCerrado_(eventos, fecha);
  var turnos = [];

  if (!cerrado) {
    for (var f = 0; f < franjas.length; f++) {
      var inicios = iniciosDeFranja_(
        minutosDelDia_(franjas[f][0]), minutosDelDia_(franjas[f][1]), elegido
      );
      for (var j = 0; j < inicios.length; j++) {
        var minuto = inicios[j];
        var inicio = new Date(
          fecha.getFullYear(), fecha.getMonth(), fecha.getDate(),
          Math.floor(minuto / 60), minuto % 60, 0, 0
        );
        if (inicio.getTime() < limite.getTime()) {
          continue;
        }
        var fin = finDeTurno_(inicio, elegido);
        var ocupados = ocupacion_(eventos, inicio, fin);
        if (ocupados >= CONFIG.CUPOS) {
          continue;
        }
        turnos.push({
          hora: rellenar_(Math.floor(minuto / 60)) + ':' + rellenar_(minuto % 60),
          estado: ocupados === 0 ? 'libre' : 'ultimo',
          cuposLibres: CONFIG.CUPOS - ocupados
        });
      }
    }
  }

  var libres = 0;
  var ultimos = 0;
  for (var t = 0; t < turnos.length; t++) {
    if (turnos[t].estado === 'libre') {
      libres++;
    } else {
      ultimos++;
    }
  }

  var estado = 'cerrado';
  if (!cerrado) {
    estado = libres > 0 ? 'disponible' : (ultimos > 0 ? 'ultimo' : 'completo');
  }

  return {
    fecha: claveFecha_(fecha),
    etiqueta: etiquetaDia_(fecha),
    etiquetaCorta: etiquetaCorta_(fecha),
    estado: estado,
    turnos: turnos
  };
}

// Version de la agenda: cambia con cada reserva para invalidar la cache.
function versionAgenda_() {
  var propiedades = PropertiesService.getScriptProperties();
  return propiedades.getProperty('versionAgenda') || '0';
}

function invalidarAgenda_() {
  var propiedades = PropertiesService.getScriptProperties();
  propiedades.setProperty('versionAgenda', String(Number(versionAgenda_()) + 1));
}

// ===========================================================================
// Reservas
// ===========================================================================
function error_(codigo, mensaje) {
  return { ok: false, error: codigo, mensaje: mensaje };
}

function validarReserva_(datos, desdePanel) {
  var nombre = String(datos.nombre || '').trim();
  var telefono = String(datos.telefono || '').replace(/\D/g, '');
  var vehiculo = String(datos.vehiculo || '').trim();
  var email = String(datos.email || '').trim();
  var comentario = String(datos.comentario || '').trim();
  var fechaTexto = String(datos.fecha || '').trim();
  var horaTexto = String(datos.hora || '').trim();

  if (nombre.length < 3 || nombre.length > 80) {
    return error_('nombre_invalido', 'Escribí tu nombre completo.');
  }
  if (telefono.length < 8 || telefono.length > 13) {
    return error_('telefono_invalido', 'Revisá el teléfono: necesitamos un número para avisarte.');
  }
  if (vehiculo.length < 2 || vehiculo.length > 80) {
    return error_('vehiculo_invalido', 'Contanos marca y modelo del vehículo.');
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(email)) {
    return error_('email_invalido', 'El email no parece válido.');
  }
  if (comentario.length > 500) {
    return error_('comentario_largo', 'El comentario es demasiado largo.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaTexto) || !/^\d{2}:\d{2}$/.test(horaTexto)) {
    return error_('fecha_invalida', 'Elegí otra vez el día y el horario.');
  }

  var elegido = servicio_(datos.servicio);
  if (!elegido) {
    return error_('servicio_invalido', 'Elegí el tipo de trabajo que necesitás.');
  }

  var inicio = momento_(fechaTexto, horaTexto);
  if (claveFecha_(inicio) !== fechaTexto) {
    return error_('fecha_invalida', 'La fecha elegida no es válida.');
  }

  var ahora = new Date();
  if (!desdePanel && inicio.getTime() < sumarMinutos_(ahora, CONFIG.ANTICIPACION_MIN).getTime()) {
    return error_('muy_pronto', 'Los turnos se piden con al menos 24 horas de anticipación.');
  }
  // Desde el panel se puede anotar para hoy (llaman por teléfono), pero nunca
  // para un horario que ya pasó.
  if (desdePanel && inicio.getTime() <= ahora.getTime()) {
    return error_('muy_pronto', 'Ese horario ya pasó: elegí uno más tarde o de otro día.');
  }
  if (inicio.getTime() > sumarDias_(ahora, CONFIG.DIAS_VISTA).getTime()) {
    return error_('fuera_de_rango', 'Ese día está fuera de la agenda abierta (30 días).');
  }

  var franjas = CONFIG.ATENCION[inicio.getDay()] || [];
  var desdeMin = minutosDelDia_(horaTexto);
  var entra = false;
  for (var i = 0; i < franjas.length; i++) {
    var abre = minutosDelDia_(franjas[i][0]);
    var cierra = minutosDelDia_(franjas[i][1]);
    if (elegido.deja) {
      // Dejar el auto: la entrega es al comienzo de una franja.
      if (desdeMin === abre) {
        entra = true;
      }
    } else if (desdeMin >= abre && desdeMin + elegido.minutos <= cierra) {
      entra = true;
    }
  }
  if (!entra) {
    return error_('fuera_de_horario', 'Ese horario queda fuera del horario de atención.');
  }

  if (!elegido.deja && desdeMin % CONFIG.PASO_MIN !== 0) {
    return error_('horario_invalido', 'Los turnos empiezan cada ' + CONFIG.PASO_MIN + ' minutos.');
  }

  return {
    ok: true,
    nombre: nombre,
    telefono: telefono,
    vehiculo: vehiculo,
    email: email,
    comentario: comentario,
    fechaTexto: fechaTexto,
    horaTexto: horaTexto,
    servicio: elegido,
    inicio: inicio,
    fin: finDeTurno_(inicio, elegido)
  };
}

/** Limites anti-abuso (por dia en total y por telefono). Usa cache de 6 h. */
function avisoLimite_(telefono) {
  var cache = CacheService.getScriptCache();
  var hoy = claveFecha_(new Date());
  var total = Number(cache.get('reservas-dia:' + hoy) || 0);
  if (total >= CONFIG.MAX_RESERVAS_POR_DIA) {
    return 'Hoy ya alcanzamos el máximo de turnos por la web. Escribinos por WhatsApp y lo vemos.';
  }
  var porTelefono = Number(cache.get('reservas-tel:' + telefono) || 0);
  if (porTelefono >= CONFIG.MAX_RESERVAS_POR_TELEFONO) {
    return 'Ya registramos reservas con este teléfono. Si necesitás otro turno, escribinos por WhatsApp.';
  }
  return null;
}

function contarReserva_(telefono) {
  var cache = CacheService.getScriptCache();
  var claveDia = 'reservas-dia:' + claveFecha_(new Date());
  var claveTelefono = 'reservas-tel:' + telefono;
  cache.put(claveDia, String(Number(cache.get(claveDia) || 0) + 1), 21600);
  cache.put(claveTelefono, String(Number(cache.get(claveTelefono) || 0) + 1), 21600);
}

/**
 * Libera el cupo antiabuso del telefono cuando el cliente cancela: si no,
 * alguien que cancela y quiere reservar de nuevo queda frenado 6 horas.
 */
function restarReserva_(telefono) {
  if (!telefono) {
    return;
  }
  var cache = CacheService.getScriptCache();
  var claveTelefono = 'reservas-tel:' + telefono;
  var actual = Number(cache.get(claveTelefono) || 0);
  if (actual > 0) {
    cache.put(claveTelefono, String(actual - 1), 21600);
  }
}

function crearReserva_(datos, desdePanel) {
  // Campo trampa: si viene completo es un bot. Se ignora sin dar pistas.
  if (!desdePanel && String(datos.empresa || '').trim() !== '') {
    return error_('no_procesado', 'No pudimos procesar la solicitud. Escribinos por WhatsApp.');
  }

  var validacion = validarReserva_(datos, desdePanel);
  if (!validacion.ok) {
    return validacion;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_MS)) {
    return error_('sistema_ocupado', 'Estamos recibiendo otra reserva. Probá de nuevo en unos segundos.');
  }

  try {
    // Se revalida con el candado tomado: evita que dos personas tomen el
    // mismo ultimo lugar al mismo tiempo.
    var eventos = calendario_().getEvents(validacion.inicio, validacion.fin);
    var ocupados = ocupacion_(eventos, validacion.inicio, validacion.fin);

    // Reintento del mismo cliente (se corto la conexion justo despues de
    // confirmar, o toco dos veces el boton): se devuelve el turno que ya
    // existe en lugar de ocupar el segundo lugar o duplicar el evento.
    var repetido = turnoRepetido_(eventos, validacion);
    if (repetido) {
      return {
        ok: true,
        repetido: true,
        codigo: codigoDeEvento_(repetido),
        estado: ocupados > 0 ? 'ultimo' : 'libre',
        cuposLibres: Math.max(CONFIG.CUPOS - ocupados, 0),
        fecha: validacion.fechaTexto,
        hora: validacion.horaTexto,
        etiqueta: etiquetaDia_(validacion.inicio),
        servicio: validacion.servicio.nombre,
        duracionMinutos: duracionEnMinutos_(validacion.inicio, validacion.fin),
        modalidad: validacion.servicio.deja ? 'dejar' : 'horario',
        mensaje: 'Ese turno ya estaba confirmado para el ' +
          etiquetaDia_(validacion.inicio) + ' a las ' + validacion.horaTexto + '.'
      };
    }

    if (ocupados >= CONFIG.CUPOS) {
      return error_('sin_cupo', 'Ese horario se acaba de ocupar. Elegí otro, por favor.');
    }

    // Limites antiabuso (por dia y por telefono). No se aplican a los turnos que
    // el taller anota a mano desde el panel.
    if (!desdePanel) {
      var aviso = avisoLimite_(validacion.telefono);
      if (aviso) {
        return error_('limite_alcanzado', aviso);
      }
    }

    // Linea interna del taller: el cliente nunca la ve.
    var linea = ocupados === 0 ? 'ELEVADOR' : 'PISO';
    var codigo = generarCodigo_();
    var largo = validacion.servicio.minutos >= CONFIG.AVISO_LARGO_MIN ? '⚠️ ' : '';

    var detalle = [
      'Código: ' + codigo,
      'Servicio: ' + validacion.servicio.nombre + (validacion.servicio.deja
        ? ' (deja el auto)'
        : ' (' + validacion.servicio.minutos + ' min)'),
      'Vehículo: ' + validacion.vehiculo,
      'Cliente: ' + validacion.nombre,
      'Teléfono: ' + validacion.telefono,
      'WhatsApp: https://wa.me/' + telefonoInternacional_(validacion.telefono),
      'Llamar: tel:+' + telefonoInternacional_(validacion.telefono),
      validacion.email ? 'Email: ' + validacion.email : '',
      validacion.comentario ? 'Comentario: ' + validacion.comentario : '',
      '',
      desdePanel ? 'Anotado desde el panel del taller.'
        : 'Reservado desde la web de Rosconi Garage.'
    ].join('\n');

    var opciones = {
      description: detalle,
      location: 'Juan Antonio Lavalleja 730, Artigas'
    };
    if (validacion.email) {
      opciones.guests = validacion.email;
      opciones.sendInvites = true;
    }

    var evento = calendario_().createEvent(
      largo + 'Turno ' + linea + ' · ' + validacion.vehiculo +
        (validacion.servicio.deja ? ' (deja el auto)' : ''),
      validacion.inicio,
      validacion.fin,
      opciones
    );

    // Recordatorio para el taller: aparece en el calendario y en el celular.
    if (CONFIG.AVISO_MINUTOS_ANTES > 0) {
      evento.addPopupReminder(CONFIG.AVISO_MINUTOS_ANTES);
    }

    if (!desdePanel) {
      contarReserva_(validacion.telefono);
    }
    invalidarAgenda_();

    return {
      ok: true,
      codigo: codigo,
      estado: ocupados === 0 ? 'libre' : 'ultimo',
      cuposLibres: Math.max(CONFIG.CUPOS - ocupados - 1, 0),
      fecha: validacion.fechaTexto,
      hora: validacion.horaTexto,
      etiqueta: etiquetaDia_(validacion.inicio),
      servicio: validacion.servicio.nombre,
      duracionMinutos: duracionEnMinutos_(validacion.inicio, validacion.fin),
      modalidad: validacion.servicio.deja ? 'dejar' : 'horario',
      mensaje: 'Turno confirmado para el ' + etiquetaDia_(validacion.inicio) +
        ' a las ' + validacion.horaTexto + '.'
    };
  } finally {
    lock.releaseLock();
  }
}

// ===========================================================================
// Codigo de reserva, consulta y cancelacion
// ===========================================================================
function generarCodigo_() {
  // Alfabeto sin caracteres que se confunden al dictarlos por telefono.
  var alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var uuid = Utilities.getUuid().replace(/-/g, '');
  var codigo = '';
  for (var i = 0; i < 8; i++) {
    codigo += alfabeto.charAt(parseInt(uuid.substr(i * 2, 2), 16) % alfabeto.length);
  }
  return 'RG-' + codigo;
}

/**
 * Turno ya creado para el mismo telefono y el mismo horario: es un reintento
 * del mismo cliente, no una reserva nueva.
 */
function turnoRepetido_(eventos, validacion) {
  var marca = 'Teléfono: ' + validacion.telefono + '\n';
  for (var i = 0; i < eventos.length; i++) {
    var evento = eventos[i];
    if (evento.isAllDayEvent()) {
      continue;
    }
    if (evento.getStartTime().getTime() !== validacion.inicio.getTime()) {
      continue;
    }
    var detalle = String(evento.getDescription() || '');
    if (detalle.indexOf(marca) > -1 && /^Código: RG-[A-Z0-9]{8}$/m.test(detalle)) {
      return evento;
    }
  }
  return null;
}

/** Codigo de reserva anotado en un evento de turno. */
function codigoDeEvento_(evento) {
  var encontrado = String(evento.getDescription() || '').match(/Código: (RG-[A-Z0-9]{8})/);
  return encontrado ? encontrado[1] : 'RG-XXXXXXXX';
}

/** Telefono anotado en un evento de turno (para liberar el limite al cancelar). */
function telefonoDeEvento_(evento) {
  var encontrado = String(evento.getDescription() || '').match(/Teléfono: (\d{8,13})/);
  return encontrado ? encontrado[1] : '';
}

/** Telefono en formato internacional para los links de WhatsApp y llamadas.
 *  '099123456' -> '59899123456' */
function telefonoInternacional_(telefono) {
  var digitos = String(telefono || '').replace(/\D/g, '');
  if (digitos.indexOf('598') === 0) {
    return digitos;
  }
  if (digitos.charAt(0) === '0') {
    digitos = digitos.slice(1);
  }
  return '598' + digitos;
}

function buscarPorCodigo_(codigo) {
  var buscado = String(codigo || '').trim().toUpperCase();
  if (!/^RG-[A-Z0-9]{8}$/.test(buscado)) {
    return null;
  }
  var ahora = new Date();
  var eventos = calendario_().getEvents(sumarDias_(ahora, -3), sumarDias_(ahora, CONFIG.DIAS_VISTA + 90));
  for (var i = 0; i < eventos.length; i++) {
    var descripcion = eventos[i].getDescription() || '';
    if (descripcion.indexOf(buscado) >= 0) {
      return eventos[i];
    }
  }
  return null;
}

function datosDeEvento_(evento, codigo) {
  var descripcion = evento.getDescription() || '';
  var servicio = descripcion.match(/Servicio: (.+?) \(/);
  var vehiculo = descripcion.match(/Vehículo: (.+)/);
  return {
    ok: true,
    codigo: codigo,
    titulo: evento.getTitle(),
    fecha: claveFecha_(evento.getStartTime()),
    hora: Utilities.formatDate(evento.getStartTime(), CONFIG.ZONA, 'HH:mm'),
    etiqueta: etiquetaDia_(evento.getStartTime()),
    servicio: servicio ? servicio[1] : '',
    vehiculo: vehiculo ? vehiculo[1].trim() : '',
    ubicacion: evento.getLocation() || ''
  };
}

function consultarReserva_(cuerpo) {
  var evento = buscarPorCodigo_(cuerpo.codigo);
  if (!evento) {
    return error_('no_encontrado', 'No encontramos un turno con ese código. Revisá que esté bien escrito.');
  }
  return datosDeEvento_(evento, String(cuerpo.codigo).trim().toUpperCase());
}

function cancelarReserva_(cuerpo) {
  var codigo = String(cuerpo.codigo || '').trim().toUpperCase();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_MS)) {
    return error_('sistema_ocupado', 'Probá de nuevo en unos segundos.');
  }
  try {
    var evento = buscarPorCodigo_(codigo);
    if (!evento) {
      return error_('no_encontrado', 'No encontramos un turno con ese código.');
    }
    var datos = datosDeEvento_(evento, codigo);
    var telefono = telefonoDeEvento_(evento);
    evento.deleteEvent();
    restarReserva_(telefono);
    invalidarAgenda_();
    datos.mensaje = 'El turno del ' + datos.etiqueta + ' a las ' + datos.hora + ' quedó cancelado.';
    return datos;
  } finally {
    lock.releaseLock();
  }
}

// ===========================================================================
// Panel del taller
// ===========================================================================
/** Un turno del calendario con los datos que necesita el taller. */
function turnoParaPanel_(evento) {
  var detalle = String(evento.getDescription() || '');
  var titulo = String(evento.getTitle() || '');
  var telefono = valorDe_(detalle, 'Teléfono');
  var codigo = detalle.match(/Código: (RG-[A-Z0-9]{8})/);
  return {
    codigo: codigo ? codigo[1] : '',
    fecha: claveFecha_(evento.getStartTime()),
    hora: Utilities.formatDate(evento.getStartTime(), CONFIG.ZONA, 'HH:mm'),
    horaFin: Utilities.formatDate(evento.getEndTime(), CONFIG.ZONA, 'HH:mm'),
    minutos: duracionEnMinutos_(evento.getStartTime(), evento.getEndTime()),
    linea: titulo.indexOf('ELEVADOR') > -1 ? 'elevador'
      : (titulo.indexOf('PISO') > -1 ? 'piso' : ''),
    deja: titulo.indexOf('(deja el auto)') > -1,
    listo: titulo.indexOf('✅') > -1,
    servicio: valorDe_(detalle, 'Servicio'),
    vehiculo: valorDe_(detalle, 'Vehículo'),
    cliente: valorDe_(detalle, 'Cliente'),
    telefono: telefono,
    whatsapp: telefono ? telefonoInternacional_(telefono) : '',
    email: valorDe_(detalle, 'Email'),
    comentario: valorDe_(detalle, 'Comentario'),
    origen: detalle.indexOf('Anotado desde el panel') > -1 ? 'panel' : 'web'
  };
}

/** Turnos de un rango de dias, con los huecos libres de cada dia. */
function turnosDelRango_(desdeTexto, dias) {
  var desde = momento_(desdeTexto || claveFecha_(new Date()), '00:00');
  var eventos = calendario_().getEvents(desde, sumarDias_(desde, dias));
  var ahora = new Date();
  var porFecha = {};
  var i;

  for (i = 0; i < eventos.length; i++) {
    var evento = eventos[i];
    if (evento.isAllDayEvent()) {
      continue;
    }
    if (String(evento.getDescription() || '').indexOf('Código: RG-') === -1) {
      continue;
    }
    var turno = turnoParaPanel_(evento);
    if (!porFecha[turno.fecha]) {
      porFecha[turno.fecha] = [];
    }
    porFecha[turno.fecha].push(turno);
  }

  var referencia = servicio_(CONFIG.SERVICIO_PREDETERMINADO);
  var salida = [];
  for (i = 0; i < dias; i++) {
    var dia = sumarDias_(desde, i);
    var clave = claveFecha_(dia);
    var lista = porFecha[clave] || [];
    lista.sort(function (a, b) {
      return a.hora === b.hora ? 0 : (a.hora < b.hora ? -1 : 1);
    });

    var franjas = CONFIG.ATENCION[dia.getDay()] || [];
    var cerrado = franjas.length === 0 || esDiaCerrado_(eventos, dia);
    var libres = [];
    if (!cerrado) {
      for (var f = 0; f < franjas.length; f++) {
        var inicios = iniciosDeFranja_(
          minutosDelDia_(franjas[f][0]), minutosDelDia_(franjas[f][1]), referencia
        );
        for (var j = 0; j < inicios.length; j++) {
          var inicio = new Date(
            dia.getFullYear(), dia.getMonth(), dia.getDate(),
            Math.floor(inicios[j] / 60), inicios[j] % 60, 0, 0
          );
          if (inicio.getTime() <= ahora.getTime()) {
            continue;
          }
          var ocupados = ocupacion_(
            eventos, inicio, sumarMinutos_(inicio, referencia.minutos)
          );
          if (ocupados < CONFIG.CUPOS) {
            libres.push({
              hora: rellenar_(Math.floor(inicios[j] / 60)) + ':' + rellenar_(inicios[j] % 60),
              lugares: CONFIG.CUPOS - ocupados
            });
          }
        }
      }
    }

    salida.push({
      fecha: clave,
      etiqueta: etiquetaDia_(dia),
      etiquetaCorta: etiquetaCorta_(dia),
      cerrado: cerrado,
      turnos: lista,
      libres: libres
    });
  }
  return salida;
}

/** Busca turnos por cliente, telefono, vehiculo, codigo o trabajo. */
function buscarTurnos_(texto) {
  var buscado = String(texto || '').trim().toLowerCase();
  if (buscado.length < 3) {
    return [];
  }
  var acentos = { 'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ú': 'u', 'ü': 'u', 'ñ': 'n' };
  function simple(valor) {
    return String(valor).toLowerCase().replace(/[áéíóúüñ]/g, function (letra) {
      return acentos[letra];
    });
  }

  var ahora = new Date();
  var eventos = calendario_().getEvents(
    sumarDias_(ahora, -30), sumarDias_(ahora, CONFIG.DIAS_VISTA + 60)
  );
  var patron = simple(buscado);
  var encontrados = [];

  for (var i = 0; i < eventos.length; i++) {
    var evento = eventos[i];
    if (evento.isAllDayEvent()) {
      continue;
    }
    if (String(evento.getDescription() || '').indexOf('Código: RG-') === -1) {
      continue;
    }
    var turno = turnoParaPanel_(evento);
    var campos = simple([turno.codigo, turno.cliente, turno.telefono, turno.vehiculo,
      turno.servicio, turno.comentario].join(' | '));
    if (campos.indexOf(patron) > -1) {
      encontrados.push(turno);
    }
  }

  encontrados.sort(function (a, b) {
    return (a.fecha + a.hora) < (b.fecha + b.hora) ? -1 : 1;
  });
  return encontrados.slice(0, 40);
}

/** Marca (o desmarca) un turno como listo: se ve en el panel y en el calendario. */
function marcarListo_(codigo, listo) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_MS)) {
    return error_('sistema_ocupado', 'Probá de nuevo en unos segundos.');
  }
  try {
    var evento = buscarPorCodigo_(codigo);
    if (!evento) {
      return error_('no_encontrado', 'No encontramos un turno con ese código.');
    }
    var titulo = String(evento.getTitle() || '').replace(/^✅\s*/, '');
    evento.setTitle(listo ? '✅ ' + titulo : titulo);
    var turno = turnoParaPanel_(evento);
    turno.ok = true;
    turno.mensaje = listo ? 'Quedó marcado como listo.' : 'Volvió a la lista de pendientes.';
    return turno;
  } finally {
    lock.releaseLock();
  }
}

/** Acciones del panel del taller (la clave de administracion ya fue validada). */
function accionAdmin_(cuerpo) {
  var accion = cuerpo.accion;
  var ahora = Utilities.formatDate(new Date(), CONFIG.ZONA, 'yyyy-MM-dd HH:mm');

  if (accion === 'estado') {
    return {
      ok: true, version: VERSION_BACKEND, zona: CONFIG.ZONA, actualizado: ahora,
      capacidades: ACCIONES_ADMIN, resumenHoy: resumenDelDia_(new Date())
    };
  }
  if (accion === 'panel') {
    var dias = Math.min(Math.max(Number(cuerpo.dias) || 14, 1), 31);
    return {
      ok: true, version: VERSION_BACKEND, zona: CONFIG.ZONA, actualizado: ahora,
      desde: cuerpo.desde || claveFecha_(new Date()), dias: dias,
      cupos: CONFIG.CUPOS, anticipacionMinutos: CONFIG.ANTICIPACION_MIN,
      servicios: CONFIG.SERVICIOS,
      servicioReferencia: CONFIG.SERVICIO_PREDETERMINADO,
      agenda: turnosDelRango_(cuerpo.desde, dias)
    };
  }
  if (accion === 'buscar') {
    return {
      ok: true, actualizado: ahora, texto: cuerpo.texto || '',
      encontrados: buscarTurnos_(cuerpo.texto)
    };
  }
  if (accion === 'anotar') {
    return crearReserva_(cuerpo, true);
  }
  if (accion === 'listo') {
    return marcarListo_(cuerpo.codigo, cuerpo.listo !== false);
  }
  return error_('accion_desconocida', 'Accion de panel no valida.');
}

// ===========================================================================
// Resumen para el taller
// ===========================================================================
/** Valor de una linea "Etiqueta: valor" de la ficha del turno. */
function valorDe_(descripcion, etiqueta) {
  var encontrado = String(descripcion || '').match(new RegExp(etiqueta + ': (.+)'));
  return encontrado ? encontrado[1].trim() : '';
}

/** Un renglon por turno: hora, auto, cliente, telefono, trabajo y linea. */
function renglonDeTurno_(evento) {
  var detalle = String(evento.getDescription() || '');
  var titulo = String(evento.getTitle() || '');
  var linea = titulo.indexOf('ELEVADOR') > -1 ? 'elevador'
    : (titulo.indexOf('PISO') > -1 ? 'piso' : '');
  var renglon = Utilities.formatDate(evento.getStartTime(), CONFIG.ZONA, 'HH:mm') +
    ' a ' + Utilities.formatDate(evento.getEndTime(), CONFIG.ZONA, 'HH:mm') +
    ' · ' + valorDe_(detalle, 'Vehículo') +
    ' · ' + valorDe_(detalle, 'Cliente') +
    ' (' + valorDe_(detalle, 'Teléfono') + ')' +
    ' · ' + valorDe_(detalle, 'Servicio') +
    (linea ? ' · ' + linea : '') +
    (titulo.indexOf('(deja el auto)') > -1 ? ' · DEJA EL AUTO' : '');
  var comentario = valorDe_(detalle, 'Comentario');
  if (comentario) {
    renglon += '\n    ' + comentario;
  }
  return renglon;
}

/** Texto con los turnos de un dia, listo para mandar al taller. */
function resumenDelDia_(fecha) {
  var inicio = momento_(claveFecha_(fecha), '00:00');
  var eventos = calendario_().getEvents(inicio, sumarDias_(inicio, 1));
  var ordenados = [];

  for (var i = 0; i < eventos.length; i++) {
    if (eventos[i].isAllDayEvent()) {
      continue;
    }
    if (String(eventos[i].getDescription() || '').indexOf('Código: RG-') === -1) {
      continue;
    }
    ordenados.push(eventos[i]);
  }
  ordenados.sort(function (a, b) {
    return a.getStartTime().getTime() - b.getStartTime().getTime();
  });

  var encabezado = 'Turnos de Rosconi Garage para ' + etiquetaDia_(inicio);
  if (!ordenados.length) {
    return encabezado + ': no hay turnos agendados por la web.';
  }

  var lineas = [encabezado + ':', ''];
  for (var j = 0; j < ordenados.length; j++) {
    lineas.push((j + 1) + '. ' + renglonDeTurno_(ordenados[j]));
  }
  lineas.push('');
  lineas.push('Si el auto queda para el dia siguiente, estira el evento en el calendario.');
  return lineas.join('\n');
}

/** Manda el resumen del dia por mail. Lo dispara la tarea programada. */
function enviarResumenDelDia() {
  var destino = CONFIG.RESUMEN_EMAIL || Session.getEffectiveUser().getEmail();
  if (!destino) {
    return;
  }
  var hoy = new Date();
  MailApp.sendEmail(
    destino,
    'Turnos de hoy · Rosconi Garage (' +
      Utilities.formatDate(hoy, CONFIG.ZONA, 'dd/MM/yyyy') + ')',
    resumenDelDia_(hoy)
  );
  Logger.log('Resumen del dia enviado a ' + destino);
}

/** Ejecutar a mano desde el editor para ver como queda el resumen de hoy. */
function verResumenDeHoy() {
  Logger.log(resumenDelDia_(new Date()));
}

/** (Re)programa el resumen diario por mail. */
function programarResumen_() {
  var disparadores = ScriptApp.getProjectTriggers();
  for (var i = 0; i < disparadores.length; i++) {
    if (disparadores[i].getHandlerFunction() === 'enviarResumenDelDia') {
      ScriptApp.deleteTrigger(disparadores[i]);
    }
  }
  ScriptApp.newTrigger('enviarResumenDelDia')
    .timeBased()
    .atHour(CONFIG.RESUMEN_HORA)
    .nearMinute(CONFIG.RESUMEN_MINUTO)
    .everyDays(1)
    .create();
  Logger.log('Resumen diario programado a las ' + CONFIG.RESUMEN_HORA + ':' +
    rellenar_(CONFIG.RESUMEN_MINUTO) + ' (hora del script).');
}

// ===========================================================================
// Instalacion y prueba
// ===========================================================================
/** Ejecutar una vez desde el editor de Apps Script. */
function instalar() {
  var propiedades = PropertiesService.getScriptProperties();
  propiedades.setProperty('versionAgenda', '0');
  var calendario = calendario_();
  Logger.log('Calendario conectado: ' + calendario.getName() + ' (' + calendario.getId() + ')');
  Logger.log('Zona del script: ' + Session.getScriptTimeZone());
  Logger.log('Clave de instalacion: ' + CONFIG.CLAVE);
  Logger.log('Servicios configurados: ' + CONFIG.SERVICIOS.length);
  programarResumen_();
  Logger.log('Resumen de hoy (asi lo recibe el taller por mail):\n' +
    resumenDelDia_(new Date()));
  Logger.log('CLAVE DEL PANEL DEL TALLER: ' + prepararClaveAdmin_());
  Logger.log('Guardala: es la que se escribe una sola vez en la pagina panel.html ' +
    'del sitio. Queda en las propiedades del script, no en el codigo. ' +
    'Si la queres cambiar, borra la propiedad claveAdmin y volve a ejecutar instalar.');
  Logger.log('Listo. Desplega como aplicacion web (acceso: cualquier usuario) y copia la URL /exec.');
}

/**
 * Prueba de punta a punta: lee la agenda, crea una reserva de prueba y la
 * borra. Sirve para confirmar que el despliegue quedo bien.
 */
function probar() {
  var agenda = leerAgenda_({ servicio: CONFIG.SERVICIO_PREDETERMINADO, dias: 14 });
  var diasAbiertos = 0;
  var primerTurno = null;
  for (var i = 0; i < agenda.dias.length; i++) {
    if (agenda.dias[i].estado !== 'cerrado') {
      diasAbiertos++;
    }
    if (!primerTurno && agenda.dias[i].turnos.length > 0) {
      primerTurno = { fecha: agenda.dias[i].fecha, hora: agenda.dias[i].turnos[0].hora };
    }
  }
  Logger.log('Dias revisados: ' + agenda.dias.length + ' | con atencion: ' + diasAbiertos);
  if (!primerTurno) {
    Logger.log('No hay turnos libres en los proximos 14 dias. Revisa el calendario y la configuracion.');
    return;
  }
  Logger.log('Primer turno libre: ' + primerTurno.fecha + ' ' + primerTurno.hora);

  var reserva = crearReserva_({
    fecha: primerTurno.fecha,
    hora: primerTurno.hora,
    nombre: 'Prueba automatica',
    telefono: '099000000',
    vehiculo: 'Prueba tecnica',
    servicio: CONFIG.SERVICIO_PREDETERMINADO,
    comentario: 'Reserva de prueba generada por probar()'
  });
  Logger.log('Reserva creada: ' + JSON.stringify(reserva));

  if (reserva.ok) {
    var cancelacion = cancelarReserva_({ codigo: reserva.codigo });
    Logger.log('Reserva de prueba borrada: ' + JSON.stringify(cancelacion));
  }
}

/**
 * Mantenimiento: borra los turnos de prueba que hayan quedado dando vueltas
 * (por ejemplo de las verificaciones automaticas del sistema). Solo toca
 * eventos cuyo cliente sea uno de los nombres de prueba conocidos: nunca
 * borra turnos reales. Se ejecuta a mano desde el editor.
 */
var NOMBRES_DE_PRUEBA = [
  'Prueba automatica',
  'Cliente de prueba',
  'Ana Perez',
  'Bruno Diaz',
  'Carla Sosa'
];

function limpiarPruebas() {
  var desde = sumarDias_(new Date(), -1);
  var hasta = sumarDias_(new Date(), CONFIG.DIAS_VISTA + 1);
  var eventos = calendario_().getEvents(desde, hasta);
  var borrados = 0;

  for (var i = 0; i < eventos.length; i++) {
    var evento = eventos[i];
    if (!esTurnoDePrueba_(String(evento.getDescription() || ''))) {
      continue;
    }
    Logger.log('Borrando: ' + evento.getTitle() + ' | ' +
      claveFecha_(evento.getStartTime()) + ' ' +
      Utilities.formatDate(evento.getStartTime(), CONFIG.ZONA, 'HH:mm'));
    evento.deleteEvent();
    borrados++;
  }

  invalidarAgenda_();
  Logger.log('Turnos de prueba borrados: ' + borrados);
}

function esTurnoDePrueba_(detalle) {
  for (var i = 0; i < NOMBRES_DE_PRUEBA.length; i++) {
    if (detalle.indexOf('Cliente: ' + NOMBRES_DE_PRUEBA[i] + '\n') > -1) {
      return true;
    }
  }
  return false;
}





