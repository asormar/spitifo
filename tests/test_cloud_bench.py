"""Tests OFFLINE del benchmark de proveedores (backend/app/cloud/bench.py).

Nada sale a internet: todo pasa por `httpx.MockTransport`. Se prueban los
ayudantes puros (percentiles, Content-Range, armado de requests de Drive,
troceo de la subida de OneDrive) y la medicion con un stream simulado.
"""
from __future__ import annotations

import json

import httpx
import pytest

from backend.app.cloud import bench


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


# --------------------------------------------------------------------- percentil
def test_percentile_interpola_lineal():
    assert bench.percentile([1, 2, 3, 4], 50) == 2.5
    assert bench.percentile([0, 10], 50) == 5.0
    assert bench.percentile([5], 95) == 5.0


def test_percentile_extremos():
    data = list(range(1, 11))
    assert bench.percentile(data, 0) == 1
    assert bench.percentile(data, 100) == 10
    assert bench.percentile(data, 95) == pytest.approx(9.55)


def test_percentile_lista_vacia_falla():
    with pytest.raises(ValueError):
        bench.percentile([], 50)


# --------------------------------------------------------------- Content-Range
def test_parse_content_range_valido():
    assert bench.parse_content_range("bytes 0-1023/4096") == (0, 1023, 4096)
    assert bench.parse_content_range("bytes 0-0/*") == (0, 0, None)


def test_parse_content_range_invalido():
    assert bench.parse_content_range(None) is None
    assert bench.parse_content_range("") is None
    assert bench.parse_content_range("0-10/100") is None
    assert bench.parse_content_range("bytes 5-2/10") is None


def test_range_matches_y_validate_ranged():
    assert bench.range_matches("bytes 10-20/100", 10, 20) is True
    assert bench.range_matches("bytes 10-19/100", 10, 20) is False
    assert bench.validate_ranged(206, "bytes 0-9/100", 0, 9) is True
    assert bench.validate_ranged(200, "bytes 0-9/100", 0, 9) is False
    assert bench.validate_ranged(206, None, 0, 9) is False


# --------------------------------------------------------------------- Drive
def test_drive_folder_query_trae_lo_que_pide_el_adr():
    q = bench.drive_folder_query("Spitifo")
    assert "name='Spitifo'" in q
    assert "mimeType='application/vnd.google-apps.folder'" in q
    assert "trashed=false" in q


def test_drive_find_or_create_crea_si_falta():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "GET":
            return httpx.Response(200, json={"files": []})
        return httpx.Response(200, json={"id": "folder-1"})

    with _client(handler) as client:
        folder = bench.drive_find_or_create_folder(
            client, {"Authorization": "Bearer x"})

    assert folder == "folder-1"
    assert [r.method for r in seen] == ["GET", "POST"]
    get, post = seen
    assert get.url.params["fields"] == "files(id,name)"
    assert "trashed=false" in get.url.params["q"]
    assert json.loads(post.content) == {
        "name": "Spitifo", "mimeType": bench.DRIVE_FOLDER_MIME}
    assert post.headers["Authorization"] == "Bearer x"


def test_drive_find_or_create_reusa_si_existe():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200, json={"files": [{"id": "folder-9", "name": "Spitifo"}]})

    with _client(handler) as client:
        folder = bench.drive_find_or_create_folder(client, {})

    assert folder == "folder-9"
    assert len(seen) == 1


def test_drive_find_file_arma_la_query_del_hijo():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["q"] = request.url.params["q"]
        seen["fields"] = request.url.params["fields"]
        return httpx.Response(200, json={"files": [
            {"id": "f1", "name": "bench-x.m4a", "size": "10"}]})

    with _client(handler) as client:
        found = bench.drive_find_file(client, {}, "folder-1", "bench-x.m4a")

    assert found == {"id": "f1", "name": "bench-x.m4a", "size": "10"}
    assert "'folder-1' in parents" in seen["q"]
    assert "name='bench-x.m4a'" in seen["q"]
    assert seen["fields"] == "files(id,name,size)"


def test_drive_find_file_devuelve_none_si_no_esta():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"files": []})

    with _client(handler) as client:
        assert bench.drive_find_file(client, {}, "folder-1", "x") is None


def test_drive_upload_usa_el_location_de_la_sesion():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "POST":
            return httpx.Response(
                200, headers={"Location": "https://upload.example/session/1"})
        return httpx.Response(200, json={"id": "file-1"})

    with _client(handler) as client:
        file_id = bench.drive_upload(
            client, {"Authorization": "Bearer x"}, "folder-1", "bench-x",
            b"abc")

    assert file_id == "file-1"
    post, put = seen
    assert post.url.params["uploadType"] == "resumable"
    assert json.loads(post.content) == {
        "name": "bench-x", "parents": ["folder-1"]}
    assert str(put.url) == "https://upload.example/session/1"
    assert put.content == b"abc"


# ------------------------------------------------------------------- OneDrive
def test_upload_ranges_cubre_todo_el_archivo():
    assert bench.upload_ranges(10, 4) == [(0, 3), (4, 7), (8, 9)]
    assert bench.upload_ranges(8, 4) == [(0, 3), (4, 7)]
    assert bench.upload_ranges(0, 4) == []


def test_upload_ranges_chunk_invalido():
    with pytest.raises(ValueError):
        bench.upload_ranges(10, 0)


def test_content_range_header():
    assert bench.content_range_header(0, 3, 10) == "bytes 0-3/10"


