// Written by scripts/media/demo-shots.mjs: the size and SHA-256 of each simulated "built" screenshot in
// server/demo-shots/, which the demo's captures of evidence name (src/domain/demo.ts). Do not edit by hand.

export const DEMO_BUILT_SHOTS: Readonly<Record<string, { bytes: number; sha256: string }>> = {
  "trip-page-built-desktop.png": {
    "bytes": 22751,
    "sha256": "32b97f516eeea4c57c89de41522fea03d9de401d4807bee842c735a4082aaa1b"
  },
  "trip-page-built-mobile.png": {
    "bytes": 47025,
    "sha256": "fd786df4576a77a375c1dcddaa1d7869c00cf81496826f2c87069a4e73de355c"
  },
  "packing-list-built-desktop.png": {
    "bytes": 19818,
    "sha256": "ebe94ff91eac62e46e25fc580a9b3a331fd7f8b865c1a7d7f37eed29f07f2373"
  },
  "packing-list-built-mobile.png": {
    "bytes": 40320,
    "sha256": "2d7d111699729741a90790d2f7a22c59fe116f657564040c228039640035cdbc"
  }
};
