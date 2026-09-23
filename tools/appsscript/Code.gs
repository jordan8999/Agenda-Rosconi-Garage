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
  CLAVE: 'rosconi-cambiar-esta-clave-2026',

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

  // Duracion estimada por servicio, en minutos.
  // >>> AJUSTAR con la tabla real de tiempos del taller <<<
  SERVICIOS: [
    { nombre: 'Service completo y lubricentro', minutos: 60 },
    { nombre: 'Diagnóstico con scanner', minutos: 30 },
    { nombre: 'Mecánica general', minutos: 120 },
    { nombre: 'Distribución y cadena', minutos: 480 },
    { nombre: 'Mecánica integral', minutos: 480 },
    { nombre: 'Reprogramación electrónica', minutos: 120 },
    { nombre: 'Otro trabajo / no estoy seguro', minutos: 60 }
  ],
  SERVICIO_PREDETERMINADO: 'Service completo y lubricentro',
  AVISO_LARGO_MIN: 240,    // a partir de aca el evento se marca como largo

  MAX_RESERVAS_POR_DIA: 12,
  MAX_RESERVAS_POR_TELEFONO: 2,
  LOCK_MS: 15000
};

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
    lista.push(armarDia_(sumarDias_(primerDia, i), eventos, elegido.minutos, limite));
  }

  var respuesta = {
    ok: true,
    zona: CONFIG.ZONA,
    actualizado: Utilities.formatDate(ahora, CONFIG.ZONA, "yyyy-MM-dd HH:mm"),
    servicio: elegido.nombre,
    duracionMinutos: elegido.minutos,
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

function armarDia_(fecha, eventos, minutos, limite) {
  var franjas = CONFIG.ATENCION[fecha.getDay()] || [];
  var cerrado = franjas.length === 0 || esDiaCerrado_(eventos, fecha);
  var turnos = [];

  if (!cerrado) {
    for (var f = 0; f < franjas.length; f++) {
      var desde = minutosDelDia_(franjas[f][0]);
      var hasta = minutosDelDia_(franjas[f][1]);
      for (var minuto = desde; minuto + minutos <= hasta; minuto += CONFIG.PASO_MIN) {
        var inicio = new Date(
          fecha.getFullYear(), fecha.getMonth(), fecha.getDate(),
          Math.floor(minuto / 60), minuto % 60, 0, 0
        );
        var fin = sumarMinutos_(inicio, minutos);
        if (inicio.getTime() < limite.getTime()) {
          continue;
        }
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

function validarReserva_(datos) {
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
  if (inicio.getTime() < sumarMinutos_(ahora, CONFIG.ANTICIPACION_MIN).getTime()) {
    return error_('muy_pronto', 'Los turnos se piden con al menos 24 horas de anticipación.');
  }
  if (inicio.getTime() > sumarDias_(ahora, CONFIG.DIAS_VISTA).getTime()) {
    return error_('fuera_de_rango', 'Ese día está fuera de la agenda abierta (30 días).');
  }

  var franjas = CONFIG.ATENCION[inicio.getDay()] || [];
  var desdeMin = minutosDelDia_(horaTexto);
  var hastaMin = desdeMin + elegido.minutos;
  var entra = false;
  for (var i = 0; i < franjas.length; i++) {
    if (desdeMin >= minutosDelDia_(franjas[i][0]) && hastaMin <= minutosDelDia_(franjas[i][1])) {
      entra = true;
    }
  }
  if (!entra) {
    return error_('fuera_de_horario', 'Ese horario queda fuera del horario de atención.');
  }

  if (desdeMin % CONFIG.PASO_MIN !== 0) {
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
    fin: sumarMinutos_(inicio, elegido.minutos)
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

function crearReserva_(datos) {
  // Campo trampa: si viene completo es un bot. Se ignora sin dar pistas.
  if (String(datos.empresa || '').trim() !== '') {
    return error_('no_procesado', 'No pudimos procesar la solicitud. Escribinos por WhatsApp.');
  }

  var validacion = validarReserva_(datos);
  if (!validacion.ok) {
    return validacion;
  }

  var aviso = avisoLimite_(validacion.telefono);
  if (aviso) {
    return error_('limite_alcanzado', aviso);
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
    if (ocupados >= CONFIG.CUPOS) {
      return error_('sin_cupo', 'Ese horario se acaba de ocupar. Elegí otro, por favor.');
    }

    // Linea interna del taller: el cliente nunca la ve.
    var linea = ocupados === 0 ? 'ELEVADOR' : 'PISO';
    var codigo = generarCodigo_();
    var largo = validacion.servicio.minutos >= CONFIG.AVISO_LARGO_MIN ? '⚠️ ' : '';

    var detalle = [
      'Código: ' + codigo,
      'Servicio: ' + validacion.servicio.nombre + ' (' + validacion.servicio.minutos + ' min)',
      'Vehículo: ' + validacion.vehiculo,
      'Cliente: ' + validacion.nombre,
      'Teléfono: ' + validacion.telefono,
      validacion.email ? 'Email: ' + validacion.email : '',
      validacion.comentario ? 'Comentario: ' + validacion.comentario : '',
      '',
      'Reservado desde la web de Rosconi Garage.'
    ].join('\n');

    var opciones = {
      description: detalle,
      location: 'Juan Antonio Lavalleja 730, Artigas'
    };
    if (validacion.email) {
      opciones.guests = validacion.email;
      opciones.sendInvites = true;
    }

    calendario_().createEvent(
      largo + 'Turno ' + linea + ' · ' + validacion.vehiculo,
      validacion.inicio,
      validacion.fin,
      opciones
    );

    contarReserva_(validacion.telefono);
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
      duracionMinutos: validacion.servicio.minutos,
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
    evento.deleteEvent();
    invalidarAgenda_();
    datos.mensaje = 'El turno del ' + datos.etiqueta + ' a las ' + datos.hora + ' quedó cancelado.';
    return datos;
  } finally {
    lock.releaseLock();
  }
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





