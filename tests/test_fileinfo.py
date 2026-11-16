"""Veredicto y procedencia por archivo (`fileinfo.py`).

Todo OFFLINE: el registro se arma de un `Track` y se guarda en un
`LocalStorage` temporal o en el Drive falso (`tests/fake_drive.py`).
"""
from __future__ import annotations

import json

import httpx
import pytest

from backend.app import fileinfo
from backend.app.fileinfo import (FileInfoBook, FileInfoFormatError,
                                  check_fields, clean_record, fileinfo_file,
                                  parse_fileinfo_file, record_for_file,
                                  record_for_ytdlp, with_checks)
from backend.app.models import Track
from backend.app.storage.local import STATE_DIR, LocalStorage

T0 = 1_760_000_000  # 2025-10-09, UTC
MES_0 = "2025-10"


def _rec(**over) -> dict:
    base = {"verdict": "match", "at": T0, "bytes": 1000, "meta": "itunes",
            "file": "youtube"}
    base.update(over)
    return base


# ------------------------------------------------------------------ clean_record
def test_clean_record_acepta_un_registro_completo():
    raw = _rec(meta_url="https://music.apple.com/x", file_url="https://youtu.be/a",
               title="Numb", artist="Linkin Park", real="Numb (Official Video)",
               real_by="video", score=0.8123)
    out = clean_record(raw)
    assert out["score"] == 0.81
    assert out["real_by"] == "video"
    assert out["meta_url"] == "https://music.apple.com/x"


@pytest.mark.parametrize("campo,valor", [
    ("verdict", "bien"), ("meta", "spotify"), ("file", "napster"),
    ("at", "ayer"), ("at", -1), ("at", True), ("bytes", None), ("bytes", 1.5),
])
def test_clean_record_rechaza_enums_y_tipos_malos(campo, valor):
    assert clean_record(_rec(**{campo: valor})) is None


def test_clean_record_descarta_urls_que_no_son_http_o_son_largas():
    out = clean_record(_rec(meta_url="javascript:alert(1)",
                            file_url="https://x.org/" + "a" * 400))
    assert "meta_url" not in out and "file_url" not in out


def test_clean_record_recorta_textos_y_ignora_real_by_sin_real():
    out = clean_record(_rec(title="  " + "t" * 500, real_by="tags", score=7))
    assert len(out["title"]) == 200
    assert "real_by" not in out and "score" not in out


# ------------------------------------------------------------- record_for_*
def _archive(**extra) -> Track:
    base = {"match": "match", "real_title": "Ghost>", "title_source": "tags",
            "match_score": 0.9, "item_url": "https://archive.org/details/x"}
    base.update(extra)
    return Track(source="archive", source_id="x", title="Ghost", artist="Phish",
                 extra=base)


@pytest.mark.parametrize("estado", ["match", "partial", "mismatch"])
def test_archive_guarda_el_veredicto_leido_de_los_tags(estado):
    rec = record_for_file(_archive(match=estado), 500, T0)
    assert rec["verdict"] == estado
    assert rec["real_by"] == "tags" and rec["real"] == "Ghost>"
    assert rec["meta"] == rec["file"] == "archive"
    assert rec["file_url"] == "https://archive.org/details/x"
    assert rec["title"] == "Ghost" and rec["bytes"] == 500


def test_archive_con_el_titulo_del_item_dice_item():
    rec = record_for_file(_archive(title_source="item-title"), 1, T0)
    assert rec["real_by"] == "item"


@pytest.mark.parametrize("origen", ["derived", "none"])
def test_archive_sin_tags_legibles_es_unknown(origen):
    rec = record_for_file(_archive(title_source=origen), 1, T0)
    assert rec["verdict"] == "unknown" and "real" not in rec


def test_lo_que_repite_el_cliente_fuera_del_enum_es_unknown():
    assert record_for_file(_archive(match="perfecto"), 1, T0)["verdict"] == "unknown"


