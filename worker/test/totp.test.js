// @ts-check
// Authenticator codes (RFC 6238), checked against the RFC's own test values.
import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, newTotpSecret, otpauthUri, totpCode, totpStep, verifyTotp } from "../src/totp.js";

// RFC 6238 appendix B: the SHA-1 secret is the ASCII text "12345678901234567890".
const RFC_SECRET = new Uint8Array(new TextEncoder().encode("12345678901234567890"));
const RFC_SECRET_B32 = base32Encode(RFC_SECRET);

describe("base32", () => {
  it("matches RFC 4648 examples and round-trips", () => {
    expect(base32Encode(new TextEncoder().encode("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("mzxw 6ytb oi==")).toEqual(new TextEncoder().encode("foobar"));
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(secret) ?? new Uint8Array())).toBe(secret);
  });

  it("refuses non-base32 text", () => {
    expect(base32Decode("not base32!")).toBeNull();
    expect(base32Decode("")).toBeNull();
  });
});

describe("TOTP", () => {
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("gives the RFC 6238 code at T=%i", async (time, code) => {
    expect(await totpCode(RFC_SECRET, totpStep(time))).toBe(code);
  });

  it("accepts the current code and one step of drift either way", async () => {
    const now = 1_800_000_000;
    for (const step of [totpStep(now) - 1, totpStep(now), totpStep(now) + 1]) {
      const code = await totpCode(RFC_SECRET, step);
      expect(await verifyTotp(RFC_SECRET_B32, code, now, 0)).toBe(step);
    }
    const old = await totpCode(RFC_SECRET, totpStep(now) - 2);
    expect(await verifyTotp(RFC_SECRET_B32, old, now, 0)).toBeNull();
  });

  it("refuses a code that was already used", async () => {
    const now = 1_800_000_000;
    const code = await totpCode(RFC_SECRET, totpStep(now));
    expect(await verifyTotp(RFC_SECRET_B32, code, now, totpStep(now))).toBeNull();
  });

  it("refuses badly formed codes", async () => {
    expect(await verifyTotp(RFC_SECRET_B32, "12345", 1_800_000_000, 0)).toBeNull();
    expect(await verifyTotp(RFC_SECRET_B32, "abcdef", 1_800_000_000, 0)).toBeNull();
  });

  it("builds an otpauth:// link for authenticator apps", () => {
    const uri = otpauthUri("JBSWY3DPEHPK3PXP", "admin", "Club Bookings");
    expect(uri).toBe(
      "otpauth://totp/Club%20Bookings:admin?secret=JBSWY3DPEHPK3PXP&issuer=Club+Bookings&algorithm=SHA1&digits=6&period=30",
    );
  });
});
