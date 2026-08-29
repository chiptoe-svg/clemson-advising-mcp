// Clemson public "Browse Classes" client (Banner 9 self-service).
//
// Read-only access to the public class schedule at regssb.sis.clemson.edu — no
// login and no Clemson network required. The VPN restriction documented for
// iROAR applies only to the authenticated *registration* side; the class
// browse is internet-facing.
//
// Banner needs a session cookie with a term bound before searchResults returns
// rows, so each search runs the 3-step dance:
//   1. GET classSearch            -> mint JSESSIONID (returned on a 302)
//   2. POST term/search?mode=search -> bind the term to the session
//   3. GET searchResults/searchResults -> the query
// A fresh session is opened per search so searches never need an inter-query
// reset.

import { log } from "./log.js";
import { roomCapacity } from "./clemson-room-capacity.js";
import { toEasternIso } from "./eastern-time.js";
import {
  openScheduleDb,
  queryScheduleDb,
  writeScheduleDb,
  loadAllSectionsFromDb,
} from "./clemson-schedule-db.js";

const SSB = "https://regssb.sis.clemson.edu/StudentRegistrationSsb/ssb";

export interface ClemsonTerm {
  code: string;
  description: string;
}

export interface ClemsonMeeting {
  days: string; // e.g. "MWF"
  beginTime: string | null; // "1325" (24h, no colon — as Banner returns it)
  endTime: string | null;
  building: string | null;
  room: string | null;
  /** Seats in the room, from committed reference data; null when unknown. */
  roomCapacity: number | null;
  startDate: string | null;
  endDate: string | null;
  type: string | null;
}

export interface ClemsonInstructor {
  name: string;
  email: string | null;
  primary: boolean;
}

export interface ClemsonSection {
  term: string;
  termDescription: string;
  crn: string;
  subjectCourse: string;
  section: string;
  title: string;
  campus: string | null;
  scheduleType: string | null;
  instructionalMethod: string | null;
  creditHours: number | null;
  enrollment: number;
  maxEnrollment: number;
  seatsAvailable: number;
  waitCount: number;
  waitCapacity: number;
  open: boolean;
  instructors: ClemsonInstructor[];
  meetings: ClemsonMeeting[];
}

export interface ClemsonSearchParams {
  term: string;
  subject?: string;
  courseNumber?: string;
  openOnly?: boolean;
  max?: number;
  offset?: number;
  refresh?: boolean;
}

export interface ClemsonSearchResult {
  totalCount: number;
  sections: ClemsonSection[];
  /** ISO date of the snapshot used; null when fetched live. */
  snapshotDate: string | null;
  scope: "snapshot" | "live";
}

class CookieJar {
  private jar = new Map<string, string>();
  capture(res: Response): void {
    const getter = (res.headers as unknown as { getSetCookie?: () => string[] })
      .getSetCookie;
    const cookies =
      typeof getter === "function" ? getter.call(res.headers) : [];
    for (const c of cookies) {
      const pair = c.split(";")[0];
      const i = pair.indexOf("=");
      if (i > 0)
        this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/**
 * Fetch a Banner endpoint on a FRESH connection (never a reused keep-alive one).
 *
 * Banner sits behind an F5 load balancer that pins a session to one backend via a
 * `BIGipServer*` stickiness cookie, set on the response of a fresh connection.
 * Node's global fetch (undici) pools keep-alive connections; on a REUSED
 * connection the F5 does not re-issue that cookie, so we never capture it — and
 * the term-bind POST then lands on one backend while the follow-up searchResults
 * lands on another, where the term isn't bound. That returns `totalCount: 0`,
 * indistinguishable from a cold session. It bit the daily full refresh hardest:
 * its extra `getTerms` warms the pool, so `classSearch` reuses a connection and
 * drops the cookie ~every run (snapshot frozen for days).
 *
 * `Connection: close` forces a new socket per request, so the F5 sets — and we
 * capture — the stickiness cookie every time, pinning the whole session to one
 * backend. Node's undici honors this header (browsers forbid it; this is server
 * code). The cost is one TLS handshake per request, negligible for a daily job
 * and worth the reliability on the interactive path too.
 */
async function bannerFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Connection: "close",
    },
  });
}