@pytest.mark.parametrize("fuente,extra,url", [
    ("jamendo", {"shareurl": "https://jamen.do/t/1", "match": "match"},
     "https://jamen.do/t/1"),
    ("wikimedia", {"match": "match"}, None),
])
def test_jamendo_y_wikimedia_nunca_tienen_veredicto(fuente, extra, url):
    t = Track(source=fuente, source_id="1", title="T", artist="A", extra=extra)
    rec = record_for_file(t, 9, T0)
    assert rec["verdict"] == "unknown"
    assert rec["meta"] == rec["file"] == fuente
    assert rec.get("file_url") == url


def test_una_fuente_sin_registro_no_lo_inventa():
    t = Track(source="itunes", source_id="1", title="T", artist="A")
    assert record_for_file(t, 1, T0) is None


def _youtube(**extra) -> Track:
    base = {"webpage_url": "https://www.youtube.com/watch?v=abc",
            "item_url": "https://music.apple.com/ar/song/1", "from_itunes": True}
    base.update(extra)
    return Track(source="itunes", source_id="1", title="Numb",
                 artist="Linkin Park", extra=base)


def test_ficha_de_itunes_con_audio_de_youtube_son_dos_fuentes():
    rec = record_for_ytdlp(_youtube(), 4000, T0, query="numb linkin park",
                           video_title="Numb (Official Video) - Linkin Park",
                           vacuous=False)
    assert rec["meta"] == "itunes" and rec["file"] == "youtube"
    assert rec["meta_url"].startswith("https://music.apple.com")
    assert rec["file_url"].startswith("https://www.youtube.com")
    assert rec["real_by"] == "video"
    assert rec["verdict"] == "match" and rec["score"] == 1.0


def test_youtube_a_secas_tiene_la_misma_fuente_en_ficha_y_archivo():
    t = Track(source="ytdlp", source_id="abc", title="Numb", artist="LP",
              extra={"webpage_url": "https://www.youtube.com/watch?v=abc"})
    rec = record_for_ytdlp(t, 1, T0, query="numb", video_title="Numb",
                           vacuous=False)
    assert rec["meta"] == rec["file"] == "youtube"
    assert rec["meta_url"] == rec["file_url"]


def test_un_enlace_pegado_se_guarda_unknown_y_no_un_coincide_vacio():
    rec = record_for_ytdlp(_youtube(), 1, T0, query="https://youtu.be/abc",
                           video_title="Numb", vacuous=True)
    assert rec["verdict"] == "unknown" and "score" not in rec


def test_un_titulo_distinto_en_el_video_es_mismatch():
    rec = record_for_ytdlp(_youtube(), 1, T0, query="numb",
                           video_title="Cooking pasta in 5 minutes",
                           vacuous=False)
    assert rec["verdict"] == "mismatch"


# ------------------------------------------------------------- nombres y libro
def test_nombres_de_los_fragmentos_por_mes():
    name = fileinfo_file("dev-1", MES_0)
    assert name == "fileinfo-dev-1-2025-10.json"
    assert parse_fileinfo_file(name) == ("dev-1", MES_0)
    for malo in ("fileinfo-dev.json", "listens-d-2025-10.json",
                 "artistinfo-d-2025-10.json"):
        assert parse_fileinfo_file(malo) is None


def test_el_libro_se_serializa_estable_y_vuelve_igual():
    uno = FileInfoBook(files={"b": clean_record(_rec()),
                              "a": clean_record(_rec(bytes=5))})
    otro = FileInfoBook(files={"a": clean_record(_rec(bytes=5)),
                               "b": clean_record(_rec())})
    assert uno.to_bytes() == otro.to_bytes()
    assert FileInfoBook.from_bytes(uno.to_bytes()).files == uno.files


def test_una_version_desconocida_se_rechaza():
    with pytest.raises(FileInfoFormatError):
        FileInfoBook.from_bytes(b'{"version": 2, "files": {}}')
    with pytest.raises(FileInfoFormatError):
        FileInfoBook.from_bytes(b"no es json")


def test_un_registro_roto_no_tira_a_los_demas():
    data = json.dumps({"version": 1, "files": {
        "a": _rec(), "b": {"verdict": "bien"}}}).encode()
    assert set(FileInfoBook.from_bytes(data).files) == {"a"}


