"""Fuerza la rama de conversion: descarga un WAV de wikimedia pidiendo mp3."""
import asyncio
import httpx
from pathlib import Path

BASE = "http://127.0.0.1:8000"


async def main():
    async with httpx.AsyncClient(timeout=300, base_url=BASE) as c:
        r = await c.get("/api/search", params={"q": "piano", "limit": 20, "source": "wikimedia"})
        data = r.json()
        # buscar uno que sea wav (ext != mp3) para forzar ffmpeg
        wav = [t for t in data["results"] if t["audio_url"].lower().split("?")[0].endswith(".wav")]
        ogg = [t for t in data["results"] if t["audio_url"].lower().split("?")[0].endswith((".ogg", ".opus", ".flac"))]
        print(f"wikimedia results={data['count']} wav={len(wav)} ogg/flac={len(ogg)}")
        target = (wav or ogg or data["results"])[0]
        orig = target["audio_url"].split(".")[-1].split("?")[0].lower()
        print(f"target: {target['title'][:40]} (origen .{orig})")

        t0 = {k: v for k, v in target.items() if k != "downloadable"}
        rd = await c.post("/api/download", json={"source": "wikimedia", "track": t0, "fmt": "mp3"})
        print(f"download: {rd.status_code}")
        if rd.status_code == 200:
            j = rd.json()
            p = Path(j["path"])
            print(f"RESULTADO: {j['filename']} ({j['size_mb']}MB, formato={j['format']})")
            print(f"  existe={p.exists()} bytes={p.stat().st_size}")
            from mutagen import File as MFile
            mf = MFile(p)
            if mf:
                i = mf.info
                print(f"  bitrate={getattr(i,'bitrate',None)} sr={getattr(i,'sample_rate',None)} "
                      f"len={round(getattr(i,'length',0),1)}s")
                print(f"  tags TIT2={mf.tags.get('TIT2')} TPE1={mf.tags.get('TPE1')}")
            # confirmar que no quedo el tmp
            leftovers = [f.name for f in p.parent.iterdir() if f.name.startswith(".")]
            print(f"  temporales huerfanos: {leftovers or 'ninguno'}")
        else:
            print(rd.text[:400])


asyncio.run(main())
