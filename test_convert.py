"""Prueba de la ruta de conversion: descarga un FLAC de archive -> MP3 con nombre correcto."""
import asyncio
import httpx
from pathlib import Path

BASE = "http://127.0.0.1:8000"


async def main():
    async with httpx.AsyncClient(timeout=300, base_url=BASE) as c:
        # buscar un item de archive con flac
        r = await c.get("/api/search", params={"q": "jazz", "limit": 10, "source": "archive"})
        data = r.json()
        print(f"archive results: {data['count']}")
        cand = data["results"][0]
        print(f"target: {cand['title'][:40]}")

        t0 = {k: v for k, v in cand.items() if k != "downloadable"}
        rr = await c.post("/api/resolve", json=t0)
        print(f"resolve: {rr.status_code}")
        rt = {k: v for k, v in rr.json().items() if k != "downloadable"}
        print(f"  source format={rt['extra'].get('format')} url=...{rt['audio_url'][-40:]}")

        # descargar como mp3 (fuerza conversion si el original es flac/opus)
        rd = await c.post("/api/download", json={"source": "archive", "track": rt, "fmt": "mp3"})
        print(f"download: {rd.status_code}")
        print(rd.text[:300])
        if rd.status_code == 200:
            j = rd.json()
            p = Path(j["path"])
            print(f"\nRESULTADO: {j['filename']}")
            print(f"  existe={p.exists()} bytes={p.stat().st_size} ({j['size_mb']}MB)")
            from mutagen import File as MFile
            mf = MFile(p)
            if mf:
                info = mf.info
                print(f"  codec={getattr(info,'codec',None)} bitrate={getattr(info,'bitrate',None)} "
                      f"sample_rate={getattr(info,'sample_rate',None)} length={getattr(info,'length',None)}")
                print(f"  tags={dict(mf.tags) if mf.tags else 'sin tags'}")

        lib = (await c.get("/api/library")).json()
        print(f"\nlibrary: {lib['count']} archivos")
        for f in lib["files"]:
            print(f"  {f['filename']}")


asyncio.run(main())
