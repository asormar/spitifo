# Deuda técnica conocida

Verificado contra el código el 29 sep 2026. Nada de esto rompe la app hoy;
es lo que conviene atacar antes de seguir agregando funciones.

## Bugs

NINGUNO abierto. Los dos que había (fuga de `JOBS` y `run.bat` sin yt-dlp) se
resolvieron y verificaron con ejecución real. Ver "Resueltos".

## Resueltos

### 1. Fuga de memoria en los jobs de descarga — ARREGLADO
`backend/app/ytdlp_source.py` — el dict `JOBS` crecía sin límite: cada descarga
yt-dlp dejaba una entrada adentro para siempre.

Ahora cada job terminado lleva `finished_at`, y `_purge_jobs()` saca solo los
que están en estado final (`done`/`error`) con el timestamp vencido
(`JOBS_TTL_S = 3600.0`, una hora). Un job `pending`/`downloading`/`processing`
no se purga jamás, así que la UI puede seguir consultando su `job_id` por HTTP
sin colgarse. La purga es perezosa: la dispara `new_job()`, no hay thread de
fondo.

**Trampa**: `_finish()` tiene que quedar FUERA del `with _JOBS_LOCK:` del hook
de progreso de yt-dlp. `threading.Lock` no es reentrante; adentro cuelga el
servidor.

Verificado: 7 jobs de prueba (3 en curso, 2 viejos, 1 reciente, 1 sin fecha) ->
purga los 2 viejos, sobreviven los 5.

### 2. `run.bat` no activaba yt-dlp — ARREGLADO
Ahora es autocontenido: se posiciona con `%~dp0`, valida que exista el `.venv`
del repo y setea `YTDLP_ENABLED=1`. El `.bat` de `%LOCALAPPDATA%\Temp` ya no
hace falta para arrancar la app.

Verificado: `run.bat` levanta el server y `/api/health` responde
`ytdlp: active:true`.

### 3. `config.py` casi huérfano — ARREGLADO
La constante se llama `USER_AGENT` y vive en `config.py` (que sigue siendo la
hoja neutra que rompe el triángulo de imports `sources ↔ ytdlp_source ↔
downloader`). La usan `sources`, `downloader`, `identify` y `matcher`;
`matcher.py` además tenía un import de `UA` que nunca usaba, y se borró.

Efecto colateral bueno: `downloader` e `identify` dejaron de importar de
`sources`, que era uno de los brazos del ciclo.

### 4. Sin selector de modo en la UI — ARREGLADO
El modo `matched` ya no es un default invisible: hay un control visible con
"Recomendado" / "Todas las fuentes" / "Solo YouTube", y el estado vive en la
URL (`?mode=`), así que es enlazable y sobrevive al refresh.

### 5. Fuentes no clickeables — ARREGLADO
Los chips de arriba filtran de verdad, con forma de volver al estado sin
filtro. Jamendo aparece marcado "sin clave" y no es filtrable.

**Comportamientos verificados contra la API** (importan si se toca esto):

| Qué mandás | Qué pasa |
|---|---|
| `mode=matched` (default) | iTunes cataloga, yt-dlp baja |
| `mode=ytdlp` solo | **NO filtra**: devuelve las 4 fuentes (count=30) |
| `mode=ytdlp&source=ytdlp` | sí: es la forma de pedir solo YouTube |
| `source=ytdlp` sin mode | el backend responde `mode=matched`, count=12 |
| `mode=matched&source=X` | **degrada el matched**: pierde el emparejamiento |
| `source=jamendo` | count=0 (apagado sin `JAMENDO_CLIENT_ID`) |

La UI avisa explícitamente el caso degradado en vez de dejar que el usuario
clickee y no entienda por qué cambió el resultado.

### 6. Tests sin framework — ARREGLADO
Los 4 scripts sueltos (`smoke_test.py`, `test_convert.py`, `test_wav.py`,
`test_ytdlp_flow.py`) se conservaron por historial, pero ya no son la única
cobertura: hay una suite pytest en `tests/`.

