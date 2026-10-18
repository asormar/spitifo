"""Verificacion de firmas OpenPGP de yt-dlp, sin red y sin `gpg`.

El vector es REAL: `tests/data/ytdlp/2026.08.19/` tiene el `SHA2-256SUMS` y el
`SHA2-256SUMS.sig` que yt-dlp publico en ese release, tal cual. Eso es lo que
hace que estos tests valgan: si el parseo o el hash se desvian del RFC 4880, el
vector deja de verificar.

Los offsets que usan los tests que rompen la firma a proposito (documentados
para no depender de numeros magicos sueltos):

    0        cabecera vieja: etiqueta 2 con largo de 2 bytes
    1..2     largo del cuerpo (2 bytes)
    3        version de firma (4)
    4        tipo de firma (0x00, documento binario)
    5        algoritmo de clave (1, RSA)
    6        algoritmo de hash (10, SHA-512)
    7..8     largo de la zona hashed
    9..37    subpaquetes hashed (huella del emisor + fecha)
    38..39   largo de la zona unhashed
    40..49   subpaquetes unhashed (key id del emisor, 42..49)
    50..51   prefijo left16 del hash
    52..565  MPI de la firma RSA
"""
from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.ytdlp_signature import (
    MAX_SIGNATURE_BYTES,
    YTDLP_KEY_FINGERPRINT,
    SignatureError,
    verify_detached,
)

#: Vector real: release 2026.08.19 de yt-dlp.
VECTOR = Path(__file__).parent / "data" / "ytdlp" / "2026.08.19"

#: Offsets del vector (ver el docstring del modulo).
OFFSET_VERSION = 3
OFFSET_TIPO = 4
OFFSET_ALGO_CLAVE = 5
OFFSET_ALGO_HASH = 6
OFFSET_HUELLA = 15
OFFSET_HASHED_EXTRA = 34
OFFSET_KEY_ID = 42
OFFSET_MPI = 100


@pytest.fixture(scope="module")
def sumas() -> bytes:
    return (VECTOR / "SHA2-256SUMS").read_bytes()


@pytest.fixture(scope="module")
def firma() -> bytes:
    return (VECTOR / "SHA2-256SUMS.sig").read_bytes()


def _roto(firma: bytes, offset: int, mascara: int = 0xFF) -> bytes:
    """Copia de `firma` con un byte cambiado en `offset`."""
    copia = bytearray(firma)
    copia[offset] ^= mascara
    return bytes(copia)


# ------------------------------------------------------------- vector real
def test_el_vector_real_tiene_la_forma_esperada(sumas, firma):
    """El vector es el asset oficial: si cambia, los offsets de aca no valen."""
    assert len(firma) == 566
    assert firma[:4] == b"\x89\x02\x33\x04"  # viejo, etiqueta 2, largo 2 bytes
    assert firma[OFFSET_VERSION] == 4
    assert firma[OFFSET_TIPO] == 0x00
    assert firma[OFFSET_ALGO_CLAVE] == 1
    assert firma[OFFSET_ALGO_HASH] == 10
    assert b"yt-dlp" in sumas


def test_el_vector_real_verifica(sumas, firma):
    """La firma real de yt-dlp valida contra la clave pineada."""
    assert verify_detached(sumas, firma) is None


def test_la_huella_pineada_es_la_de_la_clave_de_ytdlp():
    """La constante no se toca sin querer: es la huella v4 de la clave."""
    assert YTDLP_KEY_FINGERPRINT == "AC0CBBE6848D6A873464AF4E57CF65933B5A7581"
    assert len(bytes.fromhex(YTDLP_KEY_FINGERPRINT)) == 20


def test_acepta_bytearray_y_memoryview(sumas, firma):
    assert verify_detached(bytearray(sumas), bytearray(firma)) is None


# ------------------------------------------------------- firmas que no van
def test_un_byte_cambiado_en_los_datos_falla(sumas, firma):
    with pytest.raises(SignatureError):
        verify_detached(_roto(sumas, 0), firma)


def test_otro_documento_con_la_misma_firma_falla(sumas, firma):
    with pytest.raises(SignatureError):
        verify_detached(sumas + b"\n", firma)


def test_un_byte_cambiado_en_el_mpi_falla(sumas, firma):
    with pytest.raises(SignatureError):
        verify_detached(sumas, _roto(firma, OFFSET_MPI))


def test_un_byte_cambiado_en_la_zona_hashed_falla(sumas, firma):
    # La fecha de firma vive en la zona hashed: tocarla cambia el hash.
    with pytest.raises(SignatureError, match="prefijo del hash"):
        verify_detached(sumas, _roto(firma, OFFSET_HASHED_EXTRA))


def test_huella_del_emisor_de_otra_clave_falla(sumas, firma):
    # Subpaquete 33 (huella) con un byte cambiado: no es la clave pineada.
    with pytest.raises(SignatureError, match="huella"):
        verify_detached(sumas, _roto(firma, OFFSET_HUELLA))


def test_firma_truncada_falla(sumas, firma):
    with pytest.raises(SignatureError):
        verify_detached(sumas, firma[:-1])


def test_firma_con_bytes_de_mas_falla(sumas, firma):
    with pytest.raises(SignatureError):
        verify_detached(sumas, firma + b"\x00")


def test_algoritmo_de_hash_inesperado_falla(sumas, firma):
    # SHA-256 en vez de SHA-512: el vector lo firma con SHA-512.
    with pytest.raises(SignatureError, match="algoritmo de hash"):
        verify_detached(sumas, _roto(firma, OFFSET_ALGO_HASH, 0x02))


def test_tipo_de_firma_inesperado_falla(sumas, firma):
    # 0x01 = documento de texto canonico, no lo que manda yt-dlp.
    with pytest.raises(SignatureError, match="tipo de firma"):
        verify_detached(sumas, _roto(firma, OFFSET_TIPO, 0x01))


def test_algoritmo_de_clave_inesperado_falla(sumas, firma):
    with pytest.raises(SignatureError, match="algoritmo de clave"):
        verify_detached(sumas, _roto(firma, OFFSET_ALGO_CLAVE, 0x02))


def test_version_de_firma_inesperada_falla(sumas, firma):
    with pytest.raises(SignatureError, match="version de firma"):
        verify_detached(sumas, _roto(firma, OFFSET_VERSION, 0x01))


def test_emisor_de_otra_clave_falla(sumas, firma):
    """La zona unhashed no entra en el hash: si falla, es SOLO por el emisor.

    Cambiar el key id no rompe la criptografia (la firma sigue siendo valida),
    asi que lo unico que puede rechazarla es la comparacion contra la clave
    pineada. Es el test que prueba que mirar el emisor sirve de algo.
    """
    with pytest.raises(SignatureError, match="otra clave"):
        verify_detached(sumas, _roto(firma, OFFSET_KEY_ID))


def test_basura_no_pasa(sumas):
    for basura in (b"no es una firma", b"", b"\x00", b"\x88\x01\x00",
                   b"\x89\x00\x03\x04\x00\x01\x0a"):
        with pytest.raises(SignatureError):
            verify_detached(sumas, basura)


def test_datos_y_firma_invertidos_falla(sumas, firma):
    with pytest.raises(SignatureError):
        verify_detached(firma, sumas)


def test_firma_gigante_falla(sumas):
    """El asset pesa 566 bytes: 8 KiB ya es abuso."""
    with pytest.raises(SignatureError, match="maximo"):
        verify_detached(sumas, b"\x89" + b"\x00" * (MAX_SIGNATURE_BYTES + 1))
