// The egress proxy of the prepare phase (docs/design/project-environment.md). The prepare container's only way out:
// it sits on the same private Docker network, with HTTPS_PROXY pointing here, and this proxy alone also has a route
// out. It allows HTTPS by host name only:
//
//   - CONNECT host:443 and nothing else: plain HTTP, other methods and other ports are refused;
//   - the host must be on the list (the registries, and the hosts the owner added), compared exactly;
//   - an IP address is never a host, so a literal address is refused before any lookup;
//   - the name is resolved here, every address must be public, and the tunnel goes to the address that was checked,
//     so a name that resolves to this computer, its loopback, the Docker host or a private network is refused;
//   - no TLS interception: the bytes of the tunnel are passed through as they are.
//
// Self-contained (Node's standard library only), so the service runs this same file in a container with
// `node --input-type=module --eval <this file>` and the tests run it on the host. Every decision is one JSON line on
// stdout: {"orchestratorProxy":1,"host":…,"port":…,"allowed":…,"reason":…}.

import { BlockList, createServer, connect, isIP } from "node:net";
import { lookup } from "node:dns/promises";

/** Addresses that are not the public internet: this computer, private networks, the Docker host, and reserved ranges. */
// Two lists: one BlockList also matches IPv4 addresses against IPv4-mapped IPv6 rules (::ffff:0:0/96), so keep them apart.
const LOCAL4 = new BlockList();
const LOCAL6 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
])
  LOCAL4.addSubnet(net, bits, "ipv4");
