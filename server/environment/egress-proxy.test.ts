// The prepare phase's egress proxy (egress-proxy.mjs), run on this computer: what it allows and what it refuses. A
// canary listener on this computer's loopback proves a refused CONNECT never reached it.

import { afterEach, describe, expect, it } from "vitest";
import { connect, createServer, type Server, type Socket } from "node:net";
import { decide, isPublicAddress, startProxy, type ProxyLine } from "./egress-proxy.mjs";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

const listen = (s: Server) =>
  new Promise<number>((res) => {
    servers.push(s);
    if (s.listening) return res((s.address() as { port: number }).port);
    s.once("listening", () => res((s.address() as { port: number }).port));
  });

/** Send a request head to the proxy and read its status line; the socket stays open for a tunnel. */
function ask(port: number, head: string): Promise<{ status: string; socket: Socket; body: string }> {
  return new Promise((res, rej) => {
    const socket = connect(port, "127.0.0.1");
    let buf = "";
    socket.on("error", rej);
    socket.on("data", function onData(d) {
      buf += d.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      const status = buf.slice(0, buf.indexOf("\r\n"));
      if (status.includes(" 200 ")) return res({ status, socket, body: "" });
      socket.on("data", (x) => (buf += x.toString("latin1")));
      socket.on("close", () => res({ status, socket, body: buf.slice(end + 4) }));
    });
    socket.write(head);
  });
}

describe("the decision", () => {
  const cfg = { hosts: ["registry.npmjs.org", "pypi.org"] };
  it("allows a listed host on port 443 only", () => {
    expect(decide("registry.npmjs.org:443", cfg)).toEqual({ allowed: true, host: "registry.npmjs.org", port: 443 });
    expect(decide("PyPI.org.:443", cfg)).toMatchObject({ allowed: true, host: "pypi.org" });
    expect(decide("registry.npmjs.org:80", cfg)).toMatchObject({ allowed: false, reason: expect.stringMatching(/port 80/) });
  });
  it("refuses a host that is not listed", () => {
    expect(decide("example.com:443", cfg)).toMatchObject({ allowed: false, reason: "not on the list of registries" });
    expect(decide("registry.npmjs.org.evil.example:443", cfg)).toMatchObject({ allowed: false });
  });
  it("refuses every form of IP address before any lookup", () => {
    for (const t of ["1.1.1.1:443", "127.0.0.1:443", "[::1]:443", "[2606:4700::1111]:443", "2130706433:443", "0x7f000001:443", "0177.0.0.1:443"]) {
      expect(decide(t, { hosts: [...cfg.hosts, "2130706433", "127.0.0.1"] }), t).toMatchObject({ allowed: false, reason: expect.stringMatching(/IP address/) });
    }
  });
  it("judges resolved addresses: only the public internet", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.17.0.1", "192.168.5.2", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "::ffff:127.0.0.1", "fe80::1", "fd00::1"]) expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ["1.1.1.1", "104.16.0.1", "2606:4700::1111", "::ffff:1.1.1.1"]) expect(isPublicAddress(ip), ip).toBe(true);
  });
  it("judges every IPv6 form that carries a local, private or reserved address as private (review finding 12)", () => {
    const local = [
      // IPv4-compatible (::/96), dotted and in hex
      "::127.0.0.1", "::7f00:1", "::192.168.5.2", "::c0a8:502", "::a00:1",
      // IPv4-mapped, in hex as well as dotted
      "::ffff:7f00:1", "::ffff:c0a8:502", "::FFFF:127.0.0.1",
      // SIIT, RFC 6145 (::ffff:0:0:0/96)
      "::ffff:0:7f00:1", "::ffff:0:c0a8:502", "::ffff:0:1.1.1.1",
      // 6to4 (2002::/16): of 192.168.5.2, of 127.0.0.1, and of a public address (a relay to anything)
      "2002:c0a8:502::1", "2002:7f00:1::1", "2002:101:101::1",
      // Teredo (2001::/32)
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      // deprecated site-local (fec0::/10)
      "fec0::1", "feff::1",
      // NAT64 (64:ff9b::/96, 64:ff9b:1::/48) that embeds a private or local IPv4
      "64:ff9b::a00:1", "64:ff9b::127.0.0.1", "64:ff9b::c0a8:502", "64:ff9b:1::a00:1",
      // discard, documentation, ORCHID, multicast, unique local, link local, with a zone
      "100::1", "2001:db8::1", "2001:10::1", "ff02::1", "fc00::1", "fe80::1%eth0",
    ];
    for (const ip of local) expect(isPublicAddress(ip), ip).toBe(false);
    // NAT64 of a public IPv4 is how an IPv6-only network reaches a registry: allowed.
    for (const ip of ["64:ff9b::808:808", "64:ff9b::1.1.1.1", "2a03:2880:f12f:83:face:b00c:0:25de"]) expect(isPublicAddress(ip), ip).toBe(true);
  });
});

