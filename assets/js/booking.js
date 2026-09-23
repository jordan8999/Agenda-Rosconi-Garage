/* ==========================================================================
   Rosconi Garage — reserva de turnos (frontend)
   --------------------------------------------------------------------------
   Habla con el backend propio (tools/appsscript/Code.gs): no usa ninguna
   plataforma de turnos de terceros.

   Mientras ENDPOINT esté vacío la reserva se ofrece por WhatsApp, así el
   sitio nunca queda con un calendario roto.
   ========================================================================== */
(function () {
  "use strict";

  var AJUSTES = {
    // URL de la app web de Apps Script del taller (termina en /exec)
    ENDPOINT:
      "https://script.google.com/macros/s/AKfycbzxCse_fzz1IVtt1Mr2Z-3ca6ZNRegrAp_6Y6LU0-4UGcUfyFB5ihTf5bYrtOx8LxAV0g/exec",
    // Debe coincidir con CONFIG.CLAVE de tools/appsscript/Code.gs
    CLAVE: "rosconi-artigas-turnos-2026-k72b",
    SERVICIO_PREDETERMINADO: "Service completo y lubricentro",
    DIAS: 30,
    CACHE_MS: 60000,
    TIMEOUT_MS: 15000,
    // Apps Script falla de forma esporádica en el redirect de su respuesta: se
    // reintenta con una pequeña espera. Reintentar una reserva no la duplica,
    // porque el backend devuelve el turno que ya existe si el envío llegó.
    INTENTOS: 3,
    ESPERA_REINTENTO_MS: 600
  };

  var WHATSAPP = "59891317613";
  var estado = { agenda: null, servicio: null, fecha: null, hora: null };
  var refs = {};

  // En desarrollo se puede apuntar el frontend al mock local:
  //   index.html?turnos=http://127.0.0.1:8130   (ver tools/mock-turnos.py)
  // Por seguridad solo se aceptan direcciones locales.
  (function permitirMockLocal() {
    var parametro = new URLSearchParams(window.location.search).get("turnos");
    if (parametro && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(parametro)) {
      AJUSTES.ENDPOINT = parametro;
    }
  })();

  function buscarUno(selector, raiz) {
    return (raiz || document).querySelector(selector);
  }

  function buscarTodos(selector, raiz) {
    return Array.prototype.slice.call((raiz || document).querySelectorAll(selector));
  }

  function sinEndpoint() {
    return !AJUSTES.ENDPOINT || AJUSTES.ENDPOINT.indexOf("http") !== 0;
  }

  function anunciar(mensaje, tipo) {
    if (!refs.estado) {
      return;
    }
    refs.estado.textContent = mensaje || "";
    refs.estado.setAttribute("data-tipo", tipo || "");
  }

  /* ------------------------------------------------------------- cache corta */
  function claveCache() {
    return "rosconi-turnos:" + (estado.servicio || "") + ":" + AJUSTES.DIAS;
  }

  function leerCache() {
    try {
      var crudo = window.sessionStorage.getItem(claveCache());
      if (!crudo) {
        return null;
      }
      var guardado = JSON.parse(crudo);
      if (Date.now() - guardado.momento > AJUSTES.CACHE_MS) {
        return null;
      }
      return guardado.datos;
    } catch (error) {
      return null;
    }
  }

  function guardarCache(datos) {
    try {
      window.sessionStorage.setItem(
        claveCache(),
        JSON.stringify({ momento: Date.now(), datos: datos })
      );
    } catch (error) {
      /* sin cache disponible: no es un problema */
    }
  }

  function olvidarCache() {
    try {
      var claves = [];
      for (var i = 0; i < window.sessionStorage.length; i++) {
        var clave = window.sessionStorage.key(i);
        if (clave && clave.indexOf("rosconi-turnos:") === 0) {
          claves.push(clave);
        }
      }
      for (var j = 0; j < claves.length; j++) {
        window.sessionStorage.removeItem(claves[j]);
      }
    } catch (error) {
      /* nada */
    }
  }

  /* ------------------------------------------------------------------- red */
  function pedir(ruta, cuerpo, intento) {
    var numero = intento || 1;
    var controlador = typeof AbortController === "function" ? new AbortController() : null;
    var temporizador = window.setTimeout(function () {
      if (controlador) {
        controlador.abort();
      }
    }, AJUSTES.TIMEOUT_MS);

    var opciones = { method: cuerpo ? "POST" : "GET", mode: "cors", cache: "no-store" };
    if (controlador) {
      opciones.signal = controlador.signal;
    }
    if (cuerpo) {
      // text/plain evita el preflight de CORS contra Apps Script
      opciones.headers = { "Content-Type": "text/plain;charset=utf-8" };
      opciones.body = JSON.stringify(cuerpo);
    }

    return fetch(AJUSTES.ENDPOINT + ruta, opciones)
      .then(function (respuesta) {
        return respuesta.json();
      })
      .then(function (datos) {
        window.clearTimeout(temporizador);
        return datos;
      })
      .catch(function (error) {
        window.clearTimeout(temporizador);
        if (numero < AJUSTES.INTENTOS) {
          return new Promise(function (listo) {
            window.setTimeout(listo, AJUSTES.ESPERA_REINTENTO_MS * numero);
          }).then(function () {
            return pedir(ruta, cuerpo, numero + 1);
          });
        }
        throw error;
      });
  }

  function cargarAgenda() {
    if (sinEndpoint()) {
      mostrarRespaldo("El calendario online todavía no está conectado.");
      return;
    }
    var guardado = leerCache();
    if (guardado) {
      aplicarAgenda(guardado);
      return;
    }

    // Mientras se recalcula no se muestran horarios que ya no valen.
    if (refs.dias && refs.horas) {
      refs.dias.textContent = "";
      refs.horas.textContent = "";
      estado.hora = null;
      actualizarBotonEnviar();
    }

    anunciar("Buscando horarios disponibles…", "cargando");
    var consulta =
      "?action=agenda&clave=" + encodeURIComponent(AJUSTES.CLAVE) +
      "&servicio=" + encodeURIComponent(estado.servicio || "") +
      "&dias=" + AJUSTES.DIAS;

    pedir(consulta, null)
      .then(function (datos) {
        if (!datos || datos.ok !== true) {
          throw new Error((datos && datos.mensaje) || "No pudimos leer la agenda.");
        }
        guardarCache(datos);
        aplicarAgenda(datos);
      })
      .catch(function () {
        mostrarRespaldo("No pudimos cargar el calendario en este momento.");
      });
  }

  function aplicarAgenda(datos) {
    estado.agenda = datos;
    estado.servicio = estado.servicio || datos.servicio || AJUSTES.SERVICIO_PREDETERMINADO;
    pintarServicios(datos.servicios || []);

    // El día elegido se mantiene solo si sigue teniendo horarios disponibles.
    var valido = datos.dias.some(function (dia) {
      return dia.fecha === estado.fecha && dia.turnos && dia.turnos.length;
    });
    if (!valido) {
      var primero = datos.dias.filter(function (dia) {
        return dia.turnos && dia.turnos.length;
      })[0];
      estado.fecha = primero ? primero.fecha : null;
      estado.hora = null;
    }

    refs.panel.hidden = false;
    refs.respaldo.hidden = true;
    refs.exito.hidden = true;
    aplicarModalidad(datos.modalidad === "dejar");
    pintarDias(datos.dias || []);
    actualizarBotonEnviar();
  }

  function pintarServicios(lista) {
    if (!refs.servicio || !lista.length || refs.servicio.options.length === lista.length) {
      return;
    }
    refs.servicio.textContent = "";
    lista.forEach(function (servicio) {
      var opcion = document.createElement("option");
      opcion.value = servicio.nombre;
      opcion.textContent = servicio.nombre;
      refs.servicio.appendChild(opcion);
    });
    if (estado.servicio) {
      refs.servicio.value = estado.servicio;
    }
    // Si el servicio sugerido no existe en la lista, se usa el primero.
    if (!refs.servicio.value && refs.servicio.options.length) {
      estado.servicio = refs.servicio.options[0].value;
      refs.servicio.value = estado.servicio;
    }
  }

  function textoEstadoDia(estadoDia) {
    if (estadoDia === "disponible") {
      return "varios horarios";
    }
    if (estadoDia === "ultimo") {
      return "último lugar";
    }
    return "completo";
  }

  function pintarDias(dias) {
    refs.dias.textContent = "";
    // Solo se ofrecen días con horarios: los cerrados o ya completos no aparecen.
    var utiles = dias.filter(function (dia) {
      return dia.turnos && dia.turnos.length;
    });
    if (!utiles.length) {
      anunciar("No hay horarios libres en las próximas semanas para este trabajo.", "aviso");
      // Se ofrece el WhatsApp sin esconder el selector: el cliente puede probar
      // con otro trabajo o pedir el turno por WhatsApp, pero nunca queda con un
      // cuadro vacío y sin salida.
      mostrarRespaldo(
        "Para este trabajo no hay horarios libres en las próximas semanas. " +
        "Probá eligiendo otro trabajo o pedilo por WhatsApp y lo coordinamos.",
        true
      );
      return;
    }
    utiles.forEach(function (dia) {
      var boton = document.createElement("button");
      boton.type = "button";
      boton.className = "dia";
      boton.setAttribute("data-estado", dia.estado);
      boton.setAttribute("data-fecha", dia.fecha);

      var corta = document.createElement("span");
      corta.className = "dia__corta";
      corta.textContent = dia.etiquetaCorta;
      var nota = document.createElement("span");
      nota.className = "dia__nota";
      nota.textContent = textoEstadoDia(dia.estado);
      boton.appendChild(corta);
      boton.appendChild(nota);

      if (dia.fecha === estado.fecha) {
        boton.setAttribute("aria-current", "true");
        boton.setAttribute("aria-pressed", "true");
      }
      refs.dias.appendChild(boton);
    });
    pintarHoras();
  }

  function pintarHoras() {
    refs.horas.textContent = "";
    var dia = null;
    if (estado.agenda) {
      dia = estado.agenda.dias.filter(function (item) {
        return item.fecha === estado.fecha;
      })[0];
    }
    if (!dia || !dia.turnos.length) {
      anunciar("Ese día ya no tiene horarios libres. Probá con otro.", "aviso");
      return;
    }
    dia.turnos.forEach(function (turno) {
      var boton = document.createElement("button");
      boton.type = "button";
      boton.className = "hora";
      boton.setAttribute("data-hora", turno.hora);
      boton.setAttribute("data-estado", turno.estado);
      boton.textContent = turno.hora;
      if (turno.estado === "ultimo") {
        var nota = document.createElement("span");
        nota.className = "hora__nota";
        nota.textContent = "último lugar";
        boton.appendChild(nota);
      }
      if (turno.hora === estado.hora) {
        boton.setAttribute("aria-current", "true");
        boton.setAttribute("aria-pressed", "true");
      }
      refs.horas.appendChild(boton);
    });
    anunciar("", "");
  }

  function modoDejar() {
    return Boolean(estado.agenda && estado.agenda.modalidad === "dejar");
  }

  function actualizarBotonEnviar() {
    if (!refs.enviar) {
      return;
    }
    var listo = Boolean(estado.fecha && estado.hora);
    var deja = modoDejar();
    refs.enviar.disabled = !listo;
    refs.enviar.textContent = listo
      ? (deja ? "Confirmar entrega" : "Confirmar turno")
      : "Elegí un día y un horario";
  }

  /** Ajusta los textos del cuadro según si el auto se deja o se espera. */
  function aplicarModalidad(deja) {
    if (refs.rotuloHoras) {
      refs.rotuloHoras.textContent = deja ? "Horas para dejarlo" : "Horarios libres";
    }
    if (refs.modalidad) {
      refs.modalidad.hidden = !deja;
      refs.modalidad.textContent = deja
        ? "Este trabajo se hace dejando el auto en el taller: lo traés en el horario que " +
          "elijas y lo retirás cuando esté listo (puede ser el mismo día o el siguiente). " +
          "Te avisamos por teléfono."
        : "";
    }
  }

  /* -------------------------------------------------- respaldo por WhatsApp */
  function mostrarRespaldo(mensaje, mantenerPanel) {
    if (!refs.respaldo) {
      return;
    }
    // Con mantenerPanel el selector de trabajo queda a la vista, así el cliente
    // puede probar con otro servicio en vez de cerrar el cuadro.
    refs.panel.hidden = !mantenerPanel;
    refs.respaldo.hidden = false;
    if (refs.respaldoTexto && mensaje) {
      refs.respaldoTexto.textContent = mensaje;
    }
    if (!mantenerPanel) {
      anunciar("");
    }
  }

  function textoWhatsApp(datos) {
    var lineas = ["Hola Rosconi Garage, quiero pedir un turno."];
    if (datos.fecha && datos.hora) {
      lineas.push("Día elegido: " + datos.fecha + " a las " + datos.hora);
    }
    if (datos.servicio) {
      lineas.push("Trabajo: " + datos.servicio);
    }
    if (datos.nombre) {
      lineas.push("Nombre: " + datos.nombre);
    }
    if (datos.vehiculo) {
      lineas.push("Vehículo: " + datos.vehiculo);
    }
    if (datos.codigo) {
      lineas.push("Código de la reserva: " + datos.codigo);
    }
    if (datos.comentario) {
      lineas.push("Comentario: " + datos.comentario);
    }
    return "https://wa.me/" + WHATSAPP + "?text=" + encodeURIComponent(lineas.join("\n"));
  }

  /* ------------------------------------------------------------- interaccion */
  function abrir(servicioSugerido) {
    if (!refs.dialogo) {
      return;
    }
    if (servicioSugerido && refs.servicio) {
      // Si el trabajo pedido es distinto al de la agenda cargada, hay que
      // recalcularla: la duración cambia qué horarios se pueden ofrecer.
      if (estado.agenda && estado.agenda.servicio !== servicioSugerido) {
        estado.agenda = null;
        estado.hora = null;
      }
      estado.servicio = servicioSugerido;
      refs.servicio.value = servicioSugerido;
    }
    // Si vuelve a abrir después de reservar, se muestra la agenda otra vez.
    if (refs.exito && !refs.exito.hidden) {
      refs.exito.hidden = true;
      refs.panel.hidden = false;
    }
    if (typeof refs.dialogo.showModal === "function") {
      if (!refs.dialogo.open) {
        refs.dialogo.showModal();
      }
    } else {
      refs.dialogo.setAttribute("open", "open");
    }
    if (!estado.agenda) {
      cargarAgenda();
    }
    window.setTimeout(function () {
      var foco = estado.agenda ? refs.dias : refs.servicio;
      if (foco && foco.focus) {
        foco.focus();
      }
    }, 60);
  }

  function cerrar() {
    if (!refs.dialogo) {
      return;
    }
    if (typeof refs.dialogo.close === "function") {
      refs.dialogo.close();
    } else {
      refs.dialogo.removeAttribute("open");
    }
  }

  function marcarActivo(coleccion, atributo, valor) {
    buscarTodos(coleccion, refs.dialogo).forEach(function (boton) {
      var activo = boton.getAttribute(atributo) === valor;
      if (activo) {
        boton.setAttribute("aria-current", "true");
        boton.setAttribute("aria-pressed", "true");
      } else {
        boton.removeAttribute("aria-current");
        boton.removeAttribute("aria-pressed");
      }
    });
  }

  function elegirDia(fecha) {
    estado.fecha = fecha;
    estado.hora = null;
    marcarActivo(".dia", "data-fecha", fecha);
    pintarHoras();
    actualizarBotonEnviar();
  }

  function elegirHora(hora) {
    estado.hora = hora;
    marcarActivo(".hora", "data-hora", hora);
    actualizarBotonEnviar();
    if (refs.enviar && !refs.enviar.disabled && refs.enviar.focus) {
      refs.enviar.focus();
    }
  }

  function formatearParaCalendario(fecha, hora, minutos) {
    var partesFecha = fecha.split("-");
    var partesHora = hora.split(":");
    var inicio = new Date(
      Number(partesFecha[0]), Number(partesFecha[1]) - 1, Number(partesFecha[2]),
      Number(partesHora[0]), Number(partesHora[1]), 0
    );
    var fin = new Date(inicio.getTime() + minutos * 60000);
    function dos(valor) {
      return (valor < 10 ? "0" : "") + valor;
    }
    function sello(fechaObjeto) {
      return String(fechaObjeto.getFullYear()) + dos(fechaObjeto.getMonth() + 1) +
        dos(fechaObjeto.getDate()) + "T" + dos(fechaObjeto.getHours()) +
        dos(fechaObjeto.getMinutes()) + "00";
    }
    return sello(inicio) + "/" + sello(fin);
  }

  function mostrarExito(reserva) {
    refs.panel.hidden = true;
    refs.exito.hidden = false;
    olvidarCache();
    // La próxima vez que abra, se vuelve a pedir la agenda (ya sin este turno).
    estado.agenda = null;
    estado.hora = null;
    actualizarBotonEnviar();

    refs.resumen.textContent = (reserva.modalidad === "dejar" ? "Dejás el auto: " : "") +
      reserva.etiqueta + " a las " + reserva.hora +
      " · " + reserva.servicio;
    refs.codigo.textContent = reserva.codigo;

    var rango = formatearParaCalendario(
      reserva.fecha, reserva.hora, reserva.duracionMinutos || 60
    );
    if (refs.calendario) {
      refs.calendario.href = "https://calendar.google.com/calendar/render?action=TEMPLATE" +
        "&text=" + encodeURIComponent("Turno en Rosconi Garage") +
        "&dates=" + rango +
        "&details=" + encodeURIComponent("Turno " + reserva.codigo + " · " + reserva.servicio) +
        "&location=" + encodeURIComponent("Juan Antonio Lavalleja 730, Artigas");
    }
    if (refs.whatsappExito) {
      refs.whatsappExito.href = textoWhatsApp(reserva);
    }
    if (refs.tituloExito && refs.tituloExito.focus) {
      refs.tituloExito.focus();
    }
  }

  function enviar(evento) {
    evento.preventDefault();
    if (!estado.fecha || !estado.hora) {
      anunciar("Elegí un día y un horario.", "error");
      return;
    }
    if (sinEndpoint()) {
      mostrarRespaldo("El calendario online todavía no está conectado.");
      return;
    }

    var datos = {
      accion: "crear",
      clave: AJUSTES.CLAVE,
      fecha: estado.fecha,
      hora: estado.hora,
      servicio: refs.servicio.value,
      nombre: refs.nombre.value.trim(),
      telefono: refs.telefono.value.trim(),
      vehiculo: refs.vehiculo.value.trim(),
      email: refs.email.value.trim(),
      comentario: refs.comentario.value.trim(),
      empresa: refs.empresa ? refs.empresa.value : ""
    };
    if (refs.whatsappForm) {
      refs.whatsappForm.href = textoWhatsApp(datos);
    }
    if (datos.nombre.length < 3 || datos.vehiculo.length < 2 ||
        datos.telefono.replace(/\D/g, "").length < 8) {
      anunciar("Revisá el nombre, el teléfono y el vehículo.", "error");
      return;
    }

    refs.enviar.disabled = true;
    anunciar("Confirmando el turno…", "cargando");
    pedir("", datos)
      .then(function (respuesta) {
        if (!respuesta || respuesta.ok !== true) {
          throw new Error((respuesta && respuesta.mensaje) || "No pudimos confirmar el turno.");
        }
        mostrarExito(respuesta);
      })
      .catch(function (error) {
        refs.enviar.disabled = false;
        anunciar(error.message + " Podés confirmarlo por WhatsApp con el botón de abajo.", "error");
        if (refs.whatsappForm) {
          refs.whatsappForm.setAttribute("data-destacar", "true");
        }
      });
  }

  function mostrarGestion(mensaje, tipo) {
    refs.gestionResultado.textContent = mensaje;
    refs.gestionResultado.setAttribute("data-tipo", tipo || "");
    refs.gestionCancelar.hidden = tipo !== "ok";
  }

  function consultarTurno() {
    var codigo = (refs.gestionCodigo.value || "").trim().toUpperCase();
    if (!/^RG-[A-Z0-9]{8}$/.test(codigo)) {
      mostrarGestion("El código tiene el formato RG-XXXXXXXX.", "error");
      return;
    }
    mostrarGestion("Buscando el turno…", "cargando");
    pedir("", { accion: "consultar", clave: AJUSTES.CLAVE, codigo: codigo })
      .then(function (respuesta) {
        if (!respuesta || respuesta.ok !== true) {
          throw new Error((respuesta && respuesta.mensaje) || "No encontramos ese código.");
        }
        mostrarGestion(respuesta.etiqueta + " a las " + respuesta.hora + " · " +
          respuesta.servicio + " · " + respuesta.vehiculo, "ok");
      })
      .catch(function (error) {
        mostrarGestion(error.message, "error");
      });
  }

  function cancelarTurno() {
    var codigo = (refs.gestionCodigo.value || "").trim().toUpperCase();
    if (!window.confirm("¿Confirmás que querés cancelar el turno " + codigo + "?")) {
      return;
    }
    mostrarGestion("Cancelando…", "cargando");
    pedir("", { accion: "cancelar", clave: AJUSTES.CLAVE, codigo: codigo })
      .then(function (respuesta) {
        if (!respuesta || respuesta.ok !== true) {
          // Puede pasar si el primer intento sí canceló y se perdió la
          // respuesta: el reintento ya no encuentra el turno.
          if (respuesta && respuesta.error === "no_encontrado") {
            throw new Error("Ese código no tiene un turno activo: puede que ya esté cancelado.");
          }
          throw new Error((respuesta && respuesta.mensaje) || "No pudimos cancelar el turno.");
        }
        olvidarCache();
        refs.gestionCancelar.hidden = true;
        mostrarGestion(respuesta.mensaje, "ok");
      })
      .catch(function (error) {
        mostrarGestion(error.message, "error");
      });
  }

  /* ------------------------------------------------------------- arranque */
  function asignarRefs() {
    refs.dialogo = document.getElementById("reserva");
    if (!refs.dialogo) {
      return false;
    }
    refs.panel = buscarUno("[data-reserva-panel]");
    refs.exito = buscarUno("[data-reserva-exito]");
    refs.respaldo = buscarUno("[data-reserva-respaldo]");
    refs.respaldoTexto = buscarUno("[data-reserva-respaldo-texto]");
    refs.servicio = buscarUno("[data-reserva-servicio]");
    refs.estado = buscarUno("[data-reserva-estado]");
    refs.dias = buscarUno("[data-reserva-dias]");
    refs.horas = buscarUno("[data-reserva-horas]");
    refs.rotuloHoras = buscarUno("#reserva-horas-rotulo");
    refs.modalidad = buscarUno("[data-reserva-modalidad]");
    refs.form = buscarUno("[data-reserva-form]");
    refs.nombre = buscarUno("#reserva-nombre");
    refs.telefono = buscarUno("#reserva-telefono");
    refs.vehiculo = buscarUno("#reserva-vehiculo");
    refs.email = buscarUno("#reserva-email");
    refs.comentario = buscarUno("#reserva-comentario");
    refs.empresa = buscarUno("#reserva-empresa");
    refs.enviar = buscarUno("[data-reserva-enviar]");
    refs.resumen = buscarUno("[data-reserva-resumen]");
    refs.codigo = buscarUno("[data-reserva-codigo]");
    refs.calendario = buscarUno("[data-reserva-calendario]");
    refs.whatsappExito = buscarUno("[data-reserva-whatsapp]");
    refs.whatsappForm = buscarUno("[data-reserva-whatsapp-form]");
    refs.tituloExito = buscarUno("[data-reserva-titulo-exito]");
    refs.gestionCodigo = buscarUno("[data-gestion-codigo]");
    refs.gestionBuscar = buscarUno("[data-gestion-buscar]");
    refs.gestionCancelar = buscarUno("[data-gestion-cancelar]");
    refs.gestionResultado = buscarUno("[data-gestion-resultado]");
    return true;
  }

  function conectar() {
    buscarTodos("[data-abrir-reserva]").forEach(function (boton) {
      boton.addEventListener("click", function (evento) {
        evento.preventDefault();
        abrir(boton.getAttribute("data-servicio") || "");
      });
    });

    buscarTodos("[data-reserva-cerrar]").forEach(function (boton) {
      boton.addEventListener("click", function (evento) {
        evento.preventDefault();
        cerrar();
      });
    });

    refs.dias.addEventListener("click", function (evento) {
      var boton = evento.target.closest ? evento.target.closest("[data-fecha]") : null;
      if (boton) {
        elegirDia(boton.getAttribute("data-fecha"));
      }
    });

    refs.horas.addEventListener("click", function (evento) {
      var boton = evento.target.closest ? evento.target.closest("[data-hora]") : null;
      if (boton) {
        elegirHora(boton.getAttribute("data-hora"));
      }
    });

    if (refs.servicio) {
      refs.servicio.addEventListener("change", function () {
        estado.servicio = refs.servicio.value;
        estado.hora = null;
        cargarAgenda();
      });
    }

    if (refs.form) {
      refs.form.addEventListener("submit", enviar);
    }
    if (refs.gestionBuscar) {
      refs.gestionBuscar.addEventListener("click", consultarTurno);
    }
    if (refs.gestionCancelar) {
      refs.gestionCancelar.addEventListener("click", cancelarTurno);
    }
    refs.dialogo.addEventListener("close", function () {
      actualizarBotonEnviar();
    });
  }

  function precargar() {
    // Precalienta la agenda en un momento libre: el dialogo abre al instante.
    if (sinEndpoint() || estado.agenda) {
      return;
    }
    var arrancar = function () {
      cargarAgenda();
    };
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(arrancar, { timeout: 4000 });
    } else {
      window.setTimeout(arrancar, 2500);
    }
  }

  function init() {
    if (!asignarRefs()) {
      return;
    }
    conectar();
    actualizarBotonEnviar();
    if (sinEndpoint()) {
      mostrarRespaldo("El calendario online todavía no está conectado.");
      return;
    }
    precargar();
  }

  // Expuesto para las pruebas automaticas (tools/pruebas-ui.html)
  window.RosconiTurnos = {
    abrir: abrir,
    cerrar: cerrar,
    cargarAgenda: cargarAgenda,
    elegirDia: elegirDia,
    elegirHora: elegirHora,
    ajustes: AJUSTES,
    estado: estado
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
