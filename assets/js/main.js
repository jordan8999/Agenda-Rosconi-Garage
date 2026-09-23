/* ==========================================================================
   Rosconi Garage — comportamiento general
   Mejora progresiva: si este archivo no carga, el sitio sigue siendo usable.
   ========================================================================== */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ------------------------------------------------------------------ Header */
  function initHeader() {
    var header = document.querySelector("[data-header]");
    if (!header) {
      return;
    }
    var onScroll = function () {
      header.setAttribute("data-scrolled", window.scrollY > 12 ? "true" : "false");
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* ------------------------------------------------------- Menu de navegacion */
  function initNav() {
    var toggle = document.querySelector("[data-nav-toggle]");
    var nav = document.querySelector("[data-nav]");
    if (!toggle || !nav) {
      return;
    }

    var cerrar = function () {
      nav.setAttribute("data-open", "false");
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", "Abrir menu de navegacion");
      document.body.style.removeProperty("overflow");
    };

    var abrir = function () {
      nav.setAttribute("data-open", "true");
      toggle.setAttribute("aria-expanded", "true");
      toggle.setAttribute("aria-label", "Cerrar menu de navegacion");
      document.body.style.overflow = "hidden";
    };

    toggle.addEventListener("click", function () {
      if (nav.getAttribute("data-open") === "true") {
        cerrar();
      } else {
        abrir();
      }
    });

    nav.addEventListener("click", function (event) {
      if (event.target.closest("a")) {
        cerrar();
      }
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && nav.getAttribute("data-open") === "true") {
        cerrar();
        toggle.focus();
      }
    });

    window.addEventListener("resize", function () {
      if (window.innerWidth >= 960) {
        cerrar();
      }
    });
  }

  /* ------------------------------------------- Enlace activo segun el scroll */
  function initActiveLink() {
    var enlaces = Array.prototype.slice.call(document.querySelectorAll("[data-nav] a[href^='#']"));
    var secciones = enlaces
      .map(function (enlace) {
        return document.querySelector(enlace.getAttribute("href"));
      })
      .filter(Boolean);

    if (!secciones.length || !("IntersectionObserver" in window)) {
      return;
    }

    var observer = new IntersectionObserver(
      function (entradas) {
        entradas.forEach(function (entrada) {
          if (!entrada.isIntersecting) {
            return;
          }
          enlaces.forEach(function (enlace) {
            var activo = enlace.getAttribute("href") === "#" + entrada.target.id;
            if (activo) {
              enlace.setAttribute("aria-current", "true");
            } else {
              enlace.removeAttribute("aria-current");
            }
          });
        });
      },
      { rootMargin: "-45% 0px -50% 0px" }
    );

    secciones.forEach(function (seccion) {
      observer.observe(seccion);
    });
  }

  /* ------------------------------------------------- Aparicion de secciones */
  function initReveal() {
    var bloque = document.querySelectorAll(".reveal");
    if (!bloque.length || !("IntersectionObserver" in window) || reduceMotion) {
      return;
    }
    var observer = new IntersectionObserver(
      function (entradas, obs) {
        entradas.forEach(function (entrada) {
          if (entrada.isIntersecting) {
            entrada.target.classList.add("is-visible");
            obs.unobserve(entrada.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px" }
    );
    Array.prototype.forEach.call(bloque, function (elemento) {
      observer.observe(elemento);
    });
  }

  /* ------------------------------------------------------------- Lightbox */
  function initLightbox() {
    var dialog = document.getElementById("lightbox");
    var disparadores = document.querySelectorAll("[data-full]");
    if (!dialog || !disparadores.length || typeof dialog.showModal !== "function") {
      return;
    }

    var imagen = dialog.querySelector("img");
    var pie = dialog.querySelector("[data-lightbox-pie]");
    var cerrarBtn = dialog.querySelector("[data-lightbox-cerrar]");
    var ultimoFoco = null;

    var cerrar = function () {
      dialog.close();
    };

    Array.prototype.forEach.call(disparadores, function (boton) {
      boton.addEventListener("click", function () {
        ultimoFoco = boton;
        imagen.src = boton.getAttribute("data-full");
        imagen.alt = boton.getAttribute("data-alt") || "";
        pie.textContent = boton.getAttribute("data-alt") || "";
        dialog.showModal();
        cerrarBtn.focus();
      });
    });

    cerrarBtn.addEventListener("click", cerrar);
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) {
        cerrar();
      }
    });
    dialog.addEventListener("close", function () {
      if (ultimoFoco) {
        ultimoFoco.focus();
      }
    });
  }

  /* --------------------------------------------------------------- Footer */
  function initAnio() {
    var nodos = document.querySelectorAll("[data-anio]");
    var anio = String(new Date().getFullYear());
    Array.prototype.forEach.call(nodos, function (nodo) {
      nodo.textContent = anio;
    });
  }

  function init() {
    initHeader();
    initNav();
    initActiveLink();
    initReveal();
    initLightbox();
    initAnio();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
