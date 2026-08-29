from __future__ import annotations

import html
import json
import os
import re
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

# Публічна веб-версія телеграм-каналу. Обрано sectorv666: у вибірці з 20 дописів
# він дав нуль новин і закликів про донати, на відміну від інших переглянутих
# каналів, і має послідовний формат «Область: N на Місто».
# Друге, незалежне від NEPTUN джерело стану тривог. Працює без ключа, але дає
# лише рівень областей — районів у ньому немає. Використовуємо для звірки, а не
# як заміну: розбіжність між двома джерелами і є тим, що варто бачити.
UBILLING_URL = "https://ubilling.net.ua/aerialalerts/"

CHANNEL_NAME = "sectorv666"
CHANNEL_URL = f"https://t.me/s/{CHANNEL_NAME}"
CHANNEL_CACHE_TTL = 60.0
CHANNEL_CACHE = {"timestamp": 0.0, "payload": None}

# Канал пише «Чернігівщина», NEPTUN — «Чернігівська область».
CHANNEL_OBLASTS = {
    "київщина": "Київська", "чернігівщина": "Чернігівська", "полтавщина": "Полтавська",
    "сумщина": "Сумська", "харківщина": "Харківська", "дніпропетровщина": "Дніпропетровська",
    "одещина": "Одеська", "миколаївщина": "Миколаївська", "черкащина": "Черкаська",
    "житомирщина": "Житомирська", "вінниччина": "Вінницька", "запоріжжя": "Запорізька",
    "кіровоградщина": "Кіровоградська", "херсонщина": "Херсонська", "донеччина": "Донецька",
    "луганщина": "Луганська", "хмельниччина": "Хмельницька", "рівненщина": "Рівненська",
    "волинь": "Волинська", "тернопільщина": "Тернопільська", "закарпаття": "Закарпатська",
    "буковина": "Чернівецька", "львівщина": "Львівська", "прикарпаття": "Івано-Франківська",
    "київ": "м. Київ",
}

