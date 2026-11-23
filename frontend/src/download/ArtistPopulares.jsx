import { useCallback, useEffect, useMemo, useState } from "react";
import { useNav } from "../app/useNav.js";
import { useDownloadFormat } from "../settings/downloadPrefs.js";
import { artistPopulares, fetchArtistTop } from "./artistTop.js";
import { resultMenuGroups } from "./resultMenu.js";
import { MenuSurface } from "./ResultMenu.jsx";
import { pickResultAction } from "./resultMenuActions.js";
import { ResultRow, Skeleton } from "./ResultRow.jsx";
import { queueStore } from "./queueStore.js";
import { trackSpec } from "./albumText.js";
import { rowKey } from "../shared/api.js";
import { songIdOf } from "../shared/songId.js";
import { useShow } from "../listen/Notice.jsx";
import { useListen } from "../listen/ListenProvider.jsx";
import "./rows.css";
import "./artistChunk.css";

/* ---------------------------------------------------------------------------
   POPULARES EN LA FICHA DEL ARTISTA (Buscar y biblioteca)

   Una sola implementacion de la lista, el menu y el esqueleto para las dos
   paginas. El id de iTunes lo resuelve quien llama: la ficha de la biblioteca
   con "Mas de <artista>" y la pagina de Buscar con el id de la entrada. El top
   se pide aparte, despues del primer pintado: sin id o con iTunes caido no hay
   seccion. `results` es el descarte de la Buscar cuando el top viene vacio.
   El boton rosa de la ficha sigue sonando las canciones guardadas: la pagina
   de Buscar recibe las mismas filas con `onSongs` para su play grande.
   ------------------------------------------------------------------------- */

export default function ArtistPopulares({ name, artistId, results, query = name, onSongs }) {
  const nav = useNav();
  const { model, ctx } = useListen();
  const show = useShow();
  const [fmt] = useDownloadFormat();
  const [state, setState] = useState({ status: "loading", songs: [] });
  const menuAt = nav.stack.at(-1)?.type === "downmenu" ? nav.stack.at(-1) : null;

  useEffect(() => {
    const ac = new AbortController();
    let vivo = true;
    if (artistId == null) {
      setState({ status: "ok", songs: [] });
      return undefined;
    }
    setState({ status: "loading", songs: [] });
    (async () => {
      const songs = await fetchArtistTop(artistId, ac.signal);
      if (vivo) setState({ status: "ok", songs });
    })().catch((e) => {
      if (vivo && e.name !== "AbortError") setState({ status: "ok", songs: [] });
    });
    return () => {
      vivo = false;
      ac.abort();
    };
  }, [artistId]);

  const songs = useMemo(
    () => artistPopulares(state.songs, results, name),
    [state.songs, results, name]
  );
  /* La pagina de Buscar necesita las MISMAS canciones para su play grande. */
  useEffect(() => {
    onSongs?.(songs);
  }, [onSongs, songs]);

  /* El punto verde dice "descargada" cuando el id de la cancion ya esta en la
     biblioteca con archivo. El corazon lo calcula SaveHeart con el mismo id. */
  const downloadedIds = useMemo(
    () => new Set((model?.entries || []).filter((e) => e.downloaded && e.sid).map((e) => e.sid)),
    [model?.entries]
  );
  const onDl = useCallback(
    (one) => queueStore.enqueue({ items: [trackSpec(one, name || "")] }),
    [name]
  );
  const onMenu = useCallback(
    (one, el) => nav.open({ type: "downmenu", kind: "song", t: one, anchor: el }),
    [nav.open]
  );
  const pickSongMenu = (kind) =>
    pickResultAction(kind, {
      t: menuAt?.t,
      query,
      onDownload: onDl,
      show,
      locationToken: ctx.locationToken,
      nav,
      anchor: menuAt?.anchor,
    });

  return (
    <>
      {(state.status === "loading" || songs.length > 0) && (
        <section className="aps appop" aria-labelledby="h-lpop">
          <h2 className="sh2" id="h-lpop">Populares</h2>
          {state.status === "loading" ? (
            <Skeleton count={5} className="rlist--compact" />
          ) : (
            <ul className="rlist rlist--compact">
              {songs.map((t, i) => (
                <ResultRow
                  key={rowKey(t)}
                  t={t}
                  i={i}
                  query={query}
                  queue={songs}
                  source={`artist:${name}`}
                  variant="popular"
                  downloaded={downloadedIds.has(songIdOf(t))}
                  onDl={onDl}
                  onMenu={onMenu}
                />
              ))}
            </ul>
          )}
        </section>
      )}
      {menuAt?.kind === "song" && menuAt.t && (
        <MenuSurface
          groups={resultMenuGroups(menuAt.t, { fmt })}
          title={menuAt.t.title || "sin título"}
          anchor={menuAt.anchor}
          onPick={pickSongMenu}
          onClose={nav.back}
        />
      )}
    </>
  );
}
