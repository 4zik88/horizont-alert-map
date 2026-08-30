const UKRAINE = [31.1656, 48.3794];
const DEFAULT_ZOOM = 5.15;
const RETURN_DELAY = 12000;
const REGION_FILES = [
  'UA_05_Vinnytska.geojson',
  'UA_07_Volynska.geojson',
  'UA_09_Luhanska.geojson',
  'UA_12_Dnipropetrovska.geojson',
  'UA_14_Donetska.geojson',
  'UA_18_Zhytomyrska.geojson',
  'UA_21_Zakarpatska.geojson',
  'UA_23_Zaporizka.geojson',
  'UA_26_Ivano_Frankivska.geojson',
  'UA_32_Kyivska.geojson',
  'UA_35_Kirovohradska.geojson',
  'UA_43_Avtonomna_Respublika_Krym.geojson',
  'UA_46_Lvivska.geojson',
  'UA_48_Mykolaivska.geojson',
  'UA_51_Odeska.geojson',
  'UA_53_Poltavska.geojson',
  'UA_56_Rivnenska.geojson',
  'UA_59_Sumska.geojson',
  'UA_61_Ternopilska.geojson',
  'UA_63_Kharkivska.geojson',
  'UA_65_Khersonska.geojson',
  'UA_68_Khmelnytska.geojson',
  'UA_71_Cherkaska.geojson',
  'UA_74_Chernihivska.geojson',
  'UA_77_Chernivetska.geojson'
];



const REGION_NEPTUN_KEYS = [
  'vinnytska',
  'volynska',
  'luhanska',
  'dnipropetrovska',
  'donetska',
  'zhytomyrska',
  'zakarpatska',
  'zaporizka',
  'ivano-frankivska',
  'kyivska',
  'kirovohradska',
  'krymska',
  'lvivska',
  'mykolaivska',
  'odeska',
  'poltavska',
  'rivnenska',
  'sumska',
  'ternopilska',
  'kharkivska',
  'khersonska',
  'khmelnytska',
  'cherkaska',
  'chernihivska',
  'chernivetska'
];

const OBLAST_NAME_TO_KEY = {
  'вінницька': 'vinnytska',
  'волинська': 'volynska',
  'луганська': 'luhanska',
  'дніпропетровська': 'dnipropetrovska',
  'донецька': 'donetska',
  'житомирська': 'zhytomyrska',
  'закарпатська': 'zakarpatska',
  'запорізька': 'zaporizka',
  'івано-франківська': 'ivano-frankivska',
  'київська': 'kyivska',
  'м. київ': 'kyivska',
  'київ': 'kyivska',
  'кіровоградська': 'kirovohradska',
  'автономна республіка крим': 'krymska',
  'ар крим': 'krymska',
  'крим': 'krymska',
  'львівська': 'lvivska',
  'миколаївська': 'mykolaivska',
  'одеська': 'odeska',
  'полтавська': 'poltavska',
  'рівненська': 'rivnenska',
  'сумська': 'sumska',
  'тернопільська': 'ternopilska',
  'харківська': 'kharkivska',
  'херсонська': 'khersonska',
  'хмельницька': 'khmelnytska',
  'черкаська': 'cherkaska',
  'чернігівська': 'chernihivska',
  'чернівецька': 'chernivetska'
};

let regionsGeoJSON = null;
let neptunOblastsGeoJSON = null;
let neptunRaionsGeoJSON = null;
// Полігони, які зараз у тривозі: райони плюс області. Наповнюються з того самого
// набору, який іде на підсвітку, тож карта й фільтр не можуть розійтися.
let alertedPolygons = [];
// Версія зростає з кожним оновленням тривог — за нею кеш на об'єкті цілі
// розуміє, що застарів.
let alertZoneVersion = 0;
let neptunRestTimer = null;

let neptunThreatsTimer = null;
let neptunRealtimeClient = null;
let neptunRealtimeUnsubscribe = null;
let currentThreats = [];
let threatAnimationFrame = null;
const threatMarkers = new Map();

// Сторож realtime-з'єднання. SDK може підключитися успішно, а відвалитися
// пізніше — тоді жоден try/catch не спрацює, і карта тихо застигне зі старими
// цілями, показуючи «LIVE». Якщо снапшотів немає довше STALE_MS — вмикаємо REST.
const THREATS_STALE_MS = 30000;
const THREATS_WATCHDOG_INTERVAL_MS = 5000;
const THREATS_REST_INTERVAL_MS = 5000;
let neptunThreatsMode = 'rest';
let neptunLastSnapshotAt = 0;
let neptunWatchdogTimer = null;
let backgroundWorkStarted = false;

// Позиції цілей перераховуються ~10 разів на секунду, а не на кожному кадрі:
// на масштабі карти різниця з 60 fps непомітна, а роботи вшестеро менше.
// На телефоні даємо маркерам удвічі рідший темп: там і процесор слабший, і
// екран менший, тож різниці не видно, а головний потік дихає вільніше.
const IS_SMALL_SCREEN = typeof matchMedia === 'function'
  && matchMedia('(max-width: 900px), (pointer: coarse)').matches;
const THREAT_FRAME_INTERVAL_MS = IS_SMALL_SCREEN ? 200 : 100;
const UNCERTAINTY_REBUILD_MS = IS_SMALL_SCREEN ? 2000 : 1000;
let lastThreatFrameAt = 0;
let lastUncertaintyRebuildAt = 0;

const THREAT_META = {
  uav:       { label: 'ШАХЕД / БПЛА', short: 'БПЛА', color: '#ff4d4d', iconKey: 'uav' },
  recon:     { label: 'РОЗВІД-БПЛА', short: 'РОЗВІД', color: '#f7d154', iconKey: 'recon' },
  fpv:       { label: 'FPV-ДРОН', short: 'FPV', color: '#ff884d', iconKey: 'fpv' },
  missile:   { label: 'РАКЕТА', short: 'РАКЕТА', color: '#ff1f1f', iconKey: 'missile' },
  ballistic: { label: 'БАЛІСТИКА', short: 'БАЛІСТ.', color: '#ff00d4', iconKey: 'ballistic' },
  kab:       { label: 'КАБ', short: 'КАБ', color: '#ff9f1a', iconKey: 'kab' },
  mig31k:    { label: 'МІГ-31К', short: 'МІГ-31К', color: '#b794ff', iconKey: 'mig31k' },
  unknown:   { label: 'НЕВІДОМА ЦІЛЬ', short: 'ЦІЛЬ', color: '#ffffff', iconKey: 'unknown' }
};

const THREAT_ICON_SVG = {
  // Мінімалістичні силуети зверху. Ніс кожної цілі спрямований вгору (0°).
  uav:`<svg viewBox="0 0 64 64" aria-hidden="true"><path class="target-silhouette" d="M32 3 L36 16 L58 35 L45 38 L37 35 L35 39 L38 42 L32 43 L26 42 L29 39 L27 35 L19 38 L6 35 L28 16 Z"/></svg>`,
  recon:`<svg viewBox="0 0 64 64" aria-hidden="true"><path class="target-silhouette" d="M32 4 L36 18 L56 34 L43 37 L36 34 L35 51 L40 57 L34 56 L32 61 L30 56 L24 57 L29 51 L28 34 L21 37 L8 34 L28 18 Z"/><circle cx="32" cy="28" r="2.2" class="target-cutout"/></svg>`,
  fpv:`<svg viewBox="0 0 64 64" aria-hidden="true"><path class="target-stroke" d="M23 23 41 41M41 23 23 41M32 24V40M24 32H40"/><circle cx="18" cy="18" r="7" class="target-ring"/><circle cx="46" cy="18" r="7" class="target-ring"/><circle cx="18" cy="46" r="7" class="target-ring"/><circle cx="46" cy="46" r="7" class="target-ring"/><rect x="27" y="27" width="10" height="10" rx="2" class="target-silhouette"/></svg>`,
  missile:`<svg viewBox="0 0 64 64" aria-hidden="true"><path class="target-silhouette" d="M32 3 C27 9 26 16 26 25 L26 40 L17 51 L26 48 L28 61 L32 55 L36 61 L38 48 L47 51 L38 40 L38 25 C38 16 37 9 32 3 Z"/><path class="target-cutout" d="M30 17h4v22h-4z"/></svg>`,
  ballistic:`<svg viewBox="0 0 64 64" aria-hidden="true"><path class="target-silhouette" d="M32 2 C26 10 25 17 25 27 L25 43 L15 55 L26 51 L29 62 L32 56 L35 62 L38 51 L49 55 L39 43 L39 27 C39 17 38 10 32 2 Z"/></svg>`,
  kab:`<svg viewBox="0 0 64 64" aria-hidden="true"><path class="target-silhouette" d="M32 5 C26 11 25 19 26 29 L12 36 L26 39 L28 52 L22 59 L32 56 L42 59 L36 52 L38 39 L52 36 L38 29 C39 19 38 11 32 5 Z"/></svg>`,
  mig31k:`<svg viewBox="0 0 64 64" aria-hidden="true"><path class="target-silhouette" d="M32 2 L37 19 L58 34 L43 37 L37 34 L36 49 L43 57 L35 55 L32 62 L29 55 L21 57 L28 49 L27 34 L21 37 L6 34 L27 19 Z"/></svg>`,
  unknown:`<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="10" class="target-silhouette"/></svg>`
};

function threatIconSvg(iconKey) {
  return THREAT_ICON_SVG[iconKey] || THREAT_ICON_SVG.unknown;
}

function threatMeta(type) {
  return THREAT_META[type] || THREAT_META.unknown;
}

function destinationPoint(lat, lon, bearingDeg, distanceKm) {
  const R = 6371;
  const d = distanceKm / R;
  const brng = bearingDeg * Math.PI / 180;
  const lat1 = lat * Math.PI / 180;
  const lon1 = lon * Math.PI / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
  const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 * 180 / Math.PI, lon: ((lon2 * 180 / Math.PI + 540) % 360) - 180 };
}

// --- Точність даних NEPTUN --------------------------------------------------
// У стрічці NEPTUN немає поля швидкості взагалі, тож будь-яке зміщення маркера —
// це локальна оцінка, а не вимір. Тримаємо вікно екстраполяції коротким: раніше
// БПЛА «летів» на вигаданих 160 км/год до 12 хвилин, тобто до 32 км вигадки.
const EXTRAPOLATION_MAX_MINUTES = 2;

// Розбіжність між годинником пристрою й сервером NEPTUN. Екстраполяція
// рахується від updatedAt до «зараз»; якщо телефон поспішає на 5 хвилин, кожна
// ціль отримує 13 зайвих кілометрів зсуву. serverTime приходить у кожній
// відповіді й досі не використовувався.
let serverClockOffsetMs = 0;
// Дрібну різницю ігноруємо: це мережева затримка, а не зсув годинника.
const CLOCK_OFFSET_MIN_MS = 2000;

function updateServerClockOffset(serverTimeIso) {
  const serverMs = Date.parse(serverTimeIso || '');
  if (!Number.isFinite(serverMs)) return;
  const offset = serverMs - Date.now();
  serverClockOffsetMs = Math.abs(offset) < CLOCK_OFFSET_MIN_MS ? 0 : offset;
}

// Час, від якого рахуємо рух: годинник пристрою, виправлений на зсув.
function correctedNow() {
  return Date.now() + serverClockOffsetMs;
}
// Для оцінки за типом вікно коротше: помилка накопичується швидше.
const EXTRAPOLATION_MAX_MINUTES_ESTIMATED = 1;

// Діапазони швидкостей за типом. NEPTUN не розрізняє підтипи: і пропелерний, і
// реактивний «Шахед» приходять як type:'uav', title:'БпЛА'. Тому одна константа
// принципово не може бути правильною — тримаємо діапазон, а розкид переносимо
// в коло невизначеності.
// Канал розрізняє реактивні «шахеди», а NEPTUN — ні: у нього всі БпЛА
// приходять як type:'uav', title:'БпЛА'. Коли канал каже, що над областю
// реактивні, ми звужуємо діапазон замість того, щоб гадати на 120–600.
const CHANNEL_URL_PATH = '/api/channel';
const CHANNEL_INTERVAL_MS = 60000;
// Допис старший за це вже не описує поточну обстановку.
const CHANNEL_HINT_TTL_MS = 20 * 60 * 1000;
const CHANNEL_SPEED = {
  jet:  { typical: 520, min: 450, max: 620 },
  prop: { typical: 170, min: 120, max: 220 }
};
let channelTimer = null;
let channelPosts = [];
// область → { jet: bool, at: мс }
const channelOblastHints = new Map();

function normalizeOblastName(value) {
  return String(value || '').replace(/\s*область\s*$/iu, '').trim().toLowerCase();
}

