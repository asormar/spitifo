# Spitifo

Buscá una canción, bajala al momento. Web app que consulta fuentes con licencia libre
y descarga el archivo completo con los tags ya puestos.

## Arranque rápido

```bash
# backend (incluye la UI compilada en el mismo puerto)
.venv/Scripts/python.exe -m uvicorn backend.app.main:app --port 8000
# -> http://127.0.0.1:8000
```

Para desarrollo con hot-reload del frontend:

```bash
cd frontend && npm install && npm run dev   # http://localhost:5173 (proxy a :8000)
```

## Fuentes

| Fuente | Qué hace | Key |
|---|---|---|
| **Internet Archive** | Descarga real completa. `collection:(etree)` = conciertos en vivo, `audio_music`, `78rpm` | — |
| **Wikimedia Commons** | Descarga real completa. Audio CC / dominio público | — |
| **iTunes Search** | Catálogo grande para *encontrar* el tema. Sólo preview 30 s | — |
| **Jamendo** | Indie CC con MP3 completo | `JAMENDO_CLIENT_ID` (gratis) |
| **yt-dlp** | Fuente **extra apagada**. Va contra los ToS de las plataformas | `YTDLP_ENABLED=1` |

Cada resultado muestra de qué fuente sale, su licencia, y si se puede bajar entero
o es sólo preview. Nunca te muestra "descargable" algo que no lo sea.

## API

```bash
curl "http://127.0.0.1:8000/api/search?q=blues&limit=20"
curl "http://127.0.0.1:8000/api/health"          # qué fuentes están activas
curl "http://127.0.0.1:8000/api/library"         # lo ya descargado
```

- `GET /api/search` — busca en todas las fuentes activas en paralelo
- `POST /api/resolve` — completa la `audio_url` de archive / yt-dlp
- `POST /api/download` — descarga a `library/<artista>/` con tags
- `GET /api/library` — lista la biblioteca
- `GET /api/audio?path=` — sirve un archivo para preview

## Cómo funciona una descarga

1. La UI busca → cada fuente devuelve `Track` normalizado (`backend/app/models.py`).
2. Si la fuente necesita un paso extra (archive busca el archivo real en su
   metadata; yt-dlp resuelve la URL de audio), el botón primero llama `/api/resolve`.
3. `/api/download` hace streaming del archivo a disco (`downloader.py`), convierte
   a mp3/m4a con **ffmpeg** si hace falta, y escribe tags **ID3** con **mutagen**.
4. El archivo queda en `library/<artista>/<artista> - <titulo>.mp3`.

## Requisitos

- Python 3.11+ · Node 18+ (sólo para compilar la UI)
- **ffmpeg** en el PATH (conversión a mp3). Sin ffmpeg los .ogg/.opus/.wav se
  guardan sin convertir y el resto funciona igual.

## Variables de entorno

| Var | Default | Para qué |
|---|---|---|
| `SPITIFO_LIBRARY` | `./library` | Carpeta destino de las descargas |
| `JAMENDO_CLIENT_ID` | — | Activa Jamendo |
| `YTDLP_ENABLED` | `0` | Activa la fuente yt-dlp |

## Tests

```bash
.venv/Scripts/python.exe smoke_test.py      # search -> resolve -> download real
.venv/Scripts/python.exe test_convert.py    # ruta de conversión ffmpeg
```