**134 tests, 131 pasan, exit=1** (125 offline en ~1s + 8 de integración contra la red real). El 1 que falla es `test_search_resolve_download_verifica_tags`:
el 403 de archive.org (ítem 8 de abajo) deja al resolve sin tags, y el
veredicto no se escribe. **Es preexistente**: verificado con `git stash`, falla
igual sin los cambios de esta tanda.

`pytest.ini` lleva `testpaths = tests` y es **imprescindible**: sin eso pytest
colecta los 4 scripts de la raíz, que llaman `asyncio.run()` a nivel de módulo,
y la suite revienta en el collection.

Correr:
```bash
.venv/Scripts/python.exe -m pytest -m "not integration" -q   # offline, ~1s
.venv/Scripts/python.exe -m pytest -m integration -q         # con red
```

## Deuda que queda

### 7. `looks_like_music()` no filtra "curso"
**Bug real, encontrado al escribir los tests.** `NOT_MUSIC` en
`backend/app/sources.py` tiene `"course"` en inglés y no `"curso"` en español,
así que "Curso de Python" pasa el filtro anti-basura.

Está cubierto por `test_looks_like_music_deberia_filtrar_un_curso`, un **xfail
estricto**: el día que se arregle `sources.py` el test falla y obliga a sacar el
marcador. No se puede pasar inadvertido.

### 8. Download directo de archive.org da 403
`ia800607.us.archive.org` responde `403 Forbidden` para el archivo, en dos
corridas seguidas. No es la query ni un test mal escrito: es el CDN de ese nodo.
Hoy el test de integración se saltea con el motivo explícito. Si esto sigue en
CI, es señal de que esa fuente ya no sirve para descargas directas y conviene
migrarla a Wikimedia.

Los 4 scripts viejos se pueden borrar del repo cuando querás: sus casos ya
están en `tests/`.

---

# Revisión del rediseño "Cristal" — 30 sep 2026

`88e8ff5` rediseñó la UI (tema claro, grilla de tarjetas, toast que se borra solo).
Seis bloques de revisión en paralelo sobre la app real; los hallazgos verificados
quedaron arreglados en `e722dc8`. Verificado con ejecución real: build OK y **132
tests pasan** (1 skip por el 403 de archive.org, 1 xfail que es la deuda de
`NOT_MUSIC` de arriba).

## Bugs del rediseño que se ARREGLARON (`e722dc8`)

### Lectura arbitraria de archivos — `/api/audio` (el más grave)
El guardián era `str(p).startswith(str(LIBRARY.resolve()))`: un prefijo de **string**,
no de camino, así que una carpeta hermana que arrancara con el nombre de la
biblioteca (`library_backup`, `library2`…) pasaba el filtro y se servía por HTTP.

Ahora: `p.is_relative_to(LIBRARY.resolve())` (compara por componentes) + filtro por
`AUDIO_EXTS`. Verificado con el guard real: los tres hermanos con prefijo común dan
**404**, un archivo fuera del repo da **404**, y los `.mp3` reales siguen sirviéndose.

### Pedir `m4a` informaba un `.mp3`
Con `FFmpegExtractAudio` `info['filepath']` viene `None`, así que el fallback por
`glob` es el camino **normal**. Ordenaba con `.mp3` hardcodeado por delante, sin
mirar el `fmt`: si ya había un `.mp3` con el mismo nombre, el `.m4a` se producía
pero se informaban el nombre, el formato y el tamaño del `.mp3` viejo. El toast
decía "4.3 MB" habiendo pedido m4a. Ahora se prefiere la extensión pedida y se cae
a la otra si no está.

### "original" prometía no convertir
`preferredcodec` cae a mp3 para todo `fmt` que no sea mp3/m4a, así que "original"
siempre convertía. El tooltip decía *"sin convertir"*: la UI ofrecía una opción
que no existe. Ahora dice la verdad.

