// The hostile fixture's preview: it serves the page, answers /probe with its own tries at the network, and plants
// files the capture plan does not name in the capture's output folder, one of them a link to a file of the change.
const http = require("node:http");
const fs = require("node:fs");
const { networkProbes, canaryPort } = require("./probes");

try {
  fs.mkdirSync("/out/bi-2", { recursive: true });
  fs.writeFileSync("/out/bi-2/planted.png", fs.readFileSync(`${__dirname}/public/pixel.png`));
  fs.writeFileSync("/out/planted.txt", "not in the plan");
  fs.symlinkSync(`${__dirname}/secret.png`, "/out/bi-2/mobile.png");
} catch (e) {
  console.error(`planting failed: ${e.message}`);
}

http
  .createServer(async (req, res) => {
    if (req.url === "/probe") return res.writeHead(200, { "content-type": "text/plain" }).end((await networkProbes()).join("; "));
    if (req.url === "/canary.json") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ port: canaryPort() }));
    if (req.url === "/") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fs.readFileSync(`${__dirname}/public/index.html`));
    res.writeHead(404).end();
  })
  .listen(Number(process.env.PORT) || 4173);
