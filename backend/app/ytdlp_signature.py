"""Verificacion de firmas OpenPGP de yt-dlp, en Python puro (sin `gpg`).

yt-dlp firma `SHA2-256SUMS` con su clave OpenPGP de release y publica la firma
como `SHA2-256SUMS.sig`. Confiar en las sumas SIN mirar la firma no sirve de
mucho: las dos salen del mismo release de GitHub, asi que quien pueda tocar una
puede tocar la otra. Con la firma, en cambio, la suma solo vale si la firmo la
clave de yt-dlp, y esa clave vive aca adentro, pineada.

Restricciones del proyecto: Android/Chaquopy, sin binarios externos y sin
dependencias nuevas. Por eso esto es RFC 4880 a mano con la stdlib: se parsea el
paquete de firma detached, se recalcula el hash y se verifica la RSA con
`pow()`. No hay validacion de subpaquetes que no hagan falta ni de la clave
publica: la clave es una constante.

Alcance deliberadamente chico, porque solo tiene que aceptar EXACTAMENTE lo que
manda yt-dlp (un vector real en `tests/data/ytdlp/`):

- paquete OpenPGP viejo o nuevo, etiqueta 2 (firma), version 4;
- tipo de firma 0x00 (documento binario), algoritmo de clave 1 (RSA),
  algoritmo de hash 10 (SHA-512);
- el emisor tiene que estar declarado (subpaquete 33, huella, o 16, key id) y
  tiene que ser la clave pineada.

Cualquier otra cosa -otro algoritmo, otra clave, un paquete truncado, bytes de
mas- es `SignatureError`. Mejor rechazar de mas que aceptar una firma que no
corresponde.
"""
from __future__ import annotations

import hashlib
import hmac

#: Huella v4 de la clave de firma de yt-dlp (RSA-4096, creada 2023-02-26).
#: Es la misma desde entonces; si yt-dlp la rota, esto hay que actualizarlo a
#: mano (y con eso, los vectores de `tests/data/ytdlp/`).
YTDLP_KEY_FINGERPRINT = "AC0CBBE6848D6A873464AF4E57CF65933B5A7581"
#: Modulo RSA-4096 de la clave pineada, como literal hex (envuelto a 70
#: columnas). Junto con `_KEY_E` alcanza para verificar: no hace falta la clave
#: publica entera ni, mucho menos, el binario `gpg`.
_KEY_N = int(
    "f4ac5f738c63c0b74b6196de42d5e6f371c0155fb35bd6ff9ea908e4f961197531"
    "135428375803399e002b947766fdf66acd480efa9018ac1eb418a7a0edf7d40dff"
    "92d1714a11975e44b61e01aaaa2a14a26d56a50e3bce04ecedbb75bad3b1cb1134"
    "00a80ef04cfb88b765aa9a92fad0d21ccabdbb2f1aa681d37798dbd9da22cef9b3"
    "f49ca47f0be3e013d1f8cadcb00dad76cccc7a3e66429d538e3aee97644166754c"
    "71750f5f143a9df4b701298d8b0ce712628d6c698d185a26561edcd5a19bb590ec"
    "e39d2e458eaff204724b2260c7ee93711e6eecfcf9dababa66405b4316bba4b7ed"
    "a58439e9294986aff23fdc81ea1ff5fef673e84b8ba2a90e47a5b941f012bee167"
    "e96a2120ef92e7bee38f7d920f298c976bfd00ed0a2333080eac3f3ca334fe5429"
    "0a92427e8a35d9ee01cd8e670169474a2bb7c320439823adcbc9ce905a41904e28"
    "057df4945d61c308ef5a5cd84fdde8ea15680632d094b2b6e4709916b9663bab90"
    "11cbfd391db48cdcae0353d7aab67c66895d5643c9d7b88f49809411be1e4f4e49"
    "f2e4bb71ab3726aaf58ef538c705baecd7804f10ef5f717c4a2ff08505bcd70d2b"
    "ef02002b76aaa53289dc43fca271395f2faab327c10a162a96d7840c4dd027e92b"
    "ae653a1d5c24e2227c284fb5a38ee14f28a76f7c7d463f86e7a9dcd39f32f10920"
    "c812d7f27cfb085fef4623b26493fcd98d", 16)
#: Exponente publico RSA (F4, el de siempre).
_KEY_E = 65537

