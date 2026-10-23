#!/usr/bin/env python3
"""Build the Discover genre map (frontend/public/genre-map.json) from CC0 data.

    python scripts/discover/build_genre_map.py [--out frontend/public/genre-map.json]
        [--cache <dir>] [--refresh] [--iterations 150] [--seed 17]

Pipeline (see docs/adr/0003-discover-data.md, decision 1):

1. Nodes: the MusicBrainz genre list (CC0), paged at 1 request per second.
2. Edges: Wikidata (CC0) items that carry a MusicBrainz genre id (P8052) and
   their relations to other such items, from one SPARQL query. Weights:
   subclass of 1.0, influenced by 0.6, every other relation 0.5. A genre with
   no Wikidata edge gets weak 0.3 edges to the genres its name is built from
   ("latin trap" -> "trap", "latin") as a fallback.
3. Layout: Fruchterman-Reingold in pure Python. Repulsion is exact against the
   neighbouring grid cells and uses one centre of mass per far cell, so an
   iteration is far cheaper than O(n^2). Cooling schedule and seeded random
   start, so the same input gives the same map.
4. Clusters (at most 16, used for colour): weighted label propagation, the
   smallest communities merged into the closest large one.
5. Output: columnar JSON sorted by name (the contract in the session 22 notes),
   coordinates quantised to 0..65535.

Raw downloads are cached in `--cache` (default: a folder in the system temp
dir), so a re-run does not touch the network unless `--refresh` is given.
Stdlib only, Python 3.11+.
"""
from __future__ import annotations

import argparse
import datetime
import gzip
import json
import math
import random
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "frontend" / "public" / "genre-map.json"
USER_AGENT = "Spitifo/0.4 (https://github.com/asormar/spitifo)"

MB_URL = "https://musicbrainz.org/ws/2/genre/all"
MB_PAGE = 100
MB_DELAY = 1.1  # seconds between MusicBrainz requests (the limit is 1/s)
WD_URL = "https://query.wikidata.org/sparql"

# Wikidata properties linking two genres and the edge weight each one gives.
WD_WEIGHTS = {
    "P279": 1.0,  # subclass of
    "P737": 0.6,  # influenced by
    "P144": 0.5,  # based on
    "P4969": 0.5,  # derivative work
    "P527": 0.5,  # has part (fusion genres)
    "P361": 0.5,  # part of
    "P1269": 0.5,  # facet of
    "P1382": 0.5,  # partially coincident with
    "P460": 0.5,  # said to be the same as
}
NAME_WEIGHT = 0.3
VIRTUAL_WEIGHT = 0.7  # genre <-> intermediate Wikidata item without an MBID
UP_PROPS = ("P279", "P737", "P144")
MAX_CLUSTERS = 16
MAX_RELATED = 5
COORD_MAX = 65535
MARGIN = 0.03  # share of the range kept free around the layout


class DownloadError(RuntimeError):
    pass


def http(url: str, data: bytes | None = None, accept: str = "application/json") -> bytes:
    """GET (or POST with `data`) with a descriptive User-Agent and a few retries."""
    headers = {"User-Agent": USER_AGENT, "Accept": accept}
    last = "no attempt"
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, data=data, headers=headers)
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.read()
        except urllib.error.HTTPError as err:
            last = f"HTTP {err.code}"
            if err.code not in (429, 500, 502, 503, 504):
                break
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            last = str(err)
        time.sleep(5 * 2**attempt)
    raise DownloadError(f"{url}: {last}")


def fetch_musicbrainz(cache: Path, refresh: bool) -> list[dict]:
    """Every MusicBrainz genre as {"id", "name"}."""
    path = cache / "musicbrainz-genres.json"
    if path.exists() and not refresh:
        return json.loads(path.read_text(encoding="utf-8"))
    genres: list[dict] = []
    offset, total = 0, None
    while total is None or offset < total:
        query = urllib.parse.urlencode({"limit": MB_PAGE, "offset": offset, "fmt": "json"})
        page = json.loads(http(f"{MB_URL}?{query}"))
        total = page["genre-count"]
        genres += [{"id": g["id"], "name": g["name"]} for g in page["genres"]]
        offset += MB_PAGE
        print(f"  musicbrainz: {min(offset, total)}/{total}", file=sys.stderr)
        time.sleep(MB_DELAY)
    path.write_text(json.dumps(genres, ensure_ascii=False), encoding="utf-8")
    return genres


