/* ==========================================================================
   Rosconi Garage — panel del taller
   --------------------------------------------------------------------------
   Página privada del dueño/administrador. Habla con el backend propio
   (tools/appsscript/Code.gs) usando la clave de administración, que es
   distinta de la clave pública del sitio.

   Tres vistas: Hoy (la agenda real del taller), Próximos 14 días y Buscar.
   Acciones: WhatsApp y llamada en un clic, marcar un trabajo como listo y
   anotar los turnos que llegan por teléfono.
   ========================================================================== */
(function () {
  "use strict";

  var AJUSTES = {
    // Misma app web que usa el sitio (ver assets/js/booking.js).
    // Si cambia la direccion, se reemplaza aca tambien.
    ENDPOINT:
      "https://script.google.com/macros/s/AKfycbzIQY4586W2NT2bEceemIGefXRD1jLMWwDnqo4_0mXX6PixAY-ektDdE3d0q9s0WNxclg/exec",
    DIAS: 14,
    CLAVE_GUARDADA: "rosconi-panel-clave",
    REFRESCO_MS: 300000
  };

  var estado = { claveAdmin: "", tablero: null, fecha: null, vista: "dia" };
  var refs = {};

  // En desarrollo se puede apuntar el panel al mock local:
  //   panel.html?turnos=http://127.0.0.1:8131   (ver tools/mock-turnos.py)
  // Por seguridad solo se aceptan direcciones locales.
  (function permitirMockLocal() {
    var parametros = new URLSearchParams(window.location.search);
    var parametro = parametros.get("turnos");
    if (parametro && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(parametro)) {
      AJUSTES.ENDPOINT = parametro;
      // Contra el mock local tambien se acepta la clave por URL, para las
      // pruebas automaticas y las capturas de pantalla. Con el backend real
      // desplegado este parametro se ignora.
      AJUSTES.CLAVE_PRUEBA = parametros.get("clave") || "";
    }
  })();

  /* -------------------------------------------------------------- ayudas */
  function buscarUno(selector, raiz) {
    return (raiz || document).querySelector(selector);
  }

  function buscarTodos(selector, raiz) {
    return Array.prototype.slice.call((raiz || document).querySelectorAll(selector));
  }

  /** Crea un elemento con clase y texto (sin innerHTML: los datos vienen del
   *  calendario y pueden traer cualquier cosa escrita por el cliente). */
  function crear(etiqueta, clase, texto) {
    var elemento = document.createElement(etiqueta);
    if (clase) {
      elemento.className = clase;
    }
    if (texto !== undefined && texto !== null) {
      elemento.textContent = texto;
    }
    return elemento;
  }

  function aviso(mensaje, tipo) {
    refs.aviso.textContent = mensaje || "";
    refs.aviso.setAttribute("data-tipo", tipo || "");
  }

  function mayuscula(texto) {
    texto = String(texto || "");
    return texto.charAt(0).toUpperCase() + texto.slice(1);
  }

  function hoyISO() {
    var ahora = new Date();
    return aISO(ahora);
  }

  function aISO(fecha) {
    return fecha.getFullYear() + "-" +
      ("0" + (fecha.getMonth() + 1)).slice(-2) + "-" +
      ("0" + fecha.getDate()).slice(-2);
  }

  /** Fecha local a partir de un "YYYY-MM-DD" (a mediodía, para no bailar con
   *  los cambios de horario). */
  function desdeISO(iso) {
    var partes = String(iso || "").split("-");
    return new Date(Number(partes[0]), Number(partes[1]) - 1, Number(partes[2]), 12, 0, 0);
  }

  function sumarDias(iso, dias) {
    var fecha = desdeISO(iso);
    fecha.setDate(fecha.getDate() + dias);
    return aISO(fecha);
  }

  function diasDeDiferencia(iso) {
    var hoy = desdeISO(hoyISO()).getTime();
    var otro = desdeISO(iso).getTime();
    return Math.round((otro - hoy) / 86400000);
  }

  /** "vie" y "25" del día pedido. */
  function partesDia(iso) {
    var fecha = desdeISO(iso);
    var dias = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
    return { dia: dias[fecha.getDay()], numero: String(fecha.getDate()) };
  }

  /** Rótulo chico que acompaña la fecha grande. */
  function rotuloRelativo(iso) {
    var diferencia = diasDeDiferencia(iso);
    if (diferencia === 0) { return "Hoy"; }
    if (diferencia === 1) { return "Mañana"; }
    if (diferencia === -1) { return "Ayer"; }
    if (diferencia > 1 && diferencia <= 7) { return "En " + diferencia + " días"; }
    return "";
  }

  /* -------------------------------------------------------------- backend */
  function pedir(accion, extra) {
    var cuerpo = { accion: accion, claveAdmin: estado.claveAdmin };
    if (extra) {
      Object.keys(extra).forEach(function (clave) {
        cuerpo[clave] = extra[clave];
      });
    }
    return fetch(AJUSTES.ENDPOINT, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(cuerpo)
    })
      .then(function (respuesta) { return respuesta.json(); })
      .then(function (datos) {
        var mensaje = String((datos && datos.mensaje) || "");
        if (!datos || (datos.ok !== true &&
            (datos.error === "clave_admin_invalida" || /clave del panel/i.test(mensaje)))) {
          salir("La clave del panel no es válida. Volvé a escribirla.", "error");
          throw new Error("clave_invalida");
        }
        if (!datos || datos.ok !== true) {
          throw new Error(mensaje || "No pudimos completar la operación.");
        }
        return datos;
      });
  }

  /* --------------------------------------------------------- clave del panel */
  function guardarClave(clave) {
    try {
      window.localStorage.setItem(AJUSTES.CLAVE_GUARDADA, clave);
    } catch (error) {
      /* sin almacenamiento: se escribe en cada visita */
    }
  }

  function leerClave() {
    try {
      return window.localStorage.getItem(AJUSTES.CLAVE_GUARDADA) || "";
    } catch (error) {
      return "";
    }
  }

  /** Traduce el error del backend a algo que el dueño entienda. */
  function mensajeDeError(error) {
    var texto = String((error && error.message) || error || "");
    if (/clave de instalacion/i.test(texto)) {
      return "El backend todavía no tiene el panel: falta implementar una versión nueva " +
        "del script (Implementar > Administrar implementaciones > Versión: nueva versión).";
    }
    if (/failed to fetch|networkerror|load failed|network/i.test(texto)) {
      return "No pudimos comunicarnos con la agenda del taller. Revisá la conexión y " +
        "probá de nuevo.";
    }
    return "No pudimos leer la agenda: " + texto;
  }

  function entrar() {
    refs.ingreso.hidden = true;
    refs.contenido.hidden = false;
    refs.acciones.hidden = false;
    if (refs.nav) {
      refs.nav.hidden = false;
    }
    aviso("", "");
  }

  function salir(mensaje, tipo, olvidarClave) {
    estado.claveAdmin = "";
    estado.tablero = null;
    if (olvidarClave !== false) {
      try {
        window.localStorage.removeItem(AJUSTES.CLAVE_GUARDADA);
      } catch (error) {
        /* nada */
      }
    }
    cerrarHoja();
    refs.ingreso.hidden = false;
    refs.contenido.hidden = true;
    refs.acciones.hidden = true;
    if (refs.nav) {
      refs.nav.hidden = true;
    }
    refs.clave.value = "";
    aviso(mensaje || "", tipo || "");
    refs.clave.focus();
  }

  /* --------------------------------------------------------------- cargar */
  function cargarTablero(desde, conservarAviso) {
    if (!conservarAviso) {
      aviso("Cargando la agenda…", "cargando");
    }
    return pedir("panel", { dias: AJUSTES.DIAS, desde: desde || hoyISO() })
      .then(function (datos) {
        estado.tablero = datos;
        var dias = datos.agenda || [];
        var existe = dias.some(function (dia) { return dia.fecha === estado.fecha; });
        if (!existe) {
          estado.fecha = dias.length ? dias[0].fecha : hoyISO();
        }
        refs.version.textContent = "backend " + (datos.version || "?");
        refs.fecha.value = estado.fecha;
        pintarServicios(datos.servicios || []);
        pintarTira();
        pintarDia();
        pintarProximos();
        // Si el refresco viene despues de una accion, no se toca el aviso: el
        // mensaje de confirmacion (por ejemplo "turno guardado") queda a la vista.
        if (!conservarAviso) {
          aviso("", "");
        }
        return true;
      })
      .catch(function (error) {
        if (error.message === "clave_invalida") {
          return false;
        }
        // Sin agenda cargada no se muestra el panel: se vuelve al ingreso con el
        // motivo (el dueño no queda "adentro" de una pantalla vacía).
        if (!estado.tablero) {
          salir(mensajeDeError(error), "error", false);
        } else {
          aviso("No pudimos actualizar la agenda: " + error.message, "error");
        }
        return false;
      });
  }

  function diaDe(fecha) {
    return ((estado.tablero && estado.tablero.agenda) || []).filter(function (dia) {
      return dia.fecha === fecha;
    })[0] || null;
  }

  /* ------------------------------------------------------------------ tira */
  function pintarTira() {
    refs.tira.textContent = "";
    (estado.tablero.agenda || []).forEach(function (dia) {
      var boton = crear("button", "tira__dia");
      boton.type = "button";
      boton.setAttribute("data-fecha-dia", dia.fecha);
      boton.setAttribute("data-cerrado", dia.cerrado ? "true" : "false");
      if (dia.fecha === estado.fecha) {
        boton.setAttribute("aria-current", "true");
      }
      var partes = partesDia(dia.fecha);
      var cuenta = dia.turnos.length;
      var texto = dia.cerrado ? "cerrado"
        : (cuenta ? cuenta + (cuenta === 1 ? " turno" : " turnos") : "");
      boton.appendChild(crear("strong", "", dia.fecha === hoyISO() ? "hoy" : partes.dia));
      boton.appendChild(crear("span", "", partes.numero));
      boton.appendChild(crear("b", "", texto));
      refs.tira.appendChild(boton);
    });
  }

  /* ------------------------------------------------------------------- día */
  function pintarDia() {
    var dia = diaDe(estado.fecha);
    if (!dia) {
      refs.kicker.textContent = "";
      refs.titulo.textContent = "Sin datos";
      refs.resumen.textContent = "";
      refs.turnos.textContent = "";
      refs.libres.textContent = "";
      if (refs.siguiente) {
        refs.siguiente.hidden = true;
      }
      return;
    }
    var autos = dia.turnos.length;
    var lugares = dia.libres.reduce(function (total, hueco) {
      return total + hueco.lugares;
    }, 0);
    refs.kicker.textContent = dia.cerrado ? "Taller cerrado" : rotuloRelativo(dia.fecha);
    refs.titulo.textContent = mayuscula(dia.etiqueta);
    var partes = [];
    if (dia.cerrado) {
      partes.push("Taller cerrado");
    } else {
      partes.push(autos === 0 ? "Sin autos agendados"
        : autos + (autos === 1 ? " auto agendado" : " autos agendados"));
      partes.push(lugares + (lugares === 1 ? " lugar libre" : " lugares libres"));
    }
    refs.resumen.textContent = partes.join(" · ");
    pintarTurnos(dia.turnos, refs.turnos,
      autos === 0 ? "No hay autos agendados para este día." : "");
    pintarLibres(dia);
    refs.fechaAnotar.value = estado.fecha;
    if (!refs.horaAnotar.value) {
      refs.horaAnotar.value = dia.libres.length ? dia.libres[0].hora : "08:00";
    }
    pintarSiguiente(dia);
  }

  /** Franja con el auto que sigue hoy (lo primero que mira el taller). */
  function pintarSiguiente(dia) {
    if (!refs.siguiente) {
      return;
    }
    if (!dia || dia.cerrado || dia.fecha !== hoyISO()) {
      refs.siguiente.hidden = true;
      return;
    }
    var ahora = new Date();
    var hora = ("0" + ahora.getHours()).slice(-2) + ":" + ("0" + ahora.getMinutes()).slice(-2);
    var siguiente = dia.turnos.filter(function (turno) {
      return turno.hora >= hora;
    })[0];
    refs.siguiente.hidden = false;
    if (siguiente) {
      refs.siguiente.textContent = "Sigue: " + siguiente.hora + " · " +
        (siguiente.vehiculo || "auto sin datos") +
        (siguiente.cliente ? " (" + siguiente.cliente + ")" : "");
    } else {
      refs.siguiente.textContent = dia.turnos.length
        ? "Ya pasaron los " + dia.turnos.length + " turnos de hoy"
        : "Hoy no hay autos agendados";
    }
  }

  /* ---------------------------------------------------------------- turnos */
  function pintarTurnos(lista, contenedor, textoVacio) {
    contenedor.textContent = "";
    if (!lista.length) {
      if (textoVacio) {
        contenedor.appendChild(crear("p", "turno__vacio", textoVacio));
      }
      return;
    }
    lista.forEach(function (turno) {
      contenedor.appendChild(construirTurno(turno));
    });
  }

  /** Tarjeta de un turno. Muestra solo lo que el taller necesita para
   *  recibir el auto y avisarle al cliente. */
  function construirTurno(turno) {
    var tarjeta = crear("article", "turno");
    tarjeta.setAttribute("data-linea", turno.linea || "");
    tarjeta.setAttribute("data-listo", turno.listo ? "true" : "false");
    tarjeta.setAttribute("data-codigo", turno.codigo || "");

    var cabecera = crear("header", "turno__cabecera");
    var bloqueHora = crear("p", "turno__hora");
    bloqueHora.appendChild(crear("strong", "", turno.hora));
    bloqueHora.appendChild(crear("span", "", "hasta " + turno.horaFin));
    cabecera.appendChild(bloqueHora);

    var titulo = crear("div", "turno__titulo");
    titulo.appendChild(crear("h2", "turno__auto", turno.vehiculo || "Vehículo sin datos"));
    titulo.appendChild(crear("p", "turno__servicio", turno.servicio || ""));
    if (turno.linea) {
      titulo.appendChild(crear("span", "turno__linea",
        turno.linea === "elevador" ? "elevador" : "piso"));
    }
    cabecera.appendChild(titulo);
    tarjeta.appendChild(cabecera);

    var etiquetas = crear("ul", "turno__etiquetas");
    if (turno.listo) {
      etiquetas.appendChild(crear("li", "etiq etiq--listo", "listo para retirar"));
    }
    if (turno.deja) {
      etiquetas.appendChild(crear("li", "etiq etiq--deja", "deja el auto"));
    }
    if (turno.minutos >= 240) {
      etiquetas.appendChild(crear("li", "etiq etiq--largo", "trabajo largo"));
    }
    if (turno.origen === "panel") {
      etiquetas.appendChild(crear("li", "etiq etiq--panel", "anotado por teléfono"));
    }
    if (etiquetas.childNodes.length) {
      tarjeta.appendChild(etiquetas);
    }

    var cliente = crear("p", "turno__cliente");
    cliente.appendChild(crear("b", "", turno.cliente || "Cliente"));
    if (turno.telefono) {
      cliente.appendChild(crear("span", "", turno.telefono));
    }
    tarjeta.appendChild(cliente);

    if (turno.comentario) {
      var tarea = crear("div", "turno__tarea");
      tarea.appendChild(crear("b", "", "Qué hay que hacer"));
      tarea.appendChild(crear("span", "", turno.comentario));
      tarjeta.appendChild(tarea);
    }

    var acciones = crear("div", "turno__acciones");
    if (turno.whatsapp) {
      var nombre = (turno.cliente || "").split(" ")[0];
      var enlaceWhats = crear("a", "btn btn--whatsapp",
        "WhatsApp" + (nombre ? " a " + nombre : ""));
      enlaceWhats.href = "https://wa.me/" + turno.whatsapp + "?text=" +
        encodeURIComponent("Hola " + (nombre || "") +
          ", te escribo del taller Rosconi Garage por el turno del " +
          turno.fecha + " a las " + turno.hora + " (" + (turno.vehiculo || "") + ").");
      enlaceWhats.target = "_blank";
      enlaceWhats.rel = "noopener";
      acciones.appendChild(enlaceWhats);

      var enlaceLlamar = crear("a", "btn btn--llamar",
        "Llamar" + (turno.telefono ? " " + turno.telefono : ""));
      enlaceLlamar.href = "tel:+" + turno.whatsapp;
      acciones.appendChild(enlaceLlamar);
    } else {
      acciones.appendChild(crear("p", "turno__sin-tel", "Sin teléfono cargado"));
    }
    tarjeta.appendChild(acciones);

    var pie = crear("footer", "turno__pie");
    pie.appendChild(crear("span", "turno__codigo", turno.codigo || ""));
    var botonListo = crear("button",
      turno.listo ? "btn btn--volver" : "btn btn--listo",
      turno.listo ? "Volver a pendiente" : "Marcar listo para retirar");
    botonListo.type = "button";
    botonListo.setAttribute("data-listo-codigo", turno.codigo || "");
    botonListo.setAttribute("data-listo-valor", turno.listo ? "false" : "true");
    pie.appendChild(botonListo);
    tarjeta.appendChild(pie);

    return tarjeta;
  }

  /* ----------------------------------------------------------------- libres */
  function pintarLibres(dia) {
    refs.libres.textContent = "";
    if (!dia || dia.cerrado) {
      return;
    }
    if (!dia.libres.length) {
      refs.libres.appendChild(crear("span", "libres__hora", "No quedan lugares libres"));
      return;
    }
    dia.libres.forEach(function (hueco) {
      var chip = crear("span", "libres__hora");
      chip.appendChild(crear("b", "", hueco.hora));
      chip.appendChild(document.createTextNode(" · " + hueco.lugares +
        (hueco.lugares === 1 ? " lugar" : " lugares")));
      refs.libres.appendChild(chip);
    });
  }

  /* -------------------------------------------------------------- próximos */
  function pintarProximos() {
    refs.proximos.textContent = "";
    (estado.tablero.agenda || []).forEach(function (dia) {
      var bloque = crear("article", "proximo");
      bloque.setAttribute("data-cerrado", dia.cerrado ? "true" : "false");

      var cabecera = crear("button", "proximo__cabecera");
      cabecera.type = "button";
      cabecera.setAttribute("data-ir-a", dia.fecha);
      var nombreDia = crear("span", "proximo__dia");
      nombreDia.appendChild(crear("strong", "", mayuscula(dia.etiqueta)));
      nombreDia.appendChild(crear("small", "",
        rotuloRelativo(dia.fecha) || (dia.cerrado ? "Cerrado" : "Abierto")));
      cabecera.appendChild(nombreDia);
      cabecera.appendChild(crear("span", "proximo__cuenta", dia.cerrado ? "cerrado"
        : (dia.turnos.length === 0 ? "libre" : dia.turnos.length +
          (dia.turnos.length === 1 ? " auto" : " autos"))));
      cabecera.appendChild(crear("span", "proximo__chevron", "›"));
      bloque.appendChild(cabecera);

      if (dia.turnos.length) {
        var lista = crear("ul", "proximo__lista");
        dia.turnos.forEach(function (turno) {
          var fila = crear("li");
          fila.appendChild(crear("b", "", turno.hora));
          var detalle = crear("span");
          detalle.appendChild(crear("i", "", turno.vehiculo || "Auto sin datos"));
          detalle.appendChild(document.createTextNode(" · " + (turno.cliente || "") +
            (turno.deja ? " · deja el auto" : "") +
            (turno.listo ? " · listo" : "")));
          fila.appendChild(detalle);
          lista.appendChild(fila);
        });
        bloque.appendChild(lista);
      }

      refs.proximos.appendChild(bloque);
    });
  }

  function pintarServicios(lista) {
    if (!refs.servicioAnotar || refs.servicioAnotar.options.length || !lista.length) {
      return;
    }
    lista.forEach(function (ficha) {
      var nombre = ficha.nombre || ficha;
      var opcion = document.createElement("option");
      opcion.value = nombre;
      opcion.textContent = nombre;
      refs.servicioAnotar.appendChild(opcion);
    });
  }

  /* -------------------------------------------------------------- acciones */
  function marcarListo(codigo, listo) {
    aviso("Guardando…", "cargando");
    pedir("listo", { codigo: codigo, listo: listo })
      .then(function (datos) {
        aviso(datos.mensaje || "Listo.", "ok");
        return cargarTablero(estado.tablero ? estado.tablero.desde : null, true);
      })
      .catch(function (error) {
        aviso(mensajeDeError(error), "error");
      });
  }

  function anotar(evento) {
    evento.preventDefault();
    var datos = {
      fecha: refs.fechaAnotar.value,
      hora: refs.horaAnotar.value,
      servicio: refs.servicioAnotar.value,
      nombre: refs.nombreAnotar.value.trim(),
      telefono: refs.telefonoAnotar.value.trim(),
      vehiculo: refs.vehiculoAnotar.value.trim(),
      comentario: refs.comentarioAnotar.value.trim(),
      email: ""
    };
    if (!datos.fecha || !datos.hora || datos.nombre.length < 3 ||
        datos.telefono.replace(/\D/g, "").length < 8 || datos.vehiculo.length < 2) {
      aviso("Completá el día, la hora, el cliente, el teléfono y el vehículo.", "error");
      return;
    }
    aviso("Guardando el turno…", "cargando");
    refs.enviarAnotar.disabled = true;
    pedir("anotar", datos)
      .then(function (respuesta) {
        refs.enviarAnotar.disabled = false;
        aviso("Turno guardado: " + respuesta.etiqueta + " a las " + respuesta.hora +
          " (" + respuesta.codigo + ").", "ok");
        refs.formAnotar.reset();
        refs.horaAnotar.value = "";
        cerrarHoja();
        estado.fecha = respuesta.fecha;
        mostrarVista("dia");
        return cargarTablero(estado.tablero && estado.tablero.desde
          ? estado.tablero.desde : hoyISO(), true);
      })
      .catch(function (error) {
        refs.enviarAnotar.disabled = false;
        aviso(mensajeDeError(error), "error");
      });
  }

  function buscar(evento) {
    evento.preventDefault();
    var texto = refs.textoBuscar.value.trim();
    if (texto.length < 3) {
      pintarTurnos([], refs.resultados,
        "Escribí al menos 3 letras (cliente, teléfono, auto o código).");
      return;
    }
    aviso("Buscando…", "cargando");
    pedir("buscar", { texto: texto })
      .then(function (datos) {
        aviso("", "");
        var encontrados = datos.encontrados || [];
        pintarTurnos(encontrados, refs.resultados,
          "No encontramos turnos con «" + texto + "».");
        if (encontrados.length) {
          aviso(encontrados.length + (encontrados.length === 1
            ? " turno encontrado." : " turnos encontrados."), "ok");
        }
      })
      .catch(function (error) {
        aviso(mensajeDeError(error), "error");
      });
  }

  /* ----------------------------------------------------------- navegación */
  function mostrarVista(vista) {
    estado.vista = vista;
    buscarTodos("[data-panel-vista]").forEach(function (boton) {
      boton.setAttribute("aria-pressed",
        boton.getAttribute("data-panel-vista") === vista ? "true" : "false");
    });
    buscarTodos("[data-panel-seccion]").forEach(function (seccion) {
      seccion.hidden = seccion.getAttribute("data-panel-seccion") !== vista;
    });
    if (vista === "buscar" && refs.textoBuscar) {
      window.setTimeout(function () {
        refs.textoBuscar.focus();
      }, 60);
    }
  }

  function irAlDia(fecha) {
    var dentro = (estado.tablero.agenda || []).some(function (dia) {
      return dia.fecha === fecha;
    });
    estado.fecha = fecha;
    if (!dentro) {
      return cargarTablero(fecha).then(function () {
        mostrarVista("dia");
      });
    }
    refs.fecha.value = fecha;
    pintarTira();
    pintarDia();
    mostrarVista("dia");
    return null;
  }

  /** Día anterior o siguiente con las flechas de la fecha. */
  function moverDia(paso) {
    var dias = (estado.tablero && estado.tablero.agenda) || [];
    var actual = estado.fecha || hoyISO();
    var indice = -1;
    dias.forEach(function (dia, posicion) {
      if (dia.fecha === actual) {
        indice = posicion;
      }
    });
    if (indice > -1 && dias[indice + paso]) {
      irAlDia(dias[indice + paso].fecha);
      return;
    }
    irAlDia(sumarDias(actual, paso));
  }

  /* ---------------------------------------------------------------- hoja */
  function abrirHoja() {
    if (!refs.hoja) {
      return;
    }
    refs.hoja.hidden = false;
    document.body.classList.add("con-hoja");
    if (refs.vehiculoAnotar) {
      refs.vehiculoAnotar.focus();
    }
  }

  function cerrarHoja() {
    if (!refs.hoja || refs.hoja.hidden) {
      return;
    }
    refs.hoja.hidden = true;
    document.body.classList.remove("con-hoja");
  }

  function alternarAyuda() {
    if (refs.ayuda) {
      refs.ayuda.hidden = !refs.ayuda.hidden;
    }
  }

  /* ------------------------------------------------------------- arranque */
  function asignarRefs() {
    refs.aviso = buscarUno("[data-panel-aviso]");
    refs.ingreso = buscarUno("[data-panel-ingreso]");
    refs.contenido = buscarUno("[data-panel-contenido]");
    refs.acciones = buscarUno("[data-panel-acciones]");
    refs.nav = buscarUno("[data-panel-navegacion]");
    refs.formClave = buscarUno("[data-panel-form-clave]");
    refs.clave = buscarUno("#panel-clave");
    refs.botonEntrar = buscarUno("[data-panel-entrar]");
    refs.ayuda = buscarUno("[data-panel-ayuda]");
    refs.hoja = buscarUno("[data-panel-hoja]");
    refs.siguiente = buscarUno("[data-panel-proximo]");
    refs.version = buscarUno("[data-panel-version]");
    refs.tira = buscarUno("[data-panel-tira]");
    refs.kicker = buscarUno("[data-panel-kicker]");
    refs.titulo = buscarUno("[data-panel-titulo-dia]");
    refs.resumen = buscarUno("[data-panel-resumen-dia]");
    refs.fecha = buscarUno("[data-panel-fecha]");
    refs.turnos = buscarUno("[data-panel-turnos]");
    refs.libres = buscarUno("[data-panel-libres]");
    refs.proximos = buscarUno("[data-panel-proximos]");
    refs.resultados = buscarUno("[data-panel-resultados]");
    refs.formAnotar = buscarUno("[data-panel-form-anotar]");
    refs.servicioAnotar = buscarUno("[data-anotar-servicio]");
    refs.fechaAnotar = buscarUno("[data-anotar-fecha]");
    refs.horaAnotar = buscarUno("[data-anotar-hora]");
    refs.nombreAnotar = buscarUno("[data-anotar-nombre]");
    refs.telefonoAnotar = buscarUno("[data-anotar-telefono]");
    refs.vehiculoAnotar = buscarUno("[data-anotar-vehiculo]");
    refs.comentarioAnotar = buscarUno("[data-anotar-comentario]");
    refs.enviarAnotar = buscarUno("[data-anotar-enviar]");
    refs.formBuscar = buscarUno("[data-panel-form-buscar]");
    refs.textoBuscar = buscarUno("[data-panel-texto-buscar]");
  }

  function entrarConClave(evento) {
    evento.preventDefault();
    var clave = refs.clave.value.trim();
    if (clave.length < 6) {
      aviso("Escribí la clave del panel.", "error");
      return;
    }
    // No se entra "a ciegas": el panel se abre recién cuando el backend
    // confirma la clave y devuelve la agenda.
    estado.claveAdmin = clave;
    if (refs.botonEntrar) {
      refs.botonEntrar.disabled = true;
    }
    aviso("Verificando la clave…", "cargando");
    cargarTablero(null, true).then(function (ok) {
      if (refs.botonEntrar) {
        refs.botonEntrar.disabled = false;
      }
      if (!ok) {
        return;
      }
      guardarClave(clave);
      entrar();
    });
  }

  function conectar() {
    refs.formClave.addEventListener("submit", entrarConClave);

    buscarTodos("[data-panel-vista]").forEach(function (boton) {
      boton.addEventListener("click", function () {
        mostrarVista(boton.getAttribute("data-panel-vista"));
      });
    });

    refs.tira.addEventListener("click", function (evento) {
      var boton = evento.target.closest ? evento.target.closest("[data-fecha-dia]") : null;
      if (boton) {
        irAlDia(boton.getAttribute("data-fecha-dia"));
      }
    });

    refs.proximos.addEventListener("click", function (evento) {
      var boton = evento.target.closest ? evento.target.closest("[data-ir-a]") : null;
      if (boton) {
        irAlDia(boton.getAttribute("data-ir-a"));
      }
    });

    refs.fecha.addEventListener("change", function () {
      if (refs.fecha.value) {
        irAlDia(refs.fecha.value);
      }
    });

    buscarUno("[data-dia-anterior]").addEventListener("click", function () {
      moverDia(-1);
    });
    buscarUno("[data-dia-siguiente]").addEventListener("click", function () {
      moverDia(1);
    });

    refs.contenido.addEventListener("click", function (evento) {
      var boton = evento.target.closest ? evento.target.closest("[data-listo-codigo]") : null;
      if (!boton) {
        return;
      }
      marcarListo(boton.getAttribute("data-listo-codigo"),
        boton.getAttribute("data-listo-valor") === "true");
    });

    refs.formAnotar.addEventListener("submit", anotar);
    refs.formBuscar.addEventListener("submit", buscar);

    buscarTodos("[data-abrir-anotar]").forEach(function (elemento) {
      elemento.addEventListener("click", abrirHoja);
    });
    buscarTodos("[data-cerrar-anotar]").forEach(function (elemento) {
      elemento.addEventListener("click", cerrarHoja);
    });

    var ayuda = buscarUno("[data-abrir-ayuda]");
    if (ayuda) {
      ayuda.addEventListener("click", alternarAyuda);
    }

    buscarUno("[data-panel-refrescar]").addEventListener("click", function () {
      cargarTablero(estado.tablero ? estado.tablero.desde : null);
    });
    buscarUno("[data-panel-imprimir]").addEventListener("click", function () {
      window.print();
    });
    buscarUno("[data-panel-salir]").addEventListener("click", function () {
      salir("");
    });

    document.addEventListener("keydown", function (evento) {
      if (evento.key === "Escape" || evento.keyCode === 27) {
        cerrarHoja();
      }
    });
  }

  function iniciar() {
    asignarRefs();
    conectar();
    mostrarVista("dia");
    // La agenda se refresca sola cada 5 minutos: sirve para el celular o la
    // tablet que queda en el taller.
    window.setInterval(function () {
      if (!document.hidden && estado.tablero) {
        cargarTablero(estado.tablero.desde, true);
      }
    }, AJUSTES.REFRESCO_MS);

    var guardada = leerClave() || AJUSTES.CLAVE_PRUEBA || "";
    if (!guardada) {
      refs.ingreso.hidden = false;
      refs.clave.focus();
      return;
    }
    estado.claveAdmin = guardada;
    aviso("Cargando la agenda…", "cargando");
    cargarTablero(null, true).then(function (ok) {
      if (ok) {
        entrar();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else {
    iniciar();
  }
})();