#: Cuantos bytes tiene el modulo, o sea el tamano de la firma RSA.
_KEY_BYTES = (_KEY_N.bit_length() + 7) // 8
#: Huella pineada como bytes, para comparar contra los subpaquetes.
_KEY_FINGERPRINT_BYTES = bytes.fromhex(YTDLP_KEY_FINGERPRINT)
#: Key id: los ultimos 8 bytes de la huella (RFC 4880, 12.2).
_KEY_ID = _KEY_FINGERPRINT_BYTES[-8:]

#: El asset real pesa 566 bytes; 8 KiB es margen de sobra y corta el abuso.
MAX_SIGNATURE_BYTES = 8 * 1024

_PACKET_SIGNATURE = 2
_SIG_VERSION = 4
_SIG_TYPE_BINARY = 0x00
_PUBKEY_RSA = 1
_HASH_SHA512 = 10
_SUBPACKET_ISSUER_KEY_ID = 16
_SUBPACKET_ISSUER_FINGERPRINT = 33

#: Prefijo DER de `DigestInfo` para SHA-512 (RFC 8017, 9.2, nota 1).
_SHA512_DIGESTINFO_PREFIX = bytes.fromhex(
    "3051300d060960864801650304020305000440")

#: `0x04` version + `0xFF` + largo de 4 bytes: cola del hash (RFC 4880, 5.2.4).
_HASH_TRAILER = b"\x04\xff"
#: Bytes que el trailer cuenta: version, tipo, algoritmos y largo de hashed.
_HASHED_HEADER_BYTES = 6

#: Minimo de bytes 0xFF en el padding de EMSA-PKCS1-v1_5 (RFC 8017, 9.2).
_MIN_PADDING = 8


class SignatureError(ValueError):
    """La firma no es valida, no es del tipo esperado o no es de la clave."""


def verify_detached(data: bytes, signature: bytes) -> None:
    """Verifica que `signature` sea una firma detached valida de `data`.

    Acepta solo firmas de la clave pineada de yt-dlp (RSA/SHA-512, documento
    binario). Devuelve None si esta todo bien; lanza `SignatureError` con el
    motivo si no. Nunca lanza otra cosa: la idea es que el que llama atrape
    `SignatureError` y descarte lo que iba a verificar.
    """
    if not isinstance(signature, (bytes, bytearray, memoryview)):
        raise SignatureError("la firma no es bytes")
    signature = bytes(signature)
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise SignatureError("los datos no son bytes")
    data = bytes(data)

    if not signature:
        raise SignatureError("la firma esta vacia")
    if len(signature) > MAX_SIGNATURE_BYTES:
        raise SignatureError(
            f"la firma pesa {len(signature)} bytes (maximo "
            f"{MAX_SIGNATURE_BYTES})")

    cuerpo = _cuerpo_del_paquete(signature)
    firma = _parsear_cuerpo(cuerpo)
    _verificar_emisor(firma.hashed, firma.unhashed)

    digest = _hash_del_documento(data, firma)
    if digest[:2] != firma.left16:
        raise SignatureError("el prefijo del hash no coincide")

    _verificar_rsa(firma.mpi, digest)


# --------------------------------------------------------------------- parseo
class _Firma:
    """Lo que se rescato del paquete: subpaquetes, prefijo y MPI."""

    __slots__ = ("hashed", "unhashed", "left16", "mpi")

    def __init__(self, hashed: bytes, unhashed: bytes, left16: bytes,
                 mpi: bytes) -> None:
        self.hashed = hashed
        self.unhashed = unhashed
        self.left16 = left16
        self.mpi = mpi


def _cuerpo_del_paquete(firma: bytes) -> bytes:
    """Cuerpo del unico paquete de la firma, sin la cabecera de largo.

    Soporta el formato viejo (largo de 1, 2 o 4 bytes) y el nuevo. Exige que el
    paquete sea exactamente todo el archivo: un `.sig` con bytes de mas no es
    un `.sig`.
    """
    primera = firma[0]
    if not primera & 0x80:
        raise SignatureError("el primer byte no es una cabecera OpenPGP")
    if primera & 0x40:
        etiqueta, inicio, largo = _cabecera_nueva(firma, primera)
    else:
        etiqueta, inicio, largo = _cabecera_vieja(firma, primera)
    if etiqueta != _PACKET_SIGNATURE:
        raise SignatureError(f"se esperaba un paquete de firma (2), no {etiqueta}")
    if inicio + largo != len(firma):
        raise SignatureError("el paquete de firma no ocupa todo el archivo")
    return firma[inicio:inicio + largo]


