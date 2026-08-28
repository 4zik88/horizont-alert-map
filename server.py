from __future__ import annotations

import json
import os
import time
import threading
import urllib.request
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Хостинги (Railway, Render, Fly) задають порт через змінну PORT і вимагають
# слухати 0.0.0.0. Локально нічого не змінюється: без PORT лишається 127.0.0.1.
_DEFAULT_HOST = "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1"
HOST = os.environ.get("HOST", _DEFAULT_HOST)
PORT = int(os.environ.get("PORT", "8765"))
ROOT = Path(__file__).resolve().parent
NEPTUN_ALERTS_URL = "https://neptun.in.ua/api/v1/alerts"
NEPTUN_THREATS_URL = "https://neptun.in.ua/api/v1/threats"
NEPTUN_OBLASTS_GEOJSON_URL = "https://neptun.in.ua/oblasts.geojson"
NEPTUN_RAIONS_GEOJSON_URL = "https://neptun.in.ua/raions.geojson"

# Кеш відповідей NEPTUN. Без нього кожен відвідувач тягне джерело напряму: при
# 20 одночасних це ~640 запитів за хвилину з одного IP і майже певний бан.
# З кешем частота звернень до NEPTUN стала і не залежить від кількості людей.
CACHE_TTL_SECONDS = {
    NEPTUN_ALERTS_URL: 3.0,
    NEPTUN_THREATS_URL: 4.0,
    # Межі областей і районів змінюються хіба що раз на роки.
    NEPTUN_OBLASTS_GEOJSON_URL: 3600.0,
    NEPTUN_RAIONS_GEOJSON_URL: 3600.0,
}
DEFAULT_CACHE_TTL = 5.0
# Наскільки довго можна віддавати прострочені дані, коли NEPTUN не відповідає.
# Коротко й свідомо: показувати стару обстановку як свіжу — гірше, ніж помилка.
STALE_ON_ERROR_SECONDS = 30.0

_cache: dict[str, tuple[float, bytes]] = {}
_cache_lock = threading.Lock()
_fetch_locks: dict[str, threading.Lock] = {}


def fetch_upstream(url: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Horizon-Radar/1.0",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=12) as response:
        body = response.read()
    # Перевіряємо, що це справді JSON, ще до того, як покласти в кеш.
    json.loads(body.decode("utf-8"))
    return body


def cached_fetch(url: str) -> bytes:
    """Віддає відповідь NEPTUN із кешу; у мережу йде не більше одного потоку."""
    ttl = CACHE_TTL_SECONDS.get(url, DEFAULT_CACHE_TTL)

    with _cache_lock:
        entry = _cache.get(url)
        if entry and time.time() - entry[0] < ttl:
            return entry[1]
        lock = _fetch_locks.setdefault(url, threading.Lock())

    # Один потік іде по дані, решта чекає тут і забирає вже готовий результат,
    # інакше на кожному протуханні кешу всі одночасні запити пішли б у мережу.
    with lock:
        with _cache_lock:
            entry = _cache.get(url)
            if entry and time.time() - entry[0] < ttl:
                return entry[1]
        try:
            body = fetch_upstream(url)
        except Exception:
            with _cache_lock:
                entry = _cache.get(url)
            if entry and time.time() - entry[0] < ttl + STALE_ON_ERROR_SECONDS:
                return entry[1]
            raise
        with _cache_lock:
            _cache[url] = (time.time(), body)
        return body


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        # Базовий translate_path прибирає ".."-сегменти й прив'язує шлях до
        # os.getcwd() (main() ставить його в ROOT). Не обходити його власною
        # склейкою: інакше /../../etc/passwd виходить за межі папки карти.
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean in ("", "/"):
            clean = "/index.html"
        return super().translate_path(clean)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self) -> None:
        route = self.path.split("?", 1)[0]
        if route == "/api/alerts":
            self.proxy_json(NEPTUN_ALERTS_URL)
            return
        if route == "/api/threats":
            self.proxy_json(NEPTUN_THREATS_URL)
            return
        if route == "/api/oblasts-geojson":
            self.proxy_json(NEPTUN_OBLASTS_GEOJSON_URL)
            return
        if route == "/api/raions-geojson":
            self.proxy_json(NEPTUN_RAIONS_GEOJSON_URL)
            return
        super().do_GET()

    def proxy_json(self, url: str) -> None:
        try:
            body = cached_fetch(url)
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:
            body = json.dumps({"error": str(exc)}, ensure_ascii=False).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, fmt: str, *args: object) -> None:
        print(fmt % args)


def should_open_browser() -> bool:
    """Локально відкриваємо вкладку, на сервері — ніколи."""
    flag = os.environ.get("OPEN_BROWSER", "").strip().lower()
    if flag in ("0", "false", "no"):
        return False
    if flag in ("1", "true", "yes"):
        return True
    return HOST in ("127.0.0.1", "localhost", "::1")


def main() -> None:
    os.chdir(ROOT)
    # directory=ROOT прив'язує роздачу файлів до папки карти явно, а не через
    # поточний каталог процесу.
    handler = partial(Handler, directory=str(ROOT))
    server = ThreadingHTTPServer((HOST, PORT), handler)
    shown_host = "127.0.0.1" if HOST == "0.0.0.0" else HOST
    url = f"http://{shown_host}:{PORT}/"
    print(f"Карта запущена: {url}  (слухаю {HOST}:{PORT})", flush=True)
    if should_open_browser():
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
