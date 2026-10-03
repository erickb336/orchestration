#!/usr/bin/env node
// The trips CLI of the evidence fixture: lists the trips on the board.
const trips = [
  ["Lake weekend", 4, "12-14 June"],
  ["City break", 3, "3-5 July"],
  ["Coast walk", 5, "21-23 August"],
];
// The package's preinstall hook writes this file; the capture's install must never run it.
if (require("node:fs").existsSync("INSTALL-HOOK-RAN")) console.log("INSTALL HOOK RAN");
if (process.argv[2] !== "list") {
  console.log("usage: trips list");
  process.exit(2);
}
for (const [name, going, when] of trips) console.log(`${name.padEnd(14)} ${String(going).padStart(2)} going  ${when}`);