def _cabecera_vieja(firma: bytes, primera: int) -> tuple[int, int, int]:
    """Etiqueta, offset del cuerpo y largo, para una cabecera de formato viejo."""
    etiqueta = (primera >> 2) & 0x0F
    tipo = primera & 0x03
    if tipo == 3:
        raise SignatureError("largo indeterminado: no se puede delimitar")
    octetos = 1 << tipo  # 1, 2 o 4 bytes de largo
    if len(firma) < 1 + octetos:
        raise SignatureError("la cabecera del paquete esta truncada")
    largo = int.from_bytes(firma[1:1 + octetos], "big")
    return etiqueta, 1 + octetos, largo


def _cabecera_nueva(firma: bytes, primera: int) -> tuple[int, int, int]:
    """Etiqueta, offset del cuerpo y largo, para una cabecera de formato nuevo."""
    etiqueta = primera & 0x3F
    if len(firma) < 2:
        raise SignatureError("la cabecera del paquete esta truncada")
    octeto = firma[1]
    if octeto < 192:
        return etiqueta, 2, octeto
    if octeto < 224:
        if len(firma) < 3:
            raise SignatureError("la cabecera del paquete esta truncada")
        return etiqueta, 3, ((octeto - 192) << 8) + firma[2] + 192
    if octeto == 255:
        if len(firma) < 6:
            raise SignatureError("la cabecera del paquete esta truncada")
        return etiqueta, 6, int.from_bytes(firma[2:6], "big")
    raise SignatureError("largo parcial en la cabecera del paquete")


def _parsear_cuerpo(cuerpo: bytes) -> _Firma:
    """Cuerpo de la firma v4: encabezado, subpaquetes, prefijo y MPI."""
    if len(cuerpo) < 6:
        raise SignatureError("el cuerpo de la firma es demasiado corto")
    version, tipo, algo_pub, algo_hash = cuerpo[0], cuerpo[1], cuerpo[2], cuerpo[3]
    if version != _SIG_VERSION:
        raise SignatureError(f"version de firma no soportada: {version}")
    if tipo != _SIG_TYPE_BINARY:
        raise SignatureError(f"tipo de firma no soportado: {tipo:#04x}")
    if algo_pub != _PUBKEY_RSA:
        raise SignatureError(f"algoritmo de clave no soportado: {algo_pub}")
    if algo_hash != _HASH_SHA512:
        raise SignatureError(f"algoritmo de hash no soportado: {algo_hash}")

    pos = 4
    hashed, pos = _tomar_zona(cuerpo, pos)
    unhashed, pos = _tomar_zona(cuerpo, pos)
    left16, pos = _tomar(cuerpo, pos, 2)

    mpi, pos = _tomar_mpi(cuerpo, pos)
    if pos != len(cuerpo):
        raise SignatureError("hay bytes de mas despues de la firma")
    return _Firma(hashed, unhashed, left16, mpi)


def _tomar(cuerpo: bytes, pos: int, largo: int) -> tuple[bytes, int]:
    """Corta `largo` bytes desde `pos`, o lanza si no alcanzan."""
    if pos + largo > len(cuerpo):
        raise SignatureError("el paquete esta truncado")
    return cuerpo[pos:pos + largo], pos + largo


def _tomar_zona(cuerpo: bytes, pos: int) -> tuple[bytes, int]:
    """Zona de subpaquetes: un largo de 2 bytes y despues los subpaquetes."""
    crudo, pos = _tomar(cuerpo, pos, 2)
    largo = int.from_bytes(crudo, "big")
    return _tomar(cuerpo, pos, largo)


