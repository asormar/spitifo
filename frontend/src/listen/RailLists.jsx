import { useEffect } from "react";
import { playlists, usePlaylists } from "./playlists.js";

/* ---------------------------------------------------------------------------
   LISTAS EN EL RIEL

   Los nombres de las listas bajo los modos del riel (escritorio). Vive en su
   propio chunk: el riel esta en el primer script y no debe cargar con el
   almacen de listas. Cargar aqui evita que el riel espere a que se abra
   Escuchar para mostrarlas; load() no repite la peticion si ya hay una.
   ------------------------------------------------------------------------- */

export default function RailLists({ onOpen }) {
  const list = usePlaylists((s) => s.list);
  useEffect(() => {
    playlists.load();
  }, []);

  return list.map((p) => (
    <button key={p.id} type="button" className="rail__list" title={p.name} onClick={() => onOpen(p.id)}>
      {p.name}
    </button>
  ));
}