# Кеш відповідей NEPTUN. Без нього кожен відвідувач тягне джерело напряму: при
# 20 одночасних це ~640 запитів за хвилину з одного IP і майже певний бан.
# З кешем частота звернень до NEPTUN стала і не залежить від кількості людей.
CACHE_TTL_SECONDS = {
    UBILLING_URL: 5.0,
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


# Звідки летить ціль. Канал пише напрямок словами («з півночі», «з рф»,
# «з Брянської області»), і це часто єдине джерело курсу: NEPTUN лишає heading
# порожнім приблизно у кожної п'ятої цілі. Градус — це курс РУХУ, тобто напрямок,
# протилежний тому, звідки ціль зайшла.
CHANNEL_BEARINGS = {
    "півночі": 180, "півдня": 0, "сходу": 270, "заходу": 90,
    "північного сходу": 225, "північного заходу": 135,
    "південного сходу": 315, "південного заходу": 45,
}

# Напрямки, названі місцем, а не стороною світу. Курс із них не виводимо —
# для цього треба знати, де саме ціль, — але текст показуємо як є.
CHANNEL_ORIGIN_RE = re.compile(
    r"\b(?:з|зі|із)\s+(рф|[А-ЯЇІЄҐ][а-яїієґ\'’\-]+(?:\s+(?:област[іь]|краю))?)")

CHANNEL_CARDINAL_RE = re.compile(
    r"\b(?:з|зі|із)\s+((?:північного|південного)\s+(?:сходу|заходу)|півночі|півдня|сходу|заходу)")


def parse_channel_direction(segment: str) -> tuple[str, "int | None"]:
    """Повертає (текст напрямку, курс руху в градусах або None)."""
    cardinal = CHANNEL_CARDINAL_RE.search(segment)
    if cardinal:
        word = re.sub(r"\s+", " ", cardinal.group(1).strip().lower())
        return f"з {word}", CHANNEL_BEARINGS.get(word)
    origin = CHANNEL_ORIGIN_RE.search(segment)
    if origin:
        return f"з {origin.group(1)}", None
    return "", None


def parse_channel_post(text: str) -> list[dict]:
    """Розбирає допис на записи «область → скільки, куди, чи реактивний».

    Формат каналу: «Чернігівщина: 4 на Десну з півночі, 2 на Срібне (реактивні)».
    Розбір свідомо консервативний: якщо рядок не вкладається в шаблон, ми його
    просто пропускаємо. Хибний запис на карті гірший за відсутній.
    """
    records: list[dict] = []
    text = re.sub(r"Підписатися.*", "", text, flags=re.S)
    text = re.sub(r"Please open Telegram.*", "", text, flags=re.S)
    current = None
    for line in text.split("\n"):
        line = re.sub(r"[^\S\n]+", " ", line).strip()
        if not line:
            continue
        head = re.match(r"^[^\wА-Яа-яЇїІіЄєҐґ]*([А-ЯЇІЄҐ][а-яїієґ]+)\s*:?\s*(.*)$", line)
        rest = line
        if head and head.group(1).lower() in CHANNEL_OBLASTS:
            current = CHANNEL_OBLASTS[head.group(1).lower()]
            rest = head.group(2)
        # Дописи на кшталт «На Ірпінь, Бучу» або «Бандероль на Зміїв, Харківщина!»
        # не мають заголовка з областю, але називають ціль цілком конкретно.
        # Раніше ми їх мовчки викидали. Тепер записуємо без області — клієнт
        # звіряє за назвою пункту, а область для нього лише пріоритет.
        # Шаблон призначення й так вимагає «на/біля/курс» + назву з великої,
        # тож звичайний текст під нього не потрапляє.
        oblast = current or ""
        # «(реактивні)» стоїть у кінці рядка, але стосується всіх його цілей.
        # Раніше ознаку діставав лише останній сегмент, тож решта цілей того ж
        # рядка вважалися пропелерними — і отримували вчетверо меншу швидкість.
        line_jet = "реактивн" in rest.lower()
        for segment in re.split(r"[,;]", rest):
            segment = segment.strip()
            if not segment:
                continue
            # «на Десну», «біля Нових Санжар», «курс Славутич» — канал вживає всі три,
            # і раніше ми бачили лише перший, тобто мовчки губили частину цілей.
            destination = re.search(
                r"(?:на|біля|курс)\s+([А-ЯЇІЄҐ][а-яїієґ\'’\-]+(?:\s+[А-ЯЇІЄҐ][а-яїієґ\'’\-]+)?)",
                segment)
            if not destination:
                continue
            count = re.search(r"(\d+)", segment)
            direction, bearing = parse_channel_direction(segment)
            records.append({
                "oblast": oblast,
                "count": int(count.group(1)) if count else 1,
                "destination": destination.group(1),
                "jet": line_jet or "реактивн" in segment.lower(),
                "direction": direction,
                "bearingDeg": bearing,
            })
    return records


def fetch_channel() -> dict:
    """Дописи каналу + витягнуті з них записи про цілі."""
    request = urllib.request.Request(
        CHANNEL_URL,
        headers={
            "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                           "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"),
            "Accept-Language": "uk-UA,uk;q=0.9,en;q=0.7",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        page = response.read().decode("utf-8", errors="replace")

    posts, records = [], []
    wraps = re.findall(
        r'<div class="tgme_widget_message_wrap.*?(?=<div class="tgme_widget_message_wrap|$)',
        page, flags=re.S)
    for wrap in wraps:
        stamp = re.search(r'<time[^>]+datetime="([^"]+)"', wrap)
        body = re.search(
            r'<div class="tgme_widget_message_text[^>]*>(.*?)</div>\s*'
            r'(?:<div class="tgme_widget_message_footer|$)', wrap, flags=re.S)
        if not stamp or not body:
            continue
        clean = re.sub(r"<br\s*/?>", "\n", body.group(1))
        clean = html.unescape(re.sub(r"<[^>]+>", "", clean)).strip()
        clean = re.sub(r"Підписатися.*", "", clean, flags=re.S).strip()
        if not clean:
            continue
        posts.append({"time": stamp.group(1), "text": clean})
        for record in parse_channel_post(clean):
            record["time"] = stamp.group(1)
            records.append(record)

    posts = posts[-12:]
    return {"channel": CHANNEL_NAME, "posts": posts, "records": records}


def cached_channel() -> bytes:
    now = time.time()
    with _cache_lock:
        if CHANNEL_CACHE["payload"] and now - CHANNEL_CACHE["timestamp"] < CHANNEL_CACHE_TTL:
            return CHANNEL_CACHE["payload"]
        lock = _fetch_locks.setdefault(CHANNEL_URL, threading.Lock())

    with lock:
        with _cache_lock:
            if CHANNEL_CACHE["payload"] and time.time() - CHANNEL_CACHE["timestamp"] < CHANNEL_CACHE_TTL:
                return CHANNEL_CACHE["payload"]
        payload = json.dumps(fetch_channel(), ensure_ascii=False).encode("utf-8")
        with _cache_lock:
            CHANNEL_CACHE["timestamp"] = time.time()
            CHANNEL_CACHE["payload"] = payload
        return payload


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
        if route == "/api/channel":
            self.serve_channel()
            return
        if route == "/api/alerts-alt":
            self.proxy_json(UBILLING_URL)
            return
        super().do_GET()

    def serve_channel(self) -> None:
        try:
            body = cached_channel()
            status = 200
        except Exception as exc:
            body = json.dumps({"error": str(exc), "posts": [], "records": []},
                              ensure_ascii=False).encode("utf-8")
            status = 502
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
