// The Node fixture's tiny page (unit E2): the preview serves it on PORT, on the container's loopback only, with "ms",
// the dependency the prepare phase installed. Without the dependency it would not start.
const http = require("node:http");
const ms = require("ms");

const page = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Node fixture</title></head>
  <body style="font: 28px system-ui, sans-serif; padding: 48px; background: #f4f1ea; color: #1d1b16">
    <h1>Node fixture</h1>
    <p>Two days is <strong>${ms("2 days")}</strong> ms, said ms ${require("ms/package.json").version}.</p>
  </body>
</html>`;

http
  .createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log(`serving on 127.0.0.1:${process.env.PORT}`));
