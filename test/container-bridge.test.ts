// The container bridge forwards six loopback-only services (mailcal 8765, the
// schedule/catalog servers, gc_alumni, the OneCLI credential proxy) onto the
// container bridge gateway. The macOS application firewall admits node on every
// interface, and macOS accepts packets for any of its own addresses on any
// interface, so a host on the campus subnet that routes 192.168.64.0/24 via
// this Mac could reach those ports. The bridge therefore admits only peers on
// the gateway's own subnet or this host's own addresses (2026-09-26).
import assert from "node:assert/strict";
import test from "node:test";

import { peerAllowed } from "../scripts/container-bridge.mjs";

const GW = "192.168.64.1";
const IFACES = {
  lo0: [{ family: "IPv4", address: "127.0.0.1", netmask: "255.0.0.0" }],
  en0: [
    { family: "IPv4", address: "130.127.162.67", netmask: "255.255.255.0" },
  ],
  bridge103: [{ family: "IPv4", address: GW, netmask: "255.255.255.0" }],
};

test("a container on the bridge subnet is admitted", () => {
  assert.equal(peerAllowed("192.168.64.79", GW, IFACES), true);
});

test("an IPv4-mapped IPv6 container address is admitted", () => {
  assert.equal(peerAllowed("::ffff:192.168.64.80", GW, IFACES), true);
});

test("a campus host routing to the gateway is refused", () => {
  assert.equal(peerAllowed("130.127.162.99", GW, IFACES), false);
});

test("this host's own addresses are admitted (host-local clients, e.g. OrbStack NAT)", () => {
  assert.equal(peerAllowed("130.127.162.67", GW, IFACES), true);
  assert.equal(peerAllowed("127.0.0.1", GW, IFACES), true);
});

test("an adjacent private subnet is refused", () => {
  assert.equal(peerAllowed("192.168.65.5", GW, IFACES), false);
});

test("if the gateway's interface is gone, only host addresses are admitted", () => {
  const { bridge103: _gone, ...rest } = IFACES;
  assert.equal(peerAllowed("192.168.64.79", GW, rest), false);
  assert.equal(peerAllowed("127.0.0.1", GW, rest), true);
});

test("a missing or non-IPv4 peer is refused", () => {
  assert.equal(peerAllowed(undefined, GW, IFACES), false);
  assert.equal(peerAllowed("fe80::1", GW, IFACES), false);
});
