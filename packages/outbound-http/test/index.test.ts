import { describe, expect, it } from "vitest";
import {
  assertSafeOutboundUrl,
  isPublicIpAddress,
  privateHostAllowlist,
  pinnedLookup,
  safeFetch,
  UnsafeOutboundUrlError,
} from "../src/index";

const resolvesTo =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));

describe("outbound URL policy", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.8",
    "169.254.169.254",
    "192.168.1.2",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])(
    "accepts public address %s",
    (address) => expect(isPublicIpAddress(address)).toBe(true),
  );

  it("rejects a public hostname when any DNS answer is private", async () => {
    await expect(
      assertSafeOutboundUrl("https://hooks.example.com/cap", {
        lookup: resolvesTo("203.0.113.20", "10.0.0.2"),
      }),
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
  });

  it("accepts a hostname with only public DNS answers", async () => {
    await expect(
      assertSafeOutboundUrl("https://hooks.example.com/cap", {
        lookup: resolvesTo("1.1.1.1", "2606:4700:4700::1111"),
      }),
    ).resolves.toMatchObject({ hostname: "hooks.example.com" });
  });

  it("requires HTTPS and rejects embedded credentials", async () => {
    await expect(
      assertSafeOutboundUrl("http://example.com", {
        lookup: resolvesTo("1.1.1.1"),
      }),
    ).rejects.toThrow("HTTPS is required");
    await expect(
      assertSafeOutboundUrl("https://user:pass@example.com", {
        lookup: resolvesTo("1.1.1.1"),
      }),
    ).rejects.toThrow("embedded credentials");
  });

  it("blocks non-standard ports unless the operator allows the host", async () => {
    await expect(
      assertSafeOutboundUrl("https://example.com:8443/hook", {
        lookup: resolvesTo("1.1.1.1"),
      }),
    ).rejects.toThrow("non-standard ports");
    await expect(
      assertSafeOutboundUrl("https://example.com:8443/hook", {
        allowedPrivateHosts: ["example.com"],
      }),
    ).resolves.toMatchObject({ port: "8443" });
  });

  it("allows an operator-approved private hostname exactly", async () => {
    await expect(
      assertSafeOutboundUrl("https://ai.internal/v1", {
        allowedPrivateHosts: ["ai.internal"],
        lookup: resolvesTo("10.0.0.4"),
      }),
    ).resolves.toMatchObject({ hostname: "ai.internal" });
  });

  it("parses and normalizes the operator allowlist", () => {
    expect(privateHostAllowlist(" AI.INTERNAL,service.example. , ")).toEqual([
      "ai.internal",
      "service.example",
    ]);
  });
});

describe("pinnedLookup", () => {
  const approved = [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ];

  it("answers every lookup from the approved set, ignoring the hostname", () => {
    const lookup = pinnedLookup(approved);
    const seen: unknown[] = [];
    lookup("rebound.example.com", { all: true }, (error, addresses) =>
      seen.push([error, addresses]),
    );
    expect(seen).toEqual([[null, approved]]);
  });

  it("returns the first address and its family when `all` is not requested", () => {
    const lookup = pinnedLookup(approved);
    const seen: unknown[] = [];
    lookup("rebound.example.com", {}, (error, address, family) =>
      seen.push([error, address, family]),
    );
    expect(seen).toEqual([[null, "93.184.216.34", 4]]);
  });

  it("cannot be mutated through the array the caller passed in", () => {
    const mutable = [{ address: "93.184.216.34", family: 4 }];
    const lookup = pinnedLookup(mutable);
    mutable.push({ address: "169.254.169.254", family: 4 });

    const seen: unknown[] = [];
    lookup("rebound.example.com", { all: true }, (_error, addresses) =>
      seen.push(addresses),
    );
    expect(seen).toEqual([[{ address: "93.184.216.34", family: 4 }]]);
  });
});

describe("safeFetch", () => {
  it("refuses an unsafe URL before opening any connection", async () => {
    await expect(
      safeFetch(
        "https://metadata.example.com",
        {},
        {
          lookup: resolvesTo("169.254.169.254"),
        },
      ),
    ).rejects.toThrow(UnsafeOutboundUrlError);
  });

  it("refuses plaintext regardless of where it resolves", async () => {
    await expect(
      safeFetch(
        "http://example.com",
        {},
        { lookup: resolvesTo("93.184.216.34") },
      ),
    ).rejects.toThrow(UnsafeOutboundUrlError);
  });
});
