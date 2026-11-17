/* El chunk de la pagina del artista y de la hoja «Descargar discografía».
   Lo comparten las dos entradas: «Mejor resultado», «Más de <artista>» y el
   enlace del disco. Se adelanta al enfocar una tarjeta para que la pagina
   nazca lista; el arranque no paga ni un byte de aqui. */
export const loadArtistChunk = () => import("./ArtistChunk.jsx");
