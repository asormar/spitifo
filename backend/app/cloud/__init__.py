"""Conector de nube: piezas neutrales al proveedor (Google Drive u OneDrive).

La biblioteca del usuario puede vivir en su propia nube. Este paquete junta lo
que NO depende de quien gane el benchmark: el flujo OAuth PKCE, el guardado de
tokens, la cache offline de audio y el indice de la biblioteca
(docs/adr/0002-user-owned-storage.md, secciones 3, 4, 5, 7 y 8).

Modulo neutral, igual que `storage` y `config`: no importa starlette ni uvicorn.
Nada de aca sale a la red por su cuenta: cada funcion que hace HTTP recibe un
`httpx.Client`, asi los tests usan `httpx.MockTransport` y nunca tocan internet.
"""