// Канал пише назви у непрямих відмінках («на Десну», «біля Славутича»), а NEPTUN —
// у називному («Десна», «Славутич»). Порівнювати рядки як є марно, тож обидві
// сторони зводимо до основи. Стемер навмисно грубий і однаковий для обох боків:
// його завдання — не розібрати морфологію, а лише не проґавити збіг. Хибний збіг
// стримує те, що область має збігтися окремо.
const UA_ENDINGS = /(?:ами|ями|ах|ях|ов|ев|ів|ей|ою|ею|ом|ем|ій|им|их|ий|а|я|у|ю|и|і|ї|е|о)$/u;

function placeStem(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[’']/gu, "'")
    .split(/[\s\-]+/u)
    .map(word => word.length > 4 ? word.replace(UA_ENDINGS, '') : word)
    .filter(Boolean)
    .join(' ');
}

// основа назви → записи каналу про цілі в цьому пункті. Ключ — саме назва, а не
// область: Славутич адміністративно київський, але канал відносить його до
// Чернігівщини, і на області як на жорсткому фільтрі ми цю ціль губили. Область
// лишається пріоритетом при виборі серед однойменних, а не умовою збігу.
const channelTargets = new Map();
// Зростає з кожним оновленням каналу — за ним кеш на об'єкті цілі розуміє,
// що застарів. Той самий прийом, що й з токенами полігонів: збіг рахується
// для кожної цілі в кожному кадрі, тож рахувати його щоразу заново — марно.
let channelVersion = 0;

function channelTargetKey(oblast) {
  return normalizeOblastName(oblast);
}

// Знаходить свіжий запис каналу, що описує цю ціль. Порівнюємо тільки назву
// населеного пункту — район і область у каналу й NEPTUN названі по-різному.
function channelMatchForThreat(threat) {
  if (!threat || typeof threat !== 'object') return null;
  const cached = threat.__channelMatch;
  if (cached && cached.version === channelVersion) return cached.match;
  const match = computeChannelMatch(threat);
  Object.defineProperty(threat, '__channelMatch', {
    value: { version: channelVersion, match },
    enumerable: false,
    configurable: true,
    writable: true
  });
  return match;
}

function computeChannelMatch(threat) {
  const places = [threat?.locality, threat?.district]
    .map(placeStem)
    .filter(Boolean);
  if (!places.length) return null;

  const oblast = channelTargetKey(threat?.region);
  let best = null;
  for (const place of places) {
    for (const record of channelTargets.get(place) || []) {
      if (!best) { best = record; continue; }
      // Спершу та сама область, потім свіжіше. Область без збігу не відкидає
      // запис — вона лише поступається однойменному запису зі своєї області.
      const bestSame = best.oblast === oblast;
      const recordSame = record.oblast === oblast;
      if (recordSame !== bestSame) { if (recordSame) best = record; continue; }
      if (record.at > best.at) best = record;
    }
  }
  return best;
}

// Повертає 'jet' | 'prop' | null для цілі, спираючись на свіжі згадки каналу.
function channelSpeedHint(threat) {
  if (String(threat?.type || '').toLowerCase() !== 'uav') return null;
  const hint = channelOblastHints.get(normalizeOblastName(threat?.region));
  if (!hint) return null;
  if (Date.now() - hint.at > CHANNEL_HINT_TTL_MS) return null;
  return hint.jet ? 'jet' : 'prop';
}

const TYPE_SPEED = {
  uav:       { typical: 180, min: 120, max: 600 },
  recon:     { typical: 120, min: 80,  max: 220 },
  fpv:       { typical: 90,  min: 40,  max: 160 },
  missile:   { typical: 780, min: 600, max: 950 },
  ballistic: { typical: 0,   min: 0,   max: 0   },
  kab:       { typical: 650, min: 450, max: 900 },
  mig31k:    { typical: 900, min: 700, max: 1100 },
  unknown:   { typical: 0,   min: 0,   max: 0   }
};

function threatUncertaintyKm(threat) {
  const km = Number(threat?.uncertaintyKm);
  return Number.isFinite(km) && km > 0 ? km : null;
}

// Прапорцю areaOnly довіряти не можна: у WebSocket-потоці його немає взагалі
// (0 із 33 записів), а в REST він буває відсутній там, де мав би стояти. Живий
// приклад: region 'Миколаївська область', locality порожній, радіус 45 км,
// lifecycle 'confirmed', areaOnly не виставлено — і такий запис малювався
// точкою в центрі області, де за визнанням самого джерела нічого немає.
// Тому ознаку визначаємо структурно, а прапорець лишається одним із варіантів.
const AREA_ONLY_UNCERTAINTY_KM = 45;

function isAreaOnlyThreat(threat) {
  if (threat?.areaOnly === true) return true;
  // Радіус у півсотні кілометрів — це вже не точка, а область.
  if ((Number(threat?.uncertaintyKm) || 0) >= AREA_ONLY_UNCERTAINTY_KM) return true;
  const locality = String(threat?.locality || '').trim();
  // Немає населеного пункту — немає й точки.
  if (!locality) return !String(threat?.district || '').trim();
  // «Харківська область» у полі населеного пункту означає рівно те саме.
  return normalizeOblastName(locality) === normalizeOblastName(threat?.region);
}

// Рухаємо ціль, якщо в неї взагалі є курс. Приблизна позиція (positionQuality
// 'approx') і припущений курс (presumptiveCourse) руху не забороняють — про їхню
// неточність говорять коло невизначеності, затухання маркера й підпис у попапі.
// А от areaOnly — це «відома лише область», рухати там нічого.
function canExtrapolateThreat(threat) {
  return !isAreaOnlyThreat(threat);
}

function distanceKmBetween(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Швидкість із треку — єдина реально виміряна швидкість, яку можна дістати:
// точки треку мають часові мітки. Це швидкість по хорді (перша→остання точка),
// тобто нижня оцінка: якщо ціль маневрувала, фактичний шлях довший за пряму.
const TRAIL_SPEED_MIN_SECONDS = 60;
const TRAIL_SPEED_MAX_SECONDS = 3600;
const TRAIL_SPEED_MIN_KMH = 15;

// Власна історія позицій. NEPTUN присилає trail лише у 2–4 цілей із 20, але ту
// саму ціль ми бачимо кожні 5 секунд — тож за хвилину маємо власний трек для
// КОЖНОЇ, а не для десятої частини. Це замінює вигадану швидкість виміряною.
const OWN_TRAIL_MAX_POINTS = 24;
// NEPTUN оновлює updatedAt часто, але саму координату зсуває приблизно раз на
// 21–23 хвилини (виміряно на цілях, що справді летіли). При вікні 12 хвилин
// попередня фіксація відсікалася раніше, ніж приходила наступна, тож у треку
// ніколи не було двох точок — а без двох точок немає ні швидкості, ні курсу.
const OWN_TRAIL_MAX_AGE_MS = 45 * 60 * 1000;
// Менше — це шум GPS-повідомлень, а не рух.
const OWN_TRAIL_MIN_STEP_KM = 0.3;
const ownTrails = new Map();

function recordThreatPositions() {
  const now = correctedNow();
  const seen = new Set();
  for (const threat of currentThreats) {
    if (!threat || threat.status === 'resolved') continue;
    const id = String(threat.id || '');
    const lat = Number(threat.lat), lon = Number(threat.lon);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    seen.add(id);

    // Прив'язуємось до updatedAt, а не до часу отримання: та сама координата
    // може прийти кілька разів поспіль, і це не означає, що ціль стояла.
    const stamp = Date.parse(threat.updatedAt || '') || now;
    const points = ownTrails.get(id) || [];
    const last = points[points.length - 1];
    if (last) {
      if (last.t === stamp) continue;
      if (distanceKmBetween(last.lat, last.lon, lat, lon) < OWN_TRAIL_MIN_STEP_KM) continue;
    }
    points.push({ lat, lon, t: stamp });
    while (points.length > OWN_TRAIL_MAX_POINTS) points.shift();
    while (points.length && now - points[0].t > OWN_TRAIL_MAX_AGE_MS) points.shift();
    ownTrails.set(id, points);
  }
  // Ціль зникла зі стрічки — прибираємо її історію, щоб мапа не росла.
  for (const id of ownTrails.keys()) if (!seen.has(id)) ownTrails.delete(id);
}

// Курс між двома точками: градуси від півночі за годинниковою стрілкою.
function bearingDegBetween(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const f1 = lat1 * rad, f2 = lat2 * rad, dl = (lon2 - lon1) * rad;
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Коротке плече дає випадковий курс: на 300 метрах шум повідомлень більший за рух.
const OWN_TRAIL_MIN_BEARING_KM = 2;
// Відношення прямої відстані до пройденого шляху. Ціль, що петляє між
// повідомленнями, курсу не має — і вигадувати їй курс гірше, ніж лишити без нього.
const OWN_TRAIL_MIN_STRAIGHTNESS = 0.7;

// Курс із власної історії. На відміну від швидкості, беремо не всю базу, а
// ОСТАННЄ плече: якщо ціль повернула, поточний курс — це той, яким вона летить
// зараз, а не усереднений за півгодини. Довга база лишається запобіжником:
// якщо весь трек хаотичний, курсу не даємо взагалі.
function ownTrailBearingDeg(threat) {
  const points = ownTrails.get(String(threat?.id || ''));
  if (!points || points.length < 2) return null;

  const prev = points[points.length - 2], last = points[points.length - 1];
  if (distanceKmBetween(prev.lat, prev.lon, last.lat, last.lon) < OWN_TRAIL_MIN_BEARING_KM) return null;

  // Перевірку на прямизну має сенс робити лише від трьох точок: на двох вона
  // завжди дорівнює одиниці й нічого не каже.
  if (points.length >= 3) {
    let pathKm = 0;
    for (let i = 1; i < points.length; i++) {
      pathKm += distanceKmBetween(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    }
    const netKm = distanceKmBetween(points[0].lat, points[0].lon, last.lat, last.lon);
    if (pathKm > 0 && netKm / pathKm < OWN_TRAIL_MIN_STRAIGHTNESS) return null;
  }

  return bearingDegBetween(prev.lat, prev.lon, last.lat, last.lon);
}

// Швидкість із власної історії. Беремо довгу базу (перша й остання точки):
// сусідні точки шумні й дають стрибки на сотні км/год.
function ownTrailSpeedKmh(threat, ceilingKmh) {
  const points = ownTrails.get(String(threat?.id || ''));
  if (!points || points.length < 2) return null;
  const first = points[0], last = points[points.length - 1];
  const seconds = (last.t - first.t) / 1000;
  if (seconds < TRAIL_SPEED_MIN_SECONDS || seconds > TRAIL_SPEED_MAX_SECONDS) return null;
  const kmh = distanceKmBetween(first.lat, first.lon, last.lat, last.lon) / (seconds / 3600);
  if (!Number.isFinite(kmh) || kmh < TRAIL_SPEED_MIN_KMH) return null;
  const ceiling = (ceilingKmh || 0) > 0 ? ceilingKmh * 1.5 : kmh;
  return Math.min(kmh, ceiling);
}

function trailDerivedSpeedKmh(threat, typeSpeedKmh) {
  const trail = Array.isArray(threat?.trail) ? threat.trail : [];
  if (trail.length < 2) return null;

  const first = trail[0];
  const last = trail[trail.length - 1];
  const t0 = Date.parse(first?.t || first?.time || '');
  const t1 = Date.parse(last?.t || last?.time || '');
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;

  const seconds = (t1 - t0) / 1000;
  if (seconds < TRAIL_SPEED_MIN_SECONDS || seconds > TRAIL_SPEED_MAX_SECONDS) return null;

  const lat0 = Number(first.lat), lon0 = Number(first.lon);
  const lat1 = Number(last.lat), lon1 = Number(last.lon);
  if (![lat0, lon0, lat1, lon1].every(Number.isFinite)) return null;

  const kmh = distanceKmBetween(lat0, lon0, lat1, lon1) / (seconds / 3600);
  if (!Number.isFinite(kmh) || kmh < TRAIL_SPEED_MIN_KMH) return null;

  // Стеля — півтори типові швидкості: захист від сміття в треку.
  const ceiling = (typeSpeedKmh || 0) > 0 ? typeSpeedKmh * 1.5 : kmh;
  return Math.min(kmh, ceiling);
}

function fallbackMotionForThreat(threat) {
  const type = String(threat?.type || 'unknown').toLowerCase();
  const explicitSpeed = Number(threat?.velocity?.speedKmh ?? threat?.speedKmh ?? threat?.speed_kmh);
  const explicitBearing = Number(threat?.velocity?.bearingDeg ?? threat?.heading ?? threat?.bearing);

  // Підказка каналу має перевагу над типовим діапазоном: вона конкретніша.
  const hint = channelSpeedHint(threat);
  const channelBearing = channelMatchForThreat(threat)?.bearingDeg ?? null;

  // Порядок курсу: справжній вектор зі стрічки → власний вимір → припущений курс
  // стрічки → сторона світу з каналу. Наш вимір б'є припущення NEPTUN, бо це
  // спостереження, а не оцінка, — але не б'є його ж виміряний вектор швидкості.
  // NEPTUN лишає курс порожнім приблизно у кожної п'ятої цілі; раніше такі цілі
  // просто стояли на місці, хоча ми бачили, як вони зсуваються між опитуваннями.
  const feedBearing = Number.isFinite(explicitBearing) ? explicitBearing : null;
  const feedPresumed = threat?.presumptiveCourse === true;
  const ownBearing = ownTrailBearingDeg(threat);
  const course =
      feedBearing !== null && !feedPresumed ? { deg: feedBearing, source: 'feed' }
    : ownBearing !== null                   ? { deg: ownBearing, source: 'own' }
    : feedBearing !== null                  ? { deg: feedBearing, source: 'feed' }
    : channelBearing !== null               ? { deg: channelBearing, source: 'channel' }
    : { deg: null, source: 'none' };
  const range = hint ? CHANNEL_SPEED[hint] : (TYPE_SPEED[type] || TYPE_SPEED.unknown);
  const hasExplicitVelocity = Number.isFinite(explicitSpeed) && explicitSpeed > 0;
  // Власна історія має перевагу над коротким треком зі стрічки: вона щільніша
  // й довша, бо накопичується з кожного опитування.
  const ownSpeed = hasExplicitVelocity ? null : ownTrailSpeedKmh(threat, range.max);
  const trailSpeed = (hasExplicitVelocity || ownSpeed !== null)
    ? null : trailDerivedSpeedKmh(threat, range.max);

  // Пріоритет: швидкість зі стрічки → власний трек → трек NEPTUN → оцінка за типом.
  const speedKmh = hasExplicitVelocity ? explicitSpeed
    : ownSpeed !== null ? ownSpeed
    : trailSpeed !== null ? trailSpeed
    : range.typical;
  const speedSource = hasExplicitVelocity ? 'feed'
    : ownSpeed !== null ? 'own'
    : trailSpeed !== null ? 'trail'
    : 'type';
  const measured = speedSource !== 'type';

  // Невідома швидкість = невідома позиція. Для оцінки за типом беремо найбільше
  // відхилення діапазону — саме воно потім розширює коло невизначеності.
  const speedSpreadKmh = measured
    ? 0
    : Math.max(range.max - range.typical, range.typical - range.min);

  return {
    speedKmh,
    speedSource,
    speedHint: hint,
    speedMinKmh: measured ? speedKmh : range.min,
    speedMaxKmh: measured ? speedKmh : range.max,
    speedSpreadKmh,
    bearingDeg: course.deg,
    bearingSource: course.source,
    // Виміряній швидкості довіряємо довше, ніж припущенню за типом.
    maxMinutes: measured ? EXTRAPOLATION_MAX_MINUTES : EXTRAPOLATION_MAX_MINUTES_ESTIMATED,
    hasExplicitVelocity
  };
}

function predictedThreatPosition(threat, nowMs = correctedNow()) {
  const lat = Number(threat?.lat);
  const lon = Number(threat?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const motion = fallbackMotionForThreat(threat);
  const anchor = Date.parse(threat?.updatedAt || threat?.confirmedAt || threat?.createdAt || '');
  const ageMinutes = Number.isFinite(anchor) ? Math.max(0, (nowMs - anchor) / 60000) : 0;
  const speedInfo = {
    speedKmh: motion.speedKmh,
    speedSource: motion.speedSource,
    speedHint: motion.speedHint,
    speedMinKmh: motion.speedMinKmh,
    speedMaxKmh: motion.speedMaxKmh,
    bearingSource: motion.bearingSource
  };
  const reported = { lat, lon, heading: motion.bearingDeg ?? 0, extrapolatedKm: 0, ageMinutes, ...speedInfo };

  // areaOnly — відома лише область, рухати нічого.
  if (!canExtrapolateThreat(threat)) return reported;

  // SDK використовуємо лише коли у стрічці є справжня швидкість. Без velocity
  // NEPTUN.predict зазвичай повертає вихідну точку, і маркер візуально зависає.
  if (motion.hasExplicitVelocity && window.NEPTUN && typeof window.NEPTUN.predict === 'function') {
    try {
      const predicted = window.NEPTUN.predict(threat, nowMs);
      const predictedLat = Number(predicted?.lat);
      const predictedLon = Number(predicted?.lon);
      if (Number.isFinite(predictedLat) && Number.isFinite(predictedLon)) {
        return {
          lat: predictedLat,
          lon: predictedLon,
          heading: Number.isFinite(Number(predicted?.heading))
            ? Number(predicted.heading)
            : (motion.bearingDeg ?? 0),
          extrapolatedKm: distanceKmBetween(lat, lon, predictedLat, predictedLon),
          ageMinutes,
          ...speedInfo
        };
      }
    } catch (error) {
      console.warn('NEPTUN.predict error, використовую локальний fallback:', error);
    }
  }

  if (!Number.isFinite(motion.speedKmh) || motion.speedKmh <= 0 || motion.bearingDeg === null) return reported;
  if (!Number.isFinite(anchor)) return reported;

  // updatedAt важливіший за confirmedAt: рух рахуємо від останньої фактичної координати.
  const elapsedMinutes = Math.min(ageMinutes, motion.maxMinutes);
  const distanceKm = motion.speedKmh * (elapsedMinutes / 60);
  const p = destinationPoint(lat, lon, motion.bearingDeg, distanceKm);
  return {
    ...p,
    heading: motion.bearingDeg,
    extrapolatedKm: distanceKm,
    // Розкид швидкості за той самий час — наскільки далі/ближче ціль може бути.
    speedUncertaintyKm: motion.speedSpreadKmh * (elapsedMinutes / 60),
    ageMinutes,
    ...speedInfo
  };
}

// Скільки одиниць несе трек. NEPTUN дає count лише в realtime-потоці й не завжди,
// канал натомість пише число прямо («4 реактивних на Славутич»). Людське число
// точніше, тож воно має перевагу.
function threatUnitCount(threat) {
  const match = channelMatchForThreat(threat);
  if (match) return match.count;
  return Math.max(1, Number(threat?.count) || 1);
}

// Підпис ×N ставимо лише там, де одиниць справді більше однієї. Кількість можна
// передати ззовні: маркер показує кластер, а не окремий трек.
function threatCountSuffix(threat, units = threatUnitCount(threat)) {
  return units > 1 ? ` ×${units}` : '';
}

// Скільки одиниць несе кластер. Максимум, а не сума: це повідомлення про ту саму
// ціль, і найдетальніше з них уже містить розмір групи.
function clusterUnitCount(cluster) {
  return Math.max(...cluster.map(threatUnitCount));
}

// Ціль, яку давно не оновлювали, — це вже не обстановка, а історія. NEPTUN не
// завжди позначає такі як resolved, тож знімаємо їх самі.
const STALE_THREAT_MINUTES = 10;

function threatAgeMinutes(threat, nowMs = Date.now()) {
  const anchor = Date.parse(threat?.updatedAt || threat?.confirmedAt || threat?.createdAt || '');
  return Number.isFinite(anchor) ? (nowMs - anchor) / 60000 : null;
}

function isStaleThreat(threat, nowMs = Date.now()) {
  const age = threatAgeMinutes(threat, nowMs);
  // Без часової мітки судити не можемо — лишаємо ціль на карті.
  return age !== null && age > STALE_THREAT_MINUTES;
}

// Актуальні цілі: не знято зі стрічки й не застаріли. Сюди входять і
// непідтверджені — вони потрібні лічильнику, щоб було видно, скільки саме
// повідомлень ми відсіяли.
function activeThreats(nowMs = Date.now()) {
  return currentThreats.filter(t => t && t.status !== 'resolved' && !isStaleThreat(t, nowMs));
}

// Скільки незалежних підтверджень робить ціль вартою показу. Вимога росте разом
// із розмитістю позиції: «БпЛА за 4 км звідси» з двома джерелами — це ціль,
// «БпЛА десь у колі 25 км» з двома джерелами — це ще чутка.
const MIN_SOURCE_COUNT = 2;
const VAGUE_POSITION_KM = 15;
const MIN_SOURCE_COUNT_VAGUE = 3;

// Відсіюємо саме неперевірені поодинокі повідомлення, а не все підряд.
// Фільтр по lifecycle був помилкою: NEPTUN позначає 'uncertain' навіть цілі
// з п'ятьма незалежними підтвердженнями, тож карта лишалась майже порожньою,
// поки в небі були десятки дронів. sourceCount відображає реальність краще.
// --- Чи лежить ціль у зоні тривоги ------------------------------------------
// Промінь праворуч: скільки ребер перетнув — непарне означає «всередині».
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) &&
        lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Полігон рахується разом із дірками: точка в дірці — це поза полігоном.
function polygonContains(rings, lon, lat) {
  if (!rings.length || !pointInRing(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(lon, lat, rings[i])) return false;
  return true;
}

// Прямокутник навколо полігона рахуємо один раз і кладемо на сам об'єкт: без
// нього кожне оновлення перебирало б усі вершини всіх полігонів у тривозі.
function featureBBox(feature) {
  if (feature.__bbox) return feature.__bbox;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const polys = feature.geometry?.type === 'MultiPolygon'
    ? feature.geometry.coordinates
    : [feature.geometry?.coordinates || []];
  for (const rings of polys) {
    for (const [x, y] of rings[0] || []) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const bbox = [minX, minY, maxX, maxY];
  Object.defineProperty(feature, '__bbox', { value: bbox, enumerable: false, configurable: true });
  return bbox;
}

function featureContains(feature, lon, lat) {
  const [minX, minY, maxX, maxY] = featureBBox(feature);
  if (lon < minX || lon > maxX || lat < minY || lat > maxY) return false;
  const polys = feature.geometry?.type === 'MultiPolygon'
    ? feature.geometry.coordinates
    : [feature.geometry?.coordinates || []];
  return polys.some(rings => polygonContains(rings, lon, lat));
}

// Скільки точок кола невизначеності пробуємо, окрім центра.
const ALERT_ZONE_PROBES = 8;

// Перевіряємо не точку, а коло невизначеності. Позиція відома з точністю
// ±4…25 км, тож строгий тест по центру сховав би цілі, що лежать одразу за
// межею району в тривозі — а це найчастіший випадок на підльоті.
function isInsideAlertZone(threat) {
  // Полігони ще не завантажені — перевірку пропускаємо. Інакше на старті, поки
  // межі вантажаться, карта сховала б усе.
  if (!alertedPolygons.length) return true;

  const cached = threat.__alertZone;
  if (cached && cached.version === alertZoneVersion) return cached.inside;

  const lat = Number(threat?.lat), lon = Number(threat?.lon);
  let inside = false;
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    inside = alertedPolygons.some(f => featureContains(f, lon, lat));
    const radiusKm = threatUncertaintyKm(threat);
    if (!inside && radiusKm) {
      for (let i = 0; i < ALERT_ZONE_PROBES && !inside; i++) {
        const p = destinationPoint(lat, lon, (i * 360) / ALERT_ZONE_PROBES, radiusKm);
        inside = alertedPolygons.some(f => featureContains(f, p.lon, p.lat));
      }
    }
  }

  Object.defineProperty(threat, '__alertZone', {
    value: { version: alertZoneVersion, inside },
    enumerable: false, configurable: true, writable: true
  });
  return inside;
}

// Причина, з якої ціль не потрапила на карту. Повертаємо саме причину, а не
// булеве значення: без неї неможливо сказати, яка з перевірок скільки зрізала.
function threatRejectionReason(threat) {
  // Область — не ціль, і це не залежить ні від каналу, ні від кількості джерел.
  // Перевірка йде першою: раніше згадка в каналі пропускала й обласний запис.
  if (isAreaOnlyThreat(threat)) return 'area';

  // Ціль над районом, у якому тривоги немає, — майже завжди хиба даних.
  if (!isInsideAlertZone(threat)) return 'no-alert-zone';

  // Згадка в каналі — незалежне людське підтвердження, вагоміше за будь-який
  // поріг по sourceCount. Якщо канал назвав цей населений пункт, ціль показуємо.
  if (channelMatchForThreat(threat)) return null;

  // Підтвердження потрібне всім, і 'confirmed' теж: раніше цей статус проходив
  // сам по собі, навіть з одним джерелом. Винятку для positionQuality тут немає
  // навмисно — заміряно, що 'confirmed' у ньому збігається з lifecycle
  // 'confirmed' у 8 випадках із 8, тобто це не незалежний сигнал, а той самий
  // під іншою назвою, і як виняток він робив цю перевірку порожньою.
  const uncertaintyKm = threatUncertaintyKm(threat) || 0;
  const needed = uncertaintyKm > VAGUE_POSITION_KM ? MIN_SOURCE_COUNT_VAGUE : MIN_SOURCE_COUNT;
  return (Number(threat?.sourceCount) || 0) >= needed ? null : 'weak';
}

function isTrustedThreat(threat) {
  return threatRejectionReason(threat) === null;
}

function visibleThreats(nowMs = Date.now()) {
  return activeThreats(nowMs).filter(isTrustedThreat);
}

// Дедуплікація для лічильника Й ДЛЯ КАРТИ. NEPTUN не зливає повідомлення різних
// спостерігачів про один і той самий дрон, тож два треки одного типу, що лежать
// у колі невизначеності одне одного й майже збігаються в часі, — це одна ціль.
// Раніше на карті лишались обидва маркери; від цього довелося відмовитись, бо
// саме воно давало «забагато міток в одному місці».
const DEDUPE_MAX_TIME_DIFF_MINUTES = 5;

function dedupeThreatClusters(threats, nowMs = Date.now()) {
  const parent = threats.map((_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

  for (let i = 0; i < threats.length; i++) {
    for (let j = i + 1; j < threats.length; j++) {
      const a = threats[i], b = threats[j];
      if (a.type !== b.type) continue;

      const ageA = threatAgeMinutes(a, nowMs), ageB = threatAgeMinutes(b, nowMs);
      if (ageA !== null && ageB !== null &&
          Math.abs(ageA - ageB) > DEDUPE_MAX_TIME_DIFF_MINUTES) continue;

      const lat1 = Number(a.lat), lon1 = Number(a.lon);
      const lat2 = Number(b.lat), lon2 = Number(b.lon);
      if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) continue;

      // Поріг — МЕНШЕ з двох кіл: зливаємо, лише коли точка лежить усередині
      // невизначеності обох. Спробував був max — і на живому нальоті це злило
      // Балаклію (13 джерел, ±4 км) із Савинцями (14 джерел, ±4 км) лише тому,
      // що поруч лежав один розмитий запис із радіусом 25 км. Розмитий запис
      // не має ставати магнітом, що поглинає точні й добре підтверджені цілі.
      const uncA = threatUncertaintyKm(a), uncB = threatUncertaintyKm(b);
      if (uncA === null || uncB === null) continue;
      if (distanceKmBetween(lat1, lon1, lat2, lon2) <= Math.min(uncA, uncB)) union(i, j);
    }
  }

  const clusters = new Map();
  threats.forEach((t, i) => {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(t);
  });
  return [...clusters.values()];
}

function trailsToGeoJSON() {
  const features = [];
  for (const t of visibleThreats()) {
    const points = Array.isArray(t?.trail) ? t.trail : [];
    const coordinates = points
      .map(p => [Number(p.lon), Number(p.lat)])
      .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
    if (coordinates.length < 2) continue;
    features.push({
      type: 'Feature',
      properties: { color: threatMeta(t.type).color, type: t.type || 'unknown' },
      geometry: { type: 'LineString', coordinates }
    });
  }
  return { type: 'FeatureCollection', features };
}

// Коло невизначеності будуємо як полігон, а не circle-шар: радіус у кілометрах
// лишається правильним на будь-якому масштабі без перерахунку в пікселі.
// 28 сегментів замість 48: на радіусах 2–70 км різниці на око немає, а вершин
// у геометрії вдвічі менше — це прямо зменшує роботу тесселятора.
const UNCERTAINTY_CIRCLE_SEGMENTS = IS_SMALL_SCREEN ? 20 : 28;

function circlePolygon(lat, lon, radiusKm, segments = UNCERTAINTY_CIRCLE_SEGMENTS) {
  const ring = [];
  for (let i = 0; i <= segments; i++) {
    const p = destinationPoint(lat, lon, (i * 360) / segments, radiusKm);
    ring.push([p.lon, p.lat]);
  }
  return { type: 'Polygon', coordinates: [ring] };
}

function uncertaintyToGeoJSON(nowMs = Date.now()) {
  const features = [];
  for (const t of visibleThreats(nowMs)) {
    const km = threatUncertaintyKm(t);
    if (!km) continue;
    const p = predictedThreatPosition(t, nowMs);
    if (!p) continue;
    // Якщо швидкість лише припущена, коло росте на її розкид: ціль могла піти
    // далі (реактивний БпЛА) або ближче (пропелерний).
    const radiusKm = km + (Number(p.speedUncertaintyKm) || 0);
    features.push({
      type: 'Feature',
      properties: {
        color: threatMeta(t.type).color,
        uncertaintyKm: radiusKm,
        reportedUncertaintyKm: km,
        areaOnly: isAreaOnlyThreat(t) ? 1 : 0
      },
      geometry: circlePolygon(p.lat, p.lon, radiusKm)
    });
  }
  return { type: 'FeatureCollection', features };
}

// Приблизна позиція не повинна виглядати як точний вимір.
function applyThreatMarkerState(el, threat) {
  // Та сама ознака, що й у лічильнику: підтверджена ціль чи ні. Інакше карта
  // й лічильник розповідали б різні історії про ту саму ціль.
  el.classList.toggle('is-uncertain', !isConfirmedThreat(threat));
  const quality = String(threat?.positionQuality || '').toLowerCase();
  el.classList.toggle('is-approx', quality === 'approx');
  el.classList.toggle('is-area-only', isAreaOnlyThreat(threat));
}

function createThreatMarkerElement(threat, units) {
  const meta = threatMeta(threat.type);
  const el = document.createElement('div');
  el.className = 'live-threat-marker';
  el.dataset.threatId = String(threat.id || '');
  el.style.setProperty('--threat-color', meta.color);
  applyThreatMarkerState(el, threat);

  const pulse = document.createElement('span');
  pulse.className = 'live-threat-pulse';

  const icon = document.createElement('span');
  icon.className = 'live-threat-icon';
  icon.innerHTML = threatIconSvg(meta.iconKey);

  const count = threatCountSuffix(threat, units);
  const label = document.createElement('span');
  label.className = 'live-threat-label';
  label.textContent = `${meta.short}${count}`;

  el.append(pulse, icon, label);
  return el;
}

function updateThreatMarkerContent(record, threat, units) {
  const meta = threatMeta(threat.type);
  record.el.style.setProperty('--threat-color', meta.color);
  applyThreatMarkerState(record.el, threat);
  // icon/label взяті з record: пошук по DOM робиться один раз при створенні маркера.
  if (record.icon && record.iconKey !== meta.iconKey) {
    record.icon.innerHTML = threatIconSvg(meta.iconKey);
    record.iconKey = meta.iconKey;
  }
  if (record.label) {
    const count = threatCountSuffix(threat, units);
    record.label.textContent = `${meta.short}${count}`;
  }
  record.threat = threat;
}

// Відкритим може бути лише один попап цілі.
let activeThreatPopup = null;
let activeThreatPopupId = null;

function closeThreatPopup() {
  const popup = activeThreatPopup;
  activeThreatPopup = null;
  activeThreatPopupId = null;
  popup?.remove();
}

// Виміряну швидкість показуємо числом, припущену — діапазоном: для БпЛА це
// різниця між пропелерним і реактивним, і ховати її означало б вводити в оману.
function speedRow(position, hasCourse) {
  if (!(position.speedKmh > 0)) return null;
  if (position.speedSource === 'feed') return `Швидкість: ~${Math.round(position.speedKmh)} км/год (зі стрічки)`;
  if (position.speedSource === 'own') return `Швидкість: ~${Math.round(position.speedKmh)} км/год (виміряна)`;
  if (position.speedSource === 'trail') return `Швидкість: ~${Math.round(position.speedKmh)} км/год (з треку)`;
  if (!hasCourse) return null;
  const range = `${Math.round(position.speedMinKmh)}–${Math.round(position.speedMaxKmh)} км/год`;
  if (position.speedHint === 'jet') return `Швидкість: ${range} (реактивний, за каналом)`;
  if (position.speedHint === 'prop') return `Швидкість: ${range} (пропелерний, за каналом)`;
  return `Швидкість: ${range} (невідома, оцінка за типом)`;
}

function showThreatPopup(threat, marker) {
  const safe = value => String(value || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const updated = threat.updatedAt
    ? new Date(threat.updatedAt).toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';
  const position = predictedThreatPosition(threat, correctedNow());
  if (!position) return;

  const quality = String(threat.positionQuality || '').toLowerCase();
  const positionLabel = isAreaOnlyThreat(threat)
    ? 'лише район, точки немає'
    : quality === 'confirmed' ? 'підтверджена'
    : quality === 'approx' ? 'приблизна'
    : '—';
  const match = channelMatchForThreat(threat);
  // Джерело курсу вирішує все: воно ж визначає, чи курс узагалі є.
  const hasCourse = position.bearingSource && position.bearingSource !== 'none';
  const heading = Math.round(Number(position.heading) || 0);
  const courseLabel = !hasCourse ? '—'
    : position.bearingSource === 'own' ? `${heading}° (виміряний)`
    : position.bearingSource === 'channel' ? `${heading}° (${safe(match?.direction || 'за каналом')})`
    : threat.presumptiveCourse === true ? `${heading}° (припущений)`
    : `${heading}°`;
  const uncertaintyKm = threatUncertaintyKm(threat);

  const rows = [
    `<strong>${safe(threat.title || threatMeta(threat.type).label)}</strong>`,
    safe(threat.locality || threat.district || threat.region || ''),
    `Позиція: ${safe(positionLabel)}`,
    uncertaintyKm ? `Невизначеність: ±${safe(uncertaintyKm)} км` : null,
    `Курс: ${safe(courseLabel)}`,
    speedRow(position, hasCourse),
    position.extrapolatedKm > 0.05 ? `Дораховано: ${position.extrapolatedKm.toFixed(1)} км` : null,
    `Джерел: ${Number(threat.sourceCount) || 0}`,
    // Звірка з каналом — окремий рядок: видно, чи цю ціль назвала людина, чи вона
    // тримається лише на автоматичних повідомленнях.
    match
      ? `Канал: ${safe(match.count)} на ${safe(match.destination)}${match.direction ? ' ' + safe(match.direction) : ''}`
      : 'Канал: не згадує',
    `Оновлено: ${safe(updated)}`
  ].filter(Boolean).join('<br>');

  // Клік по маркеру глушить подію (stopPropagation), тож closeOnClick сам
  // попередній попап не закриє — прибираємо його вручну, щоб відкритим був один.
  closeThreatPopup();

  const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, offset: 18 })
    .setLngLat([position.lon, position.lat])
    .setHTML(`<div class="threat-popup">${rows}${threat.explanationShort ? `<hr>${safe(threat.explanationShort)}` : ''}</div>`)
    .addTo(map);

  popup.on('close', () => {
    if (activeThreatPopup === popup) {
      activeThreatPopup = null;
      activeThreatPopupId = null;
    }
  });

  activeThreatPopup = popup;
  activeThreatPopupId = String(threat.id || '');
}

// Чи є взагалі цілі, які рухаються. Якщо ні — кола невизначеності статичні,
// і перебудовувати їх у циклі рендера не треба.
let anyThreatExtrapolating = false;

function refreshThreatGeometry(nowMs = Date.now()) {
  anyThreatExtrapolating = visibleThreats(nowMs).some(canExtrapolateThreat);
  map.getSource('neptun-threat-trails')?.setData(trailsToGeoJSON());
  map.getSource('neptun-threat-uncertainty')?.setData(uncertaintyToGeoJSON(nowMs));
}

// Скільки цілей і чому не потрапило на карту. Свідомо лише в консоль: рядок про
// неточні цілі в HUD користувач уже відхиляв двічі. Але ховати мовчки й зовсім
// без сліду небезпечно — коли фільтр помиляється, це має бути видно.
let lastFilterSummary = '';

function logFilterSummary(nowMs) {
  const active = activeThreats(nowMs);
  const reasons = { area: 0, 'no-alert-zone': 0, weak: 0 };
  for (const threat of active) {
    const reason = threatRejectionReason(threat);
    if (reason) reasons[reason] = (reasons[reason] || 0) + 1;
  }
  const hidden = reasons.area + reasons['no-alert-zone'] + reasons.weak;
  const line = `${active.length}/${hidden}/${reasons.area}/${reasons['no-alert-zone']}/${reasons.weak}`;
  // Друкуємо лише коли картина змінилась: інакше консоль заллє однаковими рядками.
  if (line === lastFilterSummary) return;
  lastFilterSummary = line;
  console.info(
    `Фільтр цілей: активних ${active.length}, сховано ${hidden} ` +
    `(рівень області ${reasons.area}, поза зоною тривоги ${reasons['no-alert-zone']}, ` +
    `без підтверджень ${reasons.weak})`
  );
}

function syncThreatMarkers() {
  const nowMs = correctedNow();
  logFilterSummary(nowMs);
  const visible = visibleThreats(nowMs).filter(
    t => Number.isFinite(Number(t.lat)) && Number.isFinite(Number(t.lon))
  );
  // Один маркер на кластер, а не на трек. Ведучий — той самий, що й у лічильнику,
  // інакше заголовок і карта показували б різні цілі.
  const clusters = dedupeThreatClusters(visible, nowMs);
  const activeIds = new Set();

  for (const cluster of clusters) {
    const threat = cluster.find(isConfirmedThreat) || cluster[0];
    const units = clusterUnitCount(cluster);
    const id = String(threat.id || `${threat.type}-${threat.lat}-${threat.lon}`);
    activeIds.add(id);
    let record = threatMarkers.get(id);
    if (!record) {
      const el = createThreatMarkerElement(threat, units);
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([Number(threat.lon), Number(threat.lat)])
        .addTo(map);
      record = {
        marker,
        el,
        threat,
        icon: el.querySelector('.live-threat-icon'),
        label: el.querySelector('.live-threat-label'),
        iconKey: threatMeta(threat.type).iconKey,
        heading: null,
        fade: 1
      };
      el.addEventListener('click', event => {
        event.stopPropagation();
        showThreatPopup(record.threat, record.marker);
      });
      threatMarkers.set(id, record);
    } else {
      updateThreatMarkerContent(record, threat, units);
    }
  }

  for (const [id, record] of threatMarkers) {
    if (!activeIds.has(id)) {
      // Ціль зникла зі стрічки — не лишаємо висіти її попап зі старими даними.
      if (activeThreatPopupId && activeThreatPopupId === id) closeThreatPopup();
      record.marker.remove();
      threatMarkers.delete(id);
    }
  }
}

function addNeptunThreatLayers() {
  // Зона невизначеності йде найнижче, під траєкторіями й маркерами.
  if (!map.getSource('neptun-threat-uncertainty')) {
    map.addSource('neptun-threat-uncertainty', { type: 'geojson', data: emptyFeatureCollection() });
    map.addLayer({
      id: 'neptun-threat-uncertainty-fill',
      type: 'fill',
      source: 'neptun-threat-uncertainty',
      paint: {
        'fill-color': ['get', 'color'],
        // Чим більша зона, тим блідіша заливка: коло на 70 км не має залити пів-екрана.
        'fill-opacity': ['interpolate', ['linear'], ['get', 'uncertaintyKm'],
          2, 0.17, 10, 0.11, 25, 0.07, 70, 0.035]
      }
    });
    map.addLayer({
      id: 'neptun-threat-uncertainty-line',
      type: 'line',
      source: 'neptun-threat-uncertainty',
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.7, 8, 1.1, 12, 1.5],
        'line-opacity': 0.55,
        'line-dasharray': [2, 2]
      }
    });
  }

  // Траєкторії залишаються MapLibre-шаром, а самі цілі — DOM-маркерами.
  // Це усуває залежність від glyph/font-шарів і гарантує видимість значків.
  if (!map.getSource('neptun-threat-trails')) {
    map.addSource('neptun-threat-trails', { type: 'geojson', data: emptyFeatureCollection() });
    map.addLayer({
      id: 'neptun-threat-trails',
      type: 'line',
      source: 'neptun-threat-trails',
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.3, 8, 2.5, 12, 3.8],
        'line-opacity': 0.68,
        'line-dasharray': [2, 2]
      }
    });
  }
}

function renderThreatsFrame(timestamp = 0) {
  threatAnimationFrame = requestAnimationFrame(renderThreatsFrame);
  if (timestamp && timestamp - lastThreatFrameAt < THREAT_FRAME_INTERVAL_MS) return;
  lastThreatFrameAt = timestamp;

  const now = correctedNow();
  for (const record of threatMarkers.values()) {
    const p = predictedThreatPosition(record.threat, now);
    if (!p) continue;
    record.marker.setLngLat([p.lon, p.lat]);
    // Курс міняється рідко — не переписуємо transform, поки він той самий.
    const heading = Number(p.heading) || 0;
    if (record.icon && heading !== record.heading) {
      record.icon.style.transform = `rotate(${heading}deg)`;
      record.heading = heading;
    }
    // Чим довше позиція дорахована, тим блідіший маркер: видно, де вимір,
    // а де вже локальна оцінка.
    const fade = p.extrapolatedKm > 0
      ? Math.round(Math.max(0.55, 1 - (p.ageMinutes / EXTRAPOLATION_MAX_MINUTES) * 0.45) * 100) / 100
      : 1;
    if (fade !== record.fade) {
      record.el.style.opacity = fade === 1 ? '' : String(fade);
      record.fade = fade;
    }
  }

  // Кола невизначеності — окремим, набагато рідшим темпом. Кожен setData
  // змушує MapLibre заново розібрати й тесселювати геометрію в головному
  // потоці; на 10 Гц це підвішувало телефон. Ціль зміщується щонайбільше на
  // кілька кілометрів за хвилину, тож раз на секунду цілком достатньо — на
  // око різниці немає, роботи вдесятеро менше.
  if (anyThreatExtrapolating && now - lastUncertaintyRebuildAt >= UNCERTAINTY_REBUILD_MS) {
    lastUncertaintyRebuildAt = now;
    map.getSource('neptun-threat-uncertainty')?.setData(uncertaintyToGeoJSON(now));
  }
}

// Розбивка за типами. Рахуємо не треки, а самі об'єкти: один трек може містити
// кілька одиниць (поле count), і саме воно показане на мітці маркера як ×N.
// NEPTUN публікує і підтверджені треки, і поодинокі неперевірені повідомлення.
// Поля lifecycle / displayConfidence / confidenceLevel / positionQuality несуть
// той самий сигнал, тож достатньо lifecycle із запасним варіантом.
function isConfirmedThreat(threat) {
  const lifecycle = String(threat?.lifecycle || '').toLowerCase();
  if (lifecycle) return lifecycle === 'confirmed';
  const confidence = String(threat?.displayConfidence || threat?.confidenceLevel || '').toLowerCase();
  return confidence === 'high';
}

function threatBreakdown(nowMs = Date.now()) {
  // Головне число — це мітки на карті, одна до одної. Раніше воно рахувало
  // одиниці (групу з 4 дронів як 4), і на екрані виходило 34 при двох десятках
  // маркерів: число й карта розповідали різне. Одиниці лишились, але окремим
  // рядком, а не заголовком.
  const visible = visibleThreats(nowMs);
  const clusters = dedupeThreatClusters(visible, nowMs);
  const merged = visible.length - clusters.length;

  const byType = new Map();
  let units = 0;
  let corroborated = 0;

  for (const cluster of clusters) {
    const lead = cluster.find(isConfirmedThreat) || cluster[0];
    const type = THREAT_META[lead.type] ? lead.type : 'unknown';
    byType.set(type, (byType.get(type) || 0) + 1);
    units += clusterUnitCount(cluster);
    if (cluster.some(channelMatchForThreat)) corroborated += 1;
  }

  const order = Object.keys(THREAT_META);
  const items = [...byType.entries()]
    .sort((a, b) => (b[1] - a[1]) || (order.indexOf(a[0]) - order.indexOf(b[0])));
  return { total: clusters.length, items, merged, units, corroborated };
}

function renderThreatCounter(suffix = '') {
  const counter = document.getElementById('threatCount');
  if (!counter) return;
  const { total, items, merged, units, corroborated } = threatBreakdown();

  counter.textContent = '';
  const head = document.createElement('div');
  head.className = 'threat-count__total';
  head.textContent = `ЦІЛІ: ${total}${suffix}`;
  counter.appendChild(head);

  const note = (text) => {
    const row = document.createElement('div');
    row.className = 'threat-count__merged';
    row.textContent = text;
    counter.appendChild(row);
  };

  // Група з чотирьох дронів — це один маркер, але чотири апарати. Показуємо
  // одиниці окремо, щоб заголовок лишався рівним кількості міток на карті.
  if (units > total) note(`ОДИНИЦЬ: ${units}`);
  // Скільки цілей назвав канал — незалежна від NEPTUN людська перевірка.
  if (total > 0) note(`ЗА КАНАЛОМ: ${corroborated} З ${total}`);
  // Скільки треків злито як дублі — щоб число не змінювалося «мовчки».
  if (merged > 0) note(`ЗЛИТО ДУБЛІВ: ${merged}`);

  if (!items.length) return;
  const list = document.createElement('div');
  list.className = 'threat-count__types';
  for (const [type, units] of items) {
    const meta = threatMeta(type);
    const chip = document.createElement('span');
    chip.className = 'threat-count__chip';
    chip.style.setProperty('--chip-color', meta.color);
    chip.textContent = `${meta.short} ${units}`;
    list.appendChild(chip);
  }
  counter.appendChild(list);
}

async function fetchNeptunThreats() {
  try {
    const payload = await fetchJSON(`/api/threats?t=${Date.now()}`);
    if (payload?.error) throw new Error(payload.error);
    updateServerClockOffset(payload?.serverTime);
    currentThreats = Array.isArray(payload?.threats) ? payload.threats : [];
    recordThreatPositions();
    syncThreatMarkers();
    refreshThreatGeometry();
    renderThreatCounter();
    console.log('NEPTUN active threats:', currentThreats.length, currentThreats);
  } catch (error) {
    console.warn('REST NEPTUN threats тимчасово недоступний:', error);
    const counter = document.getElementById('threatCount');
    if (counter) counter.textContent = 'ЦІЛІ: API НЕДОСТУПНИЙ';
  }
}

function applyThreatSnapshot(snapshot = {}) {
  updateServerClockOffset(snapshot?.serverTime);
  currentThreats = Array.isArray(snapshot?.threats) ? snapshot.threats : [];
  neptunLastSnapshotAt = Date.now();
  recordThreatPositions();
  syncThreatMarkers();
  refreshThreatGeometry();
  renderThreatCounter(' • LIVE');
}

function stopNeptunRealtime() {
  try { neptunRealtimeUnsubscribe?.(); } catch (_) {}
  try { neptunRealtimeClient?.stop?.(); } catch (_) {}
  neptunRealtimeUnsubscribe = null;
  neptunRealtimeClient = null;
}

function startThreatRestPolling(reason) {
  if (neptunThreatsTimer) return;
  if (reason) console.warn('Загрози: перехід на REST-опитування —', reason);
  neptunThreatsMode = 'rest';
  fetchNeptunThreats();
  neptunThreatsTimer = setInterval(fetchNeptunThreats, THREATS_REST_INTERVAL_MS);
}

function startThreatWatchdog() {
  clearInterval(neptunWatchdogTimer);
  neptunWatchdogTimer = setInterval(() => {
    if (neptunThreatsMode !== 'live') return;
    const age = Date.now() - neptunLastSnapshotAt;
    if (age <= THREATS_STALE_MS) return;
    // Обірване WebSocket-з'єднання не кидає виняток — ловимо його за тишею.
    stopNeptunRealtime();
    startThreatRestPolling(`немає снапшота ${Math.round(age / 1000)} с`);
  }, THREATS_WATCHDOG_INTERVAL_MS);
}

function startNeptunThreats() {
  clearInterval(neptunThreatsTimer);
  neptunThreatsTimer = null;

  if (threatAnimationFrame !== null) cancelAnimationFrame(threatAnimationFrame);
  threatAnimationFrame = requestAnimationFrame(renderThreatsFrame);

  startThreatWatchdog();

  if (window.NEPTUN && typeof window.NEPTUN.RealtimeClient === 'function') {
    try {
      stopNeptunRealtime();

      neptunRealtimeClient = new window.NEPTUN.RealtimeClient('https://neptun.in.ua');
      neptunRealtimeUnsubscribe = neptunRealtimeClient.subscribe((snapshot) => {
        applyThreatSnapshot(snapshot);
        console.log('NEPTUN realtime snapshot:', currentThreats.length, currentThreats);
      });
      neptunRealtimeClient.start();
      // Даємо з'єднанню фору до першого снапшота: відлік сторожа стартує зараз.
      neptunThreatsMode = 'live';
      neptunLastSnapshotAt = Date.now();
      return;
    } catch (error) {
      console.warn('WebSocket/SDK NEPTUN недоступний, переходжу на REST:', error);
      stopNeptunRealtime();
    }
  }

  // Резервний режим, якщо SDK не завантажився.
  startThreatRestPolling();
}

function normalizeAdminToken(value = '') {
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenVariants(value = '') {
  const raw = normalizeAdminToken(value);
  if (!raw) return [];
  const variants = new Set([raw]);
  variants.add(raw.replace(/\s+(область|район)$/u, '').trim());
  variants.add(raw.replace(/^автономна\s+республіка\s+/u, '').trim());
  return [...variants].filter(Boolean);
}

function itemTokens(item) {
  if (typeof item === 'string') return new Set(tokenVariants(item));
  const values = [item?.key, item?.name, item?.oblast, item?.region, item?.district];
  return new Set(values.flatMap(tokenVariants));
}

// Токени полігона не змінюються ніколи, тож рахуємо їх один раз і кешуємо на
// самому об'єкті. Раніше вони перебудовувались для КОЖНОЇ пари «полігон ×
// тривога»: 136 полігонів × 58 тривог давали десятки тисяч викликів
// normalize('NFKC') кожні три секунди й підвішували головний потік.
function featureTokens(feature) {
  if (feature.__tokens) return feature.__tokens;
  const p = feature?.properties || {};
  const values = [
    p.key, p.name, p.NAME_1, p.NAME_2, p.name_uk, p.name_ua,
    p.oblast, p.raion, p.district, p.region, p.admin_name,
    p.ADM1_UA, p.ADM2_UA, p.shapeName
  ];
  const tokens = new Set(values.flatMap(tokenVariants));
  // Некопійована властивість: не потрапить у JSON.stringify і в setData.
  Object.defineProperty(feature, '__tokens', { value: tokens, enumerable: false });
  return tokens;
}

// Один спільний набір токенів на весь список тривог — замість перебудови
// всередині циклу по полігонах.
function itemsTokenSet(items) {
  const set = new Set();
  for (const item of items || []) {
    for (const token of itemTokens(item)) set.add(token);
  }
  return set;
}

function featureMatchesTokenSet(feature, tokenSet) {
  if (!tokenSet.size) return false;
  for (const token of featureTokens(feature)) {
    if (tokenSet.has(token)) return true;
  }
  return false;
}

function featureMatchesItems(feature, items) {
  return featureMatchesTokenSet(feature, itemsTokenSet(items));
}

// І тривоги, і полігони мають готове поле key, і на живих даних воно збігається
// повністю: 52 з 52 районних і 3 з 3 обласних. Пряма відповідність точна, тоді
// як зіставлення за назвами — евристика з тихими промахами.
// Токени лишаємо запасним варіантом на випадок, якщо ключ колись зникне.
function matchAlertFeatures(collection, items) {
  const features = collection?.features || [];
  if (!features.length || !items?.length) return [];

  const keys = new Set();
  const withoutKey = [];
  for (const item of items) {
    const key = typeof item === 'string' ? item : item?.key;
    if (key) keys.add(String(key).toLowerCase());
    else withoutKey.push(item);
  }

  const matched = [];
  const unmatchedKeys = new Set(keys);
  for (const feature of features) {
    const key = String(feature?.properties?.key || '').toLowerCase();
    if (key && keys.has(key)) {
      matched.push(feature);
      unmatchedKeys.delete(key);
    }
  }

  // Тільки те, що не знайшлося за ключем, доганяємо старою евристикою.
  if (unmatchedKeys.size || withoutKey.length) {
    const leftovers = items.filter(item => {
      const key = typeof item === 'string' ? item : item?.key;
      return !key || unmatchedKeys.has(String(key).toLowerCase());
    });
    const tokens = itemsTokenSet(leftovers);
    const already = new Set(matched);
    for (const feature of features) {
      if (already.has(feature)) continue;
      if (featureMatchesTokenSet(feature, tokens)) matched.push(feature);
    }
    if (unmatchedKeys.size) {
      console.warn('Тривоги без збігу за ключем:', [...unmatchedKeys]);
    }
  }
  return matched;
}

function emptyFeatureCollection() {
  return { type: 'FeatureCollection', features: [] };
}

// Вік даних тривог. Показує, чи жива НАША карта: скільки секунд минуло з
// останнього успішного опитування. Затримку самого NEPTUN звідси не видно —
// поле updatedAt у стрічці означає час останньої ЗМІНИ, а не час знімка.
const ALERTS_INTERVAL_MS = 3000;
const ALERT_AGE_WARN_SECONDS = 12;
let lastAlertSummary = null;
let lastAlertsFetchAt = 0;
let alertAgeTimer = null;

function setLiveStatus(text, state = '') {
  const box = document.querySelector('.live-status');
  const el = box?.querySelector('.live-status__text');
  if (!el) return;
  // Пишемо у вкладений вузол, а не в textContent усього блоку: інакше
  // знищується <span> блимної крапки.
  el.textContent = text;
  box.classList.toggle('is-error', state === 'error');
  box.classList.toggle('is-stale', state === 'stale');
}

function renderAlertStatus() {
  if (!lastAlertSummary) return;
  const ageSec = Math.max(0, Math.round((Date.now() - lastAlertsFetchAt) / 1000));
  const s = lastAlertSummary;
  setLiveStatus(
    `ТРИВОГИ: РАЙОНИ ${s.raions}/${s.raionPolys} | ОБЛАСТІ ${s.oblasts}/${s.oblastPolys} | ${ageSec} С ТОМУ`,
    ageSec > ALERT_AGE_WARN_SECONDS ? 'stale' : ''
  );
}

function startAlertAgeTicker() {
  clearInterval(alertAgeTimer);
  alertAgeTimer = setInterval(renderAlertStatus, 1000);
}

let lastAlertPayload = null;

function applyNeptunAlerts(payload = {}) {
  lastAlertPayload = payload;
  const activeRaions = Array.isArray(payload.raions) ? payload.raions : [];
  const activeOblasts = Array.isArray(payload.oblasts) ? payload.oblasts : [];

  // Важно: районная тревога подсвечивает только район, а не всю область.
  // Целая область подсвечивается только тогда, когда она есть в payload.oblasts.
  const raionFeatures = matchAlertFeatures(neptunRaionsGeoJSON, activeRaions);
  const oblastFeatures = matchAlertFeatures(neptunOblastsGeoJSON, activeOblasts);

  map.getSource('neptun-alert-raions')?.setData({
    type: 'FeatureCollection',
    features: raionFeatures
  });
  map.getSource('neptun-alert-oblasts')?.setData({
    type: 'FeatureCollection',
    features: oblastFeatures
  });

  // Ті самі полігони, що пішли на підсвітку, стають зоною для фільтра цілей.
  alertedPolygons = [...raionFeatures, ...oblastFeatures];
  alertZoneVersion += 1;

  // Позначка для CSS: при обласній тривозі декор приглушується.
  document.body.classList.toggle('has-oblast-alert', oblastFeatures.length > 0);

  lastAlertSummary = {
    raions: activeRaions.length,
    raionPolys: raionFeatures.length,
    oblasts: activeOblasts.length,
    oblastPolys: oblastFeatures.length
  };
  lastAlertsFetchAt = Date.now();
  renderAlertStatus();

  console.log('NEPTUN active raions:', activeRaions.map(x => x.key || x.name));
  console.log('NEPTUN matched raion polygons:', raionFeatures.length);
  console.log('NEPTUN active oblasts:', activeOblasts.map(x => x.key || x.name));
  console.log('NEPTUN matched oblast polygons:', oblastFeatures.length);
}

async function fetchJSON(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function loadNeptunBoundaries() {
  const [oblasts, raions] = await Promise.all([
    fetchJSON('/api/oblasts-geojson'),
    fetchJSON('/api/raions-geojson')
  ]);
  if (oblasts?.type !== 'FeatureCollection' || !Array.isArray(oblasts.features)) {
    throw new Error('Некоректний oblasts.geojson');
  }
  if (raions?.type !== 'FeatureCollection' || !Array.isArray(raions.features)) {
    throw new Error('Некоректний raions.geojson');
  }
  neptunOblastsGeoJSON = oblasts;
  neptunRaionsGeoJSON = raions;
  console.log('NEPTUN polygons loaded:', {
    oblasts: oblasts.features.length,
    raions: raions.features.length,
    oblastSample: oblasts.features[0]?.properties,
    raionSample: raions.features[0]?.properties
  });
}

function addNeptunAlertLayers() {
  map.addSource('neptun-alert-oblasts', { type: 'geojson', data: emptyFeatureCollection() });
  map.addSource('neptun-alert-raions', { type: 'geojson', data: emptyFeatureCollection() });

  // Шари тривог мають лягати ПІД підписи областей, інакше заливка забиває назви.
  const beforeId = map.getLayer('oblast-label-layer') ? 'oblast-label-layer' : undefined;
  const add = layer => map.addLayer(layer, beforeId);

  // Обласна й районна тривоги різняться за трьома незалежними ознаками —
  // товщина, штрих і гало — щоб різниця пережила дальтонізм, малий екран і
  // скріншот. Відтінок навмисно однаковий: це в обох випадках тривога.

  // 1. Гало обласної тривоги — головний носій помітності. Заливка сама по собі
  //    витягнути не може: червоний темний, і на приглушеній карті контраст
  //    яскравості в нього мізерний, а яскравий контур дає вчетверо більший.
  add({
    id: 'neptun-oblast-alert-glow',
    type: 'line',
    source: 'neptun-alert-oblasts',
    paint: {
      'line-color': '#ff1140',
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 6, 8, 12, 12, 20],
      'line-blur': ['interpolate', ['linear'], ['zoom'], 4, 4, 8, 8, 12, 14],
      'line-opacity': 0.3
    }
  });

  // 2. Заливка області — для впізнавання площі.
  add({
    id: 'neptun-oblast-alert-fill',
    type: 'fill',
    source: 'neptun-alert-oblasts',
    paint: {
      'fill-color': '#ff0a34',
      'fill-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.34, 7, 0.3, 12, 0.24]
    }
  });

  // 3. Заливка району — приблизно вдвічі легша за обласну. Якщо горить і область,
  //    і район усередині неї, заливки складаються — це семантично правильно.
  add({
    id: 'neptun-raion-alert-fill',
    type: 'fill',
    source: 'neptun-alert-raions',
    paint: {
      'fill-color': '#ff1140',
      'fill-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.16, 7, 0.14, 12, 0.11]
    }
  });

  // 4. Межа району — пунктирна: штрих читається як «локально».
  add({
    id: 'neptun-raion-alert-border',
    type: 'line',
    source: 'neptun-alert-raions',
    paint: {
      'line-color': '#ff7089',
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.8, 8, 1.4, 12, 2.2],
      'line-opacity': 0.85,
      'line-dasharray': [3, 1.6]
    }
  });

  // 5. Межа області — суцільна, вдвічі товща, додається останньою, щоб вигравати
  //    там, де межі області й району збігаються. Окремий шар потрібен тому, що
  //    fill-outline-color у MapLibre — незмінна лінія в 1 піксель.
  add({
    id: 'neptun-oblast-alert-border',
    type: 'line',
    source: 'neptun-alert-oblasts',
    paint: {
      'line-color': '#ffbecb',
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.8, 8, 3.0, 12, 4.2],
      'line-opacity': 1
    }
  });
}

