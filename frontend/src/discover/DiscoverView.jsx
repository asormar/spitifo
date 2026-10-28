import { useCallback, useEffect, useMemo, useState } from "react";
import { requestSearch } from "../download/searchRequest.js";
import { useNotice } from "../listen/Notice.jsx";
import { engine } from "../player/engine.js";
import ForYouSlot from "./ForYouSlot.jsx";
import GenreMap from "./GenreMap.jsx";
import { startingObstacle } from "./frame.js";
import { decodeMap, exploreGenres, genreIndex, normalize } from "./map.js";
import { fetchMapFile, forgetMapFile } from "./mapFile.js";
import { reco, useReco } from "./reco.js";
import { fetchArtistSamples, fetchSamples } from "./samples.js";
import "./discover.css";

/* El mapa se decodifica una vez por sesion a arreglos tipados. El archivo ya
   viene pedido (ver mapFile.js: App lo pide junto con este chunk). Si falla se
   olvida la promesa para que "Reintentar" vuelva a pedirlo. */
let mapPromise = null;
/* El mapa ya decodificado, para que la pantalla nazca con el sin esperar. */
let mapData = null;
function loadMap() {
  if (!mapPromise) {
    mapPromise = fetchMapFile()
      .then(decodeMap)
      .then((d) => (mapData = d))
      .catch((e) => {
        mapPromise = null;
        forgetMapFile();
        throw e;
      });
  }
  return mapPromise;
}

/* Adelanto: App lo llama en cuanto el usuario elige Descubrir, para que el
   mapa este decodificado cuando la pantalla se monte. */
export function warmMap() {
  loadMap().catch(() => {});
}

const NONE = new Set();

/* Pantalla de Descubrir: el mapa de generos y, dentro de el, "Para ti" con los
   artistas recomendados. `active`: la pantalla esta a la vista; solo entonces
   (y con el mapa ya en pantalla, que es lo primero) se consultan las
   recomendaciones (una vez por visita y, mientras el servidor siga
   trabajando, cada pocos segundos). */
export default function DiscoverView({ active = true, onOpenDownload }) {
  const [state, setState] = useState(() =>
    mapData ? { status: "ready", data: mapData } : { status: "loading", data: null }
  );
  const [attempt, setAttempt] = useState(0);
  const [noticeNode, notify] = useNotice();
  const [focus, setFocus] = useState(NONE);
  const [preview, setPreview] = useState(NONE);
  const genres = useReco((s) => s.genres);

  const ready = state.status === "ready";
  useEffect(() => (active && ready ? reco.watch() : undefined), [active, ready]);
  useEffect(() => reco.onError((msg) => notify(msg)), [notify]);

  useEffect(() => {
    let alive = true;
    loadMap().then(
      (data) =>
        alive && setState((s) => (s.status === "ready" && s.data === data ? s : { status: "ready", data })),
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
        <ForYouSlot
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
          initialObstacle={startingObstacle}
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
