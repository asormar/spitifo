"""Historial de escucha (ADR 0003): modelo, archivos y API.

Todo OFFLINE: la logica pura vive en `backend/app/listens.py` y los archivos
se prueban sobre un `LocalStorage` en una carpeta temporal.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from backend.app.listens import (
    MAX_EVENTS,
    ListenAggregate,
    Metric,
    apply_events,
    artist_of,
    cutoff_month,
    merge_aggregates,
    month_of,
    summary,
    validate_event,
    validate_events,
)
from backend.app.main import create_app
from backend.app.storage import set_storage
from backend.app.storage.local import STATE_DIR, LocalStorage

D1 = "d1"
D2 = "d2"
T0 = 1_772_000_000  # 2026-02-27, un instante fijo y redondo


def _event(t: int = T0, key: str = "A/A - Uno.mp3", d: int = 200_000,
           l: int = 200_000, p: int = 200_000, r: str = "end",
           o: str = "play") -> dict:
    return {"t": t, "k": key, "d": d, "l": l, "p": p, "r": r, "o": o}


def _storage(root: Path, device: str) -> LocalStorage:
    return LocalStorage(root, device_id=device)


# --------------------------------------------------------------- validacion
def test_validate_event_quita_dev_y_acepta_los_campos():
    raw = dict(_event(), dev="otro")
    assert validate_event(raw) == _event()


@pytest.mark.parametrize("cambio", [
    {"t": "ayer"}, {"t": -1}, {"k": ""}, {"k": "../fuera.mp3"},
    {"d": -1}, {"l": -1}, {"p": -1}, {"r": "pause"}, {"o": "like"},
    {"t": True}, {"d": 1.5},
])
def test_validate_event_rechaza_campos_invalidos(cambio):
    with pytest.raises(ValueError):
        validate_event(dict(_event(), **cambio))


def test_validate_events_rechaza_mas_de_doscientos():
    with pytest.raises(ValueError):
        validate_events([_event() for _ in range(MAX_EVENTS + 1)])


def test_validate_events_acepta_el_limite_exacto():
    assert len(validate_events([_event() for _ in range(MAX_EVENTS)])) == \
        MAX_EVENTS


# --------------------------------------------------------------- ayudantes
@pytest.mark.parametrize("key,artista", [
    ("Rosalia/Rosalia - Saoko.mp3", "Rosalia"),
    ("A/B.mp3", "A"),
    ("Rosalia - Saoko.mp3", "Rosalia"),
    ("Saoko.mp3", "Saoko"),
    ("varios/varios - 2. Tema.mp3", "varios"),
])
def test_artist_of(key, artista):
    assert artist_of(key) == artista


def test_month_of_usa_utc():
    assert month_of(T0) == "2026-02"
    assert cutoff_month(T0) == "2025-02"


# ------------------------------------------------------------------ modelo
def test_apply_events_suma_contadores_y_guarda_el_ultimo():
    agg = ListenAggregate()
    apply_events(agg, [
        _event(key="A/A - Uno.mp3", o="play", l=120_000, p=120_000),
        _event(T0 + 10, key="A/A - Uno.mp3", o="skip", l=10_000,
               p=10_000, r="next"),
        _event(T0 + 20, key="A/A - Uno.mp3", o="partial", l=5_000,
               p=5_000, r="close"),
    ])
    track = agg.tracks["A/A - Uno.mp3"]
    assert (track.plays, track.skips, track.listened_ms) == (1, 1, 135_000)
    assert (track.last, track.pos, track.dur, track.o) == \
        (T0 + 20, 5_000, 200_000, "partial")
    artist = agg.artists["A"]
    assert (artist.plays, artist.skips, artist.listened_ms) == (1, 1, 135_000)


def test_score_decae_con_vida_media_de_sesenta_dias():
    agg = ListenAggregate()
    apply_events(agg, [
        _event(T0, o="play"),
        _event(T0 + 60 * 86400, o="play"),
    ])
    # El primer play vale 0.5 despues de 60 dias; el segundo suma 1.
    assert agg.tracks["A/A - Uno.mp3"].score == pytest.approx(1.5)


def test_score_nunca_baja_de_cero_y_partial_no_cambia_plays():
    agg = ListenAggregate()
    apply_events(agg, [
        _event(T0, o="skip", l=1_000),
        _event(T0 + 1, o="partial", l=2_000),
    ])
    track = agg.tracks["A/A - Uno.mp3"]
    assert track.score == 0.0
    assert track.plays == 0
    assert track.skips == 1
    assert track.listened_ms == 3_000


def test_merge_suma_contadores_y_el_ultimo_gana():
    uno = ListenAggregate()
    apply_events(uno, [_event(T0, o="play", p=1_000)])
    dos = ListenAggregate()
    apply_events(dos, [_event(T0 + 100, o="skip", p=2_000, r="next")])

    merged = merge_aggregates([uno, dos], T0 + 100)
    track = merged.tracks["A/A - Uno.mp3"]
    assert (track.plays, track.skips) == (1, 1)
    assert (track.last, track.pos) == (T0 + 100, 2_000)
    # Cada dispositivo se decae y clampa por separado: el skip no resta el
    # play de otro dispositivo (documentado en merge_aggregates).
    assert track.score == pytest.approx(1.0, abs=1e-3)


def test_summary_recent_es_distinto_y_mas_nuevo_primero():
    agg = ListenAggregate()
    apply_events(agg, [
        _event(T0, key="A/A - Uno.mp3", p=1_000),
        _event(T0 + 10, key="B/B - Dos.mp3", p=2_000),
        _event(T0 + 20, key="A/A - Uno.mp3", p=3_000, o="partial"),
    ])
    out = summary([agg], T0 + 20)
    assert [e["key"] for e in out["recent"]] == \
        ["A/A - Uno.mp3", "B/B - Dos.mp3"]
    assert out["recent"][0]["pos"] == 3_000
    assert out["tracks"]["A/A - Uno.mp3"]["pos"] == 3_000


def test_summary_limita_recent_a_treinta_claves():
    agg = ListenAggregate()
    apply_events(agg, [_event(T0 + i, key=f"A/{i}.mp3")
                       for i in range(35)])
    assert len(summary([agg], T0 + 35)["recent"]) == 30


# ----------------------------------------------------------------- archivos
def test_append_escribe_el_mes_y_el_agregado(tmp_path):
    storage = _storage(tmp_path, D1)
    accepted = storage.append_listens([
        _event(o="play", l=100_000),
        _event(T0 + 10, o="skip", l=10_000, r="next"),
    ])

    assert accepted == 2
    month = tmp_path / STATE_DIR / f"listens-{D1}-2026-02.json"
    assert json.loads(month.read_bytes())["version"] == 1
    assert len(json.loads(month.read_bytes())["events"]) == 2
    agg = json.loads((tmp_path / STATE_DIR / f"listenagg-{D1}.json")
                     .read_bytes())
    assert agg["tracks"]["A/A - Uno.mp3"]["plays"] == 1
    assert agg["tracks"]["A/A - Uno.mp3"]["skips"] == 1


def test_append_en_dos_meses_crea_dos_archivos(tmp_path):
    storage = _storage(tmp_path, D1)
    storage.append_listens([_event(T0)])
    storage.append_listens([_event(T0 + 40 * 86400)])
    names = {p.name for p in (tmp_path / STATE_DIR).glob("listens-*.json")}
    assert names == {f"listens-{D1}-2026-02.json",
                     f"listens-{D1}-2026-04.json"}


def test_merge_de_dos_dispositivos(tmp_path):
    uno = _storage(tmp_path, D1)
    dos = _storage(tmp_path, D2)
    uno.append_listens([_event(T0, o="play")])
    dos.append_listens([_event(T0 + 100, o="skip", r="next")])

    out = uno.load_listens_summary(now=T0 + 100)
    track = out["tracks"]["A/A - Uno.mp3"]
    assert (track["plays"], track["skips"]) == (1, 1)
    assert track["last"] == T0 + 100
    assert len(out["recent"]) == 1

    # Cualquiera de los dos ve lo mismo.
    assert dos.load_listens_summary(now=T0 + 100) == out


def test_el_agregado_sin_archivo_devuelve_vacio(tmp_path):
    storage = _storage(tmp_path, D1)
    assert storage.load_listens_summary(now=T0) == {"tracks": {}, "recent": []}


class _Tokens:
    def access_token(self) -> str:
        return "test-token"

    def invalidate(self) -> None:
        pass


def _drive(device: str, fake):
    """`DriveStorage` sobre el Drive falso, sin red."""
    import httpx

    from backend.app.cloud.drive import DriveStorage

    client = httpx.Client(transport=httpx.MockTransport(fake))
    return DriveStorage(_Tokens(), client, device, sleep=lambda _s: None)


def test_el_mismo_contrato_funciona_sobre_drive():
    from fake_drive import FakeDrive

    fake = FakeDrive()
    uno = _drive(D1, fake)
    dos = _drive(D2, fake)
    uno.append_listens([_event(o="play")])
    dos.append_listens([_event(T0 + 100, o="skip", r="next")])

    out = uno.load_listens_summary(now=T0 + 100)
    assert out["tracks"]["A/A - Uno.mp3"]["plays"] == 1
    assert out["tracks"]["A/A - Uno.mp3"]["skips"] == 1
    assert [e["key"] for e in out["recent"]] == ["A/A - Uno.mp3"]
    assert dos.load_listens_summary(now=T0 + 100) == out

    nombres = sorted(f["name"] for f in fake.files.values()
                     if f["name"].startswith("listen"))
    assert f"listenagg-{D1}.json" in nombres
    assert f"listenagg-{D2}.json" in nombres


def test_fold_borra_meses_viejos_pero_conserva_el_historial(tmp_path):
    storage = _storage(tmp_path, D1)
    viejo = _event(T0 - 800 * 86400, key="A/A - Viejo.mp3")
    actual = _event(T0)
    storage.append_listens([viejo, actual], now=T0)

    # 2024-12 quedo plegado y su archivo ya no esta; el agregado lo conserva.
    assert not (tmp_path / STATE_DIR /
                f"listens-{D1}-{month_of(viejo['t'])}.json").exists()
    agg = json.loads((tmp_path / STATE_DIR / f"listenagg-{D1}.json")
                     .read_bytes())
    assert agg["folded_through"] == cutoff_month(T0)
    out = storage.load_listens_summary(now=T0)
    assert out["tracks"]["A/A - Viejo.mp3"]["plays"] == 1

    # Un append posterior no vuelve a sumar lo plegado.
    storage.append_listens([actual], now=T0)
    assert storage.load_listens_summary(now=T0)["tracks"][
        "A/A - Uno.mp3"]["plays"] == 2


def test_append_ordena_los_eventos_por_tiempo(tmp_path):
    storage = _storage(tmp_path, D1)
    storage.append_listens([_event(T0 + 10), _event(T0)])
    month = json.loads((tmp_path / STATE_DIR /
                        f"listens-{D1}-2026-02.json").read_bytes())
    assert [e["t"] for e in month["events"]] == [T0, T0 + 10]


# ---------------------------------------------------------------------- API
@pytest.fixture
def api(tmp_path):
    root = tmp_path / "lib"
    root.mkdir()
    set_storage(LocalStorage(root))
    try:
        with TestClient(create_app()) as c:
            yield c
    finally:
        set_storage(None)


def test_get_summary_arranca_vacio(api):
    r = api.get("/api/listens/summary")
    assert r.status_code == 200
    assert r.json() == {"tracks": {}, "recent": []}


def test_post_y_summary_feliz(api):
    ahora = int(time.time()) - 60
    eventos = [
        _event(ahora, key="A/A - Uno.mp3", o="play"),
        _event(ahora + 10, key="B/B - Dos.mp3", o="skip", r="next"),
    ]
    r = api.post("/api/listens", json={"events": eventos})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "accepted": 2}

    out = api.get("/api/listens/summary").json()
    assert set(out["tracks"]["A/A - Uno.mp3"]) == {
        "plays", "skips", "listened_ms", "last", "score", "pos", "dur"}
    assert out["tracks"]["A/A - Uno.mp3"]["plays"] == 1
    assert [e["key"] for e in out["recent"]] == \
        ["B/B - Dos.mp3", "A/A - Uno.mp3"]
    assert out["recent"][0]["o"] == "skip"


@pytest.mark.parametrize("cuerpo", [
    {},
    {"events": "no es lista"},
    {"events": [_event(), "no es un evento"]},
    {"events": [_event(t="ayer")]},
    {"events": [_event(key="../fuera.mp3")]},
    {"events": [_event(r="pause")]},
    {"events": [_event(o="like")]},
    {"events": [_event(d=-1)]},
])
def test_post_invalido_da_422(api, cuerpo):
    r = api.post("/api/listens", json=cuerpo)
    assert r.status_code == 422
    assert r.json()["detail"][0]["msg"]


def test_post_con_demasiados_eventos_da_422(api):
    r = api.post("/api/listens", json={
        "events": [_event() for _ in range(MAX_EVENTS + 1)]})
    assert r.status_code == 422


def test_post_vacio_no_rompe(api):
    r = api.post("/api/listens", json={"events": []})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "accepted": 0}
