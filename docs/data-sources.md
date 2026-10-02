# Data sources — research, 2026-10-02

Asked: are there more reliable sources than the ones in use? Researched on the web on
2026-10-02. Every claim below is cited, and the last section lists what could not be
verified.

**Short answer.** For air-raid alerts, yes: the official **Ukraine Alarm API** is the
origin the other feeds copy, and it can push by webhook. For enemy target movements, no:
there is no public structured feed, so public Telegram channels remain the only legal
source. Two more channels are worth adding.

## Air-raid alerts

Alerts are declared by the authorities. The "Повітряна тривога" app and its API were
built by Ajax Systems and Stfalcon with the Ministry of Digital Transformation as the
single source of alert signals ([mezha.ua](https://mezha.ua/en/articles/the-story-of-the-developer-of-the-air-alert-app-how-stepan-tanasiychuk-a-computer-scientist-from-khmelnytskyi-built-a-successful-it-business/)).
alerts.in.ua aggregates that feed plus regional administration channels
([devs.alerts.in.ua](https://devs.alerts.in.ua/)). Since September 2026 alerts carry a
red (missiles, mass attack) or yellow (drones) level
([blog.alerts.in.ua](https://blog.alerts.in.ua/p/alert-levels)); the schema should store it.

| Source | Kind | Access | Granularity | Verdict |
|---|---|---|---|---|
| **Ukraine Alarm API** `api.ukrainealarm.com/api/v3` | Official | Free key via form on the site ([PyPI](https://pypi.org/project/ua-alarm/)) | Oblast, raion, hromada ([HA #149536](https://github.com/home-assistant/core/issues/149536)) | **Adopt as primary.** `/alerts/status` gives a cheap change counter; webhooks exist ([SDK](https://github.com/UkraineAlarm/UkraineAlarm-python)). |
| alerts.in.ua tokened API | Aggregator | Free token ([form](https://alerts.in.ua/api-request)); 8–10 req/min per IP; non-commercial; "don't use for critical infrastructure" ([devs](https://devs.alerts.in.ua/)) | Oblast to city | **Keep as secondary** and cross-check. |
| alerts.in.ua `/v3/alerts/active.md` | Same, keyless | Free | Area level, with red/yellow levels | **Keep as last-resort fallback** (what runs today). |
| @air_alert_ua | Official channel | t.me/s | Raion, hromada | **Reject as a machine source:** newest post in the public preview was 2026-09-07. |
| Regional administration channels | Official | t.me/s | Raion | **Reject as a feed:** mixed free text; alerts.in.ua already reads them. |

## Target reports

No public structured feed exists. On 2026-09-15 a presidential adviser proposed opening
the military Shahed-movement map to civilians; it was "under discussion" at the Ministry
of Defence ([TSN](https://tsn.ua/ukrayina/tse-zbereze-sotni-zyttiv-ukrayintsiam-mozut-vidkryty-viyskovu-kartu-rukhu-shakhediv-3169325.html)).
Worth watching: it would replace scraping entirely.

All channels below had public previews with same-day posts on 2026-10-02.

| Channel | Run by | Verdict |
|---|---|---|
| **@kpszsu** | Air Force, official | **Keep as primary** — the trust anchor. |
| **@sectorv666** | Volunteer | **Keep** — the most structured format. |
| **@KozakChornobay** | Volunteer | **Keep**, with the existing boilerplate and fundraising filters. |
| **@povitryanatrivogaaa** (727K) | Anonymous OSINT | **Adopt as secondary** — structured "→Place" lines, high volume. |
| **@monitorwarr** (85.7K) | Anonymous OSINT | **Adopt as secondary** — its "all clear" posts help expire targets. |
| @war_monitor | Anonymous | Reject — irregular updates. |
| @eRadarrua | Anonymous | Reject — memes and noise. |
| @mon1tor_ua | Anonymous | Reject — fundraising spam; "ППО радар" framing conflicts with the no-air-defence rule. |
| @vanek_nikolaev | Anonymous, Russian-language | Reject — reports impacts. |

The SBU has listed about 100 "Ukrainian" Telegram channels it says Russia runs
([thepage.ua](https://thepage.ua/ua/news/100-telegram-kanaliv-propaganda-kreml)). None of
the channels above was checked against that list.

## Not verified

- Ukraine Alarm's terms of use, rate limits and latency: the site is behind a Cloudflare
  challenge. Home Assistant advises watching at most 5 regions to stay under the limit
  ([HA docs](https://www.home-assistant.io/integrations/ukraine_alarm)). Read the terms
  in a browser when requesting the key.
- Why @air_alert_ua's preview stopped on 2026-09-07.
- The accuracy of any volunteer channel. No independent audit was found.
- Telegram's position on scraping t.me/s previews. None was found either way.

## What adopting this would change

1. Request a Ukraine Alarm key (a person has to fill in the form). Add it as the primary
   alert provider behind the existing `ALERTS_PROVIDER` switch, webhook first with
   `/alerts/status` polling as the fallback. alerts.in.ua stays as the cross-check.
2. Store the red/yellow alert level (`alerts.level` in the stage-1 schema already allows
   a severity column to be added).
3. Add @povitryanatrivogaaa and @monitorwarr to `CHANNELS` only after their formats are
   in the parser's corpus tests; a new format without tests becomes wrong pins.
