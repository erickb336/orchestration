// The preview: serves public/ on $PORT (4173 when it is not set). Nothing outside public/ is served.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, sep } from "node:path";

const root = join(import.meta.dirname, "public");
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const file = join(root, path.endsWith("/") ? `${path}index.html` : path);
  if (!file.startsWith(root + sep)) return res.writeHead(404).end("not found");
  try {
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(await readFile(file));
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(Number(process.env.PORT) || 4173);
