import { useNav } from "../app/useNav.js";
import { useListen } from "./ListenProvider.jsx";
import LibraryGate from "./LibraryGate.jsx";
import HomeFeed from "./HomeFeed.jsx";
import PageHost from "./PageHost.jsx";
import "./home.css";

/* ---------------------------------------------------------------------------
   INICIO

   El inicio de la biblioteca (seguir escuchando, lo ultimo que llego, lo mas
   escuchado, artistas, albumes, listas). Sus paginas ("Ver todo", Explorar la
   biblioteca, un album...) se apilan encima con la pila de useNav y sustituyen
   a la raiz mientras estan abiertas.
   ------------------------------------------------------------------------- */

export default function HomeScreen({ ready, error, errorCode, active, onRetry }) {
  const nav = useNav();
  const { ctx, model } = useListen();
  const page = nav.pageOf("home");

  if (page && ready) return <PageHost view={page} tab="home" active={active} />;

  return (
    <section className="listen" aria-label="Inicio">
      <h1 className="sr-only">Inicio</h1>
      <LibraryGate ready={ready} error={error} errorCode={errorCode} onRetry={onRetry}>
        <HomeFeed
          index={model.index}
          byKey={model.byKey}
          lists={model.lists}
          listsReady={model.listsReady}
          ctx={ctx}
        />
      </LibraryGate>
    </section>
  );
}
