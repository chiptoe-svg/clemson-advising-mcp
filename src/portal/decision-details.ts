// The `details` payload of an mcp.access decision — the CONTRACT three repos read.
//
// This is the coordination point of the whole cross-repo design: the roster is
// reviewed here, approved once on Telegram, and then each repo acts on THIS
// object rather than on a file another repo wrote.
//
//   mailcal      reads recipients[i].email, and nothing else, to send a PIN.
//   gc_alumni    reads servers + auth_scopes to mark grants claimable.
//   this repo    mints its own registries and renders the reveal page.
//
// So the shape is defined HERE, in code, rather than described in a message.
// It had been described in a message, and the other side built a parser
// against a reasonable guess of it — which is exactly how two halves come to
// disagree while both look correct.
//
// EVERY RECIPIENT CARRIES BOTH id AND email. They are not interchangeable:
// `email` is where the PIN is sent, `id` is the consumer identity that lands
// in the usage ledger on every authenticated request. Deriving one from the
// other at read time means three repos each implementing the same local-part
// rule, and disagreeing the first time someone has a dotted address.
//
// auth_scopes IS KEYED BY SERVER, and is deliberately not called `scopes`:
// `scope` is already a PARAMETER on gc_careers' find_alumni_at_company and
// find_alumni_near_city, where it means current|prior|first|internship|any and
// has nothing to do with authorization. A bare `scopes` key beside a careers
// grant will eventually be read as that.
//
// An ABSENT entry in auth_scopes means granted whole, per the shared registry
// contract. An empty array means the same and should not be emitted.
import type { Roster, RosterRow, Server } from "../bulk-invite.js";

export interface DecisionRecipient {
  /** Consumer id — the email local part. The ledger identity, never the address. */
  id: string;
  /** Where the PIN goes. mailcal reads this field and no other. */
  email: string;
  name: string;
  /** Every server granted, mintable and delegated alike. */
  servers: Server[];
  /** Per-server scope tokens. Absent server = granted whole. */
  auth_scopes: Partial<Record<Server, string[]>>;
  note?: string;
}

export interface DecisionDetails {
  /** Format version, so a reader can refuse a shape it does not know. */
  version: 1;
  /** sha256 of the resolved roster — binds the approval to the reviewed parse. */
  fingerprint: string;
  recipients: DecisionRecipient[];
}

/**
 * Route a row's scope tokens to the servers they belong to.
 *
 * Scopes are namespaced (`clemson.*`, `gc.alumni.*`), so no per-server syntax
 * is needed in the CSV — but the WIRE form is explicit, because a reader
 * should not have to re-implement this routing to know what was granted.
 */
function scopesByServer(row: RosterRow): Partial<Record<Server, string[]>> {
  const out: Partial<Record<Server, string[]>> = {};
  for (const s of row.mintable) {
    const mine = row.scopes.filter((t) => t.startsWith(`clemson.${s}`));
    // `host` and any cross-cutting token apply to every mintable server.
    const shared = row.scopes.filter((t) => !t.startsWith("clemson."));
    const all = [...new Set([...mine, ...shared])];
    if (all.length) out[s] = all.sort();
  }
  if (row.delegated.includes("gc_alumni") && row.alumniScopes.length) {
    out.gc_alumni = [...row.alumniScopes].sort();
  }
  return out;
}

/** Build the decision details for an approved roster. */
export function rosterToDecisionDetails(roster: Roster): DecisionDetails {
  return {
    version: 1,
    fingerprint: roster.fingerprint,
    recipients: roster.rows.map((r) => {
      const rec: DecisionRecipient = {
        id: r.id,
        email: r.email,
        name: r.name,
        servers: [...r.servers].sort(),
        auth_scopes: scopesByServer(r),
      };
      if (r.note) rec.note = r.note;
      return rec;
    }),
  };
}
