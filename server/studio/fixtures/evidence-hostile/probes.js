// The hostile fixture's probes, shared by its install hook, its preview server and its CLI: each tries a way out of
// the capture's container and reports what happened. "REACHED" means a way out worked.
const net = require("node:net");
const dns = require("node:dns");
const fs = require("node:fs");

const canaryPort = () => {
  try {
    return JSON.parse(fs.readFileSync(`${__dirname}/canary.json`, "utf8")).port;
  } catch {
    return 9;
  }
};

const tcp = (host, port) =>
  new Promise((done) => {
    const s = net.connect(port, host);
    const t = setTimeout(() => {
      s.destroy();
      done(`${host}:${port} timeout`);
    }, 3000);
    s.on("connect", () => {
      clearTimeout(t);
      s.destroy();
      done(`${host}:${port} REACHED`);
    });
    s.on("error", (e) => {
      clearTimeout(t);
      done(`${host}:${port} ${e.code || "error"}`);
    });
  });

const lookup = (name) => new Promise((done) => dns.lookup(name, (e, a) => done(e ? `dns ${name} ${e.code}` : `dns ${name} REACHED ${a}`)));

/** Every network probe: the internet, a name lookup, and this computer through each name Colima and Docker give it. */
async function networkProbes() {
  const port = canaryPort();
  return Promise.all([tcp("1.1.1.1", 443), lookup("example.com"), tcp("192.168.5.2", port), tcp("host.lima.internal", port), tcp("host.docker.internal", port)]);
}

module.exports = { networkProbes, canaryPort };