### La respuesta vieja de una búsqueda pisaba a la nueva
`runSearch` no abortaba ni numeraba las peticiones. Medido: las búsquedas reales
tardan **1.75 s–2.97 s**, así que dos solapadas resolvían en cualquier orden con
facilidad. Síntoma: resultados de la query vieja, URL compartible corrupta y una
**tercera** petición por el efecto de resync. Ahora cada búsqueda toma un número y
solo la última escribe estado.

### El toast de descarga se congelaba para siempre
Tres caminos: job purgado por TTL (la UI polleaba ~12,5 min y después nada), red
caída en pleno sondeo (`TypeError` sin catch), y el `null` por el tope de 600
iteraciones (7 min) que el llamador ignoraba en silencio. B midió un concierto de
114 min que tardó **581 s** — ese caso lo revienta sin avisar. Ahora distingue
`timeout` y error de red, y avisa que la descarga sigue corriendo en el servidor.

### `[object Object]` como mensaje de error
El `detail` de FastAPI en un 422 es un **array**, y se pasaba tal cual a
`new Error(...)`. Cuatro sitios: búsqueda, verificación, setlist y resolve.

### `loadLib` sin `try/catch` y sin mirar `r.ok`
Un 500 se traducía en "Biblioteca, vacía" con 22 archivos en disco.

### El selector de modo no se podía usar con flechas
Tenía `role="radiogroup"` (que promete navegación con flechas) sin implementarla:
tres tab stops ajenos al patrón ARIA. Extraído a `ModePicker` con roving tabindex,
como el de formato, que sí estaba bien.

## Lo que queda abierto

### Dos descargas simultáneas se pisan (SIGUE ABIERTO)
`job`/`busyId` es un estado único: las dos terminan en el server pero solo se
anuncia una, y el `setBusyId(null)` de la primera apaga el spinner de la segunda.
Decisión de diseño pendiente, no bug accidental.

### `href` sin sanitizar de esquema
`main.jsx` pasa URLs del servidor a `href` sin validar el esquema. **No demostrado
como vulnerabilidad** (el HeadlessChrome las bloquea, probado también con un `<a>`
nativo), pero no hay validación ni CSP. Queda como superficie.

### El `catch` de `loadLib` confunde "vacía" con "sin consultar"
`setLib((cur) => cur || [])` deja la biblioteca como "vacía consultada" ante un
fallo de red, que es justo lo que `lib === null` servía para distinguir. Es una
regresión chica del arreglo de arriba: la forma correcta es no tocar `lib`.

## Segunda tanda: lo que se ARREGLÓ — 30 sep 2026 (después de la revisión)

Todo verificado con ejecución real, no por lectura: descargas completas de
yt-dlp contra la API viva y pantalla abierta en el navegador.

### El aviso de identidad NUNCA se disparaba (el más grave de todos)
Era la función central del proyecto y estaba muerta. **Doble causa**, y por eso
bastaba con arreglar una para que siguiera sin avisar:

1. `main.jsx` hacía `return` en el camino con `job_id` **antes** del chequeo de
   `match`. Ese camino es el modo Recomendado, que es el que se abre por
   defecto: es decir, el 90% de las descargas.
2. El job de yt-dlp nunca publicaba el veredicto. `download()` receive el
   `track` de iTunes y escribía tags con esa ficha, así que no comparaba nada
   contra el archivo real; y `/api/download` armaba `ident` con
   `track.extra.get("match")`, que en ese flujo siempre era `None`.

El veredicto se calcula ahora **después** de descargar, en
`ytdlp_source.download()`, contra el título real del video, y se publica en el
job (`_finish(..., match=, match_label=, real_title=)`). `main.py` pasa el
`query` que ya recibía por parámetro. La comprobación de la UI se movió a una
función pura, `mismatchNotice()`, usada por los dos caminos.

**Verificado con 4 descargas reales contra YouTube:**

