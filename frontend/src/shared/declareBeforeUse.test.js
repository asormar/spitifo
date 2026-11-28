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
 * Cuenta como lectura en el render la que esta en la misma funcion que la
 * declaracion (por ejemplo, en la lista de dependencias de un hook) o dentro de
 * una funcion que se ejecuta en el acto: la fabrica de useMemo, el inicial de
 * useState, el init (3.er argumento) de useReducer, el getSnapshot de
 * useSyncExternalStore, el selector de un hook de lectura (useReco(s => …)),
 * el callback de .map/.filter/.forEach y parecidos, y una funcion que se llama
 * a si misma al definirse. Tambien cuenta la que esta en el propio valor
 * inicial (const x = f(x)).
 * No cuenta la que esta dentro de otra funcion que corre mas tarde (un evento,
 * un efecto, el cuerpo de un useCallback): para entonces ya esta declarada.
 * Limite conocido: una funcion local que se declara y se llama en el render
 * antes de la variable que lee no se sigue.
 */

const traverse = traverseModule.default ?? traverseModule;
const SRC = fileURLToPath(new URL("../", import.meta.url));
/* Que argumento de cada hook se ejecuta al pintar. */
const RUN_NOW_ARG = { useMemo: 0, useState: 0, useReducer: 2, useSyncExternalStore: 1 };
const LATER_HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect", "useCallback", "useImperativeHandle"]);
const ITERATORS = new Set(["map", "filter", "forEach", "some", "every", "find", "findIndex", "findLast", "findLastIndex", "flatMap", "reduce", "reduceRight", "sort", "toSorted"]);

function sources(dir = SRC, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, found);
    else if (/\.(js|jsx)$/.test(entry.name)) found.push(path);
  }
  return found;
}

/* La funcion `fn` se ejecuta en el acto si quien la recibe la llama al pintar. */
function runsNow(fn) {
  const call = fn.parentPath;
  if (!call?.isCallExpression()) return false;
  if (call.node.callee === fn.node) return true;
  const at = call.node.arguments.indexOf(fn.node);
  const callee = call.node.callee;
  const name = callee.name || callee.property?.name;
  if (at < 0 || !name) return false;
  if (name in RUN_NOW_ARG) return RUN_NOW_ARG[name] === at;
  if (callee.type === "MemberExpression" && ITERATORS.has(name)) return at === 0;
  return /^use[A-Z]/.test(name) && !LATER_HOOKS.has(name);
}

function runsDuringRender(ref, binding) {
  const owner = binding.scope.getFunctionParent()?.block ?? null;
  for (let fn = ref.getFunctionParent(); fn && fn.node !== owner; fn = fn.getFunctionParent()) {
    if (!runsNow(fn)) return false;
  }
  return true;
}

/* Antes de la declaracion, o dentro de su propio valor inicial. */
function readTooEarly(ref, binding) {
  if (ref.node.start < binding.identifier.start) return true;
  const init = binding.path.isVariableDeclarator() ? binding.path.node.init : null;
  return Boolean(init && ref.node.start >= init.start && ref.node.end <= init.end);
}

function readsBeforeDeclare(code) {
  const ast = parse(code, { sourceType: "module", plugins: ["jsx"] });
  const found = new Set();
  const seen = new Set();
  traverse(ast, {
    Scope(path) {
      for (const [name, binding] of Object.entries(path.scope.bindings)) {
        if (binding.kind !== "const" && binding.kind !== "let") continue;
        if (seen.has(binding.identifier.start)) continue;
        seen.add(binding.identifier.start);
        for (const ref of binding.referencePaths) {
          /* Un `export const` registra la propia exportacion como referencia: no es una lectura. */
          if (!ref.isIdentifier() && !ref.isJSXIdentifier()) continue;
          if (readTooEarly(ref, binding) && runsDuringRender(ref, binding)) {
            found.add(`${name} (linea ${ref.node.loc.start.line}, declarado en la ${binding.identifier.loc.start.line})`);
          }
        }
      }
    },
  });
  return [...found];
}

describe("declarar antes de usar", () => {
  it("detecta el caso que dejaba las fichas en blanco", () => {
    const code = `function Ficha({ d }) {
      const similar = useMemo(() => related(name), [name]);
      if (!d) return null;
      const { name } = d;
      return similar;
    }`;
    expect(readsBeforeDeclare(code)).toEqual(["name (linea 2, declarado en la 4)"]);
  });

  it("detecta las funciones que corren al pintar", () => {
    const code = `function Pantalla({ items }) {
      const filas = items.map((i) => i + extra);
      const visto = useStore((s) => s[clave]);
      const [estado] = useReducer((s) => s + tarde, 0, () => inicio);
      const valor = (() => propio)();
      const { a = b, b } = items;
      const extra = 1, clave = "k", inicio = 0, propio = 2, tarde = 3;
      return [filas, visto, estado, valor, a];
    }`;
    expect(readsBeforeDeclare(code).sort()).toEqual([
      "b (linea 6, declarado en la 6)",
      "extra (linea 2, declarado en la 7)",
      "clave (linea 3, declarado en la 7)",
      "inicio (linea 4, declarado en la 7)",
      "propio (linea 5, declarado en la 7)",
    ].sort());
  });

  it("no cuenta las lecturas dentro de funciones que corren despues", () => {
    const code = `function Buscar() {
      const onSubmit = useCallback(() => record(), []);
      useEffect(() => { record(); }, []);
      const onClick = () => record();
      const record = () => {};
      return [onSubmit, onClick];
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
