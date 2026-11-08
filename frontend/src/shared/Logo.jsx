/* Marca "Disco": la palabra "spitif" y un disco de vinilo como "o" final.
   El disco lee los colores del tema (tinta, rosa, superficie), asi que no
   lleva colores propios. `spinning` lo hace girar (mientras suena audio). */
export default function Logo({ spinning = false }) {
  return (
    <span className="logo" role="img" aria-label="spitifo">
      <span aria-hidden="true">spitif</span>
      <svg className={spinning ? "logo__o is-spin" : "logo__o"} viewBox="0 0 100 100" aria-hidden="true">
        <circle className="logo__rec" cx="50" cy="50" r="50" />
        <circle className="logo__gr" cx="50" cy="50" r="36.8" strokeWidth="1.4" />
        <circle className="logo__gr" cx="50" cy="50" r="49.4" strokeWidth="1.2" />
        <g transform="translate(50 50)">
          <path className="logo__p" d="M0 0V-19A19 19 0 0 1 19 0ZM0 0V19A19 19 0 0 1-19 0Z" />
          <path className="logo__p2" d="M0 0H19A19 19 0 0 1 0 19ZM0 0H-19A19 19 0 0 1 0-19Z" />
        </g>
        <circle className="logo__hole" cx="50" cy="50" r="4.5" />
      </svg>
    </span>
  );
}
