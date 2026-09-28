# Deuda técnica conocida

Todo verificado contra el código el 28 sep 2026. Nada de esto rompe la app hoy;
es lo que conviene atacar antes de seguir agregando funciones.

## Bugs

### 1. Fuga de memoria en los jobs de descarga
`backend/app/ytdlp_source.py` — el dict `JOBS` crece sin límite: cada descarga
yt-dlp deja una entrada adentro y nunca se purga. No es problema con unas pocas
descargas, pero en una sesión larga se acumula.

**Fix**: guardar un `finished_at` en el job y purgar los terminados que tengan más
de N minutos.

### 2. `run.bat` no activa yt-dlp
El `.bat` del proyecto arranca sin `YTDLP_ENABLED=1`, o sea sin la fuente que más
usa el usuario. El que sí lo tiene está en `%LOCALAPPDATA%\Temp\spitifo_serve.bat`
(usado para las pruebas), que es frágil: vive en Temp.

**Fix**: agregar `set YTDLP_ENABLED=1` al `run.bat` del proyecto.

## Deuda

### 3. `config.py` casi huérfano
Sólo lo usa `matcher.py`, por el `UA`. El `UA` está duplicado en `sources.py`.

**Fix**: mover el `UA` a `config.py` y borrarlo de `sources.py`.

### 4. Sin selector de modo en la UI
El modo `matched` es el default invisible. El `?mode=sources` (comportamiento
anterior) y `?source=<nombre>` sólo se alcanzan por URL, así que no hay forma de
volver al viejo desde la pantalla.

### 5. Fuentes no clickeables
Los chips de arriba (iTunes / Internet Archive / Wikimedia / yt-dlp) son
informativos. `matched.search` ya acepta `?source=`, así que el filtrado es
trabajo de frontend únicamente.

### 6. Tests sin framework
Los 4 scripts (`smoke_test`, `test_convert`, `test_wav`, `test_ytdlp_flow`)
imprimen su resultado y hay que leerlos. No corren con `pytest`, no fallan con un
código de salida, y no cubren el matcher ni la búsqueda.

Es la mayor deuda de calidad: hoy un cambio puede romper algo sin que nada lo note.

## Legal — decisión del usuario

yt-dlp contra YouTube viola los ToS y es ilegal en la mayoría de las jurisdicciones
(incluida Argentina). Para uso personal está bien. Si el repo se hace público o la
app se distribuye, deja de ser un tema de uso personal.

## Notas

- `probe_apis.py` y `probe_archive.py` son scripts de sondeo de una vez. Están en
  `.gitignore`; se pueden borrar del disco.
- El repo **no tiene remote**: los 7 commits son locales.
