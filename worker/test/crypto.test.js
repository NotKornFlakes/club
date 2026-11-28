// @ts-check
// PIN hashing with the pepper, secret encryption and IP hashing (docs/architecture.md, section 5).
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEMO_PBKDF2_ITERATIONS,
  PBKDF2_ITERATIONS,
  hashRounds,
  decryptText,
  encryptText,
  hashIp,
  hashSecret,
  ipGroup,
  newPin,
  pepperKeys,
  randomToken,
  sha256Hex,
  textEqual,
  verifyDummy,
  verifySecret,
} from "../src/crypto.js";

const PEPPER = "test-pepper-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_PEPPER = "test-pepper-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const IP_KEY = "test-ip-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const FULL = PBKDF2_ITERATIONS;

describe("PIN hashing", () => {
  it("stores PBKDF2-SHA256 at 100,000 iterations with a 16-byte salt", async () => {
    const stored = await hashSecret("123456", await pepperKeys(PEPPER), FULL);
    const [scheme, iterations, salt, hash] = stored.split("$");
    expect(scheme).toBe("pbkdf2-sha256");
    expect(Number(iterations)).toBe(PBKDF2_ITERATIONS);
    expect(PBKDF2_ITERATIONS).toBe(100_000);
    expect(atob(salt ?? "")).toHaveLength(16);
    expect(atob(hash ?? "")).toHaveLength(32);
  });

  it("verifies the right PIN and refuses a wrong one", async () => {
    const keys = await pepperKeys(PEPPER);
    const stored = await hashSecret("123456", keys, FULL);
    expect(await verifySecret("123456", stored, keys, FULL)).toBe(true);
    expect(await verifySecret("123457", stored, keys, FULL)).toBe(false);
  });

  it("uses a fresh salt each time", async () => {
    const keys = await pepperKeys(PEPPER);
    expect(await hashSecret("123456", keys, FULL)).not.toBe(await hashSecret("123456", keys, FULL));
  });

  it("depends on the pepper: the same hash fails with a different pepper", async () => {
    const stored = await hashSecret("123456", await pepperKeys(PEPPER), FULL);
    expect(await verifySecret("123456", stored, await pepperKeys(OTHER_PEPPER), FULL)).toBe(false);
  });

  it("refuses malformed or over-limit hashes without throwing", async () => {
    const keys = await pepperKeys(PEPPER);
    for (const bad of ["", "x", "md5$1$a$b", "pbkdf2-sha256$100001$AAAA$AAAA", "pbkdf2-sha256$abc$AAAA$AAAA", "pbkdf2-sha256$100000$!!$??"]) {
      expect(await verifySecret("123456", bad, keys, FULL), bad).toBe(false);
    }
  });

  it("has a dummy check for unknown members that always fails", async () => {
    expect(await verifyDummy("123456", await pepperKeys(PEPPER), FULL)).toBe(false);
    expect(await verifyDummy("123456", await pepperKeys(PEPPER), DEMO_PBKDF2_ITERATIONS)).toBe(false);
  });

  it("refuses a missing or short pepper", async () => {
    await expect(pepperKeys(undefined)).rejects.toBeInstanceOf(ConfigError);
    await expect(pepperKeys("short")).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("demo sites (DEMO_MODE)", () => {
  it("uses the light rounds only when DEMO_MODE is exactly \"on\"", () => {
    expect(DEMO_PBKDF2_ITERATIONS).toBe(1_000);
    expect(hashRounds({ DEMO_MODE: "on" })).toBe(DEMO_PBKDF2_ITERATIONS);
    for (const value of [undefined, "", "off", "ON", "true", "1", true, 1]) {
      expect(hashRounds({ DEMO_MODE: value }), String(value)).toBe(PBKDF2_ITERATIONS);
    }
    expect(hashRounds({})).toBe(PBKDF2_ITERATIONS);
  });

  it("records the light rounds in the hash, and checks it with the same rounds", async () => {
    const keys = await pepperKeys(PEPPER);
    const stored = await hashSecret("123456", keys, DEMO_PBKDF2_ITERATIONS);
    expect(stored.split("$")[1]).toBe("1000");
    expect(await verifySecret("123456", stored, keys, DEMO_PBKDF2_ITERATIONS)).toBe(true);
    expect(await verifySecret("123457", stored, keys, DEMO_PBKDF2_ITERATIONS)).toBe(false);
  });

  it("never mixes them: a demo hash fails at full strength, and the other way round", async () => {
    const keys = await pepperKeys(PEPPER);
    const demo = await hashSecret("123456", keys, DEMO_PBKDF2_ITERATIONS);
    const full = await hashSecret("123456", keys, FULL);
    expect(await verifySecret("123456", demo, keys, FULL)).toBe(false);
    expect(await verifySecret("123456", full, keys, DEMO_PBKDF2_ITERATIONS)).toBe(false);
  });

  it("refuses any other number of rounds", async () => {
    const keys = await pepperKeys(PEPPER);
    for (const rounds of [0, 1, 999, 1_001, 99_999, 100_001, Number.NaN]) {
      await expect(hashSecret("123456", keys, rounds), String(rounds)).rejects.toBeInstanceOf(RangeError);
      await expect(verifySecret("123456", "", keys, rounds), String(rounds)).rejects.toBeInstanceOf(RangeError);
    }
  });
});

describe("new PINs", () => {
  it("are 6 digits", () => {
    for (let i = 0; i < 200; i += 1) expect(newPin()).toMatch(/^\d{6}$/);
  });

  it("are spread across all first digits", () => {
    const firstDigits = new Set(Array.from({ length: 300 }, () => newPin()[0]));
    expect(firstDigits.size).toBe(10);
  });
});

describe("secret encryption (authenticator keys)", () => {
  it("round-trips and uses a fresh IV", async () => {
    const keys = await pepperKeys(PEPPER);
    const a = await encryptText("JBSWY3DPEHPK3PXP", keys);
    const b = await encryptText("JBSWY3DPEHPK3PXP", keys);
    expect(a).not.toBe(b);
    expect(a).not.toContain("JBSWY3DPEHPK3PXP");
    expect(await decryptText(a, keys)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("can't be read with a different pepper", async () => {
    const sealed = await encryptText("JBSWY3DPEHPK3PXP", await pepperKeys(PEPPER));
    await expect(decryptText(sealed, await pepperKeys(OTHER_PEPPER))).rejects.toThrow();
  });
});

describe("IP addresses", () => {
  it("groups IPv6 by /64 and leaves IPv4 alone", () => {
    expect(ipGroup("203.0.113.7")).toBe("203.0.113.7");
    expect(ipGroup("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(ipGroup("2001:0DB8:0001:0002::1")).toBe("2001:db8:1:2::/64");
    expect(ipGroup("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipGroup("::ffff:198.51.100.4")).toBe("198.51.100.4");
  });

  it("stores only an HMAC, the same for one /64, different across keys", async () => {
    const a = await hashIp("2001:db8:1:2::1", IP_KEY);
    const b = await hashIp("2001:db8:1:2:ffff::9", IP_KEY);
    const c = await hashIp("2001:db8:1:3::1", IP_KEY);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(await hashIp("2001:db8:1:2::1", "test-ip-key-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).not.toBe(a);
    expect(a).not.toBe(await sha256Hex("2001:db8:1:2::/64"));
  });

  it("refuses a missing or short key", async () => {
    await expect(hashIp("203.0.113.7", "")).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("tokens", () => {
  it("are 256-bit and URL-safe", () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(token);
  });

  it("compare in constant time", () => {
    expect(textEqual("abc", "abc")).toBe(true);
    expect(textEqual("abc", "abd")).toBe(false);
    expect(textEqual("abc", "abcd")).toBe(false);
  });
});
