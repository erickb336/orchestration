// The hostile fixture's install hook. The capture's install has Docker's network, so this would reach this computer
// through the host gateway; it must never run.
const { networkProbes } = require("./probes");
networkProbes().then((lines) => console.log(lines.join("\n")));
