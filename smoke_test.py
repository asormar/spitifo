"""Prueba de humo real contra la API de Spitifo: search -> resolve -> download."""
import asyncio
import json
import sys

import httpx

BASE = "http://127.0.0.1:8000"


async def main():
    async with httpx.AsyncClient(timeout=60, base_url=BASE) as c:
        print("=== HEALTH ===")
        h = (await c.get("/api/health")).json()
        for s in h["sources"]:
            print(f"  {s['name']:<10} activa={s['active']} key={s['needs_key']}")
        print(f"  biblioteca: {h['library']}")

        print("\n=== SEARCH 'blues' ===")
        r = await c.get("/api/search", params={"q": "blues", "limit": 12})
        print(f"  status={r.status_code}")
        data = r.json()
        print(f"  count={data['count']}")
        for t in data["results"]:
            flag = "DL" if t["downloadable"] else ("RSV" if t["extra"].get("needs_resolve") else "PV")
            print(f"  [{flag}] {t['source']:<9} {t['title'][:40]:<40} {t['artist'][:24]}")

        dl = [t for t in data["results"] if t["downloadable"]]
        rsv = [t for t in data["results"] if t["extra"].get("needs_resolve")]

        # probar resolve
        if rsv:
            print(f"\n=== RESOLVE (archive) {rsv[0]['title'][:30]} ===")
            t0 = dict(rsv[0])
            t0.pop("downloadable", None)
            rr = await c.post("/api/resolve", json=t0)
            print(f"  status={rr.status_code}")
            if rr.status_code == 200:
                rt = rr.json()
                print(f"  audio_url={str(rt['audio_url'])[:100]}")
                print(f"  formato={rt['extra'].get('format')} size={rt['extra'].get('size_mb')}MB")
                dl = dl + [rt]
            else:
                print(f"  ERROR {rr.text[:200]}")

        # probar descarga real
        if dl:
            target = dl[0]
            print(f"\n=== DOWNLOAD {target['title'][:34]} ({target['format'] if 'format' in target else target['extra'].get('format')}) ===")
            body = {"source": target["source"], "track": {
                k: v for k, v in target.items() if k != "downloadable"},
                "fmt": "mp3"}
            rd = await c.post("/api/download", json=body, timeout=300)
            print(f"  status={rd.status_code}")
            if rd.status_code == 200:
                j = rd.json()
                print(f"  OK -> {j['filename']} ({j['size_mb']} MB, {j['format']})")
                print(f"  ruta: {j['path']}")
                # verificar que el archivo existe y tiene tags
                from mutagen import File as MFile
                from pathlib import Path
                p = Path(j["path"])
                print(f"  existe={p.exists()} bytes_en_disco={p.stat().st_size}")
                mf = MFile(p)
                if mf:
                    print(f"  tags: {dict(mf.tags) if mf.tags else mf.info}")
                else:
                    print("  tags: (mutagen no lo reconoce, ver formato)")
            else:
                print(f"  ERROR {rd.text[:300]}")
        else:
            print("\n  (no habia pistas descargables para probar)")

        print("\n=== LIBRARY ===")
        lib = (await c.get("/api/library")).json()
        print(f"  archivos={lib['count']}")
        for f in lib["files"][:5]:
            print(f"  {f['filename'][:50]} ({f['size_mb']}MB)")


asyncio.run(main())
