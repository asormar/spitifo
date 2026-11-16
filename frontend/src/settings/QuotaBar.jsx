/* Barra de espacio de Drive. La matematica y los textos viven en storageInfo.js
   (probados sin DOM); aqui solo se pinta. */
import { quotaView } from "./storageInfo.js";

export default function QuotaBar({ quota }) {
  const view = quotaView(quota);
  if (!view) return null;
  if (view.unlimited) {
    return (
      <div className="quota">
        <p className="quota__legend">{view.legend}</p>
      </div>
    );
  }
  return (
    <div className="quota">
      <div className="quota__bar" role="img" aria-label={view.aria}>
        <span className="quota__app" style={{ width: view.app }} />
        <span className="quota__other" style={{ width: view.others }} />
      </div>
      <ul className="quota__legend" aria-hidden="true">
        <li><span className="quota__key quota__key--app" />{view.legend[0]}</li>
        <li><span className="quota__key quota__key--other" />{view.legend[1]}</li>
        <li><span className="quota__key quota__key--free" />{view.legend[2]}</li>
      </ul>
    </div>
  );
}
