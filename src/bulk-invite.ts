// Roster import for bulk MCP access — parse, validate, resolve, fingerprint.
//
// WHY THIS IS PURE. Everything here is a function from text to a resolved
// roster or a list of problems. It mints nothing, writes nothing, and sends
// nothing, because the ORDER matters: a roster is validated and reviewed
// BEFORE a human approval is requested, so a rejected file costs no approval
// and a half-applied roster cannot exist.
//
// WHAT IT CANNOT DO, deliberately. Only `schedule` and `catalog` are mintable
// here — those are the registries this repo owns. gc_alumni and gc_public
// authenticate against registries in another repo, so this tool is
// STRUCTURALLY unable to grant them. That is a feature: a 70-row student
// roster cannot pick up alumni access through a typo in a servers column.
//
// DEFAULT SCOPE IS NARROW, and differs from `mcp:pair` on purpose. In the
// registry an absent/empty `scopes` means FULL access (default-allow), which
// is the right default when an operator is deliberately minting one token.
// It is the wrong default for seventy rows at once, where nobody is reading
// each line — so a row naming `schedule` gets `clemson.schedule`, not
// everything. An explicit scopes column overrides.
import crypto from "crypto";

/** The registries this repo can mint into. */
export const MINTABLE_SERVERS = ["schedule", "catalog"] as const;
export type MintableServer = (typeof MINTABLE_SERVERS)[number];

/**
 * Servers whose registries live in the gc_alumni repo. A roster may GRANT
 * these — they are recorded in the approval decision and minted there by
 * `--from-decision` — but this tool cannot issue them. That is deliberate and
 * load-bearing: a student roster cannot pick up alumni access through a typo
 * in a servers column, and the sensitive registry always takes a second,
 * deliberate command in the repo that owns it.
 */
export const DELEGATED_SERVERS = ["gc_alumni", "gc_careers"] as const;
export type DelegatedServer = (typeof DELEGATED_SERVERS)[number];

export type Server = MintableServer | DelegatedServer;

/** Renamed 2026-09-13. Accepted with a note, because notes and half-written
 *  rosters will carry the old name for a while and an unknown-server error
 *  would read as a typo rather than a rename. */
const RENAMED: Record<string, DelegatedServer> = { gc_public: "gc_careers" };

/** Email domains a roster row may carry. Owner decision, 2026-09-13. */
export const ALLOWED_DOMAINS = ["clemson.edu", "g.clemson.edu"];

/** The scope a row gets when it names a server and no explicit scopes. */
const DEFAULT_SCOPES: Record<MintableServer, string[]> = {
  schedule: ["clemson.schedule"],
  catalog: ["clemson.catalog"],
};

/** Above this, the review escalates — not a refusal, a louder confirmation. */
export const LARGE_ROSTER = 50;
/** Refused unless explicitly overridden: past here a mistake is likelier than intent. */
export const SANITY_CEILING = 500;

export interface RosterRow {
  /** 1-based line number in the source file, for error messages. */
  line: number;
  name: string;
  email: string;
  /** Consumer id: the lowercased local part. Never the address — the id lands
   *  in the usage ledger on every request and an audit identity should not be
   *  contact PII. Agreed with the gc_alumni session 2026-09-13. */
  id: string;
  /** Every server granted, mintable and delegated alike. */
  servers: Server[];
  /** The subset this tool will issue. */
  mintable: MintableServer[];
  /** The subset gc_alumni issues from the approved decision. */
  delegated: DelegatedServer[];
  /**
   * Scopes for the MINTABLE servers only. Delegated servers are granted whole:
   * gc_careers has no scope vocabulary and gc_alumni's is not consulted at
   * request time, so emitting per-server scopes here would record a control
   * that nothing honours — the defect this project keeps meeting. When
   * enforcement exists, carry them in the decision details instead of
   * inferring them.
   */
  scopes: string[];
  note: string;
}

export interface Problem {
  line: number;
  field: string;
  message: string;
}

export interface Roster {
  rows: RosterRow[];
  /** sha256 over the canonical form. Binds an approval to THIS parse. */
  fingerprint: string;
  /** Distinct servers across all rows, for the approval summary. */
  servers: Server[];
  /** True when any row grants a server this tool cannot issue. */
  hasDelegated: boolean;
  large: boolean;
  /** Deprecated server names seen, so the CLI can print a rename note. */
  renamed: string[];
}

/**
 * Minimal RFC4180-ish splitter: handles quoted fields and doubled quotes.
 * Deliberately small — a roster is a hand-made file, not a data feed, and a
 * dependency here would be a supply-chain surface for one comma rule.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Servers/scopes cells accept space, pipe or semicolon separation. */
