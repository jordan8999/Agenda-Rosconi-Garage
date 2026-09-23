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
    global CLAVE
    parser = argparse.ArgumentParser(description="Pruebas del contrato de turnos.")
    parser.add_argument("--url", default="http://127.0.0.1:8130")
    parser.add_argument("--clave", default=CLAVE, help="Clave de instalación del backend.")
    args = parser.parse_args()
    url = args.url.rstrip("/")
    CLAVE = args.clave
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

    fallas = [descripcion for ok, descripcion in RESULTADOS if not ok]
    print(f"\nRESULTADO: {len(RESULTADOS) - len(fallas)}/{len(RESULTADOS)} pruebas OK")
    for falla in fallas:
        print(f"  pendiente: {falla}")
    return 0 if not fallas else 1


if __name__ == "__main__":
    raise SystemExit(main())
