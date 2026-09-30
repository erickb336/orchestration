// Entry point: check the Node version before loading anything that needs node:sqlite.

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Orchestration needs Node.js 22.13 or newer (for the built-in node:sqlite). You have ${process.versions.node}.`);
  process.exit(1);
}

await import("./app");

export {};
