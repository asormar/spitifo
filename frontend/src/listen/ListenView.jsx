import { NavIcon } from "../app/navIcons.jsx";

/* Pantalla de aterrizaje de Escuchar. La sesion 17 la llena con biblioteca y
   cola; por ahora solo ocupa el modo para que el shell sea real. */
export default function ListenView() {
  return (
    <section className="empty" aria-labelledby="listen-title">
      <div className="empty__ico" aria-hidden="true">
        <NavIcon name="listen" size={28} />
      </div>
      <h1 className="empty__h" id="listen-title">
        Escuchar
      </h1>
      <p className="empty__p">
        Pronto: tu biblioteca, la cola y tus listas en un solo sitio.
      </p>
    </section>
  );
}