def test_merged_gana_el_at_mas_nuevo():
    viejo = FileInfoBook(files={"a": clean_record(_rec(at=T0, verdict="match"))})
    nuevo = FileInfoBook(files={"a": clean_record(_rec(at=T0 + 5,
                                                       verdict="mismatch"))})
    assert viejo.merged(nuevo).files["a"]["verdict"] == "mismatch"
    assert nuevo.merged(viejo).files["a"]["verdict"] == "mismatch"


# ------------------------------------------------------------------ el join
def test_check_fields_de_un_match_simple():
    out = check_fields(clean_record(_rec(meta="archive", file="archive")),
                       {"bytes": 1000})
    assert out == {"verdict": "match", "meta_src": "archive"}


def test_file_src_solo_aparece_si_difiere_y_real_solo_si_no_coincide():
    rec = clean_record(_rec(verdict="partial", real="Numb (Live)"))
    assert check_fields(rec, {"bytes": 1000}) == {
        "verdict": "partial", "meta_src": "itunes", "file_src": "youtube",
        "real": "Numb (Live)"}
    ok = clean_record(_rec(verdict="match", real="Numb"))
    assert "real" not in check_fields(ok, {"bytes": 1000})


def test_un_registro_de_otro_tamano_no_se_aplica():
    assert check_fields(clean_record(_rec()), {"bytes": 999}) == {}
    assert check_fields(None, {"bytes": 1}) == {}


def test_with_checks_no_muta_la_lista_de_entrada():
    files = [{"key": "A/a.mp3", "bytes": 1000}, {"key": "A/b.mp3", "bytes": 5}]
    out = with_checks(files, {"A/a.mp3": clean_record(_rec())})
    assert out[0]["verdict"] == "match" and "verdict" not in files[0]
    assert out[1] == files[1]
    assert with_checks(files, {}) is files


# ----------------------------------------------------------- storage local
def _local(tmp_path, device="d1") -> LocalStorage:
    return LocalStorage(tmp_path, device_id=device)


def test_local_guarda_en_la_carpeta_oculta_y_no_aparece_en_la_lista(tmp_path):
    storage = _local(tmp_path)
    (tmp_path / "A").mkdir()
    (tmp_path / "A" / "a.mp3").write_bytes(b"x" * 4)
    storage.save_fileinfo("A/a.mp3", clean_record(_rec(bytes=4)))

    assert (tmp_path / STATE_DIR / f"fileinfo-d1-{MES_0}.json").exists()
    assert [f.key for f in storage.list()] == ["A/a.mp3"]
    assert storage.load_fileinfo()["A/a.mp3"]["verdict"] == "match"


def test_dos_dispositivos_se_mergean_por_at(tmp_path):
    _local(tmp_path, "d1").save_fileinfo("k", clean_record(_rec(at=T0)))
    _local(tmp_path, "d2").save_fileinfo(
        "k", clean_record(_rec(at=T0 + 9, verdict="partial")))
    _local(tmp_path, "d2").save_fileinfo("otro", clean_record(_rec(at=T0 + 9)))

    vista = _local(tmp_path, "d3").load_fileinfo()
    assert vista["k"]["verdict"] == "partial"
    assert set(vista) == {"k", "otro"}


def test_un_guardado_solo_toca_el_fragmento_de_su_mes(tmp_path):
    storage = _local(tmp_path)
    storage.save_fileinfo("viejo", clean_record(_rec(at=T0)))
    mes_viejo = tmp_path / STATE_DIR / f"fileinfo-d1-{MES_0}.json"
    antes = mes_viejo.read_bytes()

    storage.save_fileinfo("nuevo", clean_record(_rec(at=T0 + 40 * 86400)))

    assert mes_viejo.read_bytes() == antes
    assert (tmp_path / STATE_DIR / "fileinfo-d1-2025-11.json").exists()


def test_un_fragmento_propio_ilegible_levanta_y_no_se_pisa(tmp_path):
    storage = _local(tmp_path)
    path = tmp_path / STATE_DIR / f"fileinfo-d1-{MES_0}.json"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"{roto")

    with pytest.raises(RuntimeError):
        storage.save_fileinfo("k", clean_record(_rec()))
    assert path.read_bytes() == b"{roto"