def sparql(query: str, label: str) -> list[dict]:
    started = time.time()
    body = urllib.parse.urlencode({"query": query, "format": "json"}).encode()
    raw = json.loads(http(WD_URL, data=body, accept="application/sparql-results+json"))
    rows = [{k: v["value"] for k, v in b.items()} for b in raw["results"]["bindings"]]
    print(f"  wikidata {label}: {len(rows)} rows in {time.time() - started:.0f} s", file=sys.stderr)
    return rows


def qid(uri: str) -> str:
    return uri.rsplit("/", 1)[1]


def fetch_wikidata(cache: Path, refresh: bool) -> dict:
    """Three SPARQL queries, cached together.

    - `direct`: {"mb", "p", "mb2"}, a genre and another genre related to it.
      A row without `p` is an item that has an MBID but no such relation.
    - `up`: {"mb", "p", "q"}, a genre and a Wikidata item *without* an MBID it
      is a subclass of / influenced by / based on (an intermediate such as
      "folk music of Brazil").
    - `chain`: {"q", "mb2", "q2"}, what those intermediates are a subclass of
      (a genre with an MBID, or another intermediate).
    """
    path = cache / "wikidata-relations.json"
    if path.exists() and not refresh:
        return json.loads(path.read_text(encoding="utf-8"))
    props = " ".join(f"wdt:{p}" for p in WD_WEIGHTS)
    direct = sparql(
        "SELECT ?mb ?p ?mb2 WHERE { ?g wdt:P8052 ?mb . "
        f"OPTIONAL {{ VALUES ?p {{ {props} }} ?g ?p ?r . ?r wdt:P8052 ?mb2 . "
        "FILTER(?g != ?r) } }",
        "genre relations",
    )
    up_props = " ".join(f"wdt:{p}" for p in UP_PROPS)
    up_rows = sparql(
        "SELECT ?mb ?p ?r WHERE { ?g wdt:P8052 ?mb . "
        f"VALUES ?p {{ {up_props} }} ?g ?p ?r . FILTER NOT EXISTS {{ ?r wdt:P8052 ?x }} }}",
        "intermediate items",
    )
    mids = sorted({qid(r["r"]) for r in up_rows})
    chain_rows = sparql(
        "SELECT ?r ?mb2 ?s WHERE { VALUES ?r { "
        + " ".join(f"wd:{q}" for q in mids)
        + " } ?r wdt:P279 ?s . FILTER(?r != ?s) OPTIONAL { ?s wdt:P8052 ?mb2 } }",
        "their parents",
    )
    data = {
        "direct": [
            {"mb": r["mb"], **({"p": qid(r["p"]), "mb2": r["mb2"]} if "p" in r else {})} for r in direct
        ],
        "up": [{"mb": r["mb"], "p": qid(r["p"]), "q": qid(r["r"])} for r in up_rows],
        "chain": [
            {"q": qid(r["r"]), "q2": qid(r["s"]), **({"mb2": r["mb2"]} if "mb2" in r else {})}
            for r in chain_rows
        ],
    }
    path.write_text(json.dumps(data), encoding="utf-8")
    return data