| query | archivo | `match` que llegó a la UI |
|---|---|---|
| Creep Radiohead | Creep (Acoustic) | `partial` → sin aviso |
| Smells Like Teen Spirit | Smells Like Teen Spirit (Official MV) | `match` → sin aviso |
| Wuthering Heights Kate Bush | Wuthering Heights - Official MV | `match` → sin aviso |
| So What Miles Davis (con el `webpage_url` de otro tema, a proposito) | Numb, de Linkin Park | **`mismatch` → aviso** |

El caso del aviso se forzó a mano (ficha de iTunes de "So What" apuntando al
video de "Numb") porque con queries reales el matcher acierta y no hay forma
natural de que el aviso aparezca. Salió `match: "mismatch"`,
`real_title: "Numb (Official Music Video) [4K UPGRADE] – Linkin Park"`.

`unknown` también genera aviso, y a propósito: "no se pudo verificar" es más
honesto que un visto bueno que nadie emitió.

### El toast pisaba la fila que estabas leyendo
`position: fixed` + `padding-bottom: 128px` solo protege el final de la página:
a mitad de scroll se superponía a los resultados. Ahora va **abajo a la
derecha** (380px de ancho), que es donde la lista tiene menos texto. En móvil
(`max-width: 720px`) vuelve a ocupar el ancho, porque ahí no hay "derecha
libre". Verificado en pantalla: `width: 380`, `right: 1231`.

### La "navegación flotante" era `position: static`
`88e8ff5` la describía como flotante pero no tenía `position`. Medido con scroll
560: `y: -536` (se iba con el scroll, y con ella el contador de biblioteca).
Ahora es `sticky` con `top: 12px`. Verificado: `y: 12` con scroll 560.

### Modo Recomendado con yt-dlp apagado: 0 descargables sin avisar
El aviso `.mode--dead` solo cubría el modo que se elige a mano. El modo
**Recomendado**, que es el que se abre solo, respondía "30 resultados, 0
descargables" sin mencionar nada — y con el server sin `YTDLP_ENABLED=1` esa
es la primera pantalla que ve el usuario. Nuevo aviso `matchedDead` que explica
que el audio completo sale de YouTube y que iTunes solo tiene previews.

### El `catch` de `loadLib` confundía "vacía" con "sin consultar"
`setLib((cur) => cur || [])` convertía un fallo de red en "biblioteca vacía",
que es justo lo que `lib === null` servía para distinguir. Ahora el `catch` no
toca `lib`, y además se mira `r.ok` para que un 500 no pise el contador.

### La franja `.msg` no se auto-borraba nunca
El toast (`.prog`) sí se retiraba a los 5 s; la franja de éxito se quedaba en
pantalla hasta que otra acción la limpiara. Ahora usa el mismo temporizador
(`JOB_DISMISS_MS`). **No** se retiran el aviso de error ni el de "esto no es lo
que buscabas": esos son información que el usuario necesita leer.

### Portada rota: ícono del navegador
`onError` faltante en los dos `<img class="card__art">` (Track y ShowGroup).
Ahora salen por el componente `Artwork`, que cae al placeholder con la nota
musical que ya existía en CSS (`.card__art--ph`).

### Servidor caído: "Failed to fetch" crudo, en inglés
`fetchErr()` traduce el `TypeError` de fetch a un mensaje en español. Los otros
errores pasan tal cual.

### Sin favicon
`/favicon.ico` caía en el `StaticFiles(html=True)` y devolvía el `index.html`
con 200. Ahora hay un `favicon.svg` propio en `frontend/public/` y un
`<link rel="icon">` en `index.html`. Verificado: `/favicon.svg` → 200
`image/svg+xml`, `/favicon.ico` → 404 (ya no devuelve HTML).

## Lecciones de esta revisión (importan para la próxima)

