#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Mock local del backend de turnos (mismo contrato que tools/appsscript/Code.gs).

Permite desarrollar y probar el sitio sin tocar Google Calendar:

    python tools/mock-turnos.py            # http://127.0.0.1:8130
    python tools/mock-turnos.py --puerto 9000

Apuntando ENDPOINT de assets/js/booking.js a esa direccion se prueba todo el
flujo real (agenda, reserva, consulta y cancelacion) sin ensuciar la agenda.
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, time, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

CONFIG = {
    "clave": "rosconi-cambiar-esta-clave-2026",
    "paso_min": 30,
    "anticipacion_min": 1440,
    "dias_vista": 30,
    "cupos": 2,
    # Claves = dia de la semana de Python: lunes 0 ... domingo 6
    "atencion": {
        0: [("08:00", "12:00"), ("14:00", "18:00")],
        1: [("08:00", "12:00"), ("14:00", "18:00")],
        2: [("08:00", "12:00"), ("14:00", "18:00")],
        3: [("08:00", "12:00"), ("14:00", "18:00")],
        4: [("08:00", "12:00"), ("14:00", "18:00")],
        5: [],
        6: [],
    },
    "servicios": [
        {"nombre": "Service completo y lubricentro", "minutos": 60},
        {"nombre": "Diagnóstico con scanner", "minutos": 30},
        {"nombre": "Mecánica general", "minutos": 120},
        {"nombre": "Distribución y cadena", "minutos": 480},
        {"nombre": "Mecánica integral", "minutos": 480},
        {"nombre": "Reprogramación electrónica", "minutos": 120},
        {"nombre": "Otro trabajo / no estoy seguro", "minutos": 60},
    ],
    "servicio_predeterminado": "Service completo y lubricentro",
}

DIAS_ES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
DIAS_CORTOS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"]
MESES_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
            "agosto", "septiembre", "octubre", "noviembre", "diciembre"]

RESERVAS: list[dict] = []
CERRADOS: set[str] = set()
SEMILLA = {"valor": 0}


def etiqueta(fecha: datetime) -> str:
    texto = f"{DIAS_ES[fecha.weekday()]} {fecha.day} de {MESES_ES[fecha.month - 1]}"
    return texto[0].upper() + texto[1:]


def etiqueta_corta(fecha: datetime) -> str:
    return f"{DIAS_CORTOS[fecha.weekday()]} {fecha.day}"


def minutos(hora: str) -> int:
    partes = hora.split(":")
    return int(partes[0]) * 60 + int(partes[1])


def hora(minutos_del_dia: int) -> str:
    return f"{minutos_del_dia // 60:02d}:{minutos_del_dia % 60:02d}"


def servicio(nombre) -> dict:
    buscado = str(nombre or CONFIG["servicio_predeterminado"]).strip()
    for item in CONFIG["servicios"]:
        if item["nombre"] == buscado:
            return item
    return CONFIG["servicios"][0]


def ocupados(inicio: datetime, fin: datetime) -> int:
    return sum(1 for r in RESERVAS if r["inicio"] < fin and r["fin"] > inicio)


def codigo() -> str:
    SEMILLA["valor"] += 1
    alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    base = f"{SEMILLA['valor'] * 7919:016d}"
    return "RG-" + "".join(alfabeto[(int(base[i:i + 2]) * 3 + i) % len(alfabeto)] for i in range(0, 16, 2))