export async function listClemsonTerms(
  max = 20,
): Promise<ClemsonTerm[] | null> {
  try {
    const r = await bannerFetch(
      `${SSB}/classSearch/getTerms?searchTerm=&offset=1&max=${max}`,
    );
    if (!r.ok) return null;
    const data = (await r.json()) as Array<{
      code?: string;
      description?: string;
    }>;
    return data.map((t) => ({
      code: String(t.code ?? ""),
      description: String(t.description ?? ""),
    }));
  } catch (err) {
    log.warn("clemson terms fetch failed", { err: String(err) });
    return null;
  }
}

async function openSession(term: string): Promise<CookieJar | null> {
  // The term bind (step 2) sometimes doesn't take on a fresh session, and the
  // caller then searches an unbound term — indistinguishable from a cold session
  // (page 0 returns totalCount=0). Retry the bind on a fresh session when it
  // returns a clear HTTP error, and let a good bind settle before the first
  // search. Cheap, and never worse than the previous single-shot bind.
  for (let attempt = 0; attempt < 3; attempt++) {
    const jar = new CookieJar();
    // redirect: "manual" is required — the JSESSIONID is set on the 302, and
    // fetch only exposes Set-Cookie from the response it stops on.
    const r1 = await bannerFetch(`${SSB}/classSearch/classSearch`, {
      redirect: "manual",
    });
    jar.capture(r1);
    const r2 = await bannerFetch(`${SSB}/term/search?mode=search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: jar.header(),
      },
      body: `term=${encodeURIComponent(term)}`,
      redirect: "manual",
    });
    jar.capture(r2);
    // status < 400 covers the normal 2xx / 3xx (redirect:manual) bind responses;
    // only a 4xx/5xx is a clear bind failure worth a fresh-session retry.
    if (r2.status < 400) {
      await sleep(250); // let the bind settle before the first searchResults call
      return jar;
    }
    await sleep(300 * (attempt + 1));
  }
  return null;
}

const DAY_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["monday", "M"],
  ["tuesday", "T"],
  ["wednesday", "W"],
  ["thursday", "R"],
  ["friday", "F"],
  ["saturday", "S"],
  ["sunday", "U"],
];

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(rec) : [];
}
function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}
function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
}

function mapMeeting(mf: Record<string, unknown>): ClemsonMeeting {
  const mt = rec(mf.meetingTime);
  const days = DAY_KEYS.filter(([k]) => mt[k])
    .map(([, d]) => d)
    .join("");
  const building = str(mt.buildingDescription) ?? str(mt.building);
  const room = str(mt.room);
  return {
    days,
    beginTime: str(mt.beginTime),
    endTime: str(mt.endTime),
    building,
    room,
    roomCapacity: roomCapacity(building, room),
    startDate: str(mt.startDate),
    endDate: str(mt.endDate),
    type: str(mt.meetingTypeDescription),
  };
}

function mapSection(r: Record<string, unknown>): ClemsonSection {
  const meetings = arr(r.meetingsFaculty).map(mapMeeting);
  // The same meeting repeats once per faculty member — dedupe identical rows.
  const seen = new Set<string>();
  const uniqueMeetings = meetings.filter((m) => {
    const key = JSON.stringify(m);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const instructors: ClemsonInstructor[] = arr(r.faculty).map((f) => ({
    name: String(f.displayName ?? ""),
    email: str(f.emailAddress),
    primary: Boolean(f.primaryIndicator),
  }));
  return {
    term: String(r.term ?? ""),
    termDescription: String(r.termDesc ?? ""),
    crn: String(r.courseReferenceNumber ?? ""),
    subjectCourse: String(r.subjectCourse ?? ""),
    section: String(r.sequenceNumber ?? ""),
    title: String(r.courseTitle ?? ""),
    campus: str(r.campusDescription),
    scheduleType: str(r.scheduleTypeDescription),
    instructionalMethod: str(r.instructionalMethodDescription),
    creditHours:
      typeof r.creditHourLow === "number"
        ? r.creditHourLow
        : typeof r.creditHours === "number"
          ? r.creditHours
          : null,
    enrollment: num(r.enrollment),
    maxEnrollment: num(r.maximumEnrollment),
    seatsAvailable: num(r.seatsAvailable),
    waitCount: num(r.waitCount),
    waitCapacity: num(r.waitCapacity),
    open: Boolean(r.openSection),
    instructors,
    meetings: uniqueMeetings,
  };
}

// Run the searchResults query on an already-opened session.
async function runSearch(
  jar: CookieJar,
  params: ClemsonSearchParams,
): Promise<{ totalCount: number; sections: ClemsonSection[] } | null> {
  const q = new URLSearchParams({
    txt_term: params.term,
    pageOffset: String(params.offset ?? 0),
    pageMaxSize: String(Math.min(Math.max(params.max ?? 50, 1), 500)),
    sortColumn: "subjectDescription",
    sortDirection: "asc",
  });
  if (params.subject) q.set("txt_subject", params.subject.toUpperCase());
  if (params.courseNumber) q.set("txt_courseNumber", params.courseNumber);
  if (params.openOnly) q.set("chk_open_only", "true");
  const r = await bannerFetch(`${SSB}/searchResults/searchResults?${q}`, {
    headers: { Cookie: jar.header() },
  });
  if (!r.ok) return null;
  // Banner sometimes returns an HTML error shell instead of JSON; treat that
  // as a failed fetch rather than throwing.
  const text = await r.text();
  let data: { totalCount?: number; data?: unknown };
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  log.debug("banner searchResults", {
    term: params.term,
    subject: params.subject ?? null,
    httpStatus: r.status,
    totalCount: data.totalCount ?? 0,
  });
  return {
    totalCount: data.totalCount ?? 0,
    sections: arr(data.data).map(mapSection),
  };
}

export async function searchClemsonClasses(
  params: ClemsonSearchParams,
): Promise<ClemsonSearchResult | null> {
  if (!params.refresh) {
    const db = openScheduleDb(params.term);
    if (db) {
      try {
        return queryScheduleDb(db, params);
      } finally {
        db.close();
      }
    }
  }
  // No snapshot: fall back to a live Banner query with cold-session retry.
  // Banner returns totalCount:0 when the term didn't bind to the session
  // (same cold-session behaviour as fetchSectionsPaged). Retry with a fresh
  // session rather than returning an empty list the caller might trust as fact.
  const LIVE_ATTEMPTS = 3;
  for (let attempt = 0; attempt < LIVE_ATTEMPTS; attempt++) {
    try {
      const jar = await openSession(params.term);
      if (!jar) {
        await sleep(400);
        continue;
      }
      const result = await runSearch(jar, params);
      if (result === null) {
        await sleep(400);
        continue;
      }
      if (result.totalCount === 0 && result.sections.length === 0) {
        log.warn("clemson search: empty live result — possible cold session", {
          term: params.term,
          subject: params.subject ?? null,
          attempt,
        });
        if (attempt < LIVE_ATTEMPTS - 1) {
          await sleep(400);
          continue;
        }
        // All retries exhausted with 0: return null so the MCP returns an
        // explicit error rather than an empty list the caller might treat as fact.
        return null;
      }
      return { ...result, snapshotDate: null, scope: "live" };
    } catch (e) {
      log.warn("clemson class search failed", { err: String(e) });
      if (attempt < LIVE_ATTEMPTS - 1) await sleep(400);
    }
  }
  return null;
}

// --- Per-section detail (description, prereqs, coreqs, restrictions, books) ---

export interface ClemsonSectionDetails {
  term: string;
  crn: string;
  description: string | null;
  prerequisites: string | null;
  corequisites: string | null;
  restrictions: string | null;
  attributes: string | null;
  bookstoreUrl: string | null;
}

function htmlToText(html: string): string | null {
  let t = html.replace(/<!--[\s\S]*?-->/g, "");
  // Banner returns an error shell for endpoints that don't apply.
  if (/page is not available/i.test(t)) return null;
  t = t
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return t || null;
}

// Collapse Banner's "no X information available" placeholders to null.
function meaningful(text: string | null): string | null {
  if (!text) return null;
  if (/^(no .*information( is)? available\.?|none\.?)$/i.test(text))
    return null;
  return text;
}

async function postDetail(
  jar: CookieJar,
  endpoint: string,
  term: string,
  crn: string,
): Promise<string> {
  const r = await bannerFetch(`${SSB}/searchResults/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: jar.header(),
    },
    body: `term=${encodeURIComponent(term)}&courseReferenceNumber=${encodeURIComponent(crn)}`,
  });
  return r.ok ? await r.text() : "";
}