async function fetchNeptunAlerts() {
  try {
    const payload = await fetchJSON('/api/alerts');
    applyNeptunAlerts(payload);
  } catch (error) {
    console.warn('REST NEPTUN тимчасово недоступний:', error);
    setLiveStatus('API ТРИВОГ НЕДОСТУПНИЙ', 'error');
  }
}

function startNeptunAlerts() {
  fetchNeptunAlerts();
  clearInterval(neptunRestTimer);
  neptunRestTimer = setInterval(fetchNeptunAlerts, ALERTS_INTERVAL_MS);
  startAlertAgeTicker();
}

const REGION_BASES = [
  './data/',
  'https://cdn.jsdelivr.net/gh/EugeneBorshch/ukraine_geojson@master/',
  'https://raw.githubusercontent.com/EugeneBorshch/ukraine_geojson/refs/heads/master/'
];

const OBLAST_LABELS = {
  type: 'FeatureCollection',
  features: [
    ['Волинська область', 24.72, 51.12],
    ['Рівненська область', 26.25, 51.04],
    ['Житомирська область', 28.47, 50.67],
    ['Київська область', 30.33, 50.20],
    ['Чернігівська область', 31.85, 51.17],
    ['Сумська область', 34.03, 50.98],
    ['Львівська область', 24.02, 49.82],
    ['Тернопільська область', 25.58, 49.52],
    ['Хмельницька область', 27.02, 49.42],
    ['Вінницька область', 28.73, 49.12],
    ['Черкаська область', 31.55, 49.05],
    ['Полтавська область', 34.02, 49.55],
    ['Харківська область', 36.45, 49.55],
    ['Закарпатська область', 23.20, 48.40],
    ['Івано-Франківська область', 24.72, 48.72],
    ['Чернівецька область', 25.93, 48.25],
    ['Кіровоградська область', 32.02, 48.35],
    ['Дніпропетровська область', 35.03, 48.32],
    ['Донецька область', 37.72, 48.02],
    ['Луганська область', 39.05, 48.95],
    ['Одеська область', 30.18, 46.72],
    ['Миколаївська область', 32.15, 47.02],
    ['Херсонська область', 34.08, 46.70],
    ['Запорізька область', 35.72, 47.20],
    ['Автономна Республіка Крим', 34.15, 45.25]
  ].map(([name, lng, lat]) => ({
    type: 'Feature',
    properties: { name },
    geometry: { type: 'Point', coordinates: [lng, lat] }
  }))
};