def build_edges(names: list[str], mbids: list[str], wd: dict):
    """Weighted undirected edges {(i, j): weight} with i < j.

    Nodes 0..n-1 are the MusicBrainz genres. Wikidata items without an MBID
    that sit between genres become "virtual" nodes n.., kept for the layout and
    the clustering only (they pull sibling genres together). Returns
    (edges, node count including virtual, set of genres Wikidata knows).
    """
    n = len(names)
    index = {m: i for i, m in enumerate(mbids)}
    edges: dict[tuple[int, int], float] = {}

    def add(i: int, j: int, w: float, over: bool = True) -> None:
        if i == j:
            return
        key = (i, j) if i < j else (j, i)
        if over:
            edges[key] = max(edges.get(key, 0.0), w)
        else:
            edges.setdefault(key, w)

    matched = set()
    for row in wd["direct"]:
        i = index.get(row["mb"])
        if i is None:
            continue
        matched.add(i)
        j = index.get(row.get("mb2", ""))
        if j is not None:
            add(i, j, WD_WEIGHTS[row["p"]])

    # Virtual nodes: one per intermediate item that links at least two nodes.
    virtual: dict[str, int] = {}

    def vnode(q: str) -> int:
        return virtual.setdefault(q, n + len(virtual))

    for row in sorted(wd["up"], key=lambda r: (r["q"], r["mb"], r["p"])):
        i = index.get(row["mb"])
        if i is not None:
            add(i, vnode(row["q"]), VIRTUAL_WEIGHT if row["p"] == "P279" else VIRTUAL_WEIGHT * 0.6)
    for row in sorted(wd["chain"], key=lambda r: (r["q"], r["q2"])):
        if row["q"] not in virtual:
            continue
        j = index.get(row.get("mb2", ""))
        add(virtual[row["q"]], j if j is not None else vnode(row["q2"]), VIRTUAL_WEIGHT)

    # Drop virtual nodes that connect fewer than two nodes, until none is left.
    while True:
        degree: dict[int, int] = defaultdict(int)
        for i, j in edges:
            degree[i] += 1
            degree[j] += 1
        dead = {v for v in virtual.values() if 0 < degree[v] < 2}
        if not dead:
            break
        edges = {e: w for e, w in edges.items() if e[0] not in dead and e[1] not in dead}
    alive = sorted({v for e in edges for v in e if v >= n})
    renumber = {v: n + k for k, v in enumerate(alive)}
    edges = {
        tuple(sorted((renumber.get(i, i), renumber.get(j, j)))): w for (i, j), w in edges.items()
    }

    # Fallback: genres nothing connects get weak edges to the genres in their name.
    linked = {v for e in edges for v in e}
    by_name = {nm: i for i, nm in enumerate(names)}
    for i, name in enumerate(names):
        if i in linked:
            continue
        tokens = [t for t in re.split(r"[\s/&]+", name) if t]
        found = []
        for cut in range(1, len(tokens)):
            for part in (" ".join(tokens[cut:]), " ".join(tokens[:-cut])):
                j = by_name.get(part)
                if j is not None and j != i and j not in found:
                    found.append(j)
        for j in found[:3]:
            add(i, j, NAME_WEIGHT, over=False)
    return edges, n + len(alive), matched