function bookstoreUrl(html: string): string | null {
  // Prefer the populated link over the "{0}" template the page also emits.
  const hrefs = [...html.matchAll(/href="([^"]+)"/gi)].map((m) => m[1]);
  const real = hrefs.find((h) => h.startsWith("http") && !h.includes("{"));
  return real ? real.replace(/&amp;/g, "&") : null;
}

export async function getClemsonSectionDetails(
  term: string,
  crn: string,
): Promise<ClemsonSectionDetails | null> {
  try {
    const jar = await openSession(term);
    if (!jar) return null;
    const [desc, preq, coreq, restr, attrs, books] = await Promise.all([
      postDetail(jar, "getCourseDescription", term, crn),
      postDetail(jar, "getSectionPrerequisites", term, crn),
      postDetail(jar, "getCorequisites", term, crn),
      postDetail(jar, "getRestrictions", term, crn),
      postDetail(jar, "getSectionAttributes", term, crn),
      postDetail(jar, "getSectionBookstoreDetails", term, crn),
    ]);
    return {
      term,
      crn,
      description: meaningful(htmlToText(desc)),
      prerequisites: meaningful(htmlToText(preq)),
      corequisites: meaningful(htmlToText(coreq)),
      restrictions: meaningful(htmlToText(restr)),
      attributes: meaningful(htmlToText(attrs)),
      bookstoreUrl: bookstoreUrl(books),
    };
  } catch (err) {
    log.warn("clemson section details failed", { err: String(err) });
    return null;
  }
}