const clockEl = document.getElementById('countdown');
const dateEl = document.getElementById('timerState');
function updateUkraineTime() {
  const now = new Date();
  clockEl.textContent = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(now);
  dateEl.textContent = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric'
  }).format(now);
}
updateUkraineTime();
setInterval(updateUkraineTime, 1000);

// Приглушена підкладка: ніщо на карті не має бути яскравішим за тривогу.
// raster-opacity < 1 пропускає теплий фон #map — це і дає колірну температуру.
const MAP_THEMES = {
  default: {
    'raster-saturation': -1,
    'raster-contrast': -0.12,
    'raster-brightness-min': 0.0,
    'raster-brightness-max': 0.42,
    'raster-opacity': 0.82
  },
  alt: {
    'raster-saturation': -1,
    'raster-contrast': -0.04,
    'raster-brightness-min': 0.0,
    'raster-brightness-max': 0.48,
    'raster-opacity': 0.88
  }
};

function applyMapTheme() {
  if (!map.getLayer('base-map')) return;
  const theme = document.body.classList.contains('alt') ? MAP_THEMES.alt : MAP_THEMES.default;
  for (const [prop, value] of Object.entries(theme)) {
    map.setPaintProperty('base-map', prop, value);
  }
}

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      osm: {
        type: 'raster',
        tiles: [
          'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png'
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© OpenStreetMap contributors'
      }
    },
    layers: [{
      id: 'base-map',
      type: 'raster',
      source: 'osm',
      paint: {
        // Тонування живе тут, а не в CSS-фільтрі канви: фільтр діяв би й на
        // векторні шари тривог і знебарвлював би їх разом із підкладкою.
        ...MAP_THEMES.default
      }
    }]
  },
  center: UKRAINE,
  zoom: DEFAULT_ZOOM,
  attributionControl: false,
  maxZoom: 19,
  minZoom: 3
});