- **Cuidado al "verificar" un hallazgo mirando el estado DESPUÉS del arreglo.**
  Aquí se reportó "286 KB de fuentes IBM Plex muertas en el `dist/` servido", que
  es **cierto**: los 10 `.woff2` seguían trackeados en `frontend/public/fonts/`, y
  Vite copia `public/` a la raíz de `dist/` en cada build, así que se servían por
  HTTP (200, 45 KB cada uno) sin que el CSS los referenciara (0 apariciones de
  "plex"; el CSS usa Outfit/Figtree). Al verificar, `dist/` ya estaba reconstruido
  sin ellas y el `find` dio vacío, lo que se Tomó como prueba de que nunca
  existieron. **Comprobar el estado antes del arreglo, o contra el commit
  anterior**, no el de después.
- **La carrera de búsqueda es alcanzable, no teórica**: la latencia real medida la
  hace trivialmente reproducible.
- **Verificar el archivo en disco, no el HTTP 200**: el `.m4a` de 8.8 MB existía y
  era válido mientras la API informaba el `.mp3` de 4.4 MB.
- **Aislar el headless antes de culpar al código**: `readyState: 0` en los `<audio>`
  es del navegador sin decodificar, no del `preload`. La biblioteca muestra
  `duration_s` de la API, así que el "Numb = 17:29" del diseño viejo es
  estructuralmente imposible ahí. Verificado 3:07 con ffprobe.

## Más hallazgos de la revisión (30 sep) — estado

Ninguno rompe el loop central, que se verificó entero con descargas reales
(Numb, Chopin, So What, Creep): buscar → resultados → descargar → reproducir.

**La mayoría se/arreglaron en la segunda tanda (ver arriba).** Queda esto:

### SIGUE ABIERTO: dos descargas simultáneas se pisan
`job`/`busyId` es un estado único: las dos terminan en el server pero solo se
anuncia una, y el `setBusyId(null)` de la primera apaga el spinner de la segunda.
Decisión de diseño pendiente, no bug accidental.

### SIGUE ABIERTO: `href` sin sanitizar de esquema
`main.jsx` pasa URLs del servidor a `href` sin validar el esquema. **No demostrado
como vulnerabilidad** (el HeadlessChrome las bloquea, probado también con un `<a>`
nativo), pero no hay validación ni CSP. Queda como superficie.

### ARREGLADO en la segunda tanda
- El aviso de "esto no es lo que buscabas" nunca se dispara → **arreglado** (doble causa, backend + frontend).
- Con yt-dlp apagado, el modo Recomendado da 0 descargables sin avisar → **arreglado** (`matchedDead`).
- El toast fijo pisa la fila que estás leyendo → **arreglado** (abajo a la derecha, 380px).
- La "navegación flotante" es `position: static` → **arreglado** (`sticky`, verificado y=12 con scroll 560).
- La franja de éxito `.msg` no se auto-borra nunca → **arreglado** (mismo temporizador que el toast).
- Servidor caído: "Failed to fetch" crudo en inglés → **arreglado** (`fetchErr`).
- Portada que falla al cargar → **arreglado** (`onError`, componente `Artwork`).
- Sin favicon → **arreglado** (`favicon.svg` + `<link rel="icon">`).
- El `catch` de `loadLib` confunde "vacía" con "sin consultar" → **arreglado** (el catch no toca `lib`, y se mira `r.ok`).

### Sigue siendo deuda
- `test_search_resolve_download_verifica_tags` falla: el 403 de archive.org
  deja al resolve sin tags y el veredicto no se escribe. Preexistente, verificado
  con `git stash`. Es el ítem 8.
- Flakiness de integración: 1 de 6 corridas salteó por rate-limit de **YouTube**
  (403), que es distinto del 403 de archive.org del ítem 8.
- `looks_like_music()` no filtra "curso" (xfail estricto, ítem 7).

## Legal — decisión del usuario

yt-dlp contra YouTube viola los ToS y es ilegal en la mayoría de las
jurisdicciones (incluida Argentina). Para uso personal está bien. Si el repo se hace
público o la app se distribuye, deja de ser un tema de uso personal.

## Notas

- `probe_apis.py` y `probe_archive.py` son scripts de sondeo de una vez. Están en
  `.gitignore`; se pueden borrar del disco.
- El repo **no tiene remote**: todos los commits son locales.
