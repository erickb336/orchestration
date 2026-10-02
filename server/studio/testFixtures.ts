// Test helpers for the prototype server and screenshots: artifact version folders in the shape the studio service
// (3a) writes, <studioDir>/artifacts/<artifactId>/v<n>/ with the files and a manifest.json, and a request helper that
// sets the Host header (fetch cannot).

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { versionDir, type PrototypeManifest } from "./serve";

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Writes the files and a manifest listing each with its hash; returns the version folder. */
export function writeVersion(
  studioDir: string,
  artifactId: string,
  version: number,
  files: Record<string, string | Buffer>,
  meta: Partial<Pick<PrototypeManifest, "devices" | "variants" | "kind" | "title">> = {},
): string {
  const dir = versionDir(studioDir, artifactId, version);
  const listed: PrototypeManifest["files"] = [];
  for (const [path, content] of Object.entries(files)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), buf);
    listed.push({ path, sha256: sha256(buf), bytes: buf.length });
  }
  const manifest: PrototypeManifest = {
    artifactId,
    version,
    kind: meta.kind ?? "screen",
    title: meta.title ?? `Artifact ${artifactId}`,
    devices: meta.devices ?? ["desktop", "mobile"],
    variants: meta.variants ?? [{ id: "a", label: "A", entry: "a/index.html" }],
    files: listed,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

export async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

export async function close(server: Server | undefined): Promise<void> {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}

export interface Got {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** One request to 127.0.0.1:<port> with the given Host header and a raw path (sent as is, not normalised). */
export function get(port: number, host: string, path: string, method = "GET"): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** A valid 1×1 transparent PNG. */
export const TINY_PNG = (() => {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(5))), chunk("IEND", Buffer.alloc(0))]);
})();

/** A PNG's pixel size, from its header. */
export const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