let returnTimer;
function startReturnTimer() {
  clearTimeout(returnTimer);
  // Поки тримаємо вигляд на своєму місцезнаходженні, карта не має сама
  // відлітати назад до центру країни.
  if (followingMyLocation) return;
  returnTimer = setTimeout(() => returnToUkraine(true), RETURN_DELAY);
}
function returnToUkraine(animated = true) {
  clearTimeout(returnTimer);
  map[animated ? 'easeTo' : 'jumpTo']({
    center: UKRAINE,
    zoom: DEFAULT_ZOOM,
    pitch: 0,
    bearing: 0,
    duration: animated ? 1500 : 0,
    essential: true
  });
  setTimeout(startReturnTimer, animated ? 1550 : 0);
}

async function loadRegionsGeoJSON() {
  const cached = localStorage.getItem('ukraine-oblasts-geojson-v3');
  if (cached) {
    try {
      const data = JSON.parse(cached);
      if (data?.type === 'FeatureCollection' && data.features?.length >= 24) {
        data.features.forEach((feature, index) => {
          feature.properties = feature.properties || {};
          feature.properties.neptunKey = feature.properties.neptunKey || REGION_NEPTUN_KEYS[index];
        });
        return data;
      }
    } catch (_) {}
  }

  let lastError;
  for (const base of REGION_BASES) {
    try {
      const responses = await Promise.all(REGION_FILES.map(async file => {
        const response = await fetch(base + file, { cache: 'force-cache' });
        if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
        return response.json();
      }));

      const features = responses.flatMap((data, index) => {
        let items = [];
        if (data?.type === 'FeatureCollection') items = data.features || [];
        else if (data?.type === 'Feature') items = [data];
        else if (data?.type === 'Polygon' || data?.type === 'MultiPolygon') {
          items = [{ type: 'Feature', properties: {}, geometry: data }];
        }

        return items.map(feature => ({
          ...feature,
          properties: {
            ...(feature.properties || {}),
            sourceFile: REGION_FILES[index],
            neptunKey: REGION_NEPTUN_KEYS[index]
          }
        }));
      }).filter(feature => ['Polygon', 'MultiPolygon'].includes(feature?.geometry?.type));

      if (features.length < 24) throw new Error(`Отримано лише ${features.length} областей`);

      const result = { type: 'FeatureCollection', features };
      try { localStorage.setItem('ukraine-oblasts-geojson-v3', JSON.stringify(result)); } catch (_) {}
      return result;
    } catch (error) {
      lastError = error;
      console.warn('Джерело меж областей недоступне:', base, error);
    }
  }
  throw lastError || new Error('Не вдалося завантажити межі областей');
}