def test_onedrive_upload_trocea_sin_authorization():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(202, json={"id": "item-1"})

    with _client(handler) as client:
        item_id = bench.onedrive_upload(
            client, "https://upload.example/s", b"0123456789", chunk=4)

    assert item_id == "item-1"
    assert [r.method for r in seen] == ["PUT", "PUT", "PUT"]
    assert [r.headers["Content-Range"] for r in seen] == [
        "bytes 0-3/10", "bytes 4-7/10", "bytes 8-9/10"]
    assert [len(r.content) for r in seen] == [4, 4, 2]
    # Graph RECHAZA el Authorization en el uploadUrl.
    assert all("authorization" not in r.headers for r in seen)


def test_onedrive_find_item_404_es_ausente():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": {"code": "itemNotFound"}})

    with _client(handler) as client:
        assert bench.onedrive_find_item(client, {}, "bench-x.m4a") is None


def test_onedrive_create_session_arma_la_url_del_approot():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"uploadUrl": "https://upload.example/s"})

    with _client(handler) as client:
        url = bench.onedrive_create_session(
            client, {"Authorization": "Bearer x"}, "bench-x.m4a")

    assert url == "https://upload.example/s"
    assert seen["method"] == "POST"
    assert seen["url"].endswith(
        "/approot:/bench/bench-x.m4a:/createUploadSession")


def test_onedrive_presigned_url_pide_el_select():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["select"] = request.url.params["select"]
        return httpx.Response(200, json={
            "id": "i", "@microsoft.graph.downloadUrl": "https://dl.example/x"})

    with _client(handler) as client:
        url = bench.onedrive_presigned_url(client, {}, "i")

    assert url == "https://dl.example/x"
    assert seen["select"] == "id,@microsoft.graph.downloadUrl"


# ------------------------------------------------------------------ mediciones
def test_measure_range_valida_206_y_no_negativos():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["range"] == "bytes=0-1023"
        return httpx.Response(
            206, headers={"Content-Range": "bytes 0-1023/4096"},
            content=b"x" * 4096)

    with _client(handler) as client:
        timing = bench.measure_range(client, "https://x/y", 0, 1023, 1024)

    assert timing.ok is True
    assert timing.status_code == 206
    assert timing.first_byte_s >= 0.0
    assert timing.first_chunk_s >= 0.0
    assert timing.first_chunk_s >= timing.first_byte_s


def test_measure_range_falla_si_no_es_206():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"0123456789")

    with _client(handler) as client:
        timing = bench.measure_range(client, "https://x/y", 0, 9, 10)

    assert timing.ok is False
    assert timing.status_code == 200
    assert timing.error


def test_measure_range_falla_si_el_content_range_no_coincide():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            206, headers={"Content-Range": "bytes 0-9/100"},
            content=b"0123456789")

    with _client(handler) as client:
        timing = bench.measure_range(client, "https://x/y", 10, 19, 10)

    assert timing.ok is False
    assert timing.error


def test_measure_full_suma_bytes_y_throughput():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"a" * 1024)

    with _client(handler) as client:
        timing = bench.measure_full(client, "https://x/y")

    assert timing.ok is True
    assert timing.nbytes == 1024
    assert timing.total_s >= 0.0
    assert timing.throughput_kbit_s >= 0.0
    assert timing.max_gap_s >= 0.0


# ---------------------------------------------------------------------- informe
def _samples() -> dict[str, list[dict]]:
    return {
        "first_bytes": [
            {"first_byte_s": 0.2, "first_chunk_s": 0.4, "ok": True}],
        "seek_middle": [
            {"first_byte_s": 0.3, "first_chunk_s": 0.5, "ok": True}],
        "full_download": [
            {"total_s": 10.0, "max_gap_s": 0.01, "throughput_kbit_s": 100.0,
             "ok": True}],
    }


def test_build_summary_calcula_ms_por_metrica():
    summary = bench.build_summary(_samples())
    assert summary["first_bytes:first_chunk"]["p50_ms"] == pytest.approx(400.0)
    assert summary["seek_middle:first_chunk"]["p50_ms"] == pytest.approx(500.0)
    assert "full_download:total" in summary
    assert "full_download:max_gap" in summary


def test_count_failures():
    samples = _samples()
    assert bench.count_failures(samples) == {
        "first_bytes": 0, "seek_middle": 0, "full_download": 0}
    samples["first_bytes"][0]["ok"] = False
    assert bench.count_failures(samples)["first_bytes"] == 1


def test_evaluate_targets_pass():
    targets = bench.evaluate_targets(bench.build_summary(_samples()), 3.0)
    assert targets["first_audio_p50_under_1s"]["pass"] is True
    assert targets["seek_p50_under_1s"]["pass"] is True
    assert targets["throughput_ratio_at_least_2"]["pass"] is True


def test_evaluate_targets_fail():
    samples = _samples()
    samples["first_bytes"][0]["first_chunk_s"] = 1.5
    samples["seek_middle"][0]["first_chunk_s"] = 2.0
    targets = bench.evaluate_targets(bench.build_summary(samples), 1.0)
    assert targets["first_audio_p50_under_1s"]["pass"] is False
    assert targets["seek_p50_under_1s"]["pass"] is False
    assert targets["throughput_ratio_at_least_2"]["pass"] is False


def test_evaluate_targets_sin_datos_es_none():
    targets = bench.evaluate_targets({}, None)
    assert targets["first_audio_p50_under_1s"]["pass"] is None
    assert targets["seek_p50_under_1s"]["pass"] is None
    assert targets["throughput_ratio_at_least_2"]["pass"] is None


def test_drive_query_escapa_comillas():
    q = bench.drive_children_query("fid", "bench-it's.mp3")
    assert r"name='bench-it\'s.mp3'" in q
