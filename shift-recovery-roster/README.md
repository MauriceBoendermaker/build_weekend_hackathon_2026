Retrieves authorized scheduling data from **Cal.com**, joins it with a configurable **workforce
metadata** source, and writes a normalized, deduplicated, validated **roster dataset** that an
n8n workflow can consume to recover a shift when somebody calls in sick.

It is the **sensing layer** of an autonomous shift-recovery agent. It answers *"what is the
current state of the world?"* — and deliberately does not answer *"who should cover this
shift?"*. That decision belongs to n8n.

## What does Shift Recovery Roster Source do?

It turns a scheduling system into a machine-readable picture of the workforce:

- **workers** — who exists, what they can do, when they are free, what they are already booked on
- **shifts** — when work is scheduled, what it requires, who holds it, and whether it is covered
- **scheduling events** — the raw bookings, normalized but not interpreted, for auditing
- **a summary** — one record per run saying whether the retrieval actually succeeded

It talks to the [Cal.com API v2](https://cal.com/docs/api-reference/v2/introduction) over HTTPS
using an official API key. **It never scrapes Cal.com HTML** — every field comes from a
documented JSON endpoint.

## Why does it exist?

When a healthcare worker calls in sick, the replacement hunt is manual: find the affected shift,
work out who is qualified, check who is already working, ring around, update the rota. Each step
needs current, trustworthy data. An autonomous agent can do the ringing around — but only if
something hands it a reliable picture of the roster first.

That picture has to be trustworthy in a specific way: **an empty dataset must mean "nothing is
scheduled", never "the API was down"**. An agent that mistakes an outage for an empty roster will
escalate to a human who does not exist, or conclude nobody is available. So:

- an API failure **fails the run** and writes a `summary` record with `status: "failure"` and a
  machine-readable `errorCode` — it never degrades into `[]`
- an empty-but-successful run is a **distinct, labelled state**: `emptyResult: true`
- a partially-retrieved run is labelled `status: "partial"`, never `"success"`
- every field records **where it came from**, so roster metadata can never be mistaken for data
  Cal.com actually returned

## How this fits into the autonomous shift-recovery system

```
                      ┌──────────────────────────────────────┐
   Cal.com API v2 ───▶│  APIFY ACTOR (this repo)             │
                      │  shift-recovery-roster               │
   Workforce      ───▶│                                      │
   metadata           │  retrieve → normalize → validate     │
   (roster file,      │  → deduplicate → Apify Dataset       │
   URL, or KV store)  └──────────────────┬───────────────────┘
                                         │  normalized roster + shifts + summary
                                         ▼
                      ┌──────────────────────────────────────┐
                      │  n8n DECISION LOOP                   │
                      │  1. detect absence                   │
                      │  2. determine affected shift         │
                      │  3. apply hard eligibility rules     │
                      │  4. rank candidates                  │
                      │  5. contact candidates               │
                      │  6. wait for responses               │
                      │  7. update the schedule              │
                      │  8. verify the update                │
                      │  9. escalate at the boundary         │
                      └──────────────────────────────────────┘
```

**The Actor's job** — retrieve, normalize, validate, deduplicate, expose the current scheduling
state, and report honestly whether it managed to.

**Not the Actor's job** — deciding anything. There is no LLM here, no candidate ranking, no
scoring, no contacting anybody, no writes back to Cal.com. Every rule that could be argued about
lives in n8n, where it can be inspected and changed without redeploying the data layer.

The division matters for a second reason: the Actor is safe to re-run. It only reads.

## What data does it produce?

Every record carries `recordType`, so an n8n step filters on that one field.

### `worker`

| Field | Type | Where it comes from |
| --- | --- | --- |
| `employeeId` | string | Workforce metadata, or a deterministic fallback derived from the Cal.com user ID |
| `name`, `email`, `timeZone` | string \| null | Cal.com |
| `role`, `department` | string \| null | Workforce metadata — Cal.com has no such concept |
| `skills` | string[] | Workforce metadata |
| `availability` | `{start, end, source}[]` | Cal.com schedules (projected into the window) and/or the roster file |
| `scheduledShifts` | string[] | Derived — shift IDs assigned to this worker inside the window |
| `hoursThisWeek` | number \| null | Derived — scheduled hours in the ISO week containing the window start |
| `contractedHoursPerWeek` | number \| null | Workforce metadata |
| `fieldSources` | object | Per-field provenance map |

### `shift`

| Field | Type | Where it comes from |
| --- | --- | --- |
| `shiftId` | string | Deterministic, from the Cal.com booking UID |
| `start`, `end` | ISO-8601 UTC | Cal.com |
| `durationMinutes` | number | Cal.com |
| `role`, `department`, `requiredSkills` | string / string[] | Shift-type metadata, or inferred from the assignee (labelled as such) |
| `assignedEmployeeId` | string \| null | Cal.com booking host, resolved to an employee ID |
| `status` | `scheduled` \| `pending` \| `cancelled` \| `completed` \| `unknown` | Cal.com |
| `coverageStatus` | `covered` \| `uncovered` | Derived — **this is the field that identifies a gap** |

### `summary`

One per run, always the **last** item in the dataset. Carries `status`, `emptyResult`, `counts`,
`dateRange`, `warnings`, `errorCode` and `durationMs`. Also written to the key-value store under
`SUMMARY`, with fuller diagnostics under `RUN_REPORT`.

## Provenance: never pretend metadata came from Cal.com

Cal.com stores bookings, users, teams and availability. It does **not** store employee IDs,
clinical roles, departments, skills or contracted hours. Those come from a separate configurable
source, and the distinction is preserved in the output rather than papered over:

```jsonc
{
  "recordType": "worker",
  "name": "Sarah V",              // from Cal.com
  "role": "ICU_NURSE",            // from the roster file
  "fieldSources": {
    "name": "cal.com",
    "email": "cal.com",
    "role": "workforce-metadata",           // never "cal.com"
    "skills": "workforce-metadata",
    "hoursThisWeek": "derived:scheduled-shifts-in-window"
  },
  "dataSources": ["cal.com", "workforce-metadata"],
  "synthetic": false
}
```

Provenance values: `cal.com`, `workforce-metadata`, `demo-workforce-metadata`, `demo`, or
`derived:<basis>`. Anything synthetic also sets `synthetic: true` on the record.

## Architecture

```
SOURCE ──▶ FETCH ──▶ NORMALIZE ──▶ ENRICH ──▶ DEDUPE ──▶ VALIDATE ──▶ DATASET
```

```
src/
├── main.ts                     Actor entry point: read input, run, report. Thin by design.
├── input.ts                    Input parsing, coercion, validation, log-safe config view
├── types.ts                    The output contract
├── errors.ts                   Typed error taxonomy + credential redaction
├── time.ts                     ISO-8601/UTC, relative dates, IANA wall-clock → UTC, intervals
├── http/fetcher.ts             Retries, backoff, Retry-After, timeouts, typed HTTP errors
├── sources/
│   ├── source.ts               RosterSource interface + RawSnapshot  ◀── the adapter seam
│   ├── calcom/client.ts        Cal.com API v2 client + pagination walkers
│   ├── calcom/source.ts        CalComSource: Cal.com → RawSnapshot
│   └── demo/source.ts          DemoRosterSource: synthetic → RawSnapshot (no network)
├── metadata/
│   ├── loader.ts               Workforce metadata from input / URL / key-value store
│   └── demo-metadata.ts        Synthetic roster and shift requirements
├── pipeline/
│   ├── normalize.ts            RawSnapshot → workers/shifts/events, with provenance
│   ├── dedupe.ts               Collapse on stable IDs, merging rather than dropping
│   ├── validate.ts             Reject the unusable, repair the partial
│   ├── summary.ts              The run summary record
│   └── run.ts                  The pipeline, assembled
└── output/dataset.ts           Dataset + key-value store writes, in contract order
```

### Where to replace the source adapter

Everything downstream of `FETCH` works purely against `RawSnapshot` — it has no idea Cal.com
exists. To swap in a hospital rostering system:

1. implement `RosterSource` (`src/sources/source.ts`): one `fetch()` returning a `RawSnapshot`
   of people, events, availability and shift types;
2. register it in `createSource()` (`src/pipeline/run.ts`);
3. done. Normalization, enrichment, deduplication, validation and output are unchanged.

`DemoRosterSource` is a working second implementation of exactly that interface, so the seam is
demonstrably real and not just an aspiration:

```
CalComSource      ─┐
IcalSource        ─┤
DemoRosterSource  ─┼─▶ Normalizer ─▶ WorkforceDataset
HospitalRoster…   ─┘   (your adapter goes here)
```

### iCal feeds: any calendar as the roster

`IcalSource` (`src/sources/ical/source.ts`) reads the roster from any calendar that publishes an
iCalendar feed. It needs no Cal.com account: set `icsUrl` (or the `ICS_URL` environment variable)
and the Actor uses it instead of Cal.com.

| Calendar                  | Where to find the feed                                             |
| ------------------------- | ------------------------------------------------------------------ |
| Google Calendar           | Calendar settings → *Integrate calendar* → *Secret address in iCal format* |
| Outlook / Microsoft 365   | Settings → Calendar → Shared calendars → *Publish a calendar* → ICS |
| iCloud                    | Calendar → Share → *Public Calendar* (use the `webcal://` link)    |

Mapping:

- every **timed** event overlapping the window is a shift; recurring events are expanded
  (Google-style instance ids, `<uid>_<UTC start>`), all-day events are ignored;
- the event's **guests** are the people working it — the organizer, rooms and anyone who
  declined are skipped — and they are matched to `employeeMetadata` by email;
- a title starting with **`sickPrefix`** (default `ZIEK`) means the shift was reported sick: it is
  emitted as `cancelled` and not counted towards `hoursThisWeek`;
- every `employeeMetadata` entry with an email becomes a worker, even with no shift in the window;
- the feed has no availability, so a person is available whenever they are not on a shift in the
  window, unless `employeeMetadata[].availability` narrows it.

The feed address usually embeds a secret token. It is handled like a credential: never logged,
never quoted in an error. Store it as the secret `ICS_URL` environment variable on the Actor.

## Input

See the input tab for every option. The essentials:

| Field | Default | Notes |
| --- | --- | --- |
| `mode` | `live` | `live` = Cal.com only. `hybrid` = Cal.com + synthetic metadata fallback. `demo` = no network, no credentials. |
| `apiKey` | — | **Secret.** Cal.com key starting `cal_`. Falls back to `CAL_COM_API_KEY`. Required unless `mode` is `demo`. |
| `baseUrl` | `https://api.cal.com/v2` | Change only for self-hosted Cal.com. |
| `startTime` / `endTime` | `now` / `now+7d` | ISO-8601, a bare date, `now`, or `now±<n>{m,h,d,w}`. |
| `teamIds`, `eventTypeIds`, `usernames`, `bookingStatuses` | all / `["upcoming"]` | Scope filters. |
| `employeeMetadata` | `[]` | The roster: employee IDs, roles, departments, skills, contracted hours. |
| `employeeMetadataUrl` / `employeeMetadataStoreKey` | — | Same data from an HTTPS URL or a key-value store instead. |
| `shiftTypeMetadata` | `[]` | Maps Cal.com event types to shift requirements. |
| `failOnEmptyResult` | `false` | Fail the run when a successful call yields zero workers. |

### Example input

```json
{
    "mode": "live",
    "apiKey": "cal_live_xxxxxxxxxxxxxxxx",
    "startTime": "now",
    "endTime": "now+7d",
    "teamIds": ["31"],
    "bookingStatuses": ["upcoming"],
    "employeeMetadata": [
        {
            "employeeId": "E101",
            "email": "sarah@hospital.example",
            "role": "ICU_NURSE",
            "department": "ICU",
            "skills": ["ICU", "BLS", "ALS"],
            "contractedHoursPerWeek": 36
        },
        {
            "employeeId": "E102",
            "calUsername": "jonas-b",
            "role": "ICU_NURSE",
            "department": "ICU",
            "skills": ["ICU", "BLS"],
            "contractedHoursPerWeek": 32
        }
    ],
    "shiftTypeMetadata": [
        {
            "eventTypeSlug": "icu-night-shift",
            "role": "ICU_NURSE",
            "department": "ICU",
            "requiredSkills": ["ICU", "BLS", "ALS"]
        }
    ]
}
```

Metadata entries are matched to Cal.com users by `email` (case-insensitively), then
`calUsername`, then `calUserId`. An entry needs `employeeId` plus at least one match key, or the
run fails — silently dropping a roster entry would make the agent skip a real, eligible worker.

**Do not put medical information, diagnoses or absence reasons in the metadata.** This is a
roster feed: roles, departments, skills, contracted hours and rota, and nothing else.

## Output

You can download the dataset in JSON, HTML, CSV or Excel, or read it through the API.

```json
{
    "recordType": "worker",
    "employeeId": "E101",
    "name": "Sarah V",
    "email": "sarah@hospital.example",
    "role": "ICU_NURSE",
    "department": "ICU",
    "skills": ["ICU", "BLS", "ALS"],
    "availability": [
        { "start": "2026-09-29T07:00:00.000Z", "end": "2026-09-29T15:00:00.000Z", "source": "cal.com" }
    ],
    "scheduledShifts": ["SHIFT-CAL-bk-1001"],
    "hoursThisWeek": 8,
    "contractedHoursPerWeek": 36,
    "timeZone": "Europe/Amsterdam",
    "sourceIds": { "calUserId": 502, "calUsername": "sarah-v" },
    "source": "cal.com",
    "synthetic": false,
    "retrievedAt": "2026-09-26T09:00:00.000Z"
}
```

```json
{
    "recordType": "shift",
    "shiftId": "SHIFT-CAL-bk-1003",
    "start": "2026-09-28T18:00:00.000Z",
    "end": "2026-09-29T02:00:00.000Z",
    "durationMinutes": 480,
    "role": "ICU_NURSE",
    "department": "ICU",
    "requiredSkills": ["ICU", "BLS", "ALS"],
    "assignedEmployeeId": null,
    "assignedWorkerEmail": null,
    "status": "pending",
    "coverageStatus": "uncovered",
    "sourceIds": { "bookingUid": "bk-1003", "eventTypeSlug": "icu-night-shift", "teamId": 31 },
    "source": "cal.com",
    "lastUpdated": "2026-09-20T10:00:00.000Z"
}
```

```json
{
    "recordType": "summary",
    "status": "success",
    "mode": "live",
    "sourceSystem": "cal.com",
    "workforceMetadataSource": "input-inline",
    "dateRange": { "start": "2026-09-26T00:00:00.000Z", "end": "2026-10-03T00:00:00.000Z" },
    "counts": {
        "pagesFetched": 7,
        "apiRequests": 7,
        "workersRetrieved": 12,
        "shiftsRetrieved": 37,
        "eventsRetrieved": 37,
        "recordsDiscarded": 0,
        "duplicatesDropped": 0,
        "workersWithoutMetadata": 0
    },
    "emptyResult": false,
    "warnings": [],
    "errorCode": null,
    "durationMs": 1843,
    "actorVersion": "1.0.0"
}
```

## How n8n consumes the dataset

1. **Run the Actor** — Apify node, *Run an Actor* (or *Run Actor and get dataset*), with the
   input above. For a scheduled sweep, use `"startTime": "now", "endTime": "now+7d"`.
2. **Get the items** — Apify node, *Get Dataset Items*, using the run's `defaultDatasetId`.
3. **Check the summary first.** This is the step that keeps the loop honest:

   ```javascript
   const summary = items.find((item) => item.recordType === 'summary');

   if (!summary) throw new Error('Run did not finish — the dataset is incomplete.');
   if (summary.status === 'failure') throw new Error(`Roster retrieval failed: ${summary.errorCode}`);
   if (summary.emptyResult) {
       // A successful call that found nobody. Escalate — do NOT treat it as "no staff available".
   }
   // summary.status === 'partial' means a cap or a discard: usable, but not the whole picture.
   ```

4. **Split by `recordType`** — a Switch node on `recordType` gives you `worker`, `shift`,
   `schedulingEvent` and `summary` branches.
5. **Find the gap** — filter shifts on `coverageStatus === 'uncovered'`, or on the
   `assignedEmployeeId` of the worker who called in sick.
6. **Apply your eligibility rules in n8n** — all the data you need is on the records:

   ```javascript
   const eligible = workers.filter((w) =>
       w.role === shift.role &&
       shift.requiredSkills.every((skill) => w.skills.includes(skill)) &&
       w.availability.some((win) => win.start <= shift.start && win.end >= shift.end) &&
       !w.scheduledShifts.some((id) => overlaps(id, shift)) &&
       (w.contractedHoursPerWeek === null || w.hoursThisWeek + shift.durationMinutes / 60 <= w.contractedHoursPerWeek)
   );
   ```

   All timestamps are ISO-8601 UTC with milliseconds, so string comparison and `Date.parse()`
   both work and neither needs a time-zone library.
7. **Rank, contact, update, verify, escalate** — in n8n. The Actor is done.

Alternatively, read `SUMMARY` from the run's key-value store for a cheap status check without
paging the dataset.

## How to run it locally

```bash
npm install
npm test                 # build + 227 tests, no credentials needed
npm run typecheck
npm run format:check
```

A demo run needs no Cal.com key at all — `storage/key_value_stores/default/INPUT.json` is
already set to `mode: "demo"`:

```bash
apify run --purge --user-agent apify-agent-skills/apify-actor-development
```

You get 12 synthetic staff, a three-day rota with covered and uncovered shifts, and a summary, in
about twelve milliseconds. Results land in `storage/datasets/default/` — local storage is **not**
synced to Apify Console.

To run against real Cal.com locally, put your key in that same file (it is git-ignored under
`storage/`) or export `CAL_COM_API_KEY`:

```json
{
    "mode": "live",
    "apiKey": "cal_live_xxxxxxxxxxxxxxxx",
    "startTime": "now",
    "endTime": "now+7d"
}
```

Get a key from Cal.com under **Settings → Developer → API keys**.

## How to deploy to Apify

```bash
apify login
apify push --user-agent apify-agent-skills/apify-actor-development
```

Then set `apiKey` in the Console input (it is a secret field, so it is stored encrypted and
masked), or add `CAL_COM_API_KEY` as a secret environment variable on the Actor.

## Robustness

Every one of these is handled explicitly and covered by a test:

| Situation | What happens |
| --- | --- |
| Missing credentials | Fails before any request, with `CREDENTIALS_MISSING` and a pointer to demo mode |
| Invalid / expired / revoked token (401) | `CREDENTIALS_INVALID`, **never retried**, fails on the first `/v2/me` call |
| Not permitted (403) | `UNAUTHORIZED`, not retried |
| Rate limiting (429) | Retried, honouring `Retry-After`; falls back to exponential backoff with jitter |
| Server error (5xx) | Retried with backoff, then `UPSTREAM_ERROR` with the status code |
| Client error (4xx) | `UPSTREAM_ERROR`, not retried — replaying a bad request changes nothing |
| Network error | Retried, then `NETWORK_ERROR` |
| Timeout | Per-request `AbortController`, retried, then `UPSTREAM_TIMEOUT` |
| Malformed response | `MALFORMED_RESPONSE`, not retried — never coerced into an empty list |
| `200` with `status: "error"` | Treated as an upstream failure, not as empty data |
| Pagination | Walked to exhaustion; cursor for bookings, take/skip for memberships |
| Runaway pagination | Stops on a repeated cursor, an empty page, or the page/record caps — capped runs are `partial`, never `success` |
| Empty result | `emptyResult: true` on a `success` run, with an explicit warning; optionally fails the run |
| Invalid dates | Rejected at input parsing, or discarded per record with the reason logged |
| Duplicate records | Collapsed on stable IDs, merging fields rather than dropping the second copy |
| Partial data | Preserved: `null`/`[]` for what is missing, and the record still ships |
| Unusable data | Rejected, counted, and listed with reasons in `RUN_REPORT` |

### Error codes

`INPUT_INVALID`, `CREDENTIALS_MISSING`, `CREDENTIALS_INVALID`, `UNAUTHORIZED`, `RATE_LIMITED`,
`UPSTREAM_ERROR`, `UPSTREAM_TIMEOUT`, `NETWORK_ERROR`, `MALFORMED_RESPONSE`,
`METADATA_SOURCE_ERROR`, `EMPTY_RESULT`, `UNEXPECTED_ERROR`. Branch on these in n8n rather than
parsing messages.

## Time handling

- Every output timestamp is ISO-8601 UTC with milliseconds (`2026-09-26T18:00:00.000Z`).
- A date-only input (`2026-09-26`) means **UTC midnight**. This is the only local-time assumption
  in the Actor, and it is enforced in one place.
- Cal.com stores availability as wall-clock time plus an IANA zone. Conversion resolves the real
  offset for that instant through `Intl`, so DST transitions are handled rather than approximated
  — there are tests pinning both sides of the October 2026 European changeover.
- "This week" for `hoursThisWeek` means the **ISO week** (Monday 00:00 UTC to the following
  Monday 00:00 UTC) containing the start of the requested window.
- An overnight availability rule (`23:00`–`07:00`) correctly rolls onto the next day.

## Security

- The API key travels only in an `Authorization` header — never in a URL, never in a log line.
- Every log line, error message and dataset record passes through a redactor that scrubs
  `cal_*` keys, `apify_*` tokens, bearer values and anything after an `apiKey`/`token`/`secret`
  label. There are tests asserting a credential echoed back by an upstream error does not reach
  the log.
- Logging uses `apify`'s logger throughout, which censors credentials at every level. There is no
  `console.log` in `src/`.
- The run configuration is logged as a derived, log-safe view: the key is reduced to
  `credentialProvided: true` plus a flavour (`cal_live` / `cal_test`).
- The Actor only ever issues `GET` requests. It cannot modify your Cal.com data.

## Demo mode

`mode: "demo"` makes no network calls and needs no credentials. It produces 12 synthetic staff
across ICU, ER and two wards — nurses, charge nurses and doctors with different skills,
contracted hours, availability windows and time zones — on a three-shift rota (day / evening /
night) with roughly one slot in three deliberately left uncovered, so there is something to
recover.

The data is unmistakably synthetic: every name is prefixed `Demo`, every address is on
`demo.hospital.invalid` (RFC 2606 reserves `.invalid`, so none of them can resolve), and every
record is flagged `synthetic: true` with `source: "demo"`. It is deterministic, so the same
window always yields the same roster and the same IDs.

There is **no patient data, no absence reason and no medical information about staff** anywhere in
the demo set, and a test asserts that.

`mode: "hybrid"` is the middle ground: real Cal.com scheduling data, plus a clearly-labelled
synthetic profile for any Cal.com user your roster file does not yet cover.

## Known limitations

- **Cal.com only publishes availability schedules for the authenticated user.** `/v2/schedules`
  is scoped to whoever owns the API key, so schedule-derived availability covers that one person.
  Availability for everybody else must come from the workforce metadata source. The run warns
  about this every time rather than leaving you to discover it.
- **Cal.com has no employee model.** Roles, departments, skills, employee IDs and contracted
  hours cannot come from Cal.com and are not invented from it. Without a metadata source, workers
  ship with real identity and `null` workforce fields — and a warning saying so.
- **`hoursThisWeek` only counts shifts inside the retrieved window.** If the window starts
  mid-week, earlier shifts in that ISO week are not counted. Widen `startTime` to the Monday for
  an accurate figure.
- **`/v2/slots` is not used.** It returns bookable slots per event type, which for a round-robin
  team event cannot be attributed to an individual host — so it cannot answer "is this nurse
  free?". It is a natural extension point if per-host resolution is added.
- **Team scoping multiplies requests.** Cal.com filters bookings by one status and one team per
  request, so *n* statuses × *m* teams means *n × m* paginated walks. Both are bounded by
  validated input and reported in `counts.apiRequests`.
- **`status: "completed"`** is the one temporal interpretation the Actor makes: an accepted shift
  whose end has passed. It is recorded as a derivation, not as something Cal.com said.
- **No writes.** Updating the schedule after a replacement accepts is n8n's job, via the Cal.com
  API directly.

## Tests

227 tests, no credentials and no network access required — everything runs against fixtures and
an injected `fetch` double.

```bash
npm test
```

Coverage of the behaviour that matters: successful retrieval, cursor and offset pagination,
pagination caps and cursor-loop guards, normalization, deterministic IDs, date filtering,
empty-but-successful responses, authentication failure, rate limiting with `Retry-After`, 5xx
retries, malformed responses, timeouts, network errors, duplicate records, provenance labelling,
validation and repair, DST-correct time conversion, credential redaction, and the full pipeline
end to end in both live and demo mode.

## Cost

Compute only — there is no per-result charge. A one-week window for a single team is a handful of
API requests and finishes in seconds, so a run costs a negligible fraction of a compute unit even
on a schedule. The expensive axis is scope: many statuses × many teams × a long window multiplies
the paginated walks. Keep the window to what the decision loop actually needs (a week is plenty)
and set `bookingStatuses` to `["upcoming"]` unless you need history.

## FAQ

**Does this modify my Cal.com data?** No. `GET` requests only.

**Can I run it without Cal.com?** Yes — `mode: "demo"`, no credentials.

**What if my roster lives somewhere else?** Point `employeeMetadataUrl` at it, or implement a
`RosterSource` (see *Where to replace the source adapter*).

**Why is the summary record last?** So a missing summary unambiguously means the run did not
finish, and the dataset must not be trusted.

**Why does a worker have `role: null`?** No workforce metadata entry matched them. Check the
email addresses in your roster — the run warns and names the unmatched entries.

**Do I get an error or an empty dataset when Cal.com is down?** An error. That distinction is the
whole point of this Actor.

## Disclaimer

This Actor reads scheduling data you are already authorized to access with your own Cal.com API
key. Its output contains personal data — names, email addresses and working patterns of
identifiable people. Personal data is protected by the GDPR in the European Union and by similar
regulations elsewhere: process it only where you have a lawful basis, keep the dataset's retention
short, and restrict who can read it.

It is designed for **operational roster data only**. Do not feed medical information, diagnoses,
absence reasons or any patient data into the workforce metadata source, and do not store them in
the output. If you are unsure whether your use is lawful, consult your legal team.
