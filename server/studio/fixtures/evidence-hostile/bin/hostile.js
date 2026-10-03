#!/usr/bin/env node
// The hostile fixture's CLI: it tries the network, this computer, its files and its terminals, and prints what
// happened, one line each. "REACHED" means a way out worked.
const fs = require("node:fs");
const { networkProbes } = require("../probes");

const tryRead = (p) => {
  try {
    fs.readdirSync(p);
    return `read ${p} REACHED`;
  } catch (e) {
    return `read ${p} ${e.code}`;
  }
};
const tryWrite = (p) => {
  try {
    fs.writeFileSync(p, "x");
    return `write ${p} REACHED`;
  } catch (e) {
    return `write ${p} ${e.code}`;
  }
};

(async () => {
  for (const line of await networkProbes()) console.log(line);
  for (const line of [tryRead("/Users"), tryRead("/var/run/docker.sock"), tryWrite("/etc/hostile"), tryWrite("/usr/local/bin/hostile")]) console.log(line);
  const ttys = fs.readdirSync("/dev").filter((d) => d.startsWith("ttys"));
  console.log(`host terminals ${ttys.length ? `REACHED ${ttys.join(",")}` : "none"}`);
  console.log("probes done");
})();
