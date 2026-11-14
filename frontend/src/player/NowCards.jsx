import { useMemo } from "react";
import { NavIcon } from "../app/navIcons.jsx";
import { useNav } from "../app/useNav.js";
import { requestGenre } from "../discover/genreRequest.js";
import { requestSearch } from "../download/searchRequest.js";
import { VerdictPill } from "../shared/Verdict.jsx";
import { coverTone, toneVars } from "../shared/cover.js";
import { useListen } from "../listen/ListenProvider.jsx";
import { filePill } from "../listen/fileCheck.js";
import { checkText } from "../listen/fileText.js";
import { useHistory } from "../listen/history.js";
import { initials } from "../shared/format.js";
import { useArtistGenres } from "./genreChips.js";
import { fileFacts, readReco, relatedTo } from "./nowInfo.js";

/* ---------------------------------------------------------------------------
   TARJETAS DE "AHORA SUENA"

   Lo que se sabe de la cancion que suena, solo con datos que la app tiene de
   verdad: cada tarjeta devuelve null si no hay nada que decir. Ninguna trae
   otro chunk al abrirse; solo la de generos pide algo (los generos del artista
   y, si hay, el mapa).
   ------------------------------------------------------------------------- */

/* "Ficha del archivo": el veredicto con su frase y, de la fila de la biblioteca,
   de donde salen los datos, el formato, tamano, duracion, donde esta guardada y
   cuantas veces se ha oido. Solo canciones de la biblioteca. `full` (la
   pestana Ficha) separa Ficha y Archivo y suma el nombre y la fecha. */
export function FichaCard({ track, full = false, onReveal }) {
  const { model } = useListen();
  const entry = model.byKey.get(track.key);
  const plays = useHistory((s) => s.tracks[track.key]?.plays ?? 0);
  const rows = useMemo(
    () => fileFacts(entry, { plays, storage: model.storage, full }),
    [entry, plays, model.storage, full]
  );
  if (!rows.length) return null;

  return (
    <section className="ncard" aria-label="Ficha del archivo">
      <h3 className="ncard__h">Ficha del archivo</h3>
      <VerdictPill v={filePill(entry)} />
      <p className="ncard__p">{checkText(entry, { card: true })}</p>
      <dl className="dfacts ncard__facts">
        {rows.map((r) => (
          <div key={r.k}>
            <dt>{r.k}</dt>
            <dd className={r.mono ? "is-mono" : undefined}>{r.v}</dd>
          </div>
        ))}
      </dl>
      <button type="button" className="ncard__go" onClick={() => onReveal(track.key)}>
        Ver en tu biblioteca
      </button>
    </section>
  );
}

/* "Si te gusta, prueba": artistas de "Para ti" cuya razon nombra a este. Lee la
   foto que Descubrir dejo en el dispositivo (sin pedirla): vacia hasta que
   Descubrir o Buscar la hayan cargado una vez. */
export function TryCard({ artist, trackKey }) {
  const nav = useNav();
  const list = useMemo(() => relatedTo(artist, readReco()), [artist, trackKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list.length) return null;

  return (
    <section className="ncard" aria-label="Si te gusta, prueba">
      <h3 className="ncard__h">Si te gusta, prueba</h3>
      <ul className="try">
        {list.map(({ name, reason }) => (
          <li key={name} className="try__row">
            <span
              className="cv cv--round try__av"
              style={{ ...toneVars(coverTone(name)), "--s": "44px" }}
              aria-hidden="true"
            >
              <span>{initials(name)}</span>
            </span>
            <span className="try__tx">
              <b>{name}</b>
              <small>{reason}</small>
            </span>
            <button
              type="button"
              className="cbtn cbtn--w"
              aria-label={`Buscar a ${name} para descargar`}
              title="Buscar para descargar"
              onClick={() => {
                requestSearch(name);
                nav.goTab("search");
              }}
            >
              <NavIcon name="search" size={20} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* "En el mapa de generos": los generos reales del artista que el mapa conoce,
   cada uno con el color de su zona. Un toque abre Descubrir en ese genero. No
   hay esqueleto: sin datos (artista sin perfilar, sin mapa) no hay tarjeta. */
export function GenresCard({ artist }) {
  const nav = useNav();
  const chips = useArtistGenres(artist);
  if (!chips.length) return null;

  return (
    <section className="ncard" aria-label="En el mapa de géneros">
      <h3 className="ncard__h">En el mapa de géneros</h3>
      <div className="gchips">
        {chips.map(({ name, cluster }) => (
          <button
            key={name}
            type="button"
            className="gchip"
            style={{ "--gc": `var(--genre-${cluster})` }}
            aria-label={`${name}. Abrir en Descubrir`}
            onClick={() => {
              requestGenre(name);
              nav.goTab("discover");
            }}
          >
            <span className="gd" aria-hidden="true" />
            <span className="gchip__t">{name}</span>
          </button>
        ))}
      </div>
      <p className="ncard__n">Cerca = comparten artistas, no suenan parecido.</p>
    </section>
  );
}

/* Las tarjetas en su orden; cada una es independiente. */
export default function NowCards({ track, artist, onReveal }) {
  return (
    <>
      <FichaCard track={track} onReveal={onReveal} />
      <GenresCard artist={artist} />
      <TryCard artist={artist} trackKey={track.key} />
    </>
  );
}