function addRegionLayers(regionsData) {
  regionsGeoJSON = regionsData;

  map.addSource('ukraine-regions', {
    type: 'geojson',
    data: regionsData,
    generateId: true
  });


  map.addLayer({
    id: 'oblast-fill',
    type: 'fill',
    source: 'ukraine-regions',
    paint: {
      'fill-color': [
        'case',
        ['boolean', ['feature-state', 'hover'], false], '#ffd06a',
        '#ffb62e'
      ],
      'fill-opacity': [
        'case',
        ['boolean', ['feature-state', 'hover'], false], 0.16,
        ['interpolate', ['linear'], ['zoom'], 4, 0.075, 7, 0.045, 12, 0.018]
      ]
    }
  });

  // Чёрная подложка не даёт границам потеряться на светлой карте.
  map.addLayer({
    id: 'oblast-border-casing',
    type: 'line',
    source: 'ukraine-regions',
    paint: {
      'line-color': '#000000',
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.1, 8, 1.2, 12, 1.35, 16, 1.5],
      'line-opacity': 0.35,
      'line-blur': 0.2
    }
  });

  // Основной хорошо заметный контур реальных областей.
  map.addLayer({
    id: 'oblast-border-main',
    type: 'line',
    source: 'ukraine-regions',
    paint: {
      // Червоний на цій карті зарезервовано за тривогами. Адміністративні межі
      // янтарні: якщо червоним намальовано геть усе, тривозі нічим виділитися.
      'line-color': '#ffb62e',
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.65, 8, 0.72, 12, 0.82, 16, 0.95],
      'line-opacity': 0.30
    }
  });

  // Тонкая зелёная сердцевина создаёт радарное свечение.
  map.addLayer({
    id: 'oblast-border-core',
    type: 'line',
    source: 'ukraine-regions',
    paint: {
      'line-color': '#ffd98a',
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.22, 8, 0.28, 12, 0.34, 16, 0.42],
      'line-opacity': 0.14
    }
  });

  map.addSource('oblast-labels', { type: 'geojson', data: OBLAST_LABELS });
  map.addLayer({
    id: 'oblast-label-layer',
    type: 'symbol',
    source: 'oblast-labels',
    minzoom: 4.15,
    maxzoom: 11,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 4.2, 10.5, 6, 12.5, 8, 14.5],
      'text-transform': 'uppercase',
      'text-letter-spacing': 0.04,
      'text-max-width': 10,
      'text-allow-overlap': false,
      'text-ignore-placement': false
    },
    paint: {
      'text-color': '#ffeccd',
      'text-halo-color': '#220000',
      'text-halo-width': 2.8,
      'text-halo-blur': 0.35
    }
  });

  let hoveredRegionId = null;
  map.on('mousemove', 'oblast-fill', event => {
    if (!event.features?.length) return;
    if (hoveredRegionId !== null) {
      map.setFeatureState({ source: 'ukraine-regions', id: hoveredRegionId }, { hover: false });
    }
    hoveredRegionId = event.features[0].id;
    map.setFeatureState({ source: 'ukraine-regions', id: hoveredRegionId }, { hover: true });
    map.getCanvas().style.cursor = 'crosshair';
  });
  map.on('mouseleave', 'oblast-fill', () => {
    if (hoveredRegionId !== null) {
      map.setFeatureState({ source: 'ukraine-regions', id: hoveredRegionId }, { hover: false });
    }
    hoveredRegionId = null;
    map.getCanvas().style.cursor = '';
  });

  document.body.classList.add('regions-ready');
}