describe("the proxy on this computer", () => {
  it("tunnels to a listed host's checked address, without touching the bytes", async () => {
    const upstream = createServer((c) => c.pipe(c)); // an echo stands in for a registry
    const upPort = await listen(upstream.listen(0, "127.0.0.1"));
    const lines: ProxyLine[] = [];
    // Only here: the stand-in's name resolves to this computer, and the test allows that address.
    const proxy = startProxy({ hosts: ["registry.example"], ports: [upPort], listen: "127.0.0.1", port: 0, log: (l) => lines.push(l), resolve: async () => ["127.0.0.1"], allowAddress: () => true });
    const port = await listen(proxy);
    const { status, socket } = await ask(port, `CONNECT registry.example:${upPort} HTTP/1.1\r\nHost: registry.example:${upPort}\r\n\r\n`);
    expect(status).toBe("HTTP/1.1 200 Connection Established");
    const echoed = await new Promise<string>((res) => {
      socket.once("data", (d) => res(d.toString("latin1")));
      socket.write("\x16\x03\x01 tls bytes");
    });
    expect(echoed).toBe("\x16\x03\x01 tls bytes");
    socket.destroy();
    expect(lines).toEqual([{ orchestratorProxy: 1, host: "registry.example", port: upPort, allowed: true }]);
  });

  it("refuses an unlisted host, an IP address, plain HTTP and a listed name that resolves to this computer; the canary sees nothing", async () => {
    let hits = 0;
    const canary = createServer((c) => {
      hits++;
      c.destroy();
    });
    const canaryPort = await listen(canary.listen(0, "127.0.0.1"));
    const lines: ProxyLine[] = [];
    // The production defaults (DNS, public addresses only). "localhost" is listed here only to show the address rule.
    const proxy = startProxy({ hosts: ["localhost", "registry.npmjs.org"], ports: [443, canaryPort], listen: "127.0.0.1", port: 0, log: (l) => lines.push(l) });
    const port = await listen(proxy);
    const tries = [
      `CONNECT example.com:443 HTTP/1.1\r\n\r\n`,
      `CONNECT 127.0.0.1:${canaryPort} HTTP/1.1\r\n\r\n`,
      `CONNECT [::1]:${canaryPort} HTTP/1.1\r\n\r\n`,
      `CONNECT localhost:${canaryPort} HTTP/1.1\r\n\r\n`,
      `GET http://registry.npmjs.org/ HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n`,
    ];
    const answers = [];
    for (const t of tries) answers.push(await ask(port, t));
    expect(answers.map((a) => a.status.split(" ")[1])).toEqual(["403", "403", "403", "403", "405"]);
    expect(answers[0].body).toMatch(/example\.com: not on the list of registries/);
    expect(lines.map((l) => [l.host, l.allowed, l.reason])).toEqual([
      ["example.com", false, "not on the list of registries"],
      ["127.0.0.1", false, "an IP address: the proxy allows host names only"],
      ["[::1]", false, "an IP address: the proxy allows host names only"],
      ["localhost", false, expect.stringMatching(/^resolves to a local or private address \((127\.0\.0\.1|::1)/)],
      ["registry.npmjs.org", false, "GET: only HTTPS through CONNECT is allowed"],
    ]);
    expect(hits).toBe(0);
  });
});