def test_un_fragmento_ajeno_ilegible_se_salta(tmp_path):
    _local(tmp_path, "d2").save_fileinfo("k", clean_record(_rec()))
    (tmp_path / STATE_DIR / f"fileinfo-d9-{MES_0}.json").write_bytes(b"{roto")
    assert set(_local(tmp_path, "d1").load_fileinfo()) == {"k"}


def test_un_registro_invalido_no_se_guarda(tmp_path):
    with pytest.raises(ValueError):
        _local(tmp_path).save_fileinfo("k", {"verdict": "bien"})
    assert not (tmp_path / STATE_DIR).exists()


def test_la_vista_dura_30_s_y_un_guardado_la_actualiza_en_el_acto(tmp_path):
    storage = _local(tmp_path)
    reloj = {"t": 100.0}
    storage._fileinfo_now = lambda: reloj["t"]
    assert storage.load_fileinfo() == {}

    # lo guarda OTRO dispositivo: esta vista no se entera hasta que vence
    _local(tmp_path, "d2").save_fileinfo("ajeno", clean_record(_rec()))
    assert storage.load_fileinfo() == {}
    # lo propio se ve al instante
    storage.save_fileinfo("propio", clean_record(_rec()))
    assert set(storage.load_fileinfo()) == {"propio"}

    reloj["t"] += fileinfo.TTL + 1
    assert set(storage.load_fileinfo()) == {"propio", "ajeno"}


# ----------------------------------------------------------------- en Drive
class _Tokens:
    def access_token(self) -> str:
        return "test-token"

    def invalidate(self) -> None:
        pass


def _drive(device: str, fake, snapshot=None):
    from backend.app.cloud.drive import DriveStorage

    client = httpx.Client(transport=httpx.MockTransport(fake))
    return DriveStorage(_Tokens(), client, device, snapshot=snapshot,
                        sleep=lambda _s: None)


def test_el_mismo_contrato_funciona_sobre_drive():
    from fake_drive import FakeDrive

    fake = FakeDrive()
    uno, dos = _drive("d1", fake), _drive("d2", fake)
    uno.save_fileinfo("k", clean_record(_rec(at=T0)))
    dos.save_fileinfo("k", clean_record(_rec(at=T0 + 9, verdict="mismatch")))

    assert _drive("d3", fake).load_fileinfo()["k"]["verdict"] == "mismatch"
    names = {f["name"] for f in fake.files.values()}
    assert {f"fileinfo-d1-{MES_0}.json", f"fileinfo-d2-{MES_0}.json"} <= names


def test_en_drive_un_guardado_es_una_subida_de_un_archivo_chico():
    from fake_drive import FakeDrive

    fake = FakeDrive()
    storage = _drive("d1", fake)
    storage.save_fileinfo("a", clean_record(_rec()))
    fake.reset_calls()
    storage.save_fileinfo("b", clean_record(_rec(at=T0 + 1)))

    escrituras = [c for c in fake.calls if c[0] in ("POST", "PATCH", "PUT")]
    assert len(escrituras) == 1
    assert not any("index-" in f["name"] for f in fake.files.values())


def test_en_drive_un_proceso_nuevo_reusa_la_copia_local_por_sello(tmp_path):
    from backend.app.cloud.snapshot import SmallFileSnapshot
    from fake_drive import FakeDrive

    fake = FakeDrive()
    uno = _drive("d1", fake, SmallFileSnapshot(tmp_path / "snap"))
    uno.save_fileinfo("k", clean_record(_rec()))
    _drive("d2", fake).save_fileinfo("otro", clean_record(_rec()))

    primero = _drive("d3", fake, SmallFileSnapshot(tmp_path / "snap3"))
    assert set(primero.load_fileinfo()) == {"k", "otro"}

    fake.reset_calls()
    segundo = _drive("d3", fake, SmallFileSnapshot(tmp_path / "snap3"))
    assert set(segundo.load_fileinfo()) == {"k", "otro"}
    descargas = [p for m, p in fake.calls
                 if m == "GET" and p.startswith("/drive/v3/files/")]
    assert descargas == [], "nada cambio: no se vuelve a bajar ningun fragmento"
