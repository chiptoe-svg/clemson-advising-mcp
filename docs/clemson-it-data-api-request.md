# Request to Clemson IT: supported data access

**Purpose of this document:** the brief for a meeting with Clemson IT whose
goal is **supported, read-only API access** to two bodies of published data
this service already consumes — the class schedule and the course catalog. It
states what we read today, exactly how, what we are asking for, and what
changes on our side if we get it. Everything in it is verifiable against this
repository.

The ask, in one sentence: _we already read this data the hard way; give us the
supported way, and the load on your systems goes down._

---

## 1. What we serve, and to whom

Two MCP servers (`docs/architecture.md`) expose Clemson's published class
schedule and the College of Business published curriculum to an AI advising
assistant used by College of Business advisors. Both servers are read-only,
hold no student records, and require a bearer token this deployment issues.
`docs/security.md` is the full statement of what they hold and what leaves the
machine.

## 2. What we read today, and how

### The class schedule — Banner Student Registration Self-Service

|                          |                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Host**                 | `regssb.sis.clemson.edu/StudentRegistrationSsb/ssb` — the same JSON endpoints the public "Browse Classes" page calls                                                                                 |
| **Endpoints**            | `classSearch/getTerms`, `term/search`, `searchResults/searchResults`, and the per-section detail endpoints under `searchResults/`                                                                    |
| **Authentication**       | None — these are the public, unauthenticated search endpoints                                                                                                                                        |
| **Schedule**             | One full sweep per live term, daily at 05:00. Currently seven terms, ~21,000 sections                                                                                                                |
| **Pacing**               | 200–400 ms between requests, 1 s between terms, pages of 500 sections capped at 40 pages, at most three attempts per term, `Connection: close` on every request                                      |
| **Identification**       | Every request carries `User-Agent: clemson-advising-mcp/0.1 (College of Business advising; https://github.com/chiptoe-svg/clemson-advising-mcp)` so the traffic is attributable                      |
| **Also at request time** | Three tools reach Banner live: `list-clemson-terms`, `get-course-details`, and `search-classes` when a caller asks for current seat counts. Bounded by a per-credential limit of 600 requests/minute |
| **What we keep**         | A per-term SQLite snapshot of sections, meeting times, rooms, seats, and instructor names — all as published                                                                                         |

### The course catalog — catalog.clemson.edu

|                  |                                                                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Host**         | `catalog.clemson.edu` (Acalog / Modern Campus)                                                                                                                                            |
| **Method**       | The catalog is a JavaScript application, so program pages are rendered with a headless browser (Playwright) and parsed; course pages are fetched directly                                 |
| **Schedule**     | About **once a year**, when a new catalog year is published, on whatever machine runs the rebuild. Never from the serving host                                                            |
| **Volume**       | Nine catalog years; 4,085 course pages and the program pages of seven College of Business programs plus minors and certificates, cached locally so a rebuild re-fetches only what changed |
| **What we keep** | Program plans, requirement rules, General Education categories, course descriptions and prerequisites — all as published                                                                  |

## 3. What we are asking for

### Request 1 — Ellucian Ethos (or equivalent) read access for section data

- A **read-only** credential, least privilege: no write, no student data.
- The resources that describe sections: academic periods (terms), courses,
  sections, instructional events (meeting days/times/rooms), buildings and
  rooms, and instructor names.
- **One question we need guidance on:** current open-seat counts. The Self-
  Service search returns live availability; if Ethos does not expose it, we
  would keep one narrow Self-Service call for that alone and drop everything
  else.

**What changes if we get it:** the daily sweep of the search endpoints stops.
A versioned, documented contract replaces parsing a UI's JSON.

### Request 2 — Acalog API key for catalog data

- A **read-only** API key for the current and prior catalogs.
- Catalogs, programs (cores and requirements), and courses (descriptions,
  prerequisites, corequisites).

**What changes if we get it:** the annual headless-browser render of the
catalog stops. Structured data replaces parsing rendered pages, which is also
more reliable for us.

### If neither is available

The fallback ask is narrower: a documented, sanctioned way to keep calling the
Self-Service endpoints at our current pacing, or a nightly export of each
term's section file. We would rather be told the supported path than keep
guessing at it.

## 4. What we offer

- **Room capacities.** Banner's public feed carries none, so we currently use a
  hand-exported CuSectionOverview report (`docs/security.md` §1 names it as the
  one non-published input). A supported source for room capacity would let us
  drop that too.
- **Rate limits and caching on your terms.** We cache per term and refresh on
  whatever cadence you set. The per-credential ceiling is one environment
  variable.
- **A dedicated service account**, and the exact resource list, whenever you
  want them.
- **The code.** This repository is written to be read by IT security:
  `docs/security.md` first, then `docs/architecture.md`.

## 5. Who

Owner and operator: **Chip Tonkin**, College of Business. Contact and
maintenance commitments are stated in `docs/security.md` §8.

---

_Two likely owners for the two requests: Banner/Ethos with central IT or the
Ellucian integration team; the Acalog key with the Registrar or whoever
administers catalog.clemson.edu. If the first contact bounces, that is the
redirect to expect._
