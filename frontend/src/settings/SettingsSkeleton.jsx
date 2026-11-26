/* ---------------------------------------------------------------------------
   ESQUELETO DE AJUSTES

   Un solo patron para el primer fetch de cada tarjeta (almacenamiento,
   cookies, portadas): dos filas con la forma del proveedor elegido y
   aria-busy, en vez de un hueco en blanco o una frase distinta por tarjeta.
   ------------------------------------------------------------------------- */
export default function SettingsSkeleton({ label }) {
  return (
    <div className="settings__skel" aria-busy="true">
      <div className="settings__skelrow" aria-hidden="true">
        <span className="settings__skelicon" />
        <span className="settings__skeltext">
          <i />
          <i />
        </span>
      </div>
      <p className="settings__note">{label}</p>
    </div>
  );
}
