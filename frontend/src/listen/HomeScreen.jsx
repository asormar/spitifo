import { useNav } from "../app/useNav.js";
import BrandLogo from "../app/BrandLogo.jsx";
import { NavIcon } from "../app/navIcons.jsx";
import { useListen } from "./ListenProvider.jsx";
import LibraryGate from "./LibraryGate.jsx";
import HomeFeed from "./HomeFeed.jsx";
import PageHost from "./PageHost.jsx";
import "./home.css";

/* ---------------------------------------------------------------------------
   INICIO

   El inicio de la biblioteca (seguir escuchando, lo ultimo que llego, lo mas
   escuchado, artistas, albumes, listas). En el telefono lleva la marca y el
   engranaje de Ajustes arriba (en escritorio los lleva el menu). Sus paginas ("Ver todo", Explorar la
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
      <header className="apphead">
        <BrandLogo />
        <button
          type="button"
          className="cbtn cbtn--l apphead__gear"
          onClick={() => nav.openSettings()}
          aria-label="Ajustes"
          title="Abrir los ajustes"
        >
          <NavIcon name="settings" size={22} />
        </button>
      </header>
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
