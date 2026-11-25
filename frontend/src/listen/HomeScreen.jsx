import { lazy, Suspense } from "react";
import { useNav } from "../app/useNav.js";
import BrandLogo from "../app/BrandLogo.jsx";
import ChromeButtons from "../app/ChromeButtons.jsx";
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
        <ChromeButtons className="apphead__gear" />
      </header>
      <h1 className="sr-only">Inicio</h1>
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
