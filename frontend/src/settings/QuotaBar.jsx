/* Por debajo de 1 GB va en MB: una biblioteca recien empezada en "0 GB"
   parece vacia aunque ya tenga temas. */
function fmtGB(bytes) {
  const gb = bytes / 1024 ** 3;
  if (gb < 1) {
    const mb = bytes / 1024 ** 2;
    return `${mb.toLocaleString("es-ES", { maximumFractionDigits: mb < 10 ? 1 : 0 })} MB`;
  }
  return `${gb.toLocaleString("es-ES", { maximumFractionDigits: gb < 100 ? 1 : 0 })} GB`;
}

export default function QuotaBar({ quota }) {
  if (!quota) return null;
  const { limit, usage, app } = quota;
  const others = Math.max(0, usage - app);
  if (!limit) {
    return (
      <div className="quota">
        <p className="quota__legend">Espacio sin límite · Spitifo ocupa {fmtGB(app)}</p>
      </div>
    );
  }
  const free = Math.max(0, limit - usage);
  const pct = (n) => `${Math.min(100, (n / limit) * 100)}%`;
  return (
    <div className="quota">
      <div
        className="quota__bar"
        role="img"
        aria-label={`Spitifo ${fmtGB(app)}, otros archivos ${fmtGB(others)}, libres ${fmtGB(free)} de ${fmtGB(limit)}`}
      >
        <span className="quota__app" style={{ width: pct(app) }} />
        <span className="quota__other" style={{ width: pct(others) }} />
      </div>
      <ul className="quota__legend" aria-hidden="true">
        <li><span className="quota__key quota__key--app" />Spitifo {fmtGB(app)}</li>
        <li><span className="quota__key quota__key--other" />Otros {fmtGB(others)}</li>
        <li>Libre {fmtGB(free)}</li>
      </ul>
    </div>
  );
}