// IPv6 ranges that are never a registry's address. The forms that carry an IPv4 address are refused whole (IPv4-
// compatible ::/96, SIIT ::ffff:0:0:0/96, 6to4 2002::/16, Teredo inside 2001::/23, local-use NAT64 64:ff9b:1::/48),
// except two, judged by the IPv4 address they carry: IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96).
for (const [net, bits] of [
  ["::", 96], ["::ffff:0:0:0", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["5f00::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
])
  LOCAL6.addSubnet(net, bits, "ipv6");

/** An IPv6 address as its eight 16-bit words, from any form (a zone, a dotted IPv4 tail); undefined when it is not IPv6. */
function words6(ip) {
  const s = String(ip).replace(/%.*$/, "");
  if (isIP(s) !== 6) return undefined;
  let text = s;
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const o = dotted.slice(2).map(Number);
    text = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const gap = text.indexOf("::");
  const part = (t) => (t ? t.split(":") : []);
  const head = gap < 0 ? part(text) : part(text.slice(0, gap));
  const tail = gap < 0 ? [] : part(text.slice(gap + 2));
  return [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail].map((x) => parseInt(x, 16));
}

/**
 * Is this resolved address on the public internet? Every textual form of IPv6 is read into its words first, so an
 * IPv4 address inside IPv6 is judged as that IPv4 address (mapped, NAT64) or refused with its whole range.
 */
export function isPublicAddress(ip) {
  if (isIP(String(ip)) === 4) return !LOCAL4.check(String(ip), "ipv4");
  const w = words6(ip);
  if (!w) return false;
  const v4 = () => `${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`;
  const zeros = (from, to) => w.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && w[5] === 0xffff) return isPublicAddress(v4());
  if (w[0] === 0x64 && w[1] === 0xff9b && zeros(2, 6)) return isPublicAddress(v4());
  return !LOCAL6.check(w.map((x) => x.toString(16)).join(":"), "ipv6");
}

const looksLikeAddress = (h) => isIP(h) !== 0 || /^[0-9.]+$/.test(h) || /^0x[0-9a-f.x]*$/i.test(h) || h.startsWith("[");

/**
 * The decision for a CONNECT target ("host:port"), before any lookup: allowed with the host and port, or refused with
 * the reason. `cfg.hosts`: the allowed host names; `cfg.ports`: the allowed ports (443).
 */
export function decide(target, cfg) {
  const t = String(target ?? "");
  if (t.startsWith("[")) return { allowed: false, host: t.slice(0, t.indexOf("]") + 1 || 255), reason: "an IP address: the proxy allows host names only" };
  const i = t.lastIndexOf(":");
  const host = (i < 0 ? t : t.slice(0, i)).toLowerCase().replace(/\.$/, "").slice(0, 255);
  const portText = i < 0 ? "" : t.slice(i + 1);
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
  if (!host) return { allowed: false, host, reason: "no host" };
  if (looksLikeAddress(host)) return { allowed: false, host, port, reason: "an IP address: the proxy allows host names only" };
  if (!(cfg.ports ?? [443]).includes(port)) return { allowed: false, host, port, reason: `port ${portText || "(none)"}: only ${(cfg.ports ?? [443]).join(", ")} is allowed` };
  if (!cfg.hosts.includes(host)) return { allowed: false, host, port, reason: "not on the list of registries" };
  return { allowed: true, host, port };
}

const HEAD_LIMIT = 8 * 1024;
const HEAD_TIMEOUT_MS = 10_000;
const IDLE_MS = 5 * 60_000;
const MAX_CONNECTIONS = 128;

/**
 * Start the proxy. `cfg`: { hosts, ports?, port?, listen?, log?, resolve?, allowAddress? } — `resolve` and
 * `allowAddress` exist for tests only (a local stand-in for a registry); the defaults are DNS and isPublicAddress.
 */
export function startProxy(cfg) {
  const log = cfg.log ?? ((line) => process.stdout.write(`${JSON.stringify(line)}\n`));
  const resolve = cfg.resolve ?? (async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address));
  const allowAddress = cfg.allowAddress ?? isPublicAddress;
  const say = (d) => log({ orchestratorProxy: 1, host: d.host ?? "", port: Number.isFinite(d.port) ? d.port : null, allowed: !!d.allowed, ...(d.reason ? { reason: d.reason } : {}) });
  let open = 0;
  const server = createServer((client) => {
    if (open >= MAX_CONNECTIONS) return void client.destroy();
    open++;
    client.once("close", () => open--);
    client.on("error", () => client.destroy());
    client.setTimeout(HEAD_TIMEOUT_MS, () => client.destroy());
    let head = Buffer.alloc(0);
    const refuse = (status, d) => {
      say({ ...d, allowed: false });
      client.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nRefused by the prepare phase's proxy: ${d.host || "(no host)"}: ${d.reason}\r\n`);
    };
    const onData = async (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > HEAD_LIMIT) client.destroy();
        return;
      }
      client.off("data", onData);
      client.pause();
      const rest = head.subarray(end + 4);
      const [method, target] = head.subarray(0, end).toString("latin1").split("\r\n")[0].split(" ");
      if (method !== "CONNECT") {
        let host = "";
        try {
          host = new URL(target).hostname;
        } catch {
          /* not an absolute URL */
        }
        return refuse("405 Method Not Allowed", { host, reason: `${String(method).slice(0, 16)}: only HTTPS through CONNECT is allowed` });
      }
      const d = decide(target, cfg);
      if (!d.allowed) return refuse("403 Forbidden", d);
      let addresses;
      try {
        addresses = await resolve(d.host);
      } catch (e) {
        return refuse("502 Bad Gateway", { ...d, reason: `the name did not resolve (${e?.code ?? "error"})` });
      }
      const local = addresses.filter((a) => !allowAddress(a));
      if (!addresses.length || local.length) return refuse("403 Forbidden", { ...d, reason: `resolves to a local or private address (${local.join(", ") || "none"})` });
      const upstream = connect({ host: addresses[0], port: d.port });
      let connected = false;
      upstream.setTimeout(HEAD_TIMEOUT_MS, () => upstream.destroy(new Error("timeout")));
      upstream.on("error", (e) => {
        if (connected) return void client.destroy();
        connected = true; // one answer only
        refuse("502 Bad Gateway", { ...d, reason: `could not connect (${e?.code ?? e?.message ?? "error"})` });
      });
      upstream.once("connect", () => {
        connected = true;
        say(d);
        upstream.setTimeout(IDLE_MS, () => upstream.destroy());
        client.setTimeout(IDLE_MS, () => client.destroy());
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
        client.once("close", () => upstream.destroy());
        upstream.once("close", () => client.destroy());
      });
    };
    client.on("data", onData);
  });
  server.listen(cfg.port ?? 3128, cfg.listen ?? "0.0.0.0", () => cfg.onListening?.(server.address()));
  return server;
}

if (process.env.ORC_PROXY_CONFIG) {
  const cfg = JSON.parse(process.env.ORC_PROXY_CONFIG);
  startProxy({ hosts: cfg.hosts, ports: cfg.ports, port: cfg.port, onListening: (a) => process.stdout.write(`${JSON.stringify({ orchestratorProxy: 1, listening: a.port })}\n`) });
}
