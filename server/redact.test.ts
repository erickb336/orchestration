// ORC-013 step 2 review (L4): the token shapes redaction masks, and a PEM block cut off by an output cap.

import { describe, expect, it } from "vitest";
import { redact } from "./redact";

describe("redact (L4)", () => {
  it("masks npm, AWS, GitLab, Slack and Stripe token shapes, next to the ones it already knew", () => {
    const cases: [string, string][] = [
      [`token npm_${"a1B2".repeat(9)} end`, "token *** end"],
      ["key AKIAIOSFODNN7EXAMPLE end", "key *** end"],
      ["key ASIAIOSFODNN7EXAMPLE end", "key *** end"],
      ["gitlab glp" + "at-xxxxxxxxxxxxxxxxxxxx end", "gitlab *** end"],
      ["slack xox" + "b-1234567890-abcdefghij end", "slack *** end"],
      ["slack xox" + "p-1234567890-abcdefghij end", "slack *** end"],
      ["stripe sk_" + "live_4eC39HqLyjWDarjtT1zdp7dc end", "stripe *** end"],
      ["stripe sk_" + "test_4eC39HqLyjWDarjtT1zdp7dc end", "stripe *** end"],
      ["github ghp_abcdefghijklmnopqrstuvwxyz0123456789 end", "github *** end"],
      ["openai sk-abcdefghijklmnop end", "openai *** end"],
    ];
    for (const [text, masked] of cases) expect(redact(text, {}), text).toBe(masked);
    // Short or differently shaped values are not tokens.
    expect(redact("npm_short AKIA123 glpat-abc xoxb-1 sk_live_ab", {})).toBe("npm_short AKIA123 glpat-abc xoxb-1 sk_live_ab");
  });

  it("a PEM block with no END line (cut off by the output cap) is masked from BEGIN to the end of the text", () => {
    const whole = "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\nafter";
    expect(redact(whole, {})).toBe("before\n***\nafter");
    const cut = "before\n-----BEGIN PRIVATE KEY-----\nMIIE...\nmore lines";
    expect(redact(cut, {})).toBe("before\n***");
    // A public key or a certificate is not a private key.
    expect(redact("-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----", {})).toContain("BEGIN CERTIFICATE");
  });
});
