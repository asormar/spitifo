/* Puro: Enter durante la composicion IME (japones, chino) no debe enviar.
   Algunos WebViews reportan keyCode 229 en vez de isComposing. */
export const isComposing = (e) => {
  const n = e?.nativeEvent ?? e;
  return Boolean(n?.isComposing || n?.keyCode === 229);
};
