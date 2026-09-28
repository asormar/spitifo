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

## Verificación de identidad (importante)

Internet Archive guarda **un item por pista**, pero el item se titula con el nombre
del concierto y el match de la búsqueda cae contra la descripción (el setlist), no
contra la pista. Buscar "Bohemian Rhapsody" devuelve un concierto de Phish donde esa
canción aparece en el setlist.

Por eso el resolve **lee los tags reales del audio** (`backend/app/identify.py`, sólo
los primeros 256 KB con un `Range` implícito) y compara contra la consulta. Cada
descarga queda con un veredicto:

| Estado | Qué significa |
|---|---|
| `match` | el título del archivo es el que buscabas (≥80% de palabras) |
| `partial` | se parece pero no es (≥40%) |
| `mismatch` | **no es lo que buscabas** — la UI avisa y el archivo se guarda con su título real |
| `unknown` | el archivo no trae tags; no se puede verificar |

- `GET /api/verify?q=...&source=archive&source_id=...` — qué hay adentro de un item, sin bajarlo
- `GET /api/setlist?source_ids=id1,id2&q=...` — resuelve varios items y devuelve el setlist con títulos reales
- `POST /api/resolve?query=...` — ahora recibe la consulta para poder verificar
- `POST /api/download?query=...` — devuelve `match` y `real_title`

Los resultados de un mismo concierto se agrupan en una fila que se expande con su
setlist, y cada pista se puede bajar por separado.

## Colecciones de Internet Archive (importante)

`collection:(etree)` sonaba obvia pero tiene **solo 4 items de audio**. El catálogo
real está en:

| Colección | Items de audio | Qué hay |
|---|---|---|
| `opensource_audio` | 2.960.378 | MP3s subidos, covers, ripeos |
| `audio_music` | 509.979 | audio en general |
| `78rpm` | 309.420 | discos de 78rpm (dominio público) |
| `etree` | 4 | conciertos en vivo |

Además, archive exige **AND entre palabras**: `"linkin park numb"` da 0 resultados
aunque "Meteora" de Linkin Park esté subida. Por eso `search()` prueba variantes de
menor a mayor especificidad y termina con un OR sobre las palabras más largas
(`_loose()`), y después reordena por relevancia real con `_rank()`.

**Al agregar una fuente, sondear contra la API real antes de escribir el adaptador:**
si no hay resultados, el problema suele ser la query, no la fuente.

## Filtro anti-basura (importante)

Internet Archive (y Wikimedia) tienen audio en general, no solo música: buscando
`Numb Linkin Park` salían *"HUBS report"*, *"Chaos in Portland"*, *"Toe sucking
burglar"* y *"VOA Global English"*. Dos filtros en `sources.py` lo evitan:

- **`looks_like_music()`** — descarta items cuyo título/artista tiene palabras de
  podcast, noticia, sermón, curso, audiobook (`NOT_MUSIC`).
- **`relevance()`** — puntúa 0..1 exigiendo que el item contenga la **mayoría** de
  las palabras *distintivas* de la consulta (las que no están en `FILLER`). Un item
  que solo matchea una palabra común ("park") queda penalizado, y si hubo que
  recurrir al query relajado (`min_relevance=0.01`) se descarta lo que no coincide
  en nada.

Verificado: de 40 resultados con 3 podcasts/noticias al frente, a 41 resultados
todos musicales. Al añadir fuentes, aplicar ambos filtros.

## yt-dlp (fuente opcional, ver la nota legal)

Se activa con `YTDLP_ENABLED=1`. Buscá y descargá de YouTube, que es la única vía
para el catálogo comercial (iTunes sólo da preview de 30 s).

```bash
# PowerShell, en la terminal
$env:YTDLP_ENABLED=1; .venv\Scripts\python.exe -m uvicorn backend.app.main:app --port 8000
```

- **Aviso legal**: descargar de YouTube viola sus ToS y es ilegal en la mayoría de
  las jurisdicciones. Sirve para uso personal; no lo publiques ni lo distributes.
- Flujo: `POST /api/download` arranca la descarga en background y devuelve
  `job_id`; la UI hace polling a `GET /api/download/progress/{job_id}` para la
  barra de progreso. Con `?wait=true` devuelve el resultado al terminar.
- `backend/app/ytdlp_source.py` tiene su propio pipeline (formatos + postprocess
  ffmpeg + progreso); no reutiliza `downloader.download_track`.

### Trampa de yt-dlp (importante)

Con el postprocessor `FFmpegExtractAudio`, **`info['filepath']` viene `None`**:
yt-dlp lo limpia después del postprocess. Y `ydl.prepare_filename(info)` tampoco
sirve, porque devuelve el nombre con la extensión del stream **original**
(webm/opus), no la del postprocess (mp3). El archivo final es
`folder/<stem>.<ext>`, donde `stem` es el que ya construiste para el `outtmpl`, así
que hay que buscarlo con un glob sobre ese `stem` (con `glob.escape`, porque los
títulos traen `[` `]`).

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