map.on('load', async () => {
  try {
    const [regionsData] = await Promise.all([
      loadRegionsGeoJSON(),
      loadNeptunBoundaries()
    ]);
    addRegionLayers(regionsData);
    addNeptunAlertLayers();
    addNeptunThreatLayers();
    startNeptunAlerts();
    startNeptunThreats();
    backgroundWorkStarted = true;
  } catch (error) {
    console.error('Дані карти або межі NEPTUN не завантажено:', error);
    setLiveStatus('MAP DATA ERROR', 'error');
  }

  startReturnTimer();
  map.fire('move');
});


['dragstart', 'zoomstart', 'rotatestart', 'pitchstart'].forEach(name => map.on(name, () => clearTimeout(returnTimer)));
['dragend', 'zoomend', 'rotateend', 'pitchend'].forEach(name => map.on(name, startReturnTimer));

map.on('mousemove', (event) => {
  const { lng, lat } = event.lngLat;
  document.getElementById('coords').textContent = `${Math.abs(lng).toFixed(4)}° ${lng >= 0 ? 'E' : 'W'} / ${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}`;
});
map.on('resize', () => map.fire('move'));
// --- Моє місцезнаходження ---------------------------------------------------
// Координати лишаються виключно в браузері: нікуди не надсилаються, ніде не
// зберігаються і на сервер не потрапляють.
const MY_LOCATION_ZOOM = 9;
const MY_LOCATION_STORAGE_KEY = 'my-location-enabled';
const MY_LOCATION_LAYERS = ['my-location-accuracy-fill', 'my-location-accuracy-line'];
const MY_LOCATION_WATCH_OPTS = { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 };
let myLocationMarker = null;
let myLocationWatchId = null;
let lastMyPosition = null;
let followingMyLocation = false;

function setFollowingMyLocation(on, remember = true) {
  followingMyLocation = on;
  if (remember) {
    try { localStorage.setItem(MY_LOCATION_STORAGE_KEY, on ? '1' : '0'); } catch (_) {}
  }
  const btn = document.getElementById('myLocationBtn');
  btn?.classList.toggle('is-active', on);
  if (on) btn?.classList.remove('is-armed');
  if (!on) {
    if (myLocationWatchId !== null) {
      navigator.geolocation.clearWatch(myLocationWatchId);
      myLocationWatchId = null;
    }
    myLocationMarker?.remove();
    myLocationMarker = null;
    map.getSource('my-location-accuracy')?.setData(emptyFeatureCollection());
    if (btn) btn.textContent = '◉ Я ТУТ';
  }
}

function addMyLocationLayers() {
  // Стиль може бути ще не готовий, якщо кнопку натиснули одразу після
  // відкриття: addSource у такому стані кидає виняток.
  if (!map.isStyleLoaded() || map.getSource('my-location-accuracy')) return;
  map.addSource('my-location-accuracy', { type: 'geojson', data: emptyFeatureCollection() });
  // Холодний колір: моє положення не має читатися як загроза.
  map.addLayer({
    id: 'my-location-accuracy-fill',
    type: 'fill',
    source: 'my-location-accuracy',
    paint: { 'fill-color': '#7fd4ff', 'fill-opacity': 0.12 }
  });
  map.addLayer({
    id: 'my-location-accuracy-line',
    type: 'line',
    source: 'my-location-accuracy',
    paint: { 'line-color': '#a8e4ff', 'line-width': 1.2, 'line-opacity': 0.65 }
  });
}

function renderMyLocation(position, recenter) {
  const lat = Number(position?.coords?.latitude);
  const lon = Number(position?.coords?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  lastMyPosition = position;

  // Коло точності — необов'язкове: якщо шар ще не створено, маркер усе одно
  // з'явиться, а коло додасться наступним оновленням позиції.
  addMyLocationLayers();
  const accuracyKm = Math.max(0.05, (Number(position.coords.accuracy) || 0) / 1000);
  map.getSource('my-location-accuracy')?.setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: circlePolygon(lat, lon, accuracyKm) }]
  });

  if (!myLocationMarker) {
    const el = document.createElement('div');
    el.className = 'my-location-marker';
    el.innerHTML = '<span class="my-location-pulse"></span><span class="my-location-dot"></span>';
    myLocationMarker = new maplibregl.Marker({ element: el, anchor: 'center' });
    myLocationMarker.setLngLat([lon, lat]).addTo(map);
  } else {
    myLocationMarker.setLngLat([lon, lat]);
  }

  if (recenter) {
    clearTimeout(returnTimer);
    map.flyTo({ center: [lon, lat], zoom: MY_LOCATION_ZOOM, duration: 1400, essential: true });
  }
}

