"""Prueba end-to-end de yt-dlp: download con job_id + polling de progreso."""
import asyncio
import httpx
from pathlib import Path

BASE = "http://127.0.0.1:8000"


async def main():
    async with httpx.AsyncClient(timeout=300, base_url=BASE) as c:
        r = await c.get("/api/search",
                        params={"q": "numb linkin park", "limit": 5,
                                "source": "ytdlp"})
        res = r.json()["results"]
        if not res:
            print("sin resultados ytdlp")
            return
        t = res[0]
        print(f"objetivo: {t['title'][:50]}")
        print(f"  video : {t['extra'].get('webpage_url')}")

        body = {k: v for k, v in t.items() if k != "downloadable"}
        rd = await c.post("/api/download", json={"source": "ytdlp",
                                                "track": body, "fmt": "mp3"})
        print(f"download POST -> {rd.status_code}")
        j = rd.json()
        job_id = j.get("job_id")
        print(f"  job_id: {job_id}")

        # polling de progreso
        last = -1
        for i in range(120):
            pr = await c.get(f"/api/download/progress/{job_id}")
            d = pr.json()
            p = d.get("progress", 0)
            if p != last:
                print(f"  {d.get('status'):<12} {p}%  speed={d.get('speed')}")
                last = p
            if d.get("status") in ("done", "error"):
                print(f"  FINAL: {d.get('status')} -> {d.get('path')}")
                if d.get("status") == "done":
                    p = Path(d["path"])
                    print(f"  archivo: {p.name} ({p.stat().st_size} bytes)")
                    from mutagen import File as MFile
                    mf = MFile(p)
                    if mf:
                        i = mf.info
                        print(f"  codec info: bitrate={getattr(i,'bitrate',None)} "
                              f"sr={getattr(i,'sample_rate',None)} "
                              f"len={round(getattr(i,'length',0),1)}s")
                        if mf.tags:
                            print(f"  tags: {dict(mf.tags)}")
                break
            await asyncio.sleep(1)


asyncio.run(main())