def layout(n: int, edges: dict[tuple[int, int], float], rng: random.Random, iterations: int):
    """Fruchterman-Reingold with a grid approximation of the repulsion."""
    k = 1.0  # ideal edge length
    side = math.sqrt(n) * k
    xs = [rng.uniform(0, side) for _ in range(n)]
    ys = [rng.uniform(0, side) for _ in range(n)]
    edge_list = [(i, j, w) for (i, j), w in edges.items()]
    cell = 4.0 * k
    gravity = 0.9
    cx0 = cy0 = side / 2
    t0 = side / 8

    for it in range(iterations):
        temp = max(t0 * (1 - it / iterations) ** 1.5, 0.02)
        # Bin the nodes; keep a centre of mass per occupied cell.
        grid: dict[tuple[int, int], list[int]] = defaultdict(list)
        for i in range(n):
            grid[(int(xs[i] // cell), int(ys[i] // cell))].append(i)
        far = []  # (cell key, count, mean x, mean y)
        for key, members in grid.items():
            m = len(members)
            far.append((key, m, sum(xs[i] for i in members) / m, sum(ys[i] for i in members) / m))

        dx_ = [0.0] * n
        dy_ = [0.0] * n
        for (gx, gy), members in grid.items():
            near = []
            for ax in (gx - 1, gx, gx + 1):
                for ay in (gy - 1, gy, gy + 1):
                    near += grid.get((ax, ay), ())
            for i in members:
                xi, yi = xs[i], ys[i]
                fx = fy = 0.0
                for j in near:
                    if j == i:
                        continue
                    ex, ey = xi - xs[j], yi - ys[j]
                    d2 = ex * ex + ey * ey
                    if d2 < 1e-6:  # coincident: nudge apart deterministically
                        ex, ey, d2 = 0.01 * ((i - j) % 7 - 3), 0.01 * ((i + j) % 5 - 2), 1e-4
                    f = k * k / d2  # (k^2 / d) along the unit vector
                    fx += ex * f
                    fy += ey * f
                for (ax, ay), m, mx, my in far:
                    if abs(ax - gx) <= 1 and abs(ay - gy) <= 1:
                        continue
                    ex, ey = xi - mx, yi - my
                    f = k * k * m / (ex * ex + ey * ey + 1e-9)
                    fx += ex * f
                    fy += ey * f
                dx_[i] = fx
                dy_[i] = fy

        for i, j, w in edge_list:
            ex, ey = xs[i] - xs[j], ys[i] - ys[j]
            d = math.sqrt(ex * ex + ey * ey) + 1e-9
            f = w * d / k  # (w * d^2 / k) along the unit vector
            dx_[i] -= ex * f
            dy_[i] -= ey * f
            dx_[j] += ex * f
            dy_[j] += ey * f

        for i in range(n):
            dx_[i] -= gravity * (xs[i] - cx0)
            dy_[i] -= gravity * (ys[i] - cy0)
            disp = math.sqrt(dx_[i] ** 2 + dy_[i] ** 2) + 1e-9
            step = min(disp, temp)
            xs[i] += dx_[i] / disp * step
            ys[i] += dy_[i] / disp * step
    return xs, ys


def quantise(xs: list[float], ys: list[float]):
    """Map coordinates to ints 0..65535 with a margin, clipping the far outliers."""

    def span(vs: list[float]):
        s = sorted(vs)
        lo, hi = s[int(0.005 * (len(s) - 1))], s[int(math.ceil(0.995 * (len(s) - 1)))]
        return lo, max(hi, lo + 1e-9)

    (x0, x1), (y0, y1) = span(xs), span(ys)
    scale = (1 - 2 * MARGIN) * COORD_MAX / max(x1 - x0, y1 - y0)  # one scale: keep the shape
    ox = COORD_MAX / 2 - (x0 + x1) / 2 * scale
    oy = COORD_MAX / 2 - (y0 + y1) / 2 * scale

    def q(v: float, o: float) -> int:
        return min(COORD_MAX, max(0, round(v * scale + o)))

    return [q(x, ox) for x in xs], [q(y, oy) for y in ys]


def communities(n: int, total: int, adj: list[dict[int, float]], xs, ys, rng: random.Random) -> list[int]:
    """Cluster index per genre (nodes < n): weighted label propagation over the
    whole graph, virtual nodes included, merged down to MAX_CLUSTERS."""
    label = list(range(total))
    order = list(range(total))
    for _ in range(40):
        rng.shuffle(order)
        moved = 0
        for i in order:
            if not adj[i]:
                continue
            score: dict[int, float] = defaultdict(float)
            for j, w in adj[i].items():
                score[label[j]] += w
            best = max(score.items(), key=lambda kv: (kv[1], -kv[0]))
            if score.get(label[i], 0.0) < best[1]:
                label[i] = best[0]
                moved += 1
        if not moved:
            break

    groups: dict[int, list[int]] = defaultdict(list)
    for i, lab in enumerate(label):
        groups[lab].append(i)

    def real(g: list[int]) -> list[int]:
        return [i for i in g if i < n]

    ranked = sorted((g for g in groups.values() if real(g)), key=lambda g: (-len(real(g)), g[0]))
    big, small = ranked[:MAX_CLUSTERS], ranked[MAX_CLUSTERS:]

    owner = {}
    for c, members in enumerate(big):
        for i in members:
            owner[i] = c
    centre = []
    for g in big:
        r = real(g)
        centre.append((sum(xs[i] for i in r) / len(r), sum(ys[i] for i in r) / len(r)))
    for members in small:
        tie: dict[int, float] = defaultdict(float)
        for i in members:
            for j, w in adj[i].items():
                if j in owner:
                    tie[owner[j]] += w
        if tie:
            target = max(tie.items(), key=lambda kv: (kv[1], -kv[0]))[0]
        else:  # no edge into a big community (isolated): nearest by layout
            r = real(members)
            mx = sum(xs[i] for i in r) / len(r)
            my = sum(ys[i] for i in r) / len(r)
            target = min(range(len(big)), key=lambda c: (centre[c][0] - mx) ** 2 + (centre[c][1] - my) ** 2)
        for i in members:
            owner[i] = target
    return [owner[i] for i in range(n)]


def build(cache: Path, refresh: bool, iterations: int, seed: int, built: str):
    genres = fetch_musicbrainz(cache, refresh)
    wd = fetch_wikidata(cache, refresh)

    genres = sorted({g["name"]: g for g in genres}.values(), key=lambda g: g["name"])
    names = [g["name"] for g in genres]
    mbids = [g["id"] for g in genres]
    n = len(names)
    edges, total, matched = build_edges(names, mbids, wd)

    adj: list[dict[int, float]] = [{} for _ in range(total)]
    for (i, j), w in edges.items():
        adj[i][j] = w
        adj[j][i] = w

    rng = random.Random(seed)
    t0 = time.time()
    xs, ys = layout(total, edges, rng, iterations)
    layout_s = time.time() - t0
    qx, qy = quantise(xs[:n], ys[:n])
    cluster = communities(n, total, adj, xs, ys, rng)
    # Colour index 0 = biggest cluster; renumber so that empty indexes never appear.
    sizes = defaultdict(int)
    for c in cluster:
        sizes[c] += 1
    used = sorted(sizes, key=lambda c: (-sizes[c], c))
    remap = {c: k for k, c in enumerate(used)}
    cluster = [remap[c] for c in cluster]

    # Genre-to-genre strength: direct edges, plus two hops through a virtual node.
    link: list[dict[int, float]] = [{} for _ in range(n)]
    for i in range(n):
        for j, w in adj[i].items():
            if j < n:
                link[i][j] = max(link[i].get(j, 0.0), w)
            else:
                for k, w2 in adj[j].items():
                    if k < n and k != i:
                        link[i][k] = max(link[i].get(k, 0.0), 0.5 * min(w, w2))
    degree = [sum(a.values()) for a in adj[:n]]
    top = max(degree) or 1.0
    w = [round(100 * math.log1p(d) / math.log1p(top)) for d in degree]
    related = []
    for i in range(n):
        ranked = sorted(link[i], key=lambda j: (-link[i][j], -w[j], names[j]))
        related.append(ranked[:MAX_RELATED])

    data = {
        "version": 1,
        "built": built,
        "sources": ["MusicBrainz genre list (CC0)", "Wikidata (CC0)"],
        "n": names,
        "x": qx,
        "y": qy,
        "c": cluster,
        "w": w,
        "r": related,
        "mb": mbids,
    }
    stats = {
        "genres": n,
        "wikidata_match": len(matched),
        "edges": len(edges),
        "direct_edges": sum(1 for (i, j), v in edges.items() if j < n and v != NAME_WEIGHT),
        "virtual_nodes": total - n,
        "virtual_edges": sum(1 for (i, j) in edges if j >= n),
        "name_edges": sum(1 for (i, j), v in edges.items() if j < n and v == NAME_WEIGHT),
        "isolated": sum(1 for i in range(n) if not adj[i]),
        "no_related": sum(1 for r in related if not r),
        "clusters": len(used),
        "cluster_sizes": sorted(sizes.values(), reverse=True),
        "layout_seconds": round(layout_s, 1),
    }
    return data, stats, (xs, ys)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output JSON path")
    ap.add_argument(
        "--cache",
        type=Path,
        default=Path(tempfile.gettempdir()) / "spitifo-genre-map-cache",
        help="folder for the raw downloads",
    )
    ap.add_argument("--refresh", action="store_true", help="download again even if cached")
    ap.add_argument("--iterations", type=int, default=150, help="layout iterations")
    ap.add_argument("--seed", type=int, default=17, help="random seed of the layout")
    ap.add_argument("--built", default=datetime.date.today().isoformat(), help="date stamped in the file")
    args = ap.parse_args()

    args.cache.mkdir(parents=True, exist_ok=True)
    started = time.time()
    try:
        data, stats, _ = build(args.cache, args.refresh, args.iterations, args.seed, args.built)
    except DownloadError as err:
        print(f"download failed, nothing written: {err}", file=sys.stderr)
        return 1

    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(payload)
    packed = len(gzip.compress(payload, 9, mtime=0))

    print(f"genres:            {stats['genres']}")
    print(f"with Wikidata:     {stats['wikidata_match']}")
    print(
        f"edges:             {stats['edges']} ({stats['direct_edges']} genre-genre from Wikidata, "
        f"{stats['virtual_edges']} via {stats['virtual_nodes']} intermediate items, {stats['name_edges']} by name)"
    )
    print(f"isolated:          {stats['isolated']} (no related genre at all: {stats['no_related']})")
    print(f"clusters:          {stats['clusters']} sizes {stats['cluster_sizes']}")
    print(f"layout:            {stats['layout_seconds']} s")
    print(f"output:            {args.out} {len(payload)} B raw, {packed} B gzip")
    print(f"total:             {time.time() - started:.1f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
