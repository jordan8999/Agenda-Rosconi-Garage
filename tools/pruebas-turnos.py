#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pruebas del contrato de turnos (mock local o Apps Script desplegado).

    python tools/mock-turnos.py                  # en otra ventana
    python tools/pruebas-turnos.py               # contra http://127.0.0.1:8130
    python tools/pruebas-turnos.py --url https://script.google.com/macros/s/XXX/exec

Verifica reglas de negocio: cupos simultaneos, anticipacion de 24 h, horario de
atencion, validaciones, reserva, consulta y cancelacion.
"""
from __future__ import annotations

import argparse
import json
import urllib.request
from datetime import date, datetime, timedelta

CLAVE = "rosconi-cambiar-esta-clave-2026"
SERVICIO = "Service completo y lubricentro"
RESULTADOS: list[tuple[bool, str]] = []


def pedir(url: str, ruta: str, cuerpo: dict | None = None) -> dict:
    datos = json.dumps(cuerpo).encode("utf-8") if cuerpo is not None else None
    peticion = urllib.request.Request(
        url + ruta,
        data=datos,
        headers={"Content-Type": "text/plain;charset=utf-8"},
        method="POST" if datos else "GET",
    )
    with urllib.request.urlopen(peticion, timeout=30) as respuesta:
        return json.loads(respuesta.read().decode("utf-8"))


def verificar(condicion: bool, descripcion: str) -> None:
    RESULTADOS.append((bool(condicion), descripcion))
    print(f"  {'OK   ' if condicion else 'FALLA'}  {descripcion}")


def agenda_de(url: str, servicio: str = SERVICIO) -> dict:
    return pedir(url, f"/?action=agenda&clave={CLAVE}&servicio={servicio.replace(' ', '%20')}")


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
    parser = argparse.ArgumentParser(description="Pruebas del contrato de turnos.")
    parser.add_argument("--url", default="http://127.0.0.1:8130")
    args = parser.parse_args()
    url = args.url.rstrip("/")
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

    fallas = [descripcion for ok, descripcion in RESULTADOS if not ok]
    print(f"\nRESULTADO: {len(RESULTADOS) - len(fallas)}/{len(RESULTADOS)} pruebas OK")
    for falla in fallas:
        print(f"  pendiente: {falla}")
    return 0 if not fallas else 1


if __name__ == "__main__":
    raise SystemExit(main())
