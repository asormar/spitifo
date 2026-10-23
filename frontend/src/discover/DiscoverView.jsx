import { NavIcon } from "../app/navIcons.jsx";

/* Pantalla de aterrizaje de Descubrir. El mapa de generos y las
   recomendaciones llegan en las sesiones 22 y 23. */
export default function DiscoverView() {
  return (
    <section className="empty" aria-labelledby="discover-title">
      <div className="empty__ico" aria-hidden="true">
        <NavIcon name="discover" size={28} />
      </div>
      <h1 className="empty__h" id="discover-title">
        Descubrir
      </h1>
      <p className="empty__p">
        Pronto: recomendaciones según lo que escuchas y un mapa de géneros para
        explorar.
      </p>
    </section>
  );
}
