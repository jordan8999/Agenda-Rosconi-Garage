/* ==========================================================================
   Rosconi Garage — reserva online con Cal.com
   Mejora progresiva: los botones ya son enlaces reales a Cal.com.
   Este script solo los convierte en calendario incrustado (inline) al hacer
   clic, cargando el embed de Cal.com en ese momento (no bloquea la carga
   inicial de la pagina).

   IMPORTANTE (mantenimiento): los "slug" de abajo deben coincidir con los
   tipos de evento creados en la cuenta de Cal.com del taller.
   --------------------------------------------------------------------------
   Cuenta: https://cal.com/rosconigarage
   Tipo de evento 1: Turno en elevador         -> slug: turno-elevador
   Tipo de evento 2: Turno de service rapido   -> slug: turno-service-rapido
   ========================================================================== */
(function () {
  "use strict";

  var CONFIG = {
    usuario: "rosconigarage",
    origenCal: "https://cal.com",
    origenEmbed: "https://app.cal.com/embed/embed.js",
    tema: "dark",
    colorMarca: "#ff6b00",
    layout: "month_view",
    // Tiempo maximo de espera del script del embed antes de abrir Cal.com
    timeoutMs: 6000
  };

  var promesaEmbed = null;
  var embedsCreados = {};

  function cargarScriptEmbed() {
    if (promesaEmbed) {
      return promesaEmbed;
    }
    promesaEmbed = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      var terminado = false;
      var temporizador = window.setTimeout(function () {
        if (!terminado) {
          terminado = true;
          reject(new Error("timeout"));
        }
      }, CONFIG.timeoutMs);

      script.src = CONFIG.origenEmbed;
      script.async = true;
      script.onload = function () {
        if (terminado) {
          return;
        }
        terminado = true;
        window.clearTimeout(temporizador);
        resolve();
      };
      script.onerror = function () {
        if (terminado) {
          return;
        }
        terminado = true;
        window.clearTimeout(temporizador);
        reject(new Error("error de red"));
      };
      document.head.appendChild(script);
    });
    return promesaEmbed;
  }

  function inicializarCal() {
    if (typeof window.Cal !== "function") {
      return;
    }
    window.Cal("init", { origin: CONFIG.origenCal });
    window.Cal("ui", {
      theme: CONFIG.tema,
      hideEventTypeDetails: false,
      layout: CONFIG.layout,
      styles: {
        branding: { brandColor: CONFIG.colorMarca }
      }
    });
  }

  function montarEmbed(contenedor, calLink) {
    if (embedsCreados[contenedor.id]) {
      return;
    }
    embedsCreados[contenedor.id] = true;
    window.Cal("inline", {
      elementOrSelector: "#" + contenedor.id,
      calLink: calLink,
      config: { theme: CONFIG.tema, layout: CONFIG.layout }
    });
    window.Cal("ui", {
      theme: CONFIG.tema,
      layout: CONFIG.layout,
      styles: { branding: { brandColor: CONFIG.colorMarca } }
    });
  }

  function conectarBoton(boton) {
    boton.addEventListener("click", function (evento) {
      var calLink = boton.getAttribute("data-cal-link");
      var selector = boton.getAttribute("data-cal-embed");
      var contenedor = selector ? document.querySelector(selector) : null;

      // Sin contenedor o sin JS disponible: se deja el enlace normal a Cal.com.
      if (!calLink || !contenedor) {
        return;
      }

      evento.preventDefault();
      contenedor.hidden = false;
      boton.setAttribute("aria-expanded", "true");

      var aviso = contenedor.querySelector("[data-cal-estado]");
      if (aviso) {
        aviso.textContent = "Cargando el calendario de turnos...";
      }

      contenedor.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "start"
      });

      cargarScriptEmbed()
        .then(function () {
          inicializarCal();
          if (typeof window.Cal !== "function") {
            throw new Error("embed no disponible");
          }
          montarEmbed(contenedor, calLink);
          if (aviso) {
            aviso.textContent = "";
          }
        })
        .catch(function () {
          // Si el embed no carga, se abre Cal.com en una pestana nueva.
          contenedor.hidden = true;
          boton.setAttribute("aria-expanded", "false");
          if (aviso) {
            aviso.textContent = "";
          }
          window.open(boton.href, "_blank", "noopener");
        });
    });
  }

  function init() {
    var botones = document.querySelectorAll("[data-cal-link]");
    Array.prototype.forEach.call(botones, conectarBoton);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
