// The hostile fixture (server/environment/environment.docker.test.ts). As the project's own install script (the prepare
// phase) and as its test (the run phase), it tries to reach what an environment must never reach: a host that is not a
// registry, this computer's loopback (where the canary listens), the Docker host and its gateway, and names outside.
// It prints one line, HOSTILE {...}, of what happened, and always exits 0: the test judges, not this script. As the
// install script it also plants a test report full of passes, which the service must not read.
//
// Unit E2 (server/studio/evidence.container.test.ts): as the preview ("preview") it tries the same, and Lima's name
// for this computer, then serves a page whose own script tries to leave the capture's browser; both report as
// console errors, which come back as the screen's warnings. As the CLI in a recording ("cli") it prints its line.
const net = require("node:net");
const dns = require("node:dns");
const fs = require("node:fs");

const { canary } = JSON.parse(fs.readFileSync("canary.json", "utf8"));
const phase = process.argv[2] ?? "prepare";
const FAKE_REPORT = '<testsuites><testsuite name="planted" tests="50"><testcase name="planted pass" classname="planted"/></testsuite></testsuites>';
if (phase === "prepare") {
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/junit.xml", FAKE_REPORT);
}

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

/** The page the preview serves: its script tries each way out of the browser, and reports with the server's own line. */
const PAGE = (server) => `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Hostile page</title></head>
  <body style="font: 20px system-ui, sans-serif; padding: 32px">
    <h1>Hostile page</h1>
    <p id="out">probing…</p>
    <script>
      const port = ${canary};
      const tryFetch = (url) => fetch(url, { mode: "no-cors" }).then(() => url + " REACHED", () => url + " blocked");
      const stun = () => new Promise((done) => {
        try {
          const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
          const found = [];
          pc.onicecandidate = (e) => { if (e.candidate) found.push(e.candidate.type); else done("webrtc " + (found.includes("srflx") ? "REACHED" : "no srflx")); };
          pc.createDataChannel("x");
          pc.createOffer().then((o) => pc.setLocalDescription(o));
          setTimeout(() => done("webrtc no srflx (timeout)"), 3000);
        } catch (e) { done("webrtc " + e.message); }
      });
      (async () => {
        const results = await Promise.all([tryFetch("http://1.1.1.1/"), tryFetch("http://192.168.5.2:" + port + "/"), tryFetch("http://host.lima.internal:" + port + "/"), tryFetch("http://host.docker.internal:" + port + "/"), tryFetch("http://127.0.0.1:" + port + "/"), stun()]);
        document.getElementById("out").textContent = results.join("; ");
        console.error("PROBES " + results.join("; "));
        console.error("HOSTILE " + ${JSON.stringify(JSON.stringify(server))});
      })();
    </script>
  </body>
</html>`;

(async () => {
  const r = { phase };
  if (phase === "prepare" || phase === "run") {
    Object.assign(r, {
      proxyNotRegistry: await via("example.com:443"),
      proxyLoopback: await via(`127.0.0.1:${canary}`),
      proxyLocalhost: await via(`localhost:${canary}`),
      proxyHostGateway: await via(`host.docker.internal:${canary}`),
      proxyHostAddress: await via(`192.168.5.2:${canary}`),
      proxyRegistryPlainPort: await via("registry.npmjs.org:80"),
    });
  }
  Object.assign(r, {
    directOutside: await tcp("1.1.1.1", 443),
    directHostAddress: await tcp("192.168.5.2", canary),
    directDockerBridge: await tcp("172.17.0.1", canary),
    directHostGateway: await tcp("host.docker.internal", canary),
    dnsOutside: await lookup("example.com"),
  });
  if (phase === "preview" || phase === "cli") {
    Object.assign(r, { directLima: await tcp("host.lima.internal", canary), ownLoopback: await tcp("127.0.0.1", canary), terminal: process.stdout.isTTY ? "a terminal" : "no terminal" });
  }
  console.log(`HOSTILE ${JSON.stringify(r)}`);
  if (phase === "preview") {
    require("node:http")
      .createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE(r));
      })
      .listen(Number(process.env.PORT));
  }
})();
