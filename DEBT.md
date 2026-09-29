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

**134 tests, 133 pasan, exit=0** (125 offline en ~1s + 8 de integración contra
la red real).

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

## Legal — decisión del usuario

yt-dlp contra YouTube viola los ToS y es ilegal en la mayoría de las
jurisdicciones (incluida Argentina). Para uso personal está bien. La UI lo dice
una sola vez, en el panel de fuentes, sin sermón. Si el repo se hace público o
la app se distribuye, deja de ser un tema de uso personal.

## Notas

- `probe_apis.py` y `probe_archive.py` son scripts de sondeo de una vez. Están en
  `.gitignore`; se pueden borrar del disco.
- El repo **no tiene remote**: todos los commits son locales.
