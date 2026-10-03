// The hostile fixture (server/environment/environment.docker.test.ts). As the project's own install script (the prepare
// phase) and as its test (the run phase), it tries to reach what an environment must never reach: a host that is not a
// registry, this computer's loopback (where the canary listens), the Docker host and its gateway, and names outside.
// It prints one line, HOSTILE {...}, of what happened, and always exits 0: the test judges, not this script.
const net = require("node:net");
const dns = require("node:dns");
const fs = require("node:fs");

const { canary } = JSON.parse(fs.readFileSync("canary.json", "utf8"));
const phase = process.argv[2] ?? "prepare";

const tcp = (host, port) =>
  new Promise((done) => {
    const s = net.connect(port, host);
    const t = setTimeout(() => {
      s.destroy();
      done("TIMEOUT");
    }, 3000);
    s.on("connect", () => {
      clearTimeout(t);
      s.destroy();
      done("CONNECTED");
    });
    s.on("error", (e) => {
      clearTimeout(t);
      done(e.code || "ERROR");
    });
  });

/** A CONNECT through the proxy the environment gives (HTTPS_PROXY): its status line. */
const via = (target) =>
  new Promise((done) => {
    if (!process.env.HTTPS_PROXY) return done("NO PROXY");
    const proxy = new URL(process.env.HTTPS_PROXY);
    const s = net.connect(Number(proxy.port), proxy.hostname);
    let buf = "";
    const t = setTimeout(() => {
      s.destroy();
      done("TIMEOUT");
    }, 8000);
    s.on("connect", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\r\n");
      if (i < 0) return;
      clearTimeout(t);
      s.destroy();
      done(buf.slice(0, i));
    });
    s.on("error", (e) => {
      clearTimeout(t);
      done(e.code || "ERROR");
    });
  });

const lookup = (name) => new Promise((done) => dns.lookup(name, (e, a) => done(e ? e.code : `RESOLVED ${a}`)));

(async () => {
  const r = {
    phase,
    proxyNotRegistry: await via("example.com:443"),
    proxyLoopback: await via(`127.0.0.1:${canary}`),
    proxyLocalhost: await via(`localhost:${canary}`),
    proxyHostGateway: await via(`host.docker.internal:${canary}`),
    proxyHostAddress: await via(`192.168.5.2:${canary}`),
    proxyRegistryPlainPort: await via("registry.npmjs.org:80"),
    directOutside: await tcp("1.1.1.1", 443),
    directHostAddress: await tcp("192.168.5.2", canary),
    directDockerBridge: await tcp("172.17.0.1", canary),
    directHostGateway: await tcp("host.docker.internal", canary),
    dnsOutside: await lookup("example.com"),
  };
  console.log(`HOSTILE ${JSON.stringify(r)}`);
})();
