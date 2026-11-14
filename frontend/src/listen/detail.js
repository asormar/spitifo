import { albumVerdict } from "./fileText.js";
import { artistId, groupAlbums } from "./library.js";
import { albumOrder, albumTone, entryTone, minutes, plural, songs, sortEntries, toneOf } from "./home.js";

/* ---------------------------------------------------------------------------
   FICHA DE UN ALBUM, UN ARTISTA O UNA LISTA (logica pura)

   `detailOf` resuelve la pagina de la pila (`view`: { type, id }) contra la
   biblioteca y las listas, y dice en que estado esta: "loading" (las listas aun
   no llegaron), "error" (no llegaron), "missing" (ya no existe) u "ok". Detail.jsx
   solo pinta lo que sale de aqui.
   ------------------------------------------------------------------------- */

/* ok: { kind, name, artist, artistId, rows, albums, mins, tone, pl, gone }.
   `rows` son las canciones que siguen en la biblioteca, en el orden de la
   pagina: las de un album por pista, las de un artista de la A a la Z, las de una
   lista en el orden de la lista (las claves que ya no estan se conservan en los
   datos pero no se ven). `gone`: la lista tiene claves y ninguna sigue. */
export function detailOf(view, { index, byKey, lists, listsReady, listsError }) {
  const kind = view.type;
  if (kind === "list") {
    const pl = lists.find((p) => p.id === view.id);
    if (!pl) return { kind, state: listsReady ? "missing" : listsError ? "error" : "loading" };
    const rows = pl.keys.map((k) => byKey.get(k)).filter(Boolean);
    return {
      kind,
      state: "ok",
      name: pl.name,
      rows,
      albums: [],
      mins: minutes(rows),
      tone: rows.length ? entryTone(rows[0]) : toneOf(pl.name),
      pl,
      gone: pl.keys.length > 0 && !rows.length,
    };
  }

  const group = (kind === "album" ? index.albums : index.artists).find((g) => g.id === view.id);
  if (!group) return { kind, state: "missing" };
  const album = kind === "album";
  const rows = album ? albumOrder(group.entries) : sortEntries(group.entries, "az");
  return {
    kind,
    state: "ok",
    name: group.name,
    artist: album ? group.artist : undefined,
    artistId: album ? artistId(group.entries[0]) : undefined,
    rows,
    albums: album ? [] : groupAlbums(group.entries),
    mins: minutes(rows),
    tone: album ? albumTone(group.artist, group.name) : toneOf(group.name),
    pl: null,
    gone: false,
  };
}

/* Los textos de la ficha: `meta` (lista y artista) y `liner` (album: la
   linea fuerte, con «Todo coincide» o «k de n coinciden» si hay veredictos
   guardados, y donde esta guardado), sin la linea de genero y ano que no hay. */
export function detailMeta(d, storage) {
  const n = d.rows.length;
  const time = d.mins ? ` · ${d.mins} min` : "";
  if (d.kind === "list") return { meta: `Lista · ${songs(n)}${time}` };
  if (d.kind === "album") {
    const check = albumVerdict(d.rows);
    return { liner: [`${songs(n)}${time}${check ? ` · ${check}` : ""}`, `En ${storage}`] };
  }
  return { meta: `${plural(d.albums.length, "álbum", "álbumes")} · ${songs(n)}` };
}
