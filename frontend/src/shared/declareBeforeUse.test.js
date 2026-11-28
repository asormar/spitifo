import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import { describe, expect, it } from "vitest";

/*
 * NINGUNA VARIABLE SE LEE ANTES DE SU const/let
 *
 * Leer un const o un let antes de su declaracion, en la misma llamada, lanza
 * «Cannot access … before initialization» y deja la pantalla en blanco. Los
 * tests no pintan las pantallas enteras, asi que no lo ven: paso con las
 * fichas de la biblioteca (`name` en las dependencias de un useMemo, Detail.jsx)
 * y con Buscar (`record` en las de onSubmit, SearchScreen.jsx).
 *
 * Cuenta como lectura en el render:
 *   - la que esta en la misma funcion que la declaracion (por ejemplo, en la
 *     lista de dependencias de un hook);
 *   - la que esta dentro de la funcion que useMemo, useState o useReducer
 *     ejecutan en el acto.
 * No cuenta la que esta dentro de otra funcion que corre mas tarde (un evento,
 * un efecto, el cuerpo de un useCallback): para entonces ya esta declarada.
 */

const traverse = traverseModule.default ?? traverseModule;
const SRC = fileURLToPath(new URL("../", import.meta.url));
const RUN_NOW = new Set(["useMemo", "useState", "useReducer"]);

function sources(dir = SRC, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, found);
    else if (/\.(js|jsx)$/.test(entry.name)) found.push(path);
  }
  return found;
}

/* La funcion que contiene la lectura corre en el acto si es la misma que la de
   la declaracion o si es la fabrica de useMemo, useState o useReducer. */
function runsDuringRender(ref, binding) {
  const owner = binding.scope.getFunctionParent()?.block ?? null;
  let fn = ref.getFunctionParent();
  while (fn && fn.node !== owner) {
    const call = fn.parentPath;
    const callee = call?.isCallExpression() ? call.node.callee.name || call.node.callee.property?.name : null;
    if (!(callee && RUN_NOW.has(callee) && call.node.arguments[0] === fn.node)) return false;
    fn = fn.getFunctionParent();
  }
  return true;
}

function readsBeforeDeclare(code) {
  const ast = parse(code, { sourceType: "module", plugins: ["jsx"] });
  const found = [];
  const seen = new Set();
  traverse(ast, {
    Scope(path) {
      for (const [name, binding] of Object.entries(path.scope.bindings)) {
        if (binding.kind !== "const" && binding.kind !== "let") continue;
        const at = binding.identifier.start;
        if (seen.has(at)) continue;
        seen.add(at);
        for (const ref of binding.referencePaths) {
          if (ref.node.start >= at || ref.node.loc.start.line === binding.identifier.loc.start.line) continue;
          if (runsDuringRender(ref, binding)) found.push(`${name} (linea ${ref.node.loc.start.line}, declarado en la ${binding.identifier.loc.start.line})`);
        }
      }
    },
  });
  return found;
}

describe("declarar antes de usar", () => {
  it("detecta el caso que dejaba las fichas en blanco", () => {
    const code = `function Ficha({ d }) {
      const similar = useMemo(() => related(name), [name]);
      if (!d) return null;
      const { name } = d;
      return similar;
    }`;
    expect(readsBeforeDeclare(code)).toEqual(["name (linea 2, declarado en la 4)", "name (linea 2, declarado en la 4)"]);
  });

  it("no cuenta las lecturas dentro de funciones que corren despues", () => {
    const code = `function Buscar() {
      const onSubmit = useCallback(() => record(), []);
      useEffect(() => { record(); }, []);
      const record = () => {};
      return onSubmit;
    }`;
    expect(readsBeforeDeclare(code)).toEqual([]);
  });

  it("ningun archivo de src lee un const o let antes de declararlo", () => {
    const problems = [];
    for (const path of sources()) {
      const file = relative(SRC, path).split(sep).join("/");
      for (const hit of readsBeforeDeclare(readFileSync(path, "utf8"))) problems.push(`${file}: ${hit}`);
    }
    expect(problems).toEqual([]);
  });
});
