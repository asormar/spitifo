/* La portada que se pide para un hueco de 58 px (96x54 la de video): iTunes la
   da en 300 px y YouTube en 480x360, y de sobra con 200 px y la 16:9 de 320x180
   (la mitad de bytes, ver docs/performance.md). Otra URL se deja como llega. */
export function thumbUrl(url) {
  if (!url) return url;
  return url.replace("/300x300bb.", "/200x200bb.").replace("/hqdefault.", "/mqdefault.");
}
