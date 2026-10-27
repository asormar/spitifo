"""Fichas de artista (ADR 0003): nombres, MusicBrainz, ListenBrainz y storage.

Todo OFFLINE: los clientes HTTP usan `httpx.MockTransport`, el enricher un
`ArtistSource` falso y los archivos un `LocalStorage` en una carpeta temporal.
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import httpx
import pytest

from backend.app.artistinfo import (
    MATCH_RULE,
    MAX_GENRES,
    MAX_SIMILAR,
    ArtistInfoBook,
    ArtistSource,
    Enricher,
    ListenBrainz,
    MusicBrainz,
    Throttle,
    artist_name,
    artistinfo_file,
    error_record,
    fold,
    is_stale,
    library_artists,
    parse_artistinfo_file,
    split_artists,
    unknown_record,
)
from backend.app.discover import DiscoverBook, discover_file
from backend.app.storage.local import STATE_DIR, LocalStorage

T0 = 1_772_000_000.0  # un instante fijo y redondo


def _record(name: str = "A", at: float = T0, *, status: str = "ok",
            genres: list | None = None, similar: list | None = None,
            mbid: str | None = "mbid-a") -> dict:
    return {"name": name, "mbid": mbid, "genres": genres or [],
            "similar": similar or [], "fetched_at": at, "status": status,
            "rule": MATCH_RULE}


def _storage(root: Path, device: str) -> LocalStorage:
    return LocalStorage(root, device_id=device)


def _no_throttle() -> Throttle:
    """Sin esperas reales: el reloj no avanza y el sleep no hace nada."""
    return Throttle(0.0, clock=lambda: 0.0, sleep=lambda _s: None)


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


# ------------------------------------------------------------------- nombres
@pytest.mark.parametrize("entry,esperado", [
    ({"key": "Rosalia/Rosalia - Saoko.mp3", "artist": "ROSALIA"}, "ROSALIA"),
    ({"key": "Daft Punk/Daft Punk - One More Time.mp3"}, "Daft Punk"),
    ({"key": "Daft Punk - One More Time.mp3"}, "Daft Punk"),
    ({"key": "Saoko.mp3"}, "Saoko"),
    ({"key": "A/B.mp3"}, "A"),
    ({"key": "A/B.mp3", "artist": "   "}, "A"),
    ({"key": ""}, ""),
])
def test_artist_name_usa_tag_carpeta_y_archivo(entry, esperado):
    assert artist_name(entry) == esperado


def test_fold_saca_acentos_mayusculas_y_espacios():
    assert fold("  Rosalía   PIPAS ") == "rosalia pipas"
    assert fold("ROSALIA PIPAS") == fold("Rosalía Pipas")
    assert fold("Daft  Punk") == "daft punk"
    assert fold(None) == ""


@pytest.mark.parametrize("credito, partes", [
    ("Bizarrap & Milo j", ["Bizarrap", "Milo j"]),
    ("Bizarrap y Milo j", ["Bizarrap", "Milo j"]),
    ("Bizarrap Y Milo j", ["Bizarrap", "Milo j"]),
    ("Bizarrap x Milo j", ["Bizarrap", "Milo j"]),
    ("Bizarrap X Milo j", ["Bizarrap", "Milo j"]),
    ("Bizarrap, Milo j", ["Bizarrap", "Milo j"]),
    ("Bizarrap feat. Milo j", ["Bizarrap", "Milo j"]),
    ("Bizarrap feat Milo j", ["Bizarrap", "Milo j"]),
    ("Bizarrap ft. Milo j", ["Bizarrap", "Milo j"]),
    ("Bizarrap ft Milo j", ["Bizarrap", "Milo j"]),
    ("Bizarrap featuring Milo j", ["Bizarrap", "Milo j"]),
    ("Bizarrap con Milo j", ["Bizarrap", "Milo j"]),
    ("Bizarrap vs. Milo j", ["Bizarrap", "Milo j"]),
    ("Bizarrap VS Milo j", ["Bizarrap", "Milo j"]),
    ("Milo j & Milo J", ["Milo j"]),  # el mismo artista no cuenta dos veces
])
def test_split_artists_parte_los_separadores_conocidos(credito, partes):
    assert split_artists(credito) == partes


@pytest.mark.parametrize("nombre", [
    "Daft Punk",
    "Malcolm X",       # una X sola no es colaboracion
    "A & B",           # una parte de una letra no se separa
    "Rosalia",
    "  Rosalia  ",
])
def test_split_artists_no_parte_lo_que_no_corresponde(nombre):
    assert split_artists(nombre) == [nombre.strip()]


def test_split_artists_tolera_none_y_vacio():
    assert split_artists(None) == []
    assert split_artists("   ") == []


# ------------------------------------------------------------ biblioteca
def test_library_artists_cuenta_pistas_y_salta_videos():
    entries = [
        {"key": "A/A - Uno.mp3", "kind": "audio", "duration_s": 180.0},
        {"key": "A/A - Dos.mp3", "kind": "audio", "duration_s": 200.0},
        {"key": "B/B - Video.mp4", "kind": "video", "duration_s": 200.0},
        {"key": "C/C - Tema.mp3", "duration_s": None},
    ]
    out = library_artists(entries)
    assert out == {"a": {"name": "A", "tracks": 2},
                   "c": {"name": "C", "tracks": 1}}


def test_library_artists_salta_podcasts_de_pistas_largas():
    entries = [
        # Todas largas: es un programa de radio, no musica.
        {"key": "Late Motiv/Late Motiv - 1.mp3", "duration_s": 3600.0},
        {"key": "Late Motiv/Late Motiv - 2.mp3", "duration_s": 1800.0},
        # Una corta alcanza para que el artista se busque.
        {"key": "Podcast/Podcast - 1.mp3", "duration_s": 3600.0},
        {"key": "Podcast/Podcast - 2.mp3", "duration_s": 120.0},
        # Duracion desconocida: no se puede afirmar que sea largo.
        {"key": "Dudoso/Dudoso - 1.mp3", "duration_s": None},
    ]
    out = library_artists(entries)
    assert set(out) == {"podcast", "dudoso"}
    assert out["podcast"]["tracks"] == 2


def test_library_artists_una_duracion_desconocida_no_es_larga_ni_corta():
    entries = [
        # Larga conocida + desconocida: sigue siendo un programa (la
        # desconocida no cuenta como corta y no lo salva).
        {"key": "Programa/Programa - 1.mp3", "duration_s": 3600.0},
        {"key": "Programa/Programa - 2.mp3", "duration_s": None},
        # Todas desconocidas: no hay evidencia de que sea un programa.
        {"key": "Dudoso/Dudoso - 1.mp3", "duration_s": None},
        {"key": "Dudoso/Dudoso - 2.mp3", "duration_s": None},
    ]
    assert set(library_artists(entries)) == {"dudoso"}


def test_library_artists_parte_colaboraciones_y_cuenta_la_pista_a_cada_uno():
    entries = [
        {"key": "Varios/Bizarrap & Milo j - En la ciudad.mp3",
         "artist": "Bizarrap & Milo j", "duration_s": 180.0},
        {"key": "Varios/Bizarrap feat. Milo j - Otra.mp3",
         "artist": "Bizarrap feat. Milo j", "duration_s": 200.0},
        {"key": "Milo j/Milo j - Solo.mp3", "artist": "Milo j",
         "duration_s": 210.0},
    ]
    out = library_artists(entries)
    assert out == {"bizarrap": {"name": "Bizarrap", "tracks": 2},
                   "milo j": {"name": "Milo j", "tracks": 3}}


# ------------------------------------------------------------------ MusicBrainz
def _mb(artists: list[dict], genres: list[dict] | None = None,
        calls: list | None = None) -> MusicBrainz:
    def handler(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(request)
        # `.../ws/2/artist` es la busqueda; `.../ws/2/artist/<mbid>` el lookup.
        if request.url.path.rstrip("/").endswith("/artist"):
            return httpx.Response(200, json={"artists": artists})
        return httpx.Response(200, json={"genres": genres or []})

    return MusicBrainz(_client(handler), throttle=_no_throttle())


def _search(artists: list[dict], genres: list[dict] | None = None,
            calls: list | None = None, name: str = "Rosalia"):
    return _mb(artists, genres, calls).match(name)


def test_match_elige_la_coincidencia_exacta_aunque_no_sea_la_primera():
    artists = [
        {"id": "otro", "name": "Otro Grupo", "score": 100},
        {"id": "mbid-1", "name": "Rosalía", "score": 92},
    ]
    found = _search(artists, name="Rosalia")
    assert found and found["id"] == "mbid-1"


def test_match_ignora_acentos_y_mayusculas():
    artists = [{"id": "mbid-1", "name": "ROSALÍA", "score": 95}]
    assert _search(artists, name="rosalia")["id"] == "mbid-1"


def test_match_ignora_un_exacto_con_score_bajo():
    artists = [{"id": "mbid-1", "name": "Rosalía", "score": 80}]
    assert _search(artists, name="Rosalia") is None


def test_match_no_acepta_el_mejor_si_el_nombre_no_coincide():
    # Score altisimo y otro nombre: es OTRO artista (el programa "Late Motiv"
    # no es la banda homonima que devuelve la busqueda).
    assert _search([{"id": "x", "name": "Late Motiv Tribute",
                     "score": 100}], name="Late Motiv") is None
    assert _search([{"id": "x", "name": "Rosalia Tribute",
                     "score": 98}], name="Rosalia") is None


def test_match_acepta_el_sort_name_plegado():
    artists = [{"id": "mbid-1", "name": "Rosalía", "sort-name": "Rosalia",
                "score": 90}]
    assert _search(artists, name="Rosalia")["id"] == "mbid-1"


def test_match_acepta_un_alias_plegado():
    artists = [{"id": "mbid-1", "name": "La Rosalia", "score": 95,
                "aliases": [{"name": "ROSALÍA", "sort-name": "Rosalia"}]}]
    assert _search(artists, name="Rosalia")["id"] == "mbid-1"


def test_match_no_acepta_un_alias_con_score_bajo():
    artists = [{"id": "x", "name": "Otra", "score": 80,
                "aliases": [{"name": "Rosalia"}]}]
    assert _search(artists, name="Rosalia") is None


def test_match_ignora_aliases_mal_formados():
    artists = [{"id": "x", "name": "Otra", "score": 99,
                "aliases": [None, {"name": 3}, "Rosalia", {"sort-name": ""}]}]
    assert _search(artists, name="Rosalia") is None
    assert _search([{"id": "x", "name": "Otra", "score": 99,
                     "aliases": "Rosalia"}], name="Rosalia") is None


def test_match_sin_candidatos_es_none():
    assert _search([], name="Rosalia") is None


def test_la_busqueda_usa_query_limit_y_el_cliente_manda_el_user_agent():
    calls: list[httpx.Request] = []
    _search([{"id": "x", "name": "A", "score": 100}], calls=calls, name="A")
    request = calls[0]
    assert request.url.params["query"] == "artist:A"
    assert request.url.params["limit"] == "5"
    assert request.url.params["fmt"] == "json"

    from backend.app.artistinfo import _http_client
    client = _http_client()
    try:
        assert client.headers["User-Agent"].startswith("spitifo/")
    finally:
        client.close()


def test_genres_ordena_recorta_y_descarta_count_cero():
    genres = [{"name": f"g{i}", "count": i} for i in range(1, 12)]
    genres += [{"name": "cero", "count": 0}, {"name": "neg", "count": -3},
               {"name": "", "count": 4}]
    client = _mb([], genres)
    out = client.genres("mbid-1")
    assert len(out) == MAX_GENRES
    assert out[0] == ["g11", 11]
    assert out[-1] == ["g4", 4]
    assert "cero" not in [name for name, _ in out]


# --------------------------------------------------------------- ListenBrainz
def test_similar_parsea_los_campos_y_descarta_los_invalidos():
    rows = [
        {"artist_mbid": "m1", "name": "Uno", "score": 0.9},
        {"artist_mbid": None, "name": "sin mbid", "score": 1},
        {"artist_mbid": "m3", "name": "Tres"},
        {"artist_mbid": "m4", "name": ""},
    ]
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=rows)

    client = ListenBrainz(_client(handler), throttle=_no_throttle())
    out = client.similar("mbid-a")
    assert out == [{"name": "Uno", "mbid": "m1", "score": 0.9},
                   {"name": "Tres", "mbid": "m3", "score": 0.0}]
    assert seen[0].url.params["artist_mbids"] == "mbid-a"
    assert "algorithm" in seen[0].url.params


def test_similar_recorta_a_treinta_y_ordena_por_score():
    rows = [{"artist_mbid": f"m{i}", "name": f"Artista {i:02d}",
             "score": i / 100} for i in range(1, 41)]

    client = ListenBrainz(_client(lambda _request: httpx.Response(200,
                                                                 json=rows)),
                          throttle=_no_throttle())
    out = client.similar("mbid-a")
    assert len(out) == MAX_SIMILAR
    assert out[0] == {"name": "Artista 40", "mbid": "m40", "score": 0.4}
    assert out[-1] == {"name": "Artista 11", "mbid": "m11", "score": 0.11}
    assert all(set(item) == {"name", "mbid", "score"} for item in out)


# ------------------------------------------------------------------- throttle
def test_throttle_usa_el_reloj_y_el_sleep_inyectados():
    now = [0.0]
    sleeps: list[float] = []

    def clock() -> float:
        return now[0]

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        now[0] += seconds

    throttle = Throttle(1.1, clock=clock, sleep=sleep)
    assert throttle.wait() == 0.0
    assert throttle.wait() == pytest.approx(1.1)
    assert throttle.wait() == pytest.approx(1.1)
    assert sleeps == [pytest.approx(1.1), pytest.approx(1.1)]


def test_el_throttle_de_musicbrainz_espacia_las_requests():
    calls: list[httpx.Request] = []
    now = [0.0]
    sleeps: list[float] = []

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        now[0] += seconds

    client = MusicBrainz(_client(lambda request: (
        calls.append(request) or httpx.Response(200, json={"artists": []}))),
        throttle=Throttle(1.1, clock=lambda: now[0], sleep=sleep))
    client.search("A")
    client.search("B")
    assert len(calls) == 2
    assert sleeps == [pytest.approx(1.1)]


# ------------------------------------------------------------------- records
def test_is_stale_respeta_los_plazos_por_estado():
    assert is_stale(None, T0)
    assert not is_stale(_record(at=T0 - 29 * 86400), T0)
    assert is_stale(_record(at=T0 - 31 * 86400), T0)
    assert not is_stale(_record(at=T0 - 3600, status="unknown"), T0)
    # Un error se reintenta al dia siguiente.
    assert not is_stale(_record(at=T0 - 3600, status="error"), T0)
    assert is_stale(_record(at=T0 - 2 * 86400, status="error"), T0)
    assert is_stale({"status": "raro", "fetched_at": T0}, T0)


def test_error_record_conserva_lo_que_ya_se_sabia():
    previous = _record("Rosalía", T0, genres=[["pop", 2]],
                       similar=[{"name": "X", "mbid": "mx", "score": 1.0}])
    out = error_record("Rosalia", T0 + 10, previous)
    assert out["status"] == "error"
    assert out["name"] == "Rosalía"
    assert out["genres"] == [["pop", 2]]
    assert out["similar"][0]["name"] == "X"
    assert out["fetched_at"] == T0 + 10


def test_unknown_record_no_tiene_mbid_ni_datos():
    out = unknown_record("Nadie", T0)
    assert out == {"name": "Nadie", "mbid": None, "genres": [],
                   "similar": [], "fetched_at": T0, "status": "unknown",
                   "rule": MATCH_RULE}


def test_una_ficha_de_una_regla_vieja_esta_vencida_y_no_se_conserva():
    # La regla 1 aceptaba candidatos parecidos (un programa de radio salio
    # como un artista de drum and bass): esas fichas se vuelven a buscar.
    old = dict(_record("Late Motiv", T0, genres=[["drum and bass", 3]]))
    old.pop("rule")
    assert is_stale(old, T0 + 60)
    out = error_record("Late Motiv", T0 + 60, old)
    assert out["genres"] == [] and out["mbid"] is None


def test_artist_source_une_musicbrainz_y_listenbrainz():
    def mb_handler(request: httpx.Request) -> httpx.Response:
        if "artist/" in request.url.path:
            return httpx.Response(200, json={"genres": [{"name": "pop",
                                                         "count": 3}]})
        return httpx.Response(200, json={"artists": [
            {"id": "mbid-a", "name": "Rosalía", "score": 100}]})

    def lb_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[
            {"artist_mbid": "mx", "name": "X", "score": 0.9}])

    source = ArtistSource(
        MusicBrainz(_client(mb_handler), throttle=_no_throttle()),
        ListenBrainz(_client(lb_handler), throttle=_no_throttle()),
        clock=lambda: T0)
    record = source.fetch("Rosalia")
    assert record["status"] == "ok"
    assert record["mbid"] == "mbid-a"
    assert record["genres"] == [["pop", 3]]
    assert record["similar"] == [{"name": "X", "mbid": "mx", "score": 0.9}]

    only_genres = source.fetch_genres("Rosalia")
    assert only_genres["similar"] == []


# ------------------------------------------------------------ storage local
def test_artistinfo_ida_y_vuelta_en_un_dispositivo(tmp_path):
    storage = _storage(tmp_path, "d1")
    storage.save_artistinfo({
        "rosalia": _record("Rosalía", T0, genres=[["pop", 3]], similar=[
            {"name": "X", "mbid": "mx", "score": 0.5}])})
    path = tmp_path / STATE_DIR / artistinfo_file("d1")
    payload = json.loads(path.read_bytes())
    assert payload["version"] == 1
    assert payload["artists"]["rosalia"]["name"] == "Rosalía"

    out = storage.load_artistinfo()
    assert out["rosalia"]["genres"] == [["pop", 3]]
    assert out["rosalia"]["similar"][0]["name"] == "X"


def test_artistinfo_merge_de_dos_dispositivos_gana_el_mas_nuevo(tmp_path):
    uno = _storage(tmp_path, "d1")
    dos = _storage(tmp_path, "d2")
    uno.save_artistinfo({"a": _record("A", T0, genres=[["rock", 1]])})
    dos.save_artistinfo({"a": _record("A", T0 + 10, genres=[["pop", 2]])})

    out = uno.load_artistinfo()
    assert out["a"]["genres"] == [["pop", 2]]
    assert out["a"]["fetched_at"] == T0 + 10
    assert dos.load_artistinfo() == out
    names = {path.name for path in (tmp_path / STATE_DIR).glob(
        "artistinfo-*.json")}
    assert names == {"artistinfo-d1.json", "artistinfo-d2.json"}


def test_artistinfo_no_pisa_un_archivo_propio_ilegible(tmp_path):
    storage = _storage(tmp_path, "d1")
    path = tmp_path / STATE_DIR / artistinfo_file("d1")
    path.parent.mkdir(parents=True)
    path.write_bytes(b"no es json")
    with pytest.raises(RuntimeError):
        storage.save_artistinfo({"a": _record()})
    assert path.read_bytes() == b"no es json"


def test_artistinfo_rechaza_una_version_desconocida():
    with pytest.raises(ValueError):
        ArtistInfoBook.from_bytes(b'{"version": 99, "artists": {}}')


def test_parse_artistinfo_file():
    assert parse_artistinfo_file("artistinfo-d1.json") == "d1"
    assert parse_artistinfo_file("discover-d1.json") is None


# ------------------------------------------------------- descartes (discover)
def test_discover_ida_y_vuelta_y_merge_de_dos_dispositivos(tmp_path):
    uno = _storage(tmp_path, "d1")
    dos = _storage(tmp_path, "d2")
    uno.dismiss_artist("Rosalía", now=T0)
    assert uno.load_discover().dismissed_set() == {"rosalia"}

    dos.dismiss_artist("Rosalía", undo=True, now=T0 + 10)
    assert uno.load_discover().dismissed_set() == set()
    assert dos.load_discover().dismissed_set() == set()
    names = {path.name for path in (tmp_path / STATE_DIR).glob(
        "discover-*.json")}
    assert names == {"discover-d1.json", "discover-d2.json"}

    path = tmp_path / STATE_DIR / discover_file("d2")
    payload = json.loads(path.read_bytes())
    assert payload["version"] == 1
    assert payload["dismissed"]["rosalia"]["undone"] is True


def test_dismiss_siempre_crece_aunque_el_reloj_retroceda(tmp_path):
    storage = _storage(tmp_path, "d1")
    storage.dismiss_artist("X", now=T0 + 100)
    storage.dismiss_artist("X", undo=True, now=T0)
    entry = storage.load_discover().dismissed["x"]
    assert entry["undone"] is True
    assert entry["at"] == pytest.approx(T0 + 100.001)


def test_dismiss_rechaza_un_nombre_vacio(tmp_path):
    with pytest.raises(ValueError):
        _storage(tmp_path, "d1").dismiss_artist("   ")


# ------------------------------------------------------------ storage en Drive
class _Tokens:
    def access_token(self) -> str:
        return "test-token"

    def invalidate(self) -> None:
        pass


def _drive(device: str, fake):
    from backend.app.cloud.drive import DriveStorage

    client = httpx.Client(transport=httpx.MockTransport(fake))
    return DriveStorage(_Tokens(), client, device, sleep=lambda _s: None)


def test_el_mismo_contrato_de_artistinfo_funciona_sobre_drive():
    from fake_drive import FakeDrive

    fake = FakeDrive()
    uno = _drive("d1", fake)
    dos = _drive("d2", fake)
    uno.save_artistinfo({"a": _record("A", T0, genres=[["rock", 1]])})
    dos.save_artistinfo({"a": _record("A", T0 + 10, genres=[["pop", 2]])})

    out = uno.load_artistinfo()
    assert out["a"]["genres"] == [["pop", 2]]
    assert dos.load_artistinfo() == out
    names = {f["name"] for f in fake.files.values()}
    assert {"artistinfo-d1.json", "artistinfo-d2.json"} <= names


def test_el_mismo_contrato_de_discover_funciona_sobre_drive():
    from fake_drive import FakeDrive

    fake = FakeDrive()
    uno = _drive("d1", fake)
    dos = _drive("d2", fake)
    uno.dismiss_artist("X", now=T0)
    assert uno.load_discover().dismissed_set() == {"x"}

    dos.dismiss_artist("X", undo=True, now=T0 + 10)
    assert uno.load_discover().dismissed_set() == set()
    assert dos.load_discover().dismissed_set() == set()
    names = {f["name"] for f in fake.files.values()}
    assert {"discover-d1.json", "discover-d2.json"} <= names


# -------------------------------------------------------------------- enricher
class FuenteFalsa:
    """Doble de `ArtistSource`: responde al instante y anota las llamadas."""

    def __init__(self, similar: dict | None = None,
                 genres: list | None = None, at: float = T0) -> None:
        self.calls: list[str] = []
        self.genre_calls: list[str] = []
        self.similar = similar or {}
        self.genres = genres if genres is not None else [["rock", 3]]
        self.at = at

    def fetch(self, name: str, *, similar: bool = True) -> dict:
        self.calls.append(name)
        return _record(name, self.at, genres=self.genres,
                       similar=self.similar.get(name, []))

    def fetch_genres(self, name: str) -> dict:
        self.genre_calls.append(name)
        return _record(name, self.at, genres=self.genres)


class FuenteRota:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.genre_calls: list[str] = []

    def fetch(self, name: str, *, similar: bool = True) -> dict:
        self.calls.append(name)
        raise RuntimeError("sin red")

    def fetch_genres(self, name: str) -> dict:
        self.genre_calls.append(name)
        raise RuntimeError("sin red")


class SpyStorage:
    """LocalStorage que recuerda cuantas fichas se guardaron en cada lote."""

    def __init__(self, inner: LocalStorage) -> None:
        self.inner = inner
        self.saves: list[int] = []
        self.loads = 0

    def load_artistinfo(self) -> dict:
        self.loads += 1
        return self.inner.load_artistinfo()

    def save_artistinfo(self, records: dict) -> None:
        self.saves.append(len(records))
        self.inner.save_artistinfo(records)

    def load_listens_summary(self) -> dict:
        return {"tracks": {}, "recent": []}

    def load_discover(self) -> DiscoverBook:
        return DiscoverBook()


def _entries(*names: str) -> list[dict]:
    return [{"key": f"{name}/{name} - Tema.mp3", "kind": "audio",
             "duration_s": 180.0} for name in names]


def _wait(enricher: Enricher, timeout: float = 5.0) -> None:
    limit = time.time() + timeout
    while time.time() < limit:
        if not enricher.status()["running"]:
            return
        time.sleep(0.01)
    raise AssertionError("el enricher no termino")


def test_enricher_busca_por_pistas_y_progresan_los_contadores(tmp_path):
    storage = _storage(tmp_path, "d1")
    source = FuenteFalsa()
    enricher = Enricher(source=source, scan=lambda: _entries("A", "B"),
                        storage=lambda: storage, clock=lambda: T0)

    enricher.ensure_started()
    _wait(enricher)

    assert source.calls == ["A", "B"]  # empate de pistas: por nombre plegado
    out = storage.load_artistinfo()
    assert set(out) == {"a", "b"}
    assert enricher.status() == {"done": 2, "total": 2, "running": False,
                                 "offline": False}


def test_enricher_ordena_por_cantidad_de_pistas(tmp_path):
    storage = _storage(tmp_path, "d1")
    source = FuenteFalsa()
    entries = _entries("A", "B", "B", "C", "C", "C")
    enricher = Enricher(source=source, scan=lambda: entries,
                        storage=lambda: storage, clock=lambda: T0)
    enricher.ensure_started()
    _wait(enricher)
    assert source.calls == ["C", "B", "A"]


def test_enricher_guarda_por_lotes_y_al_final(tmp_path):
    storage = SpyStorage(_storage(tmp_path, "d1"))
    source = FuenteFalsa()
    enricher = Enricher(source=source,
                        scan=lambda: _entries("A", "B", "C", "D", "E", "F"),
                        storage=lambda: storage, clock=lambda: T0,
                        batch_size=5)
    enricher.ensure_started()
    _wait(enricher)
    assert storage.saves == [5, 1]
    assert set(storage.load_artistinfo()) == {"a", "b", "c", "d", "e", "f"}


def test_enricher_marca_error_y_con_tres_seguidos_queda_offline(tmp_path):
    storage = _storage(tmp_path, "d1")
    source = FuenteRota()
    now = [T0]
    enricher = Enricher(source=source,
                        scan=lambda: _entries("A", "B", "C", "D", "E"),
                        storage=lambda: storage, clock=lambda: now[0])
    enricher.ensure_started()
    _wait(enricher)

    status = enricher.status()
    assert status["offline"] is True
    assert status["running"] is False
    assert status["done"] == 3  # corta en el tercer error
    assert status["total"] == 5
    assert source.calls == ["A", "B", "C"]
    out = storage.load_artistinfo()
    assert set(out) == {"a", "b", "c"}
    assert all(record["status"] == "error" for record in out.values())

    # Antes de los 60 s no se reintenta.
    now[0] = T0 + 59
    enricher.ensure_started()
    assert enricher.status()["running"] is False
    assert source.calls == ["A", "B", "C"]

    # Pasado el minuto, la proxima llamada lo vuelve a arrancar.
    now[0] = T0 + 61
    enricher.ensure_started()
    _wait(enricher)
    assert len(source.calls) > 3


def test_enricher_no_repite_lo_que_esta_fresco(tmp_path):
    storage = _storage(tmp_path, "d1")
    storage.save_artistinfo({"a": _record("A", T0)})
    source = FuenteFalsa()
    enricher = Enricher(source=source, scan=lambda: _entries("A", "B"),
                        storage=lambda: storage, clock=lambda: T0)
    enricher.ensure_started()
    _wait(enricher)
    assert source.calls == ["B"]
    assert enricher.status()["done"] == 1


def test_enricher_completa_generos_de_los_candidatos(tmp_path):
    storage = _storage(tmp_path, "d1")
    similar = {"A": [{"name": "X", "mbid": "mx", "score": 1.0},
                     {"name": "Y", "mbid": "my", "score": 0.5}]}
    source = FuenteFalsa(similar=similar)
    enricher = Enricher(source=source, scan=lambda: _entries("A"),
                        storage=lambda: storage, clock=lambda: T0)
    enricher.ensure_started()
    _wait(enricher)

    assert source.calls == ["A"]
    assert set(source.genre_calls) == {"X", "Y"}
    out = storage.load_artistinfo()
    assert set(out) == {"a", "x", "y"}
    assert out["x"]["genres"] == [["rock", 3]]
    assert out["x"]["similar"] == []
    assert enricher.status()["done"] == 3
    assert enricher.status()["total"] == 3


class FuenteConPausa:
    """Doble que se frena en cada fase para poder mirar el status en el medio."""

    def __init__(self, similar: dict | None = None) -> None:
        self.similar = similar or {}
        self.calls: list[str] = []
        self.genre_calls: list[str] = []
        self.phase_one_started = threading.Event()
        self.phase_one_gate = threading.Event()
        self.phase_two_started = threading.Event()
        self.phase_two_gate = threading.Event()

    def fetch(self, name: str, *, similar: bool = True) -> dict:
        self.calls.append(name)
        self.phase_one_started.set()
        assert self.phase_one_gate.wait(5), "nadie solto la fase 1"
        return _record(name, T0, similar=self.similar.get(name, []))

    def fetch_genres(self, name: str) -> dict:
        self.genre_calls.append(name)
        self.phase_two_started.set()
        assert self.phase_two_gate.wait(5), "nadie solto la fase 2"
        return _record(name, T0)


def test_enricher_el_progreso_es_monotonico_en_ambas_fases(tmp_path):
    storage = _storage(tmp_path, "d1")
    source = FuenteConPausa(
        {"A": [{"name": "X", "mbid": "mx", "score": 1.0}]})
    enricher = Enricher(source=source, scan=lambda: _entries("A"),
                        storage=lambda: storage, clock=lambda: T0)
    enricher.ensure_started()

    # Fase 1 en curso: ya se sabe CUANTO falta (antes se veia {0, 0}).
    assert source.phase_one_started.wait(5)
    first = enricher.status()
    assert first == {"done": 0, "total": 1, "running": True, "offline": False}

    # Fase 1 terminada y fase 2 en curso: el total SUMA los candidatos.
    source.phase_one_gate.set()
    assert source.phase_two_started.wait(5)
    second = enricher.status()
    assert second == {"done": 1, "total": 2, "running": True, "offline": False}
    assert second["done"] >= first["done"]
    assert second["total"] >= first["total"]

    # Las dos fases terminaron: `running` baja y done llega al total.
    source.phase_two_gate.set()
    _wait(enricher)
    assert enricher.status() == {"done": 2, "total": 2, "running": False,
                                 "offline": False}


def test_enricher_no_reinicia_los_contadores_al_rearrancar(tmp_path):
    storage = _storage(tmp_path, "d1")
    source = FuenteFalsa()
    enricher = Enricher(source=source, scan=lambda: _entries("A"),
                        storage=lambda: storage, clock=lambda: T0,
                        rerun_after=0)
    enricher.ensure_started()
    _wait(enricher)
    done, total = enricher.status()["done"], enricher.status()["total"]
    assert done == total == 1

    # Otro GET arranca una corrida nueva (ya no queda nada fresco por buscar):
    # el status NO vuelve a {done: 0, total: 0}.
    enricher.ensure_started()
    assert enricher.status()["done"] == done
    assert enricher.status()["total"] == total
    _wait(enricher)
    assert enricher.status()["done"] == done
    assert enricher.status()["total"] == total


def test_enricher_no_se_relanza_en_cada_get_tras_terminar(tmp_path):
    # Cada GET de Discover llama ensure_started: recien terminado no debe
    # volver a correr (releeria la nube y diria running: true para siempre).
    storage = _storage(tmp_path, "d1")
    scans = []
    now = [T0]

    def scan():
        scans.append(1)
        return _entries("A")

    enricher = Enricher(source=FuenteFalsa(), scan=scan,
                        storage=lambda: storage, clock=lambda: now[0],
                        rerun_after=600)
    enricher.ensure_started()
    _wait(enricher)
    enricher.ensure_started()
    assert enricher.status()["running"] is False
    assert len(scans) == 1
    # Pasado el plazo si vuelve a mirar (puede haber musica nueva).
    now[0] = T0 + 601
    enricher.ensure_started()
    _wait(enricher)
    assert len(scans) == 2


def test_enricher_expone_las_fichas_que_tiene_en_memoria(tmp_path):
    storage = _storage(tmp_path, "d1")
    source = FuenteFalsa()
    enricher = Enricher(source=source, scan=lambda: _entries("A"),
                        storage=lambda: storage, clock=lambda: T0)
    # Antes de leer nada no hay copia: Discover cae al storage.
    assert enricher.records() is None

    enricher.ensure_started()
    _wait(enricher)
    records = enricher.records()
    assert set(records) == {"a"}
    # Es una COPIA: tocarla no cambia la del enricher.
    records.clear()
    assert set(enricher.records()) == {"a"}