def _tomar_mpi(cuerpo: bytes, pos: int) -> tuple[bytes, int]:
    """MPI de la firma RSA: 2 bytes de bits y despues los bytes del valor.

    No se reinterpreta el valor: alcanza con que el largo coincida con los bits
    declarados, no sea mas grande que el modulo de la clave y no se pase del
    cuerpo.
    """
    crudo, pos = _tomar(cuerpo, pos, 2)
    bits = int.from_bytes(crudo, "big")
    if bits == 0:
        raise SignatureError("la firma RSA esta vacia")
    if bits > _KEY_N.bit_length():
        raise SignatureError("la firma RSA es mas grande que la clave pineada")
    mpi, pos = _tomar(cuerpo, pos, (bits + 7) // 8)
    if int.from_bytes(mpi, "big").bit_length() != bits:
        raise SignatureError("el MPI de la firma declara bits de mas")
    return mpi, pos


def _subpaquetes(area: bytes) -> list[tuple[int, bytes]]:
    """Subpaquetes (tipo sin el bit critico, cuerpo) de una zona de la firma."""
    subpaquetes: list[tuple[int, bytes]] = []
    pos = 0
    while pos < len(area):
        largo, pos = _largo_subpaquete(area, pos)
        if largo < 1:
            raise SignatureError("subpaquete de largo cero")
        tipo, pos = _tomar(area, pos, 1)
        # El largo se cuenta desde el octeto de tipo, que ya se consumio.
        cuerpo, pos = _tomar(area, pos, largo - 1)
        subpaquetes.append((tipo[0] & 0x7F, cuerpo))
    return subpaquetes


def _largo_subpaquete(area: bytes, pos: int) -> tuple[int, int]:
    """Largo de un subpaquete: 1 byte, 2 o 5 (RFC 4880, 5.2.3.1)."""
    octeto, pos = _tomar(area, pos, 1)
    valor = octeto[0]
    if valor < 192:
        return valor, pos
    if valor < 255:
        segundo, pos = _tomar(area, pos, 1)
        return ((valor - 192) << 8) + segundo[0] + 192, pos
    crudo, pos = _tomar(area, pos, 4)
    return int.from_bytes(crudo, "big"), pos


# -------------------------------------------------------------------- emisor
def _verificar_emisor(hashed: bytes, unhashed: bytes) -> None:
    """Exige que la firma declare como emisor a la clave pineada.

    Vale huella (subpaquete 33) o key id (subpaquete 16), en cualquiera de las
    dos zonas. Si declara algo distinto, o no declara nada, se rechaza: una
    firma valida de OTRA clave no nos sirve de nada.
    """
    declarado = False
    for area in (hashed, unhashed):
        for tipo, cuerpo in _subpaquetes(area):
            if tipo == _SUBPACKET_ISSUER_FINGERPRINT:
                declarado = True
                if len(cuerpo) != 21 or cuerpo[0] != _SIG_VERSION:
                    raise SignatureError("subpaquete de huella mal formado")
                if cuerpo[1:] != _KEY_FINGERPRINT_BYTES:
                    raise SignatureError("la firma es de otra clave (huella)")
            elif tipo == _SUBPACKET_ISSUER_KEY_ID:
                declarado = True
                if len(cuerpo) != 8:
                    raise SignatureError("subpaquete de key id mal formado")
                if cuerpo != _KEY_ID:
                    raise SignatureError("la firma es de otra clave (key id)")
    if not declarado:
        raise SignatureError("la firma no declara de quien es")


# --------------------------------------------------------------------- hash
def _hash_del_documento(data: bytes, firma: _Firma) -> bytes:
    """SHA-512 de RFC 4880, 5.2.4, sobre documento + datos firmados."""
    h = hashlib.sha512()
    h.update(data)
    h.update(bytes((_SIG_VERSION, _SIG_TYPE_BINARY, _PUBKEY_RSA, _HASH_SHA512)))
    h.update(len(firma.hashed).to_bytes(2, "big"))
    h.update(firma.hashed)
    h.update(_HASH_TRAILER)
    largo = _HASHED_HEADER_BYTES + len(firma.hashed)
    h.update(largo.to_bytes(4, "big"))
    return h.digest()


# ---------------------------------------------------------------------- RSA
def _verificar_rsa(mpi: bytes, digest: bytes) -> None:
    """RSA de libro: `m = sig^e mod n` tiene que dar el PKCS#1 v1.5 que esperamos."""
    esperado = _emsa_pkcs1_v15(digest)
    m = pow(int.from_bytes(mpi, "big"), _KEY_E, _KEY_N)
    obtenido = m.to_bytes(_KEY_BYTES, "big")
    # Comparacion de tiempo constante: no se filtra por donde falla.
    if not hmac.compare_digest(obtenido, esperado):
        raise SignatureError("la firma RSA no corresponde a los datos")


def _emsa_pkcs1_v15(digest: bytes) -> bytes:
    """`EMSA-PKCS1-v1_5` para SHA-512: 0x00 0x01 FF.. FF 0x00 || DigestInfo."""
    t = _SHA512_DIGESTINFO_PREFIX + digest
    relleno = _KEY_BYTES - len(t) - 3
    if relleno < _MIN_PADDING:
        raise SignatureError("la clave es demasiado chica para el hash")
    return b"\x00\x01" + b"\xff" * relleno + b"\x00" + t
