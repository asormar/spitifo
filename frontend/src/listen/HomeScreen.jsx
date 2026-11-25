import { lazy, Suspense } from "react";
import { useNav } from "../app/useNav.js";
import BrandLogo from "../app/BrandLogo.jsx";
import { Icon } from "./icons.jsx";
import { homeGreeting } from "./home.js";
import { useListen } from "./ListenProvider.jsx";
import LibraryGate from "./LibraryGate.jsx";
import HomeFeed from "./HomeFeed.jsx";
import PageHost from "./pageLoader.jsx";
import {
  folderLabel,
  shouldShowFirstRun,
  useFirstRunFlag,
} from "../onboarding/firstRun.js";
import { loadFirstRunChunk } from "../onboarding/firstRunChunk.js";

/* Solo se descarga si la tarjeta va a pintarse de verdad. */
const FirstRunCard = lazy(loadFirstRunChunk);

/* ---------------------------------------------------------------------------
   INICIO

   El inicio de la biblioteca (seguir escuchando, lo ultimo que llego, lo mas
   escuchado, artistas, albumes, listas). En el telefono lleva la marca y el
   engranaje de Ajustes arriba (en escritorio los lleva el menu). Sus paginas ("Ver todo", Explorar la
   biblioteca, un album...) se apilan encima con la pila de useNav y sustituyen
   a la raiz mientras estan abiertas.
   ------------------------------------------------------------------------- */

/* Esqueleto de Inicio mientras llega la biblioteca: la Mezcla, los chips y dos
   estanterias, con las mismas clases que el contenido (home.css), asi cada caja
   ocupa ya su sitio y nada salta cuando llega. */
const SKEL_CHIPS = [150, 170, 156];
const skelShelf = (n) => (
  <section className="sec" aria-hidden="true">
    <div className="shead">
      <span className="hsk hsk--h" />
    </div>
    <div className="shelf">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="card" style={{ "--i": i }}>
          <span className="hsk hsk--cv" />
          <span className="hsk hsk--t" />
          <span className="hsk hsk--s" />
        </span>
      ))}
    </div>
  </section>
);

function HomeSkeleton() {
  return (
    <div className="hfeed" aria-busy="true" aria-label="Cargando tu música">
      <div className="mezcla hsk hsk--hero" aria-hidden="true" />
      <div className="mixes" aria-hidden="true">
        {SKEL_CHIPS.map((w, i) => (
          <span key={i} className="hsk hsk--chip" style={{ width: w, "--i": i }} />
        ))}
      </div>
      {skelShelf(4)}
      {skelShelf(4)}
    </div>
  );
}

/* Biblioteca vacia: la Mezcla se ve deshabilitada y dos estantes de invitacion
   ocupan el sitio del esqueleto, para que el paso a contenido real no salte. */
function HomeEmpty({ folder }) {
  const nav = useNav();
  return (
    <div className="hfeed hempty">
      <div className="mezcla mezcla--off" aria-disabled="true">
        <div className="mz__pill">
          <div className="mz__txt">
            <b>Mezcla lista</b>
            <small>Añade música para empezar</small>
          </div>
          <button type="button" className="mz__play" disabled aria-label="Mezcla lista: añade música para empezar">
            <Icon name="Play" weight="fill" size="md" className="mz__play-i" />
          </button>
        </div>
        <div className="mz__rec" aria-hidden="true" />
      </div>
      <div className="hempty__note">
        <b>Busca tu primera canción.</b>
        <br />
        Prueba «Mesmerizer Satsuki» o «Despechá ROSALÍA» — se verifica antes de guardarla.
        <br />
        <button type="button" className="btn btn--acc" onClick={() => nav.goTab("search")}>
          Ir a Buscar
        </button>
      </div>
      <div className="hempty__note">
        <b>Canciones libres ya esperan en Descubrir.</b>
        <br />
        Explora el mapa de géneros mientras llenas tu biblioteca.
        <br />
        <button type="button" className="btn btn--soft" onClick={() => nav.goTab("discover")}>
          Ir a Descubrir
        </button>
      </div>
      <p className="hempty__folder">{folder}</p>
    </div>
  );
}

/* Un toque abre Buscar con el campo ya enfocado y el teclado arriba. El campo
   vive en otra pestana, así que se espera a que entre en el DOM (con transicion
   de vista) antes de darle el foco. */
function focusSearchField(tries = 20) {
  const field = document.querySelector('[data-screen]:not([hidden]) [data-field="search"]');
  if (field && field.getClientRects().length) {
    field.focus({ preventScroll: true });
    return;
  }
  if (tries > 0) requestAnimationFrame(() => focusSearchField(tries - 1));
}

export default function HomeScreen({ ready, error, errorCode, active, onRetry, storagePath }) {
  const nav = useNav();
  const { ctx, model } = useListen();
  const page = nav.pageOf("home");
  const flag = useFirstRunFlag();
  /* Con la biblioteca aun cargando no se muestra: evitaria un parpadeo si
     resulta que no esta vacia. */
  const showFirstRun = ready && shouldShowFirstRun(model.entries.length, flag);
  const folder = folderLabel(storagePath);

  if (page && ready) return <PageHost view={page} tab="home" active={active} />;

  return (
    <section className="listen" aria-label="Inicio">
      <header className="apphead">
        <BrandLogo />
        <div className="apphead__acts">
          <button
            type="button"
            className="cbtn cbtn--l apphead__search"
            onClick={() => {
              nav.goTab("search");
              requestAnimationFrame(() => focusSearchField());
            }}
            aria-label="Buscar"
            title="Buscar"
          >
            <Icon name="MagnifyingGlass" size="lg" />
          </button>
          <button
            type="button"
            className="cbtn cbtn--l apphead__gear"
            onClick={() => nav.openSettings()}
            aria-label="Ajustes"
            title="Abrir los ajustes"
          >
            <Icon name="GearSix" size="lg" />
          </button>
        </div>
      </header>
      <h1 className="sr-only">Inicio</h1>
      {ready && !error && <p className="hm__greet">{homeGreeting(model.entries.length)}</p>}
      {showFirstRun && (
        <Suspense fallback={null}>
          <FirstRunCard folder={folder} />
        </Suspense>
      )}
      <LibraryGate
        ready={ready}
        error={error}
        errorCode={errorCode}
        onRetry={onRetry}
        folder={folder}
        loading={<HomeSkeleton />}
        emptyView={<HomeEmpty folder={folder} />}
      >
        <HomeFeed
          index={model.index}
          byKey={model.byKey}
          lists={model.lists}
          listsReady={model.listsReady}
          ctx={ctx}
          active={active}
        />
      </LibraryGate>
    </section>
  );
}