// --- Instructor lookup + "what is <name> teaching" ---

/** Match a term by code or by name ("Fall 2026") against Banner's live term list. */
async function resolveBannerTerm(
  term: string,
): Promise<{ code: string; description: string } | null> {
  if (/^\d{6}$/.test(term)) {
    const all = await listClemsonTerms(50);
    const hit = all?.find((t) => t.code === term);
    return { code: term, description: hit?.description ?? term };
  }
  const all = await listClemsonTerms(50);
  const q = term.trim().toLowerCase();
  const hit = all?.find((t) => t.description.toLowerCase().includes(q));
  return hit ? { code: hit.code, description: hit.description } : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Page through searchResults on one session, accumulating every section.
// Banner's txt_instructor filter is unreliable (HTTP 500s), so the instructor
// flow instead lists sections (optionally subject-scoped) and filters by
// faculty name in code. With a subject this is one page; without one it walks
// the whole term (~10k sections) in 500-row pages.
const PAGE_SIZE = 500;
const MAX_PAGES = 40;

type PagedResult = { sections: ClemsonSection[]; complete: boolean };

async function fetchSectionsPaged(
  term: string,
  subject: string | undefined,
  openOnly: boolean | undefined,
  attempts = 4,
): Promise<PagedResult | null> {
  // NB: Banner's searchResults is stateful per session — the first query on a
  // session fixes the result set, and offset paging walks it. Do NOT issue any
  // other search (e.g. a probe) on the same session first; that resets the set
  // and breaks paging. So each attempt opens a fresh session and pages the real
  // query directly. A first page with totalCount=0 means the term didn't bind
  // (cold session) — retry with a new session rather than report "no results".
  for (let attempt = 0; attempt < attempts; attempt++) {
    const jar = await openSession(term);
    if (!jar) {
      log.warn("clemson scan: session open failed", {
        term,
        subject,
        attempt: attempt + 1,
        attempts,
      });
      await sleep(400);
      continue;
    }
    const out: ClemsonSection[] = [];
    let failed = false;
    let cold = false;
    let totalCount = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await runSearch(jar, {
        term,
        subject,
        openOnly,
        offset: page * PAGE_SIZE,
        max: PAGE_SIZE,
      });
      if (res === null) {
        failed = true;
        break;
      }
      if (page === 0 && res.totalCount === 0 && res.sections.length === 0) {
        cold = true;
        break;
      }
      totalCount = res.totalCount;
      out.push(...res.sections);
      if (out.length >= res.totalCount || res.sections.length === 0) {
        return { sections: out, complete: true };
      }
      await sleep(200);
    }
    if (cold || (failed && out.length === 0)) {
      log.warn("clemson scan: attempt failed before any page landed", {
        term,
        subject,
        attempt: attempt + 1,
        attempts,
        reason: cold ? "cold-session" : "first-page-failed",
      });
      // Linear backoff: a cold session often clears on a later try, and backing
      // off gives Banner room to recover instead of hammering it fresh-session.
      await sleep(400 * (attempt + 1));
      continue;
    }
    // Partial failure mid-scan: return what we have, marked incomplete.
    // NB: this returns immediately — the retry loop above is never re-entered,
    // so a mid-scan failure costs the whole scan with no second try.
    log.warn("clemson scan: incomplete, not retried", {
      term,
      subject,
      attempt: attempt + 1,
      attempts,
      reason: failed ? "mid-scan-request-failed" : "max-pages-exhausted",
      sections: out.length,
      totalCount,
      pages: Math.ceil(out.length / PAGE_SIZE),
    });
    return { sections: out, complete: false };
  }
  log.warn("clemson scan: all attempts exhausted", { term, subject, attempts });
  return null;
}