// Помилка ПЕРШОГО запиту: користувач натиснув кнопку й нічого не отримав.
// Тут вимкнення й скидання збереженого вибору доречні.
function myLocationError(error) {
  const btn = document.getElementById('myLocationBtn');
  const text = error?.code === 1 ? 'ДОСТУП ЗАБОРОНЕНО'
             : error?.code === 3 ? 'ЧАС ВИЙШОВ'
             : 'МІСЦЕ НЕВІДОМЕ';
  console.warn('Геолокація недоступна:', error?.message || error);
  setFollowingMyLocation(false);
  if (btn) {
    btn.textContent = text;
    setTimeout(() => { if (!followingMyLocation) btn.textContent = '◉ Я ТУТ'; }, 3000);
  }
}

// Помилка під час СТЕЖЕННЯ — на мобільному це буденність: тунель, підвал,
// ліфт, збій GPS. Раніше будь-який такий збій вимикав функцію й затирав
// збережений вибір на '0'. Тепер вимикаємось лише коли дозвіл справді
// відкликано (code 1), решту просто перечікуємо.
function myLocationWatchError(error) {
  if (error?.code === 1) {
    myLocationError(error);
    return;
  }
  console.warn('Геолокація: тимчасовий збій стеження, не вимикаю:', error?.message || error);
}

// Мобільні браузери приспиняють watchPosition, коли сторінка йде у фон, і
// після повернення він може вже не оживати. Перепідписуємось.
function refreshMyLocationWatch() {
  if (!followingMyLocation || !navigator.geolocation) return;
  if (myLocationWatchId !== null) {
    try { navigator.geolocation.clearWatch(myLocationWatchId); } catch (_) {}
  }
  myLocationWatchId = navigator.geolocation.watchPosition(
    p => renderMyLocation(p, false),
    myLocationWatchError,
    MY_LOCATION_WATCH_OPTS
  );
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshMyLocationWatch();
});

// recenter=false — для відновлення після перезавантаження: маркер показуємо,
// але камеру не чіпаємо. Наближає карту лише свідоме натискання кнопки.
function toggleMyLocation(recenter = true) {
  const btn = document.getElementById('myLocationBtn');
  if (followingMyLocation) { setFollowingMyLocation(false); return; }

  if (!navigator.geolocation) {
    if (btn) btn.textContent = 'НЕ ПІДТРИМУЄТЬСЯ';
    return;
  }
  // Геолокація працює лише в захищеному контексті (HTTPS або localhost).
  if (!window.isSecureContext) {
    if (btn) btn.textContent = 'ПОТРІБЕН HTTPS';
    setTimeout(() => { btn.textContent = '◉ Я ТУТ'; }, 3000);
    return;
  }

  if (btn) btn.textContent = 'ПОШУК...';
  navigator.geolocation.getCurrentPosition(
    position => {
      setFollowingMyLocation(true);
      if (btn) btn.textContent = '◉ Я ТУТ';
      renderMyLocation(position, recenter);
      // Далі стежимо за переміщенням, але камеру більше не смикаємо.
      myLocationWatchId = navigator.geolocation.watchPosition(
        p => renderMyLocation(p, false),
        myLocationWatchError,
        MY_LOCATION_WATCH_OPTS
      );
    },
    myLocationError,
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
}

document.getElementById('myLocationBtn')?.addEventListener('click', () => toggleMyLocation(true));

// Відновлення після перезавантаження. Запитуємо позицію самі лише тоді, коли
// дозвіл УЖЕ надано: інакше сторінка при відкритті кидала б у обличчя
// системний запит, якого користувач не просив.
// Вибір збережено, але відновити автоматично не можна (дозвіл ще не наданий
// або є лише на один раз). Показуємо це кнопкою: одне натискання поверне все.
function setMyLocationArmed(armed, reason) {
  const btn = document.getElementById('myLocationBtn');
  if (!btn) return;
  btn.classList.toggle('is-armed', armed);
  btn.title = armed
    ? 'Позицію запам\'ятано — торкніться, щоб показати знову'
    : 'Показати моє місцезнаходження';
  if (armed) myLocationLog('очікує дотику:', reason);
}

// Діагностика вмикається адресою ?debug=1 — щоб можна було подивитись на
// телефоні, де саме обривається відновлення.
const MY_LOCATION_DEBUG = new URLSearchParams(location.search).get('debug') === '1';
function myLocationLog(...args) {
  if (MY_LOCATION_DEBUG) console.log('[Я ТУТ]', ...args);
}

async function restoreMyLocation() {
  let saved = '0';
  try { saved = localStorage.getItem(MY_LOCATION_STORAGE_KEY) || '0'; } catch (err) {
    myLocationLog('localStorage недоступний:', err?.message);
  }
  myLocationLog('збережений стан:', saved, '| secure:', window.isSecureContext,
                '| geolocation:', !!navigator.geolocation);
  if (saved !== '1' || !navigator.geolocation || !window.isSecureContext) return;

  // Де Permissions API є — відновлюємо лише при вже наданому дозволі, тобто
  // системного запиту гарантовано не буде. Safari на iOS цей API для
  // геолокації не підтримує й кидає виняток; тоді пробуємо напряму, бо за
  // наявного дозволу запит проходить без діалогу.
  let state = null;
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' });
    state = status?.state ?? null;
    // Chrome дає ще й дозвіл «лише цього разу»: після перезавантаження він
    // повертається в prompt. Слухаємо зміну, щоб піднятись самим, щойно
    // дозвіл стане постійним.
    if (status && !status.__horizonBound) {
      status.__horizonBound = true;
      status.addEventListener?.('change', () => {
        myLocationLog('дозвіл змінився на:', status.state);
        if (status.state === 'granted') restoreMyLocation();
        if (status.state === 'denied') setMyLocationArmed(false);
      });
    }
  } catch (err) {
    myLocationLog('Permissions API недоступний:', err?.message);
  }
  myLocationLog('стан дозволу:', state);

  if (state === 'denied' || state === 'prompt') {
    // Вибір не втрачено — просто потрібне одне свідоме дотикання.
    setMyLocationArmed(true, state);
    return;
  }

  setMyLocationArmed(false);
  // Без наближення: при відкритті сторінки карта має лишатись на огляді країни.
  toggleMyLocation(false);
}

// Відновлення НЕ чекає на подію load карти. Раніше воно висіло саме на ній, і
// на телефоні це означало, що стан просто не відновлювався: подія настає лише
// після відмальовки перших тайлів, а при повільній мережі, згорнутому браузері
// чи збої тайлів вона може не настати взагалі. Маркеру карта потрібна лише як
// система координат, а коло точності й так чекає на isStyleLoaded().
restoreMyLocation();

// Коли стиль нарешті готовий — домальовуємо коло точності для вже отриманої
// позиції. Без цього при ранньому відновленні лишався б маркер без кола.
map.on('load', () => {
  if (followingMyLocation && lastMyPosition) renderMyLocation(lastMyPosition, false);
});

document.getElementById('homeBtn').addEventListener('click', () => {
  setFollowingMyLocation(false);
  returnToUkraine(true);
});
document.getElementById('styleBtn').addEventListener('click', () => {
  document.body.classList.toggle('alt');
  // Тонування тепер у paint растрового шару, тож перемикач класу сам собою
  // карту вже не змінює — застосовуємо тему явно.
  applyMapTheme();
});
window.addEventListener('resize', () => map.resize());





// --- Стрічка каналу ---------------------------------------------------------
// Повідомлення каналу НЕ стають цілями на карті: у них немає координат, а
// «курсом на Вишгород» — це напрямок, а не позиція. Панель для читання
// людиною, плюс ознака «реактивний», якою уточнюється швидкість.
const channelFeed = document.getElementById('channelFeed');
const channelList = document.getElementById('channelList');
const channelStatus = document.getElementById('channelStatus');
const channelToggle = document.getElementById('channelToggle');
const channelTab = document.getElementById('channelTab');

function escapeText(value) {
  return String(value || '').replace(/[&<>"']/g,
    ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]));
}

function formatChannelTime(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleTimeString('uk-UA',
    { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' });
}

function renderChannel(payload) {
  const posts = Array.isArray(payload?.posts) ? payload.posts : [];
  channelPosts = posts;

  // Підказки про реактивні — по областях, зі свіжістю за часом допису.
  channelOblastHints.clear();
  channelTargets.clear();
  channelVersion += 1;
  const cutoff = Date.now() - CHANNEL_HINT_TTL_MS;
  for (const record of payload?.records || []) {
    const key = normalizeOblastName(record.oblast);
    const at = Date.parse(record.time || '') || Date.now();
    if (key) {
      const prev = channelOblastHints.get(key);
      if (!prev || at >= prev.at) channelOblastHints.set(key, { jet: !!record.jet, at });
    }

    // Застарілий допис уже не описує обстановку, тож у звірку не йде.
    if (at < cutoff) continue;
    const stem = placeStem(record.destination);
    if (!stem) continue;
    if (!channelTargets.has(stem)) channelTargets.set(stem, []);
    channelTargets.get(stem).push({
      stem,
      at,
      oblast: key,
      destination: record.destination || '',
      count: Math.max(1, Number(record.count) || 1),
      jet: !!record.jet,
      direction: record.direction || '',
      // Саме typeof, а не Number(): Number(null) — це 0, а Number.isFinite(0)
      // істинне, тож кожен запис без напрямку діставав би курс 0°, тобто «на
      // північ». Мовчазна стрілка в неправильний бік гірша за відсутню.
      bearingDeg: typeof record.bearingDeg === 'number' && Number.isFinite(record.bearingDeg)
        ? record.bearingDeg
        : null
    });
  }

  if (!channelList) return;
  channelList.textContent = '';
  if (!posts.length) {
    if (channelStatus) channelStatus.textContent = 'ПОВІДОМЛЕНЬ НЕМАЄ';
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const post of [...posts].reverse()) {
    const item = document.createElement('div');
    item.className = 'channel-post' + (/реактивн/i.test(post.text) ? ' is-jet' : '');
    item.innerHTML =
      `<div class="channel-post__time">${escapeText(formatChannelTime(post.time))}</div>` +
      `<div class="channel-post__text">${escapeText(post.text)}</div>`;
    fragment.appendChild(item);
  }
  channelList.appendChild(fragment);
  if (channelStatus) {
    channelStatus.textContent = `ОНОВЛЕНО ${formatChannelTime(new Date().toISOString())}`;
  }
}

async function loadChannel() {
  try {
    const payload = await fetchJSON(CHANNEL_URL_PATH);
    if (payload?.error) throw new Error(payload.error);
    renderChannel(payload);
  } catch (error) {
    console.warn('Канал недоступний:', error);
    if (channelStatus) channelStatus.textContent = 'КАНАЛ НЕДОСТУПНИЙ';
  }
}

function setChannelHidden(hidden) {
  channelFeed?.classList.toggle('is-hidden', hidden);
  channelTab?.classList.toggle('is-visible', hidden);
  try { localStorage.setItem('channel-feed-hidden', hidden ? '1' : '0'); } catch (_) {}
}

channelToggle?.addEventListener('click', () => setChannelHidden(true));
channelTab?.addEventListener('click', () => setChannelHidden(false));
setChannelHidden(localStorage.getItem('channel-feed-hidden') === '1');
loadChannel();
channelTimer = setInterval(loadChannel, CHANNEL_INTERVAL_MS);


// Пауза у фоні: у прихованій вкладці немає сенсу тримати rAF-цикл і чотири
// таймери. Звукових сповіщень у карти немає, тож нічого не втрачається —
// при поверненні дані оновлюються одразу.
function pauseBackgroundWork() {
  if (threatAnimationFrame !== null) {
    cancelAnimationFrame(threatAnimationFrame);
    threatAnimationFrame = null;
  }
  clearInterval(neptunRestTimer);
  clearInterval(neptunThreatsTimer);
  clearInterval(neptunWatchdogTimer);
  clearInterval(alertAgeTimer);
  clearInterval(channelTimer);
  channelTimer = null;
  alertAgeTimer = null;
  neptunRestTimer = null;
  neptunThreatsTimer = null;
  neptunWatchdogTimer = null;
}

function resumeBackgroundWork() {
  if (threatAnimationFrame === null) {
    lastThreatFrameAt = 0;
    threatAnimationFrame = requestAnimationFrame(renderThreatsFrame);
  }
  if (!neptunRestTimer) startNeptunAlerts();

  // Свіжий відлік: за час у фоні снапшотів не було, і без скидання сторож
  // одразу вирішив би, що realtime мертвий.
  neptunLastSnapshotAt = Date.now();
  if (!neptunWatchdogTimer) startThreatWatchdog();
  if (neptunThreatsMode === 'rest') startThreatRestPolling();
  if (!channelTimer) {
    loadChannel();
    channelTimer = setInterval(loadChannel, CHANNEL_INTERVAL_MS);
  }
}

document.addEventListener('visibilitychange', () => {
  if (!backgroundWorkStarted) return;
  if (document.hidden) pauseBackgroundWork();
  else resumeBackgroundWork();
});
