#!/usr/bin/env python3
"""Build the Discover genre map (frontend/public/genre-map.json) from CC0 data.

    python scripts/discover/build_genre_map.py [--out frontend/public/genre-map.json]
        [--cache <dir>] [--refresh] [--iterations 150] [--seed 17]

Pipeline (see docs/adr/0003-discover-data.md, decision 1):

1. Nodes: the MusicBrainz genre list (CC0), paged at 1 request per second.
2. Edges: Wikidata (CC0) items that carry a MusicBrainz genre id (P8052) and
   their relations to other such items, from three SPARQL queries (direct
   relations, intermediate items without a MusicBrainz id, and their parents).
   Weights: subclass of 1.0, influenced by 0.6, every other relation 0.5. A
   genre with no other edge gets weak edges to the genres its name is built
   from ("latin trap" -> "trap", "latin"; 0.3) or shares a rare word with (0.2).
3. Groups (at most 16, also the colours): Louvain on the graph alone, links
   through hub genres discounted, then the cheapest communities merged.
4. Layout: the groups are placed first with a small force layout of the group
   graph; then Fruchterman-Reingold in pure Python with a pull of every genre
   to its group's centre, so hubs do not blur the middle into one soup.
   Repulsion is exact against the neighbouring grid cells and uses one centre
   of mass per far cell. Seeded, so the same input gives the same map. Genres
   nothing links to are parked on a ring outside.
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
import heapq
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
TOKEN_WEIGHT = 0.2  # genres that only share a rare word
TOKEN_MAX_HOLDERS = 30  # a word in more genre names than this says nothing
STOP_WORDS = frozenset({"music", "song", "songs", "and", "the", "for", "del", "los", "las"})
VIRTUAL_WEIGHT = 0.7  # genre <-> intermediate Wikidata item without an MBID
UP_PROPS = ("P279", "P737", "P144")
MAX_CLUSTERS = 16
MAX_RELATED = 5
INTERMEDIATE_HOPS = 4  # how far a genre with no other relation looks through intermediate items
NEIGHBOURS = 10  # neighbours looked at by the cohesion metric
COORD_MAX = 65535
# Layout and clustering knobs.
HUB_POWER = 0.7  # how much a link through a hub is discounted (0 = not at all)
RESOLUTION = 1.0  # Louvain resolution (higher: more, smaller communities)
GROUP_RADIUS = 0.8  # initial radius of a group, per square root of its size
GROUP_PULL = 6.0  # attraction between related groups when they are placed
GROUP_GRAVITY = 0.6  # pull of every node to the centroid of its group (0.15: hubs blur the middle)
GRAVITY = 0.05  # pull of every node to the middle of the map
REPULSION = 1.0
ATTRACTION = 2.0  # the edge force grows with distance to this power (2 = Fruchterman-Reingold)
START_TEMP = 0.06  # initial maximum step, as a share of the map side
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

    # Fallback: genres with no genre neighbour (direct, or through an intermediate
    # item) get weak edges to the genres their name is built from.
    nbrs: dict[int, set[int]] = defaultdict(set)
    for i, j in edges:
        nbrs[i].add(j)
        nbrs[j].add(i)
    lonely = [
        i for i in range(n) if not any(j < n or any(k < n and k != i for k in nbrs[j]) for j in nbrs[i])
    ]
    for i, others in name_relatives(names, lonely, {i: len(nbrs[i]) for i in range(n)}).items():
        for j, w in others:
            add(i, j, w, over=False)
    return edges, n + len(alive), matched


def name_relatives(names: list[str], lonely: list[int], degree: dict[int, int]):
    """For each lonely genre, up to 3 (genre, weight) built from its name:

    1. a phrase of its words that is itself a genre ("latin trap" -> "trap", "latin"),
    2. a genre it ends with ("steampunk" -> "punk"),
    3. genres sharing its rarest words ("tamil folk" -> the other "tamil ..." genres).
    """
    by_name = {nm: i for i, nm in enumerate(names)}

    def words(name: str) -> list[str]:
        return [t for t in re.split(r"[\s/&-]+", name.lower()) if len(t) >= 3 and t not in STOP_WORDS]

    freq: dict[str, int] = defaultdict(int)
    holders: dict[str, list[int]] = defaultdict(list)
    for i, nm in enumerate(names):
        for t in set(words(nm)):
            freq[t] += 1
            holders[t].append(i)

    out: dict[int, list[tuple[int, float]]] = {}
    for i in lonely:
        name = names[i]
        tokens = [t for t in re.split(r"[\s/&]+", name) if t]
        found: list[tuple[int, float]] = []

        def take(j, w):
            if j is not None and j != i and all(j != f for f, _ in found):
                found.append((j, w))

        for cut in range(1, len(tokens)):
            for part in (" ".join(tokens[cut:]), " ".join(tokens[:-cut])):
                take(by_name.get(part), NAME_WEIGHT)
        if not found:
            tail = max((g for g in names if len(g) >= 4 and len(name) - len(g) >= 3 and name.endswith(g)), key=len, default=None)
            if tail:
                take(by_name[tail], NAME_WEIGHT)
        if not found:
            score: dict[int, float] = defaultdict(float)
            for t in set(words(name)):
                if freq[t] <= TOKEN_MAX_HOLDERS:
                    for j in holders[t]:
                        if j != i:
                            score[j] += math.log(len(names) / freq[t])
            for j in sorted(score, key=lambda j: (-score[j], -degree.get(j, 0), names[j]))[:3]:
                take(j, TOKEN_WEIGHT)
        if found:
            out[i] = found[:3]
    return out


def hub_normalise(adj: list[dict[int, float]], power: float) -> list[dict[int, float]]:
    """Edge weights divided by (strength_i * strength_j) ** power, so that a link
    through a hub ("pop", "rock") says less than a link between two specific
    genres. Rescaled to keep the mean weight, so the force balance is unchanged."""
    strength = [sum(a.values()) or 1.0 for a in adj]
    out = [{j: w / (strength[i] * strength[j]) ** power for j, w in a.items()} for i, a in enumerate(adj)]
    old = sum(w for a in adj for w in a.values())
    new = sum(w for a in out for w in a.values())
    scale = old / new if new else 1.0
    return [{j: w * scale for j, w in a.items()} for a in out]


def louvain(adj: list[dict[int, float]], resolution: float, rng: random.Random) -> list[int]:
    """Community id per node: Louvain modularity optimisation (local moves, then
    the communities become the nodes of the next level)."""
    size = len(adj)
    members = [[i] for i in range(size)]
    graph = [dict(a) for a in adj]
    loops = [0.0] * size
    while True:
        count = len(graph)
        strength = [sum(g.values()) + 2 * loops[i] for i, g in enumerate(graph)]
        m2 = sum(strength)
        if not m2:
            break
        comm = list(range(count))
        total = strength[:]
        improved = False
        moved = True
        while moved:
            moved = False
            order = list(range(count))
            rng.shuffle(order)
            for i in order:
                here = comm[i]
                links: dict[int, float] = defaultdict(float)
                for j, w in graph[i].items():
                    links[comm[j]] += w
                total[here] -= strength[i]
                best, gain = here, links.get(here, 0.0) - resolution * total[here] * strength[i] / m2
                for c, link in links.items():
                    g = link - resolution * total[c] * strength[i] / m2
                    if g > gain + 1e-12:
                        best, gain = c, g
                total[best] += strength[i]
                if best != here:
                    comm[i] = best
                    moved = improved = True
        if not improved:
            break
        ids = {c: k for k, c in enumerate(sorted(set(comm)))}
        merged: list[list[int]] = [[] for _ in ids]
        new_graph: list[dict[int, float]] = [defaultdict(float) for _ in ids]
        new_loops = [0.0] * len(ids)
        for i, c in enumerate(comm):
            k = ids[c]
            merged[k] += members[i]
            new_loops[k] += loops[i]
            for j, w in graph[i].items():
                kj = ids[comm[j]]
                if kj == k:
                    new_loops[k] += w / 2
                else:
                    new_graph[k][kj] += w
        members, graph, loops = merged, [dict(g) for g in new_graph], new_loops
    label = [0] * size
    for k, group in enumerate(members):
        for i in group:
            label[i] = k
    return label


def merge_communities(adj: list[dict[int, float]], label: list[int], target: int) -> list[int]:
    """Merge communities, always the pair that costs modularity least, until
    `target` are left."""
    ids = sorted(set(label))
    index = {c: k for k, c in enumerate(ids)}
    label = [index[c] for c in label]
    count = len(ids)
    strength = [0.0] * count
    link: list[dict[int, float]] = [defaultdict(float) for _ in range(count)]
    for i, a in enumerate(adj):
        for j, w in a.items():
            strength[label[i]] += w
            if label[i] != label[j]:
                link[label[i]][label[j]] += w / 2  # each edge is seen from both ends
    m2 = sum(strength)
    alive = set(range(count))
    parent = list(range(count))
    while len(alive) > target:
        best = None
        for a in alive:
            for b in alive:
                if a < b:
                    gain = link[a].get(b, 0.0) - strength[a] * strength[b] / m2
                    if best is None or (gain, -a, -b) > best[0]:
                        best = ((gain, -a, -b), a, b)
        _, a, b = best
        for c, w in link[b].items():
            if c != a:
                link[a][c] += w
                link[c][a] += w
            link[c].pop(b, None)
        link[a].pop(b, None)
        link[b] = defaultdict(float)
        strength[a] += strength[b]
        alive.discard(b)
        parent[b] = a

    def root(c: int) -> int:
        while parent[c] != c:
            c = parent[c]
        return c

    return [root(c) for c in label]


def place_groups(group: list[int], adj: list[dict[int, float]], rng: random.Random):
    """Centre and radius of every group: a small force layout of the group graph,
    where bigger groups are pushed further apart and related ones pulled together."""
    ids = sorted(set(group))
    index = {c: k for k, c in enumerate(ids)}
    count = len(ids)
    size = [0] * count
    strength = [0.0] * count
    tie = [[0.0] * count for _ in range(count)]
    for i, a in enumerate(adj):
        gi = index[group[i]]
        size[gi] += 1
        for j, w in a.items():
            gj = index[group[j]]
            strength[gi] += w
            if gi != gj:
                tie[gi][gj] += w
    radius = [GROUP_RADIUS * math.sqrt(s) for s in size]
    pull = [
        [tie[a][b] / math.sqrt(strength[a] * strength[b]) if tie[a][b] else 0.0 for b in range(count)]
        for a in range(count)
    ]
    span = math.sqrt(sum(size))
    px = [rng.uniform(-1, 1) * span for _ in range(count)]
    py = [rng.uniform(-1, 1) * span for _ in range(count)]
    rounds = 600
    for it in range(rounds):
        temp = 3.0 * (1 - it / rounds) + 0.05
        fx = [0.0] * count
        fy = [0.0] * count
        for a in range(count):
            for b in range(a + 1, count):
                ex, ey = px[a] - px[b], py[a] - py[b]
                d = math.hypot(ex, ey) + 1e-9
                ideal = (radius[a] + radius[b]) * 1.1
                f = ideal * ideal / d - GROUP_PULL * pull[a][b] * d * d / ideal
                fx[a] += ex / d * f
                fy[a] += ey / d * f
                fx[b] -= ex / d * f
                fy[b] -= ey / d * f
        for a in range(count):
            fx[a] -= 0.05 * px[a]
            fy[a] -= 0.05 * py[a]
            d = math.hypot(fx[a], fy[a]) + 1e-9
            step = min(d, temp)
            px[a] += fx[a] / d * step
            py[a] += fy[a] / d * step
    return {c: (px[k], py[k], radius[k]) for c, k in index.items()}


def layout(adj: list[dict[int, float]], group: list[int], rng: random.Random, iterations: int):
    """Force layout with a grid approximation of the repulsion.

    The groups (clusters found before the layout) start around their own centre,
    placed by `place_groups`, and every node is pulled weakly to the centroid of
    its group, so a cluster stays one region of the map."""
    n = len(adj)
    k = 1.0  # ideal edge length
    side = math.sqrt(n) * k
    spots = place_groups(group, adj, rng)
    xs = [0.0] * n
    ys = [0.0] * n
    for i in range(n):
        gx, gy, r = spots[group[i]]
        angle = rng.uniform(0, 2 * math.pi)
        reach = r * math.sqrt(rng.random())
        xs[i] = gx + reach * math.cos(angle)
        ys[i] = gy + reach * math.sin(angle)
    edge_list = [(i, j, w) for i, a in enumerate(adj) for j, w in a.items() if i < j]
    members: dict[int, list[int]] = defaultdict(list)
    for i, g in enumerate(group):
        members[g].append(i)
    cell = 4.0 * k
    t0 = side * START_TEMP

    for it in range(iterations):
        temp = max(t0 * (1 - it / iterations) ** 1.5, 0.02)
        # Bin the nodes; keep a centre of mass per occupied cell.
        grid: dict[tuple[int, int], list[int]] = defaultdict(list)
        for i in range(n):
            grid[(int(xs[i] // cell), int(ys[i] // cell))].append(i)
        far = []  # (cell key, count, mean x, mean y)
        for key, cell_members in grid.items():
            m = len(cell_members)
            far.append((key, m, sum(xs[i] for i in cell_members) / m, sum(ys[i] for i in cell_members) / m))

        dx_ = [0.0] * n
        dy_ = [0.0] * n
        for (gx, gy), cell_members in grid.items():
            near = []
            for ax in (gx - 1, gx, gx + 1):
                for ay in (gy - 1, gy, gy + 1):
                    near += grid.get((ax, ay), ())
            beyond = [c for c in far if abs(c[0][0] - gx) > 1 or abs(c[0][1] - gy) > 1]
            for i in cell_members:
                xi, yi = xs[i], ys[i]
                fx = fy = 0.0
                for j in near:
                    if j == i:
                        continue
                    ex, ey = xi - xs[j], yi - ys[j]
                    d2 = ex * ex + ey * ey
                    if d2 < 1e-6:  # coincident: nudge apart deterministically
                        ex, ey, d2 = 0.01 * ((i - j) % 7 - 3), 0.01 * ((i + j) % 5 - 2), 1e-4
                    f = REPULSION * k * k / d2  # (k^2 / d) along the unit vector
                    fx += ex * f
                    fy += ey * f
                for _, m, mx, my in beyond:
                    ex, ey = xi - mx, yi - my
                    f = REPULSION * k * k * m / (ex * ex + ey * ey + 1e-9)
                    fx += ex * f
                    fy += ey * f
                dx_[i] = fx
                dy_[i] = fy

        for i, j, w in edge_list:
            ex, ey = xs[i] - xs[j], ys[i] - ys[j]
            d = math.sqrt(ex * ex + ey * ey) + 1e-9
            f = w * d ** (ATTRACTION - 1) / k ** (ATTRACTION - 1)  # w * d^ATTRACTION along the unit vector
            dx_[i] -= ex * f
            dy_[i] -= ey * f
            dx_[j] += ex * f
            dy_[j] += ey * f

        for ids in members.values():
            mx = sum(xs[i] for i in ids) / len(ids)
            my = sum(ys[i] for i in ids) / len(ids)
            for i in ids:
                dx_[i] -= GROUP_GRAVITY * (xs[i] - mx)
                dy_[i] -= GROUP_GRAVITY * (ys[i] - my)
        for i in range(n):
            dx_[i] -= GRAVITY * xs[i]
            dy_[i] -= GRAVITY * ys[i]
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


def communities(adj: list[dict[int, float]], rng: random.Random) -> list[int]:
    """Group id per node, found on the graph alone (before any layout)."""
    return merge_communities(adj, louvain(adj, RESOLUTION, rng), MAX_CLUSTERS)


def through_intermediates(i: int, n: int, adj: list[dict[int, float]]) -> dict[int, float]:
    """Genres reachable from genre `i` through chains of intermediate items,
    weaker the longer the chain (a last resort for genres with no closer relation)."""
    best: dict[int, float] = {}
    frontier = {j: w for j, w in adj[i].items() if j >= n}
    seen = set(frontier)
    for hops in range(INTERMEDIATE_HOPS):
        nxt: dict[int, float] = {}
        for v, strength in frontier.items():
            for k, w in adj[v].items():
                if k < n:
                    if k != i:
                        best[k] = max(best.get(k, 0.0), 0.5 * min(strength, w) * 0.6**hops)
                elif k not in seen:
                    nxt[k] = max(nxt.get(k, 0.0), min(strength, w))
        seen |= set(nxt)
        frontier = nxt
    return best


def park_isolated(n: int, adj: list[dict[int, float]], xs: list[float], ys: list[float], owner: list[int]) -> None:
    """Put the genres without any edge on a ring just outside the layout, evenly
    spread, each in the cluster whose centre is nearest to its spot."""
    lone = [i for i in range(n) if not adj[i]]
    if not lone:
        return
    placed = [i for i in range(n) if adj[i]]
    sx, sy = sorted(xs[i] for i in placed), sorted(ys[i] for i in placed)
    lo, hi = int(0.005 * (len(placed) - 1)), int(math.ceil(0.995 * (len(placed) - 1)))
    cx, cy = (sx[lo] + sx[hi]) / 2, (sy[lo] + sy[hi]) / 2
    radius = max(sx[hi] - sx[lo], sy[hi] - sy[lo]) / 2
    sums: dict[int, list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])
    for i in placed:
        acc = sums[owner[i]]
        acc[0] += xs[i]
        acc[1] += ys[i]
        acc[2] += 1
    for k, i in enumerate(lone):
        angle = 2 * math.pi * k / len(lone)
        xs[i], ys[i] = cx + radius * math.cos(angle), cy + radius * math.sin(angle)
        owner[i] = min(sums, key=lambda g: ((sums[g][0] / sums[g][2] - xs[i]) ** 2 + (sums[g][1] / sums[g][2] - ys[i]) ** 2, g))


def quality_report(data: dict) -> dict:
    """Objective layout metrics, computed from the output columns only.

    - `related_ratio`: mean distance from a genre to its nearest related genre,
      over the mean distance of random pairs (lower is better, 1.0 = random).
    - `cohesion`: mean share of a genre's 10 nearest spatial neighbours that
      share its cluster (higher is better; ~0.1 for 16 equal clusters at random).
    - `no_related`: genres with an empty related list.
    """
    xs, ys, cl, rel = data["x"], data["y"], data["c"], data["r"]
    n = len(xs)
    rng = random.Random(0)
    pairs = [(rng.randrange(n), rng.randrange(n)) for _ in range(60000)]
    rand = [math.hypot(xs[i] - xs[j], ys[i] - ys[j]) for i, j in pairs if i != j]
    near = [min(math.hypot(xs[i] - xs[j], ys[i] - ys[j]) for j in r) for i, r in enumerate(rel) if r]
    same = 0.0
    for i in range(n):
        xi, yi = xs[i], ys[i]
        d2 = [((xs[j] - xi) ** 2 + (ys[j] - yi) ** 2, j) for j in range(n) if j != i]
        same += sum(cl[j] == cl[i] for _, j in heapq.nsmallest(NEIGHBOURS, d2)) / NEIGHBOURS
    return {
        "related_ratio": (sum(near) / len(near)) / (sum(rand) / len(rand)),
        "cohesion": same / n,
        "no_related": sum(1 for r in rel if not r),
    }


def print_report(rep: dict) -> None:
    print(f"related distance:  {rep['related_ratio']:.3f} of a random pair (lower is better)")
    print(f"cluster cohesion:  {rep['cohesion']:.3f} of the {NEIGHBOURS} nearest are in the same cluster (higher is better)")
    print(f"no related genre:  {rep['no_related']}")


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

    # Layout and clusters work on the connected nodes; the few genres nothing
    # links to are parked on an outer ring afterwards.
    active = [i for i in range(total) if adj[i]]
    slot = {i: k for k, i in enumerate(active)}
    discounted = hub_normalise(adj, HUB_POWER)
    graph = [{slot[j]: w for j, w in discounted[i].items()} for i in active]

    rng = random.Random(seed)
    group = communities(graph, rng)
    t0 = time.time()
    ax, ay = layout(graph, group, rng, iterations)
    layout_s = time.time() - t0
    xs = [0.0] * total
    ys = [0.0] * total
    owner = [-1] * total
    for i in active:
        xs[i], ys[i], owner[i] = ax[slot[i]], ay[slot[i]], group[slot[i]]
    park_isolated(n, adj, xs, ys, owner)
    qx, qy = quantise(xs[:n], ys[:n])
    cluster = owner[:n]
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
    for i in range(n):
        if not link[i]:  # only intermediate items around it: walk further through them
            link[i] = through_intermediates(i, n, adj)
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
    ap.add_argument("--report-only", type=Path, metavar="JSON", help="print the quality report of a map and exit")
    ap.add_argument("--built", default=datetime.date.today().isoformat(), help="date stamped in the file")
    args = ap.parse_args()

    if args.report_only:
        print_report(quality_report(json.loads(args.report_only.read_text(encoding="utf-8"))))
        return 0
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
    print_report(quality_report(data))
    print(f"output:            {args.out} {len(payload)} B raw, {packed} B gzip")
    print(f"total:             {time.time() - started:.1f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