// --- Per-term snapshots (SQLite) ---
//
// A full-term scan is ~20 requests and Banner rate-limits bursts, so the live
// (registering) terms are scanned once a day by a separate job and written
// to state/clemson/<term>.db (SQLite, atomic temp-file + rename). Queries open
// the DB read-only, run SQL with subject/courseNumber/openOnly filters, and
// stamp results with the DB's fetched_at timestamp. Snapshots are per term —
// Banner binds one term per session. Past "(View Only)" terms never change,
// so they need no refresh.

export interface ClemsonTermSnapshot {
  term: string;
  termDescription: string;
  fetchedAt: string; // ISO 8601
  sectionCount: number;
  sections: ClemsonSection[];
}

// Scan a term's full section list and persist it. Returns null if the scan did
// not complete (so a throttled/partial scan never overwrites a good snapshot).
export async function refreshClemsonSnapshot(
  term: string,
): Promise<ClemsonTermSnapshot | null> {
  const resolved = await resolveBannerTerm(term);
  if (!resolved) {
    log.warn("clemson refresh failed: term did not resolve", { term });
    return null;
  }
  // The daily refresh runs unattended; a cold-session miss leaves the term with
  // no .db until tomorrow (forcing tools onto the slow live-scan fallback), so
  // spend more attempts here than an interactive query would.
  const fetched = await fetchSectionsPaged(
    resolved.code,
    undefined,
    undefined,
    8,
  );
  if (fetched === null) {
    log.warn("clemson refresh failed: snapshot left unchanged", {
      term: resolved.code,
      reason: "all-attempts-failed",
    });
    return null;
  }
  if (!fetched.complete) {
    log.warn("clemson refresh failed: snapshot left unchanged", {
      term: resolved.code,
      reason: "partial-scan-discarded",
      sections: fetched.sections.length,
    });
    return null;
  }
  const snap: ClemsonTermSnapshot = {
    term: resolved.code,
    termDescription: resolved.description,
    fetchedAt: new Date().toISOString(),
    sectionCount: fetched.sections.length,
    sections: fetched.sections,
  };
  // A snapshot that did not reach disk is not a refresh, whatever Banner said.
  if (!writeScheduleDb(snap)) return null;
  return snap;
}

// Banner labels BOTH archived past terms and published-but-not-yet-registerable
// future terms "(View Only)" — the string cannot distinguish them, so the old
// "skip View Only" rule silently never snapshotted Spring 2027 until the day
// registration opened (2026-08-26 review, F3). A term is refreshed when it is
// not View Only, OR when its code is numerically above every non-View-Only
// term's (a future term that has been published). Past View-Only terms
// (below the live ones) stay skipped — they never change.
function isLiveTerm(t: ClemsonTerm): boolean {
  return !/\(view only\)/i.test(t.description);
}

export function selectRefreshTerms(
  terms: readonly ClemsonTerm[],
): ClemsonTerm[] {
  const live = terms.filter(isLiveTerm);
  if (live.length === 0) return []; // degraded getTerms (everything View Only): refresh nothing, as before
  const maxLive = live.reduce((m, t) => Math.max(m, Number(t.code) || 0), 0);
  return terms.filter((t) => isLiveTerm(t) || (Number(t.code) || 0) > maxLive);
}

export interface ClemsonRefreshResult {
  term: string;
  description: string;
  sections: number | null; // null = scan failed (snapshot left untouched)
}

// Daily job: discover the live terms via getTerms and refresh each snapshot.
export async function refreshLiveClemsonSnapshots(): Promise<
  ClemsonRefreshResult[]
> {
  const terms = await listClemsonTerms(20);
  if (!terms) return [];
  const out: ClemsonRefreshResult[] = [];
  for (const t of selectRefreshTerms(terms)) {
    const snap = await refreshClemsonSnapshot(t.code);
    out.push({
      term: t.code,
      description: t.description,
      sections: snap?.sectionCount ?? null,
    });
    await sleep(1000); // be gentle between term scans
  }
  return out;
}