def agenda(nombre_servicio, dias: int) -> dict:
    elegido = servicio(nombre_servicio)
    ahora = datetime.now()
    limite = ahora + timedelta(minutes=CONFIG["anticipacion_min"])
    lista = []
    for indice in range(dias):
        dia = (ahora + timedelta(days=indice)).date()
        franjas = CONFIG["atencion"].get(dia.weekday(), [])
        cerrado = not franjas or dia.isoformat() in CERRADOS
        turnos = []
        if not cerrado:
            for desde, hasta in franjas:
                minuto = minutos(desde)
                while minuto + elegido["minutos"] <= minutos(hasta):
                    inicio = datetime.combine(dia, time(minuto // 60, minuto % 60))
                    fin = inicio + timedelta(minutes=elegido["minutos"])
                    turno_hora = hora(minuto)
                    minuto += CONFIG["paso_min"]
                    if inicio < limite:
                        continue
                    usados = ocupados(inicio, fin)
                    if usados >= CONFIG["cupos"]:
                        continue
                    turnos.append({
                        "hora": turno_hora,
                        "estado": "libre" if usados == 0 else "ultimo",
                        "cuposLibres": CONFIG["cupos"] - usados,
                    })
        libres = sum(1 for t in turnos if t["estado"] == "libre")
        ultimos = len(turnos) - libres
        estado = "cerrado"
        if not cerrado:
            estado = "disponible" if libres else ("ultimo" if ultimos else "completo")
        mediodia = datetime.combine(dia, time(12, 0))
        lista.append({
            "fecha": dia.isoformat(),
            "etiqueta": etiqueta(mediodia),
            "etiquetaCorta": etiqueta_corta(mediodia),
            "estado": estado,
            "turnos": turnos,
        })
    return {
        "ok": True, "zona": "America/Montevideo",
        "actualizado": ahora.strftime("%Y-%m-%d %H:%M"),
        "servicio": elegido["nombre"], "duracionMinutos": elegido["minutos"],
        "anticipacionMinutos": CONFIG["anticipacion_min"], "cupos": CONFIG["cupos"],
        "servicios": CONFIG["servicios"], "dias": lista,
    }


def crear(cuerpo: dict) -> dict:
    if str(cuerpo.get("empresa", "")).strip():
        return {"ok": False, "error": "no_procesado", "mensaje": "No pudimos procesar la solicitud."}
    elegido = next(
        (s for s in CONFIG["servicios"] if s["nombre"] == str(cuerpo.get("servicio") or "").strip()),
        None,
    )
    if not elegido:
        return {"ok": False, "error": "servicio_invalido", "mensaje": "Elegí el tipo de trabajo que necesitás."}
    if len(str(cuerpo.get("nombre", "")).strip()) < 3:
        return {"ok": False, "error": "nombre_invalido", "mensaje": "Escribí tu nombre completo."}
    if len(str(cuerpo.get("vehiculo", "")).strip()) < 2:
        return {"ok": False, "error": "vehiculo_invalido", "mensaje": "Contanos marca y modelo."}
    telefono = re.sub(r"\D", "", str(cuerpo.get("telefono", "")))
    if not 8 <= len(telefono) <= 13:
        return {"ok": False, "error": "telefono_invalido", "mensaje": "Revisá el teléfono."}
    try:
        inicio = datetime.fromisoformat(f"{cuerpo['fecha']}T{cuerpo['hora']}:00")
    except Exception:
        return {"ok": False, "error": "fecha_invalida", "mensaje": "Elegí otra vez el día y el horario."}
    fin = inicio + timedelta(minutes=elegido["minutos"])
    if inicio.date() > (datetime.now() + timedelta(days=CONFIG["dias_vista"])).date():
        return {"ok": False, "error": "fuera_de_rango", "mensaje": "Ese día está fuera de la agenda abierta."}
    if inicio < datetime.now() + timedelta(minutes=CONFIG["anticipacion_min"]):
        return {"ok": False, "error": "muy_pronto", "mensaje": "Los turnos se piden con 24 h de anticipación."}
    inicio_min = inicio.hour * 60 + inicio.minute
    franjas = CONFIG["atencion"].get(inicio.weekday(), [])
    if not any(minutos(d) <= inicio_min and inicio_min + elegido["minutos"] <= minutos(h)
               for d, h in franjas):
        return {"ok": False, "error": "fuera_de_horario", "mensaje": "Ese horario queda fuera de atención."}
    usados = ocupados(inicio, fin)
    if usados >= CONFIG["cupos"]:
        return {"ok": False, "error": "sin_cupo", "mensaje": "Ese horario se acaba de ocupar."}
    nuevo = codigo()
    RESERVAS.append({
        "codigo": nuevo, "inicio": inicio, "fin": fin,
        "nombre": str(cuerpo.get("nombre", "")), "telefono": telefono,
        "vehiculo": str(cuerpo.get("vehiculo", "")), "servicio": elegido["nombre"],
    })
    return {
        "ok": True, "codigo": nuevo,
        "estado": "libre" if usados == 0 else "ultimo",
        "cuposLibres": max(CONFIG["cupos"] - usados - 1, 0),
        "fecha": inicio.date().isoformat(), "hora": inicio.strftime("%H:%M"),
        "etiqueta": etiqueta(inicio), "servicio": elegido["nombre"],
        "duracionMinutos": elegido["minutos"],
        "mensaje": f"Turno confirmado para el {etiqueta(inicio)} a las {inicio:%H:%M}.",
    }


def buscar(valor) -> dict | None:
    buscado = str(valor or "").strip().upper()
    for reserva in RESERVAS:
        if reserva["codigo"] == buscado:
            return reserva
    return None


def consultar(cuerpo: dict) -> dict:
    reserva = buscar(cuerpo.get("codigo"))
    if not reserva:
        return {"ok": False, "error": "no_encontrado", "mensaje": "No encontramos ese código."}
    return {
        "ok": True, "codigo": reserva["codigo"],
        "fecha": reserva["inicio"].date().isoformat(),
        "hora": reserva["inicio"].strftime("%H:%M"),
        "etiqueta": etiqueta(reserva["inicio"]),
        "servicio": reserva["servicio"], "vehiculo": reserva["vehiculo"],
        "ubicacion": "Juan Antonio Lavalleja 730, Artigas",
    }


def cancelar(cuerpo: dict) -> dict:
    reserva = buscar(cuerpo.get("codigo"))
    if not reserva:
        return {"ok": False, "error": "no_encontrado", "mensaje": "No encontramos ese código."}
    datos = consultar(cuerpo)
    RESERVAS.remove(reserva)
    datos["mensaje"] = f"El turno del {datos['etiqueta']} a las {datos['hora']} quedó cancelado."
    return datos


def control(accion: str, valor: str) -> dict:
    """Atajos solo para las pruebas automaticas."""
    if accion == "cerrar-dia":
        CERRADOS.add(valor)
        return {"ok": True, "mensaje": f"Dia {valor} cerrado."}
    if accion == "limpiar":
        RESERVAS.clear()
        CERRADOS.clear()
        return {"ok": True, "mensaje": "Estado limpio."}
    if accion == "reservas":
        return {"ok": True, "total": len(RESERVAS),
                "reservas": [{"codigo": r["codigo"], "inicio": r["inicio"].isoformat(),
                              "servicio": r["servicio"]} for r in RESERVAS]}
    return {"ok": False, "error": "accion_desconocida", "mensaje": "Accion no valida."}


class Manejador(BaseHTTPRequestHandler):
    server_version = "MockTurnosRosconi/1.0"

    def responder(self, datos: dict, estado: int = 200) -> None:
        cuerpo = json.dumps(datos, ensure_ascii=False).encode("utf-8")
        self.send_response(estado)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.end_headers()
        self.wfile.write(cuerpo)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.responder({"ok": True})

    def do_GET(self) -> None:  # noqa: N802
        consulta = parse_qs(urlparse(self.path).query)
        if consulta.get("clave", [""])[0] != CONFIG["clave"]:
            self.responder({"ok": False, "error": "clave_invalida", "mensaje": "Clave invalida."})
            return
        if consulta.get("action", ["agenda"])[0] == "ping":
            self.responder({"ok": True, "mensaje": "Mock activo", "zona": "America/Montevideo"})
            return
        dias = min(int(consulta.get("dias", [CONFIG["dias_vista"]])[0]), CONFIG["dias_vista"])
        self.responder(agenda(consulta.get("servicio", [None])[0], dias))

    def do_POST(self) -> None:  # noqa: N802
        largo = int(self.headers.get("Content-Length", 0))
        try:
            cuerpo = json.loads(self.rfile.read(largo) or b"{}")
        except json.JSONDecodeError:
            self.responder({"ok": False, "error": "json_invalido", "mensaje": "Cuerpo invalido."})
            return
        if str(cuerpo.get("clave", "")) != CONFIG["clave"]:
            self.responder({"ok": False, "error": "clave_invalida", "mensaje": "Clave invalida."})
            return
        manejador = {"crear": crear, "consultar": consultar, "cancelar": cancelar}.get(
            str(cuerpo.get("accion", ""))
        )
        if not manejador:
            self.responder({"ok": False, "error": "accion_desconocida", "mensaje": "Accion no valida."})
            return
        self.responder(manejador(cuerpo))

    def do_PUT(self) -> None:  # noqa: N802
        largo = int(self.headers.get("Content-Length", 0))
        cuerpo = json.loads(self.rfile.read(largo) or b"{}")
        self.responder(control(str(cuerpo.get("accion", "")), str(cuerpo.get("valor", ""))))

    def log_message(self, formato: str, *args) -> None:
        print(f"[mock] {self.address_string()} {formato % args}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Mock local del backend de turnos.")
    parser.add_argument("--puerto", type=int, default=8130)
    args = parser.parse_args()
    servidor = ThreadingHTTPServer(("127.0.0.1", args.puerto), Manejador)
    print(f"Mock de turnos en http://127.0.0.1:{args.puerto}  |  clave: {CONFIG['clave']}")
    print("GET /?action=agenda&clave=...&servicio=...   POST / {accion: crear|consultar|cancelar}")
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\nMock detenido.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