function splitList(cell: string): string[] {
  return cell
    .split(/[\s|;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Deliberately permissive on the local part and strict on shape: the domain
// check below is what actually gates, and a clever regex here would reject
// valid Clemson addresses while proving nothing.
const EMAIL_RE = /^([^\s@]+)@([^\s@]+)$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

export interface ParseOptions {
  /** Existing consumer ids per MINTABLE server, so collisions are caught
   *  before minting. Delegated registries are checked by their own tool; this
   *  process cannot read them and must not pretend to. */
  existing: Partial<Record<MintableServer, Set<string>>>;
  /** Accept a roster past SANITY_CEILING. */
  allowHuge?: boolean;
  isValidScope: (token: string) => boolean;
}

/**
 * Parse and validate a whole roster. Returns EITHER a resolved roster or every
 * problem found — never a partial roster, and never one problem at a time.
 *
 * Reporting all problems in one pass is what makes all-or-nothing bearable at
 * scale: what is painful about refusing a 300-row file is discovering its
 * errors one run at a time, not the refusal itself.
 */
export function parseRoster(
  text: string,
  opts: ParseOptions,
): { roster: Roster; problems: [] } | { roster: null; problems: Problem[] } {
  const problems: Problem[] = [];
  const lines = text.split(/\r?\n/);
  const rows: RosterRow[] = [];

  const headerIdx = lines.findIndex((l) => l.trim() !== "");
  if (headerIdx === -1) {
    return { roster: null, problems: [{ line: 0, field: "file", message: "the file is empty" }] };
  }
  const header = splitCsvLine(lines[headerIdx]).map((h) => h.toLowerCase());
  const col = (n: string) => header.indexOf(n);
  for (const required of ["name", "email", "servers"]) {
    if (col(required) === -1) {
      problems.push({
        line: headerIdx + 1,
        field: "header",
        message:
          `missing required column '${required}'. Expected a header row with ` +
          `name, email, servers and optionally scopes, note.`,
      });
    }
  }
  if (problems.length) return { roster: null, problems };

  const iName = col("name"), iEmail = col("email"), iServers = col("servers");
  const iScopes = col("scopes"), iNote = col("note");

  const seenEmail = new Map<string, number>();
  const seenId = new Map<string, number>();
  const renamedSeen = new Set<string>();

  for (let n = headerIdx + 1; n < lines.length; n++) {
    const raw = lines[n];
    if (raw.trim() === "") continue;
    const line = n + 1;
    const cells = splitCsvLine(raw);
    const get = (i: number) => (i === -1 ? "" : (cells[i] ?? ""));

    const name = get(iName);
    const email = get(iEmail).toLowerCase();
    if (!name) problems.push({ line, field: "name", message: "name is empty" });

    const m = EMAIL_RE.exec(email);
    let id = "";
    if (!m) {
      problems.push({ line, field: "email", message: `'${email}' is not an email address` });
    } else {
      const [, local, domain] = m;
      if (!ALLOWED_DOMAINS.includes(domain)) {
        problems.push({
          line,
          field: "email",
          message:
            `domain '${domain}' is not permitted — rosters are restricted to ` +
            `${ALLOWED_DOMAINS.join(" or ")} (owner decision, 2026-09-13)`,
        });
      }
      id = local.toLowerCase();
      if (!ID_RE.test(id)) {
        problems.push({
          line,
          field: "email",
          message: `'${local}' does not yield a usable consumer id (allowed: a-z 0-9 . _ -)`,
        });
      }
      const prevE = seenEmail.get(email);
      if (prevE !== undefined) {
        problems.push({ line, field: "email", message: `duplicate of line ${prevE}` });
      } else seenEmail.set(email, line);

      const prevI = seenId.get(id);
      if (prevI !== undefined && prevE === undefined) {
        // Two DIFFERENT addresses collapsing to one id — jsmith@clemson.edu and
        // jsmith@g.clemson.edu. Silently minting one token for what the file
        // presents as two people is the failure worth catching here.
        problems.push({
          line,
          field: "email",
          message:
            `consumer id '${id}' already taken by line ${prevI} — two addresses ` +
            `with the same local part cannot both be onboarded`,
        });
      } else if (prevI === undefined) seenId.set(id, line);
    }

    const serverCells = splitList(get(iServers));
    const servers: Server[] = [];
    const mintable: MintableServer[] = [];
    const delegated: DelegatedServer[] = [];
    if (serverCells.length === 0) {
      problems.push({ line, field: "servers", message: "no server requested" });
    }
    for (const cell of serverCells) {
      const s = RENAMED[cell] ?? cell;
      if (RENAMED[cell]) renamedSeen.add(cell);
      if ((MINTABLE_SERVERS as readonly string[]).includes(s)) {
        if (!mintable.includes(s as MintableServer)) mintable.push(s as MintableServer);
      } else if ((DELEGATED_SERVERS as readonly string[]).includes(s)) {
        if (!delegated.includes(s as DelegatedServer)) delegated.push(s as DelegatedServer);
      } else {
        problems.push({
          line,
          field: "servers",
          message:
            `unknown server '${cell}' (expected ` +
            `${[...MINTABLE_SERVERS, ...DELEGATED_SERVERS].join(", ")})`,
        });
        continue;
      }
      if (!servers.includes(s as Server)) servers.push(s as Server);
    }

    const explicit = splitList(get(iScopes));
    for (const s of explicit) {
      if (!opts.isValidScope(s)) {
        problems.push({ line, field: "scopes", message: `unknown scope '${s}'` });
      }
    }
    if (explicit.length && mintable.length === 0) {
      problems.push({
        line,
        field: "scopes",
        message:
          `scopes apply to ${MINTABLE_SERVERS.join("/")} only, and this row ` +
          `grants neither. ${delegated.join("/")} is granted whole — recording ` +
          `a scope nothing enforces would state a control that does not exist.`,
      });
    }
    const scopes = explicit.length
      ? explicit
      : [...new Set(mintable.flatMap((s) => DEFAULT_SCOPES[s]))];

    for (const s of mintable) {
      if (id && opts.existing[s]?.has(id)) {
        problems.push({
          line,
          field: "email",
          message:
            `consumer '${id}' already exists on the ${s} registry — revoke it ` +
            `first to rotate, rather than overwriting a live credential`,
        });
      }
    }

    rows.push({ line, name, email, id, servers, mintable, delegated, scopes, note: get(iNote) });
  }

  if (rows.length === 0) {
    problems.push({ line: headerIdx + 1, field: "file", message: "the roster has no data rows" });
  }
  if (rows.length > SANITY_CEILING && !opts.allowHuge) {
    problems.push({
      line: 0,
      field: "file",
      message:
        `${rows.length} rows exceeds the sanity ceiling of ${SANITY_CEILING}. ` +
        `This is not a limit on how many people may be onboarded — it is a ` +
        `check that the file is the one you meant. Re-run with --allow-huge ` +
        `to proceed.`,
    });
  }

  if (problems.length) {
    problems.sort((a, b) => a.line - b.line || a.field.localeCompare(b.field));
    return { roster: null, problems };
  }

  const servers = [...new Set(rows.flatMap((r) => r.servers))].sort() as Server[];
  return {
    roster: {
      rows,
      servers,
      hasDelegated: rows.some((r) => r.delegated.length > 0),
      large: rows.length > LARGE_ROSTER,
      fingerprint: fingerprintRoster(rows),
      renamed: [...renamedSeen].sort(),
    },
    problems: [],
  };
}

/**
 * sha256 over a CANONICAL form — sorted by id, fixed field order, line numbers
 * excluded. Reordering the CSV or re-saving it does not change the
 * fingerprint; changing WHO is on it, what they get, or which address they
 * have does. The approval is bound to the resolved content, not to the file.
 */
export function fingerprintRoster(rows: RosterRow[]): string {
  const canon = [...rows]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => [r.id, r.email, r.name, [...r.servers].sort().join("+"), [...r.scopes].sort().join("+")]);
  return crypto.createHash("sha256").update(JSON.stringify(canon), "utf-8").digest("hex");
}

/**
 * The one-line summary that goes on the Telegram card.
 *
 * Delegated servers are named explicitly rather than folded in with the rest:
 * approving a roster that grants gc_alumni is a materially different act from
 * approving one that grants class times, and the card is where that has to be
 * legible. The full roster never appears here — it is reviewed in the terminal
 * and bound to this approval by the fingerprint.
 */
export function rosterSummary(roster: Roster): string {
  const delegated = [...new Set(roster.rows.flatMap((r) => r.delegated))].sort();
  return (
    `${roster.rows.length} recipients · ${roster.servers.join(" + ")} · ` +
    `fp ${roster.fingerprint.slice(0, 12)}` +
    (delegated.length ? ` · DELEGATED: ${delegated.join(" + ")}` : "") +
    (roster.large ? " · LARGE ROSTER" : "")
  );
}
