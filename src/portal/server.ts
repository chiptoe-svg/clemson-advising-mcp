#!/usr/bin/env -S npx tsx
// The access portal: PIN in, tokens out.
//
//   PORT=8768 npx tsx src/portal/server.ts
//
// Loopback only. Caddy terminates TLS and reverse-proxies /access/* to it, so
// this process never faces the network directly and never sees a certificate.
//
// THREE ROUTES AND NOTHING ELSE. Every unmatched path is a 404, including the
// root: there is no index listing what exists, because an index of this service
// is an index of who might have access.
//
//   GET  /activate   the code form
//   POST /activate   verify, mint, show tokens ONCE
//   POST /resend     always the same answer (see pages.ts)
//
// NO SESSIONS, NO COOKIES. The PIN is the whole authentication and it is spent
// in one request. A session would create a second credential to steal and a
// second expiry to reason about, for a flow a person completes in one step.
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import { openStore, verifyPin, rotatePin, markRevealed, hashPin, expireLapsed } from "./store.js";
import { activatePage, resendPage, errorPage } from "./pages.js";
import { renderRevealPage, type RevealFailure } from "./reveal-page.js";
import { mintAll } from "./mint.js";
import { PIN_DIGITS, PIN_TTL_HOURS, MAX_PIN_RESENDS } from "./constants.js";
import { log } from "../log.js";

const PORT = Number(process.env.PORT ?? 8768);
const HOST = "127.0.0.1";
const CONTACT = process.env.ACCESS_CONTACT ?? "Chip Tonkin";
const MAX_PIN_ATTEMPTS = 5;
/** Bodies are two short fields. Anything larger is not this form. */
const MAX_BODY = 4096;

const db = openStore();

/** Uniform delay on every failed activation. */
const FAIL_DELAY_MS = 400;

function send(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    // The reveal page contains a credential: never store it anywhere.
    "cache-control": "no-store, no-cache, must-revalidate, private",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    // No external anything: this page must render with no network at all.
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
  });
  res.end(html);
}

async function readBody(req: http.IncomingMessage): Promise<URLSearchParams> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf-8"));
}

/** Human-readable reason, chosen so it never distinguishes unknown from wrong. */
function failureMessage(reason: string): string {
  switch (reason) {
    case "claim_expired":
      return (
        "That access request has expired. Codes last 24 hours and the request " +
        `itself lasts 7 days. Ask ${CONTACT} to issue it again.`
      );
    case "too_many_attempts":
      return (
        "Too many incorrect codes. Request a new code below — that resets the " +
        "attempts."
      );
    case "too_many_resends":
      return `Too many codes requested. Ask ${CONTACT} for a new request.`;
    default:
      // no_grant, wrong_pin and pin_expired share one message ON PURPOSE.
      // Distinguishing them would tell a stranger whether an address has
      // access pending, which is exactly what this form must not answer.
      return (
        "That code and address do not match anything we can activate. Check " +
        "both, or request a new code below."
      );
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  // handle_path strips the /access prefix, so paths arrive bare.
  const route = url.pathname.replace(/^\/+|\/+$/g, "");

  try {
    if (req.method === "GET" && (route === "activate" || route === "")) {
      return send(res, 200, activatePage());
    }

    if (req.method === "POST" && route === "resend") {
      const body = await readBody(req);
      const email = (body.get("email") ?? "").trim().toLowerCase();
      const pin = String(Math.floor(Math.random() * 10 ** PIN_DIGITS)).padStart(
        PIN_DIGITS,
        "0",
      );
      const r = rotatePin(
        db,
        email,
        hashPin(pin),
        Date.now() + PIN_TTL_HOURS * 3_600_000,
        MAX_PIN_RESENDS,
      );
      if (r.ok) {
        // TODO(send): hand `pin` to mailcal's send-on-decision for r.grant.
        // Until that is wired the code is generated and stored but not
        // delivered, so a resend cannot yet reach anyone. Logged WITHOUT the
        // pin so this is visible in operation rather than silently inert.
        log.info(`resend issued for a pending grant (delivery not wired)`);
      }
      // Same page, same status, same timing, whatever happened.
      await sleep(FAIL_DELAY_MS);
      return send(res, 200, resendPage());
    }

    if (req.method === "POST" && route === "activate") {
      const body = await readBody(req);
      const email = (body.get("email") ?? "").trim().toLowerCase();
      const pin = (body.get("pin") ?? "").trim();

      const v = verifyPin(db, email, pin, MAX_PIN_ATTEMPTS);
      if (!v.ok) {
        log.info(`activation refused: ${v.reason}`);
        await sleep(FAIL_DELAY_MS);
        return send(res, 200, activatePage(failureMessage(v.reason), email));
      }

      const { grants, failures } = await mintAll(
        v.grant.servers,
        v.grant.consumer_id,
        v.grant.auth_scopes,
      );
      for (const f of failures) log.info(`mint failed ${f.server}: ${f.detail}`);

      // Marked revealed even on partial failure: the PIN is spent, and letting
      // it be reused would mint a SECOND token for whatever already succeeded.
      markRevealed(db, v.grant.id);
      log.info(
        `revealed ${v.grant.consumer_id}: ${grants.length} issued, ${failures.length} failed`,
      );

      const shown: RevealFailure[] = failures.map((f) => ({
        label: f.label,
        message: f.message,
      }));
      return send(
        res,
        200,
        renderRevealPage({
          personName: v.grant.name,
          grants,
          failures: shown,
          contact: CONTACT,
        }),
      );
    }

    return send(res, 404, errorPage("Not found", "There is nothing at this address."));
  } catch (e) {
    log.error(`portal unhandled: ${String(e)}`);
    return send(
      res,
      500,
      errorPage(
        "Something went wrong",
        `This is a fault on our side, not a problem with your request. ` +
          `Nothing was issued. Please try again, or contact ${CONTACT}.`,
      ),
    );
  }
});

// Hourly sweep so `status` is a fact rather than a read-time guess.
setInterval(() => {
  const n = expireLapsed(db);
  if (n) log.info(`swept ${n} lapsed grant(s)`);
}, 3_600_000).unref();

server.listen(PORT, HOST, () => {
  log.info(`access portal on http://${HOST}:${PORT} (loopback only)`);
});
