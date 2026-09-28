"""Normalizacion de resultados: todo fuente -> un solo Track."""
from __future__ import annotations

from dataclasses import dataclass, asdict, field
from typing import Any


@dataclass
class Track:
    source: str
    source_id: str
    title: str
    artist: str
    album: str | None = None
    duration_s: int | None = None
    artwork_url: str | None = None
    # URL directa al archivo de audio completo (licencia libre) o None
    audio_url: str | None = None
    # URL de preview corto (30s) cuando no hay descarga completa
    preview_url: str | None = None
    license: str | None = None
    year: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def downloadable(self) -> bool:
        return bool(self.audio_url)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["downloadable"] = self.downloadable
        return d


def safe_name(s: str, maxlen: int = 80) -> str:
    """Nombre de archivo seguro para Windows: sin \/:*?"<>| ni controles."""
    out = "".join(c for c in s if c.isprintable() and c not in '\\/:*?"<>|')
    out = " ".join(out.split()).strip(" .")
    return (out[:maxlen] or "untitled").rstrip(" .")
