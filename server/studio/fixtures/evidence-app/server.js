const http = require("node:http"), fs = require("node:fs");
http.createServer((req, res) => (req.url === "/" ? res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fs.readFileSync(`${__dirname}/public/index.html`)) : res.writeHead(404).end("not found"))).listen(Number(process.env.PORT) || 4173);
