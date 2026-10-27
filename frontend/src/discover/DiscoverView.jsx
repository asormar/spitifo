import { useCallback, useEffect, useMemo, useState } from "react";
import { requestSearch } from "../download/searchRequest.js";
import { useNotice } from "../listen/Notice.jsx";
import { engine } from "../player/engine.js";
import ForYou from "./ForYou.jsx";
import GenreMap from "./GenreMap.jsx";
import { decodeMap, exploreGenres, genreIndex, normalize } from "./map.js";
import { reco, useReco } from "./reco.js";
import { fetchArtistSamples, fetchSamples } from "./samples.js";
import "./discover.css";
import "./foryou.css";

/* El mapa se pide una vez por sesion (el archivo viaja con la app, ver ADR
   0003) y se decodifica a arreglos tipados. Si falla se olvida la promesa para
   que "Reintentar" vuelva a pedirlo. No se importa como modulo: son datos, no
   codigo, y asi no engordan el chunk. */
let mapPromise = null;
function loadMap() {
  if (!mapPromise) {
    mapPromise = fetch(`${import.meta.env.BASE_URL}genre-map.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`genre-map.json: HTTP ${r.status}`);
        return r.json();
      })
      .then(decodeMap)
      .catch((e) => {
        mapPromise = null;
        throw e;
      });
  }
  return mapPromise;
}

const NONE = new Set();

/* Pantalla de Descubrir: el mapa de generos y, dentro de el, "Para ti" con los
   artistas recomendados. `active`: la pantalla esta a la vista; solo entonces
   se consultan las recomendaciones (una vez por visita y, mientras el servidor
   siga trabajando, cada pocos segundos). */
export default function DiscoverView({ active = true, onOpenDownload }) {
  const [state, setState] = useState({ status: "loading", data: null });
  const [attempt, setAttempt] = useState(0);
  const [noticeNode, notify] = useNotice();
  const [focus, setFocus] = useState(NONE);
  const [preview, setPreview] = useState(NONE);
  const genres = useReco((s) => s.genres);

  useEffect(() => (active ? reco.watch() : undefined), [active]);
  useEffect(() => reco.onError((msg) => notify(msg)), [notify]);

  useEffect(() => {
    let alive = true;
    loadMap().then(
      (data) => alive && setState({ status: "ready", data }),
      () => alive && setState({ status: "error", data: null })
    );
    return () => {
      alive = false;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ status: "loading", data: null });
    setAttempt((n) => n + 1);
  }, []);

  /* Primero el pedido y luego el cambio de pantalla: Descargar lo toma al
     montarse o en cuanto se avisa. */
  const searchGenre = useCallback(
    (name) => {
      requestSearch(name);
      onOpenDownload?.();
    },
    [onOpenDownload]
  );

  /* La muestra suena en el reproductor de siempre: cola de previews, el
     mini-reproductor la muestra y siguiente/anterior pasan de una a otra. */
  const playTracks = (tracks) => {
    if (tracks.length) engine.play(tracks[0], { queue: tracks, index: 0, restart: true });
    return tracks.length;
  };
  const playSample = useCallback(async (name) => playTracks(await fetchSamples(name)), []);
  const playArtist = useCallback(async (name) => playTracks(await fetchArtistSamples(name)), []);

  /* Los generos del usuario sobre el mapa: nombre del servidor -> indice. */
  const data = state.data;
  const idx = useMemo(() => (data ? genreIndex(data) : null), [data]);
  const mine = useMemo(
    () => (idx ? genres.map((g) => ({ ...g, i: idx.get(normalize(g.name)) ?? -1 })) : []),
    [idx, genres]
  );
  const mineSet = useMemo(() => {
    const on = mine.filter((g) => g.i >= 0).map((g) => g.i);
    return on.length ? new Set(on) : NONE;
  }, [mine]);
  const explore = useMemo(
    () =>
      data
        ? exploreGenres(
            data,
            mine.filter((g) => g.i >= 0).map((g) => g.i),
            6
          )
        : [],
    [data, mine]
  );

  /* El panel vive dentro del mapa y recibe lo que el mapa sabe de si mismo. No
     se monta hasta que el mapa tiene tamano: la hoja nace ya en su sitio. */
  const panel = useCallback(
    (ctx) =>
      ctx.box.w > 0 && (
        <ForYou
          data={data}
          idx={idx}
          mine={mine}
          explore={explore}
          ctx={ctx}
          notify={notify}
          onFocus={setFocus}
          onPreview={setPreview}
          onSearch={searchGenre}
          onPlayArtist={playArtist}
          onPlayGenre={playSample}
        />
      ),
    [data, idx, mine, explore, notify, searchGenre, playArtist, playSample]
  );

  return (
    <>
      <h1 className="sr-only">Descubrir</h1>
      {state.status === "ready" ? (
        <GenreMap
          data={state.data}
          highlight={mineSet}
          focus={focus}
          preview={preview}
          onSearchGenre={searchGenre}
          onPlaySample={playSample}
          panel={panel}
        />
      ) : state.status === "error" ? (
        <div className="gmap gmap--state" role="alert">
          <div>
            <p className="gmap__msg">No se pudo cargar el mapa de géneros.</p>
            <button type="button" className="gmap__go gmap__retry" onClick={retry}>
              Reintentar
            </button>
          </div>
        </div>
      ) : (
        <div className="gmap gmap--state" role="status" aria-label="Cargando el mapa de géneros">
          <div>
            <div className="gmap__pulse" aria-hidden="true" />
            <p className="gmap__msg">Cargando el mapa de géneros…</p>
          </div>
        </div>
      )}
      {noticeNode}
    </>
  );
}
