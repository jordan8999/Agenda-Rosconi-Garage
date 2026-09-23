#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pruebas del contrato de turnos (mock local o Apps Script desplegado).

    python tools/mock-turnos.py                  # en otra ventana
    python tools/pruebas-turnos.py               # contra http://127.0.0.1:8130
    python tools/pruebas-turnos.py --url https://script.google.com/macros/s/XXX/exec \
        --clave TU_CLAVE                         # contra el backend desplegado

Verifica reglas de negocio: cupos simultaneos, anticipacion de 24 h, horario de
atencion, validaciones, reserva, consulta y cancelacion.
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta

CLAVE = "rosconi-artigas-turnos-2026-k72b"
CLAVE_ADMIN = "rg-panel-j72k9x4m-d7qm"
SERVICIO = "Service completo y lubricentro"
RESULTADOS: list[tuple[bool, str]] = []


# Apps Script contesta con un redirect a script.googleusercontent.com que
# necesita las cookies de la primera respuesta: sin ellas devuelve 404 de
# forma intermitente. El opener las conserva (el mock local no las usa).
ABRIDOR = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
)


def pedir(url: str, ruta: str, cuerpo: dict | None = None) -> dict:
    # El mock atiende en la raíz (http://127.0.0.1:8130/), pero Apps Script
    # sirve en /exec y responde 404 si se agrega una barra antes de los
    # parámetros. Se normaliza acá para que la misma suite sirva en los dos.
    base = url.rstrip("/")
    if base.endswith("/exec") and ruta.startswith("/"):
        ruta = ruta[1:]
    datos = json.dumps(cuerpo).encode("utf-8") if cuerpo is not None else None
    peticion = urllib.request.Request(
        base + ruta,
        data=datos,
        headers={
            "Content-Type": "text/plain;charset=utf-8",
            "User-Agent": "RosconiGarage-pruebas-turnos",
        },
        method="POST" if datos else "GET",
    )
    # Solo se reintentan las lecturas: reintentar una reserva podría duplicarla.
    intentos = 1 if datos else 3
    for intento in range(1, intentos + 1):
        try:
            with ABRIDOR.open(peticion, timeout=45) as respuesta:
                return json.loads(respuesta.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if error.code != 404 or intento == intentos:
                raise
            time.sleep(1.5)
    raise RuntimeError("El backend no respondio.")


def control(url: str, accion: str, valor: str = "") -> dict:
    """Atajos del mock local para revisar lo que ve el taller (no existen en
    Apps Script: ahi la ficha se mira en Google Calendar)."""
    peticion = urllib.request.Request(
        url.rstrip("/") + "/",
        data=json.dumps({"accion": accion, "valor": valor}).encode("utf-8"),
        headers={"Content-Type": "text/plain;charset=utf-8"},
        method="PUT",
    )
    with ABRIDOR.open(peticion, timeout=30) as respuesta:
        return json.loads(respuesta.read().decode("utf-8"))


def panel(url: str, accion: str, extra: dict | None = None,
          clave_admin: str | None = None) -> dict:
    """Peticion al panel del taller (acciones que exigen clave de administracion)."""
    cuerpo = {"accion": accion,
              "claveAdmin": CLAVE_ADMIN if clave_admin is None else clave_admin}
    if extra:
        cuerpo.update(extra)
    return pedir(url, "/", cuerpo)


def verificar(condicion: bool, descripcion: str) -> None:
    RESULTADOS.append((bool(condicion), descripcion))
    print(f"  {'OK   ' if condicion else 'FALLA'}  {descripcion}")


def agenda_de(url: str, servicio: str = SERVICIO) -> dict:
    return pedir(url, f"/?action=agenda&clave={CLAVE}&servicio={urllib.parse.quote(servicio)}")


def datos_reserva(**extra) -> dict:
    base = {
        "accion": "crear",
        "clave": CLAVE,
        "nombre": "Cliente de prueba",
        "telefono": "099123456",
        "vehiculo": "VW Gol 2015",
        "servicio": SERVICIO,
        "email": "",
        "comentario": "",
        "empresa": "",
    }
    base.update(extra)
    return base


def primer_libre(agenda: dict) -> dict | None:
    for dia in agenda["dias"]:
        for turno in dia["turnos"]:
            if turno["estado"] == "libre":
                return {"fecha": dia["fecha"], "hora": turno["hora"]}
    return None


def turno_en(agenda: dict, fecha: str, hora: str) -> dict | None:
    for dia in agenda["dias"]:
        if dia["fecha"] == fecha:
            for turno in dia["turnos"]:
                if turno["hora"] == hora:
                    return turno
    return None


def main() -> int:
    global CLAVE, CLAVE_ADMIN
    parser = argparse.ArgumentParser(description="Pruebas del contrato de turnos.")
    parser.add_argument("--url", default="http://127.0.0.1:8130")
    parser.add_argument("--clave", default=CLAVE, help="Clave de instalación del backend.")
    parser.add_argument("--clave-admin", dest="clave_admin", default=CLAVE_ADMIN,
                        help="Clave del panel (la genera `instalar` en Apps Script).")
    args = parser.parse_args()
    url = args.url.rstrip("/")
    CLAVE = args.clave
    CLAVE_ADMIN = args.clave_admin
    es_local = "127.0.0.1" in url or "localhost" in url
    print(f"\n=== Pruebas de turnos contra {url} ===\n")

    print("1. Autenticacion y lectura de agenda")
    agenda = agenda_de(url)
    verificar(agenda.get("ok") is True, "la agenda responde ok")
    verificar(len(agenda.get("dias", [])) >= 7, "devuelve al menos 7 dias")
    verificar(agenda.get("duracionMinutos") == 60, "el service completo dura 60 min")
    verificar(bool(agenda.get("servicios")), "devuelve la lista de servicios")
    verificar(pedir(url, "/?action=agenda&clave=incorrecta").get("ok") is False,
              "rechaza una clave incorrecta")
    primer_dia_abierto = next((d for d in agenda["dias"] if d["turnos"]), None)
    verificar(primer_dia_abierto is not None and date.fromisoformat(primer_dia_abierto["fecha"]).weekday() < 5,
              "solo ofrece dias de lunes a viernes")
    verificar(all(t["hora"] >= "08:00" and t["hora"] <= "17:00" for t in primer_dia_abierto["turnos"]),
              "los turnos caen dentro del horario de atencion")

    print("\n2. Anticipacion, feriados y rango")
    pronto = pedir(url, "/", datos_reserva(fecha=datetime.now().strftime("%Y-%m-%d"), hora="09:00"))
    verificar(pronto.get("error") in ("muy_pronto", "fuera_de_horario"),
              "no permite reservar con menos de 24 h")
    lejano = (datetime.now() + timedelta(days=90)).strftime("%Y-%m-%d")
    verificar(pedir(url, "/", datos_reserva(fecha=lejano, hora="09:00")).get("error") == "fuera_de_rango",
              "rechaza fechas a mas de 30 dias")
    sabado = datetime.now() + timedelta(days=1)
    while sabado.weekday() != 5:
        sabado += timedelta(days=1)
    verificar(pedir(url, "/", datos_reserva(fecha=sabado.strftime("%Y-%m-%d"), hora="09:00")).get("error")
              == "fuera_de_horario", "rechaza sabados")
    temprano = datetime.now() + timedelta(days=2)
    while temprano.weekday() >= 5:
        temprano += timedelta(days=1)
    verificar(pedir(url, "/", datos_reserva(fecha=temprano.strftime("%Y-%m-%d"), hora="07:00")).get("error")
              == "fuera_de_horario", "rechaza horarios antes de las 08:00")
    verificar(pedir(url, "/", datos_reserva(fecha=temprano.strftime("%Y-%m-%d"), hora="17:30")).get("error")
              == "fuera_de_horario", "rechaza un service que no entraría antes del cierre")

    print("\n3. Validaciones de datos")
    libre = primer_libre(agenda)
    verificar(libre is not None, "hay al menos un turno libre para probar")
    if not libre:
        print("\nNo hay turnos libres. Reiniciá el mock y volvé a intentar.")
        return 1
    fecha, hora = libre["fecha"], libre["hora"]

    verificar(pedir(url, "/", datos_reserva(fecha=fecha, hora=hora, nombre="")).get("error")
              == "nombre_invalido", "exige nombre")
    verificar(pedir(url, "/", datos_reserva(fecha=fecha, hora=hora, vehiculo="")).get("error")
              == "vehiculo_invalido", "exige vehiculo")
    verificar(pedir(url, "/", datos_reserva(fecha=fecha, hora=hora, telefono="123")).get("error")
              == "telefono_invalido", "exige telefono valido")
    verificar(pedir(url, "/", datos_reserva(fecha=fecha, hora=hora, servicio="Inexistente")).get("error")
              == "servicio_invalido", "rechaza servicios inexistentes")
    verificar(pedir(url, "/", datos_reserva(fecha=fecha, hora=hora, empresa="spam")).get("error")
              == "no_procesado", "ignora el envio del campo trampa")

    print("\n4. Cupos: 1 elevador + 1 piso de desborde")
    primera = pedir(url, "/", datos_reserva(fecha=fecha, hora=hora, nombre="Ana Perez"))
    verificar(primera.get("ok") is True, "primera reserva confirmada")
    verificar(primera.get("estado") == "libre", "la primera queda como libre")
    codigo = primera.get("codigo", "")
    verificar(codigo.startswith("RG-") and len(codigo) == 11, "entrega un codigo RG-XXXXXXXX")
    verificar(primera.get("cuposLibres") == 1, "informa 1 cupo libre restante")

    segunda = pedir(url, "/", datos_reserva(fecha=fecha, hora=hora, nombre="Bruno Diaz",
                                           telefono="099222333"))
    verificar(segunda.get("ok") is True, "segunda reserva confirmada (desborde)")
    verificar(segunda.get("estado") == "ultimo", "la segunda queda como ultimo lugar")
    verificar(segunda.get("cuposLibres") == 0, "ya no quedan cupos")

    # Reintento del mismo cliente: si se corta la conexion justo al confirmar
    # (o toca dos veces el boton), el segundo envio debe devolver el turno que
    # ya existe, sin consumir el segundo lugar ni duplicar el evento.
    repetida = pedir(url, "/", datos_reserva(fecha=fecha, hora=hora, nombre="Ana Perez"))
    verificar(repetida.get("ok") is True, "un reintento del mismo cliente se acepta")
    verificar(repetida.get("repetido") is True, "el backend avisa que el turno ya existia")
    verificar(repetida.get("codigo") == codigo, "el reintento devuelve el mismo codigo")

    tercera = pedir(url, "/", datos_reserva(fecha=fecha, hora=hora, nombre="Carla Sosa",
                                           telefono="099444555"))
    verificar(tercera.get("error") == "sin_cupo", "la tercera se rechaza por falta de cupo")

    verificar(turno_en(agenda_de(url), fecha, hora) is None,
              "el horario lleno ya no se ofrece en la agenda")

    print("\n5. Consulta y cancelacion")
    consulta = pedir(url, "/", {"accion": "consultar", "clave": CLAVE, "codigo": codigo})
    verificar(consulta.get("ok") is True, "el cliente puede consultar su turno")
    verificar(consulta.get("fecha") == fecha, "la fecha consultada coincide")
    verificar(pedir(url, "/", {"accion": "consultar", "clave": CLAVE, "codigo": "RG-XXXXXXXX"}).get("error")
              == "no_encontrado", "rechaza codigos inexistentes")

    cancelacion = pedir(url, "/", {"accion": "cancelar", "clave": CLAVE, "codigo": codigo})
    verificar(cancelacion.get("ok") is True, "se puede cancelar con el codigo")
    vuelto = turno_en(agenda_de(url), fecha, hora)
    verificar(vuelto is not None and vuelto["estado"] == "ultimo",
              "al cancelar, el horario vuelve como ultimo lugar")

    print("\n6. Limpieza (la suite no deja turnos de prueba)")
    restante = segunda.get("codigo", "")
    verificar(bool(restante), "la segunda reserva tambien entrego un codigo")
    cierre = pedir(url, "/", {"accion": "cancelar", "clave": CLAVE, "codigo": restante})
    verificar(cierre.get("ok") is True, "se cancela la segunda reserva")
    liberado = turno_en(agenda_de(url), fecha, hora)
    verificar(liberado is not None and liberado["estado"] == "libre",
              "con los dos cupos libres el horario vuelve a ofrecerse")
    verificar(agenda_de(url, "Servicio completo y lubricentro").get("ok") is True,
              "la agenda sigue respondiendo despues de la limpieza")

    print("\n7. Limites antiabuso y liberacion al cancelar")
    libres = []
    for dia in agenda_de(url)["dias"]:
        for turno in dia["turnos"]:
            if turno["estado"] == "libre":
                libres.append((dia["fecha"], turno["hora"]))
        if len(libres) >= 3:
            break
    verificar(len(libres) >= 3, "hay al menos 3 horarios libres para probar el limite")
    if len(libres) < 3:
        return 1

    telefono = "099555111"
    propios = []
    for numero, (dia, hora) in enumerate(libres[:2], start=1):
        reserva = pedir(url, "/", datos_reserva(fecha=dia, hora=hora, nombre="Limite Prueba",
                                                telefono=telefono))
        verificar(reserva.get("ok") is True, f"turno {numero} del mismo telefono se acepta")
        propios.append(reserva.get("codigo", ""))

    frenado = pedir(url, "/", datos_reserva(fecha=libres[2][0], hora=libres[2][1],
                                           nombre="Limite Prueba", telefono=telefono))
    verificar(frenado.get("error") == "limite_alcanzado",
              "el tercer turno del mismo telefono se frena")

    verificar(pedir(url, "/", {"accion": "cancelar", "clave": CLAVE,
                               "codigo": propios[0]}).get("ok") is True,
              "se cancela uno de los dos turnos")
    liberado = pedir(url, "/", datos_reserva(fecha=libres[2][0], hora=libres[2][1],
                                             nombre="Limite Prueba", telefono=telefono))
    verificar(liberado.get("ok") is True, "al cancelar se libera el cupo del telefono")

    for pendiente in propios[1:] + [liberado.get("codigo", "")]:
        pedir(url, "/", {"accion": "cancelar", "clave": CLAVE, "codigo": pendiente})

    print("\n8. Trabajos en los que el cliente deja el auto")
    servicio_deja = "Mecánica integral"
    agenda_deja = agenda_de(url, servicio_deja)
    verificar(agenda_deja.get("modalidad") == "dejar",
              "la agenda avisa que el auto se deja en el taller")
    dias_deja = [d for d in agenda_deja["dias"] if d["turnos"]]
    verificar(len(dias_deja) > 0, "un trabajo de dejar el auto tiene dias disponibles")
    horas_deja = sorted({t["hora"] for d in dias_deja for t in d["turnos"]})
    verificar(horas_deja == ["08:00", "14:00"],
              f"solo ofrece horas de entrega al comienzo de cada franja ({horas_deja})")

    fecha_entrega = dias_deja[0]["fecha"]
    hora_entrega = dias_deja[0]["turnos"][0]["hora"]
    entrega = pedir(url, "/", datos_reserva(fecha=fecha_entrega, hora=hora_entrega,
                                            servicio=servicio_deja, nombre="Deja Prueba",
                                            telefono="099666222"))
    verificar(entrega.get("ok") is True, "se registra la entrega del auto")
    verificar(entrega.get("modalidad") == "dejar",
              "la reserva queda marcada como dejar el auto")
    verificar(entrega.get("duracionMinutos") == (600 if hora_entrega == "08:00" else 240),
              "el auto ocupa el lugar hasta el cierre del dia")

    media_manana = pedir(url, "/", datos_reserva(fecha=fecha_entrega, hora="09:00",
                                                 servicio=servicio_deja, nombre="Deja Prueba",
                                                 telefono="099666333"))
    verificar(media_manana.get("error") == "fuera_de_horario",
              "no se puede entregar el auto a las 09:00 (solo al comienzo de la franja)")

    dia_con_entrega = next((d for d in agenda_de(url)["dias"] if d["fecha"] == fecha_entrega), None)
    verificar(dia_con_entrega is not None and dia_con_entrega["turnos"] and
              all(t["cuposLibres"] == 1 for t in dia_con_entrega["turnos"]),
              "ese dia queda un solo lugar para los trabajos por horario")

    verificar(pedir(url, "/", {"accion": "cancelar", "clave": CLAVE,
                               "codigo": entrega.get("codigo", "")}).get("ok") is True,
              "se cancela la entrega del auto")
    dia_devuelto = next((d for d in agenda_de(url)["dias"] if d["fecha"] == fecha_entrega), None)
    verificar(dia_devuelto is not None and dia_devuelto["turnos"] and
              all(t["cuposLibres"] == 2 for t in dia_devuelto["turnos"]),
              "al cancelar, el dia vuelve a tener los dos lugares")

    print("\n9. Ficha del turno y resumen para el taller")
    if not es_local:
        print("  (se omite: la ficha y el resumen se verifican contra el mock local;")
        print("   en el backend real esa informacion se ve en Google Calendar)")
    else:
        libres = []
        for dia in agenda_de(url)["dias"]:
            for turno in dia["turnos"]:
                if turno["estado"] == "libre":
                    libres.append((dia["fecha"], turno["hora"]))
            if len(libres) >= 2:
                break

        dia_corto, hora_corto = libres[0]
        corto = pedir(url, "/", datos_reserva(fecha=dia_corto, hora=hora_corto,
                                              nombre="Ficha Prueba", telefono="099777333",
                                              vehiculo="Fiat Cronos 2021",
                                              email="cliente@ejemplo.com",
                                              comentario="Ruido en la suspension delantera"))
        verificar(corto.get("ok") is True, "se registra el turno del que se revisa la ficha")

        ficha = control(url, "ficha", corto.get("codigo", ""))
        texto_ficha = ficha.get("descripcion", "")
        verificar(ficha.get("ok") is True, "el taller puede abrir la ficha del turno")
        verificar(ficha.get("linea") in ("ELEVADOR", "PISO"),
                  "la ficha indica la linea del taller (" + str(ficha.get("linea")) + ")")
        for dato in ["Código: " + corto.get("codigo", ""),
                     "Servicio: Service completo y lubricentro (60 min)",
                     "Vehículo: Fiat Cronos 2021",
                     "Cliente: Ficha Prueba",
                     "Teléfono: 099777333",
                     "Email: cliente@ejemplo.com",
                     "Comentario: Ruido en la suspension delantera",
                     "Reservado desde la web de Rosconi Garage."]:
            verificar(dato in texto_ficha, "la ficha incluye «" + dato + "»")
        verificar("https://wa.me/59899777333" in texto_ficha,
                  "la ficha trae el WhatsApp del cliente con un clic")
        verificar("tel:+59899777333" in texto_ficha,
                  "la ficha trae el link para llamar al cliente")

        dias_entrega = [d for d in agenda_de(url, "Mecánica integral")["dias"] if d["turnos"]]
        dia_entrega = dias_entrega[0]["fecha"]
        entrega = pedir(url, "/", datos_reserva(fecha=dia_entrega,
                                                hora=dias_entrega[0]["turnos"][0]["hora"],
                                                servicio="Mecánica integral",
                                                nombre="Deja Ficha", telefono="099777444",
                                                vehiculo="Toyota Hilux 2019"))
        verificar(entrega.get("ok") is True, "se registra la entrega para revisar su ficha")
        ficha_entrega = control(url, "ficha", entrega.get("codigo", ""))
        verificar("(deja el auto)" in ficha_entrega.get("descripcion", ""),
                  "la ficha avisa cuando el auto queda en el taller")

        resumen = control(url, "resumen", dia_entrega)
        texto_resumen = resumen.get("resumen", "")
        verificar("Turnos de Rosconi Garage para" in texto_resumen,
                  "el resumen arranca con el dia")
        verificar("Toyota Hilux 2019" in texto_resumen and "Deja Ficha" in texto_resumen,
                  "el resumen lista el auto que se deja, con el cliente")
        verificar("DEJA EL AUTO" in texto_resumen,
                  "el resumen marca los autos que quedan en el taller")
        verificar(("elevador" in texto_resumen.lower()) or ("piso" in texto_resumen.lower()),
                  "el resumen indica en que linea entra cada auto")
        if dia_corto == dia_entrega:
            verificar("Fiat Cronos 2021" in texto_resumen,
                      "el resumen lista tambien el trabajo por horario")

        ayer = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        verificar("no hay turnos agendados" in control(url, "resumen", ayer).get("resumen", ""),
                  "el resumen avisa cuando el dia no tiene turnos")

        limpieza = [pedir(url, "/", {"accion": "cancelar", "clave": CLAVE,
                                     "codigo": pendiente}).get("ok")
                    for pendiente in [corto.get("codigo", ""), entrega.get("codigo", "")]]
        verificar(all(limpieza), "se cancelan los turnos de la prueba de la ficha")

    print("\n10. Panel del taller")
    if not panel(url, "estado").get("version"):
        print("  (se omite: el backend desplegado todavia no tiene el panel)")
    else:
        verificar(panel(url, "panel", {"dias": 3}, "").get("error") == "clave_admin_invalida",
                  "el panel no abre sin clave de administracion")
        verificar(panel(url, "panel", {"dias": 3}, CLAVE).get("error") == "clave_admin_invalida",
                  "la clave publica del sitio NO sirve para el panel")
        verificar(panel(url, "panel", {"dias": 3}, "otra-clave").get("error")
                  == "clave_admin_invalida", "una clave equivocada no abre el panel")

        tablero = panel(url, "panel", {"dias": 14})
        verificar(tablero.get("ok") is True, "el taller abre el tablero con su clave")
        dias_tablero = tablero.get("agenda", [])
        verificar(len(dias_tablero) == 14, "el tablero trae 14 dias de una sola vez")
        verificar(all("turnos" in dia and "libres" in dia for dia in dias_tablero),
                  "cada dia trae sus turnos y sus lugares libres")
        verificar(any(dia["libres"] for dia in dias_tablero),
                  "el tablero muestra los huecos libres del taller")

        estado = panel(url, "estado")
        verificar(bool(estado.get("version")),
                  "el panel informa la version del backend desplegado")
        verificar("anotar" in estado.get("capacidades", []),
                  "el panel informa que puede listar, buscar y anotar turnos")
        verificar("Turnos de Rosconi Garage" in estado.get("resumenHoy", ""),
                  "el estado trae el resumen del dia listo para leer")

        libres_tablero = [(dia["fecha"], turno["hora"])
                          for dia in dias_tablero for turno in dia["libres"]]
        verificar(len(libres_tablero) >= 2, "hay horarios libres para anotar a mano")
        fecha_anotada, hora_anotada = libres_tablero[0]
        anotado = panel(url, "anotar", {
            "fecha": fecha_anotada, "hora": hora_anotada,
            "servicio": "Mecánica general",
            "nombre": "Cliente por teléfono", "telefono": "099123456",
            "vehiculo": "Citroen C3 2017", "email": "",
            "comentario": "Llamó por teléfono, no usa la web", "empresa": "",
        })
        verificar(anotado.get("ok") is True, "el taller puede anotar un turno a mano")
        if not anotado.get("ok"):
            print("   No se pudo anotar: " + str(anotado.get("mensaje")))
        codigo_anotado = anotado.get("codigo", "")

        segundo = panel(url, "anotar", {
            "fecha": libres_tablero[1][0], "hora": libres_tablero[1][1],
            "servicio": "Service completo y lubricentro",
            "nombre": "Cliente por teléfono", "telefono": "099123456",
            "vehiculo": "Citroen C3 2017", "empresa": "",
        })
        verificar(segundo.get("ok") is True,
                  "el taller anota sin topar con el limite antiabuso de la web")

        dia_del_anotado = panel(url, "panel", {"desde": fecha_anotada, "dias": 1})
        turnos_dia = dia_del_anotado.get("agenda", [{}])[0].get("turnos", [])
        nuestro = next((turno for turno in turnos_dia
                        if turno.get("codigo") == codigo_anotado), None)
        verificar(nuestro is not None, "el turno anotado aparece en el tablero de ese dia")
        if nuestro:
            verificar(nuestro.get("cliente") == "Cliente por teléfono",
                      "el tablero muestra el cliente")
            verificar(nuestro.get("telefono") == "099123456",
                      "el tablero muestra el telefono para llamarlo")
            verificar(nuestro.get("whatsapp") == "59899123456",
                      "el tablero arma el link de WhatsApp del cliente")
            verificar(nuestro.get("linea") in ("elevador", "piso"),
                      "el tablero dice en que linea va el auto")
            verificar(nuestro.get("origen") == "panel",
                      "el tablero distingue los turnos anotados a mano")
            verificar(nuestro.get("comentario") == "Llamó por teléfono, no usa la web",
                      "el tablero muestra el comentario del cliente")

        busqueda = panel(url, "buscar", {"texto": "citroen"})
        verificar(busqueda.get("ok") is True, "el panel busca por texto")
        verificar(any(turno.get("codigo") == codigo_anotado
                      for turno in busqueda.get("encontrados", [])),
                  "la busqueda encuentra al cliente por el vehiculo")
        verificar(bool(panel(url, "buscar", {"texto": "099123456"}).get("encontrados")),
                  "la busqueda encuentra por telefono")
        verificar(bool(panel(url, "buscar", {"texto": codigo_anotado}).get("encontrados")),
                  "la busqueda encuentra por codigo")
        verificar(panel(url, "buscar", {"texto": "ab"}).get("encontrados") == [],
                  "la busqueda pide al menos 3 letras")

        marcado = panel(url, "listo", {"codigo": codigo_anotado})
        verificar(marcado.get("ok") is True and marcado.get("listo") is True,
                  "el taller marca un turno como listo")
        tras_marcar = panel(url, "panel", {"desde": fecha_anotada, "dias": 1})
        turno_marcado = next((turno for turno in
                              tras_marcar.get("agenda", [{}])[0].get("turnos", [])
                              if turno.get("codigo") == codigo_anotado), None)
        verificar(turno_marcado is not None and turno_marcado.get("listo") is True,
                  "el tablero muestra el turno marcado como listo")
        desmarcado = panel(url, "listo", {"codigo": codigo_anotado, "listo": False})
        verificar(desmarcado.get("ok") is True and desmarcado.get("listo") is False,
                  "el taller puede volver el turno a pendiente")

        limpieza_panel = [pedir(url, "/", {"accion": "cancelar", "clave": CLAVE,
                                           "codigo": turno.get("codigo", "")}).get("ok")
                          for turno in [anotado, segundo]]
        verificar(all(limpieza_panel), "se cancelan los turnos anotados a mano")

    print("\n11. Estructura del backend real (para que no se repita un error de orden)")

    import pathlib as _pathlib

    raiz = _pathlib.Path(__file__).resolve().parent.parent
    codigo_real = (raiz / "tools" / "appsscript" / "Code.gs").read_text(encoding="utf-8")
    backend_falso = (raiz / "tools" / "mock-turnos.py").read_text(encoding="utf-8")

    def entre(texto: str, inicio: str, fin: str) -> str:
        desde = texto.find(inicio)
        return texto[desde:desde + fin] if desde > -1 else ""

    do_post_real = entre(codigo_real, "function doPost(e) {", 1800)
    verificar("ACCIONES_ADMIN.indexOf(accion)" in do_post_real,
              "el backend real atiende las acciones del panel en doPost")
    posicion_panel = do_post_real.find("ACCIONES_ADMIN.indexOf(accion)")
    posicion_clave = do_post_real.find("exigirClave_(cuerpo.clave)")
    verificar(posicion_clave > posicion_panel,
              "el panel se atiende ANTES de exigir la clave publica (bug que rompia el panel)")
    verificar("clave_admin_invalida" in codigo_real,
              "el backend real responde clave_admin_invalida cuando la clave del panel es mala")

    import re as _re

    acciones_reales = set(_re.findall(r"""["']([a-z]+)["']""",
                                     entre(codigo_real, "var ACCIONES_ADMIN = [", 200)))
    acciones_falsas = set(_re.findall(r"""["']([a-z]+)["']""",
                                     entre(backend_falso, "ACCIONES_ADMIN = [", 200)))
    for nombre_accion in ["panel", "buscar", "anotar", "listo", "estado"]:
        verificar(nombre_accion in acciones_reales,
                  "el backend real acepta la accion de panel '" + nombre_accion + "'")
    verificar(acciones_reales == acciones_falsas and acciones_reales,
              "el mock y el backend real manejan las mismas acciones de panel")

    do_post_falso = entre(backend_falso, "def do_POST(self)", 900)
    verificar(do_post_falso.find("ACCIONES_ADMIN") < do_post_falso.find('CONFIG["clave"]'),
              "el mock tambien atiende el panel antes de la clave publica")

    fallas = [descripcion for ok, descripcion in RESULTADOS if not ok]
    print(f"\nRESULTADO: {len(RESULTADOS) - len(fallas)}/{len(RESULTADOS)} pruebas OK")
    for falla in fallas:
        print(f"  pendiente: {falla}")
    return 0 if not fallas else 1


if __name__ == "__main__":
    raise SystemExit(main())
