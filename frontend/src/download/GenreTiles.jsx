import { useEffect, useMemo, useState } from "react";
import { useNav } from "../app/useNav.js";
import { fetchMapFile } from "../discover/mapFile.js";
import { requestGenre } from "../discover/genreRequest.js";
import { genreTiles } from "../discover/genres.js";
import { reco, useReco } from "../discover/reco.js";
import { PATTERNS, hash32 } from "../shared/cover.js";

/* ---------------------------------------------------------------------------
   EXPLORAR POR GENERO

   Los generos que mas escuchas, como atajos a Descubrir con ese genero ya
   elegido en el mapa. Los datos salen de /api/discover (ya guardados en el
   dispositivo tras una visita a Descubrir) y el color de cada genero, del
   archivo del mapa.

   Cache primero: sin generos guardados se pide /api/discover UNA vez (sin
   sondeo). El archivo del mapa se pide con la app ociosa y solo si hay atajos
   que pintar; es la misma promesa que usa Descubrir, que luego abre al instante.
   Sin generos todavia: una tarjeta que lleva a Descubrir. Biblioteca vacia o
   sin respuesta: nada.
   ------------------------------------------------------------------------- */

/* El archivo ya leido, para que volver a Buscar pinte sin esqueleto. */
let mapRaw = null;
let askedReco = false;

const idle = (fn) =>
  typeof requestIdleCallback === "function"
    ? [requestIdleCallback(fn), (id) => cancelIdleCallback(id)]
    : [setTimeout(fn, 600), clearTimeout];

const color = (c) => `var(--genre-${c})`;

export default function GenreTiles({ active, empty }) {
  const nav = useNav();
  const genres = useReco((s) => s.genres);
  const loaded = useReco((s) => s.ready);
  const [raw, setRaw] = useState(mapRaw);
  const [mapFailed, setMapFailed] = useState(false);

  /* Sin generos guardados: una consulta, y solo con la pantalla a la vista. */
  useEffect(() => {
    if (!active || empty || askedReco || loaded || genres.length) return;
    askedReco = true;
    reco.load();
  }, [active, empty, loaded, genres.length]);

  /* El mapa, con la app ociosa y solo si hay atajos que colorear. */
  const need = active && !empty && genres.length > 0 && !raw && !mapFailed;
  useEffect(() => {
    if (!need) return undefined;
    let alive = true;
    const [id, cancel] = idle(() => {
      fetchMapFile().then(
        (data) => {
          mapRaw = data;
          if (alive) setRaw(data);
        },
        () => alive && setMapFailed(true)
      );
    });
    return () => {
      alive = false;
      cancel(id);
    };
  }, [need]);

  const tiles = useMemo(() => (raw || mapFailed ? genreTiles(genres, raw) : []), [genres, raw, mapFailed]);

  if (empty) return null;
  const open = () => nav.goTab("discover");
  const pick = (name) => {
    requestGenre(name);
    open();
  };

  let body;
  if (genres.length === 0) {
    /* Con la consulta en vuelo o fallida no hay nada que prometer. */
    if (!loaded) return null;
    body = (
      <div className="gnote">
        <p>Tus géneros aparecen aquí cuando Descubrir los conozca.</p>
        <button type="button" className="chip" onClick={open}>
          Abrir Descubrir
        </button>
      </div>
    );
  } else if (!tiles.length && !(raw || mapFailed)) {
    body = (
      <ul className="gtiles" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="gt gt--skel" />
        ))}
      </ul>
    );
  } else if (!tiles.length) {
    return null;
  } else {
    body = (
      <ul className="gtiles">
        {tiles.map((t, i) => (
          <li key={t.name} style={{ "--i": i }}>
            <button
              type="button"
              className="gt"
              style={{ "--c": color(t.c) }}
              aria-label={`${t.name}, ${t.pct} de tu música. Abrir en Descubrir`}
              onClick={() => pick(t.name)}
            >
              <span className="gt__n">{t.name}</span>
              <span className="gt__p">{t.pct} de tu música</span>
              <span className={`cv cv-p${hash32(t.name) % PATTERNS}`} aria-hidden="true">
                <span>{[...t.name][0]?.toUpperCase()}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section className="gsec" aria-labelledby="gsec-h">
      <h2 className="sh2" id="gsec-h">
        Explorar por género
      </h2>
      {body}
    </section>
  );
}
