import { afterEach, describe, expect, it } from "vitest";
import { clientAddress, UNKNOWN_ADDRESS } from "./client-address";

function requestWith(headers: Record<string, string>): Request {
  return new Request("https://cap.test/api/auth/login", {
    method: "POST",
    headers,
  });
}

afterEach(() => {
  delete process.env.TRUSTED_PROXY_HOP_COUNT;
});

describe("clientAddress", () => {
  it("reads the entry the single trusted proxy appended", () => {
    expect(
      clientAddress(requestWith({ "x-forwarded-for": "203.0.113.7" })),
    ).toBe("203.0.113.7");
  });

  it("ignores entries the caller prepended to the chain", () => {
    // The attacker sends the first two; Traefik appends the real peer.
    const request = requestWith({
      "x-forwarded-for": "1.1.1.1, 2.2.2.2, 203.0.113.7",
    });
    expect(clientAddress(request)).toBe("203.0.113.7");
  });

  it("counts back by the configured number of proxies", () => {
    process.env.TRUSTED_PROXY_HOP_COUNT = "2";
    const request = requestWith({
      "x-forwarded-for": "9.9.9.9, 203.0.113.7, 10.0.0.5",
    });
    expect(clientAddress(request)).toBe("203.0.113.7");
  });

  it("never trusts x-real-ip, which a caller can forge wholesale", () => {
    const request = requestWith({
      "x-real-ip": "5.5.5.5",
      "x-forwarded-for": "203.0.113.7",
    });
    expect(clientAddress(request)).toBe("203.0.113.7");
    expect(clientAddress(requestWith({ "x-real-ip": "5.5.5.5" }))).toBe(
      UNKNOWN_ADDRESS,
    );
  });

  it("refuses a chain shorter than the configured proxy count", () => {
    process.env.TRUSTED_PROXY_HOP_COUNT = "2";
    expect(
      clientAddress(requestWith({ "x-forwarded-for": "203.0.113.7" })),
    ).toBe(UNKNOWN_ADDRESS);
  });

  it("reports unknown when no forwarded chain is present", () => {
    expect(clientAddress(requestWith({}))).toBe(UNKNOWN_ADDRESS);
  });

  it("rejects a value that is not an address, so buckets cannot be minted", () => {
    expect(
      clientAddress(requestWith({ "x-forwarded-for": "not-an-address" })),
    ).toBe(UNKNOWN_ADDRESS);
  });

  it.each([
    ["203.0.113.7", "203.0.113.7"],
    ["203.0.113.7:41234", "203.0.113.7"],
    ["2001:db8::1", "2001:db8::1"],
    ["[2001:db8::1]", "2001:db8::1"],
    ["[2001:db8::1]:443", "2001:db8::1"],
  ])("reads %s as %s", (header, expected) => {
    expect(clientAddress(requestWith({ "x-forwarded-for": header }))).toBe(
      expected,
    );
  });

  it("attributes nothing when the deployment declares no trusted proxy", () => {
    process.env.TRUSTED_PROXY_HOP_COUNT = "0";
    expect(
      clientAddress(requestWith({ "x-forwarded-for": "203.0.113.7" })),
    ).toBe(UNKNOWN_ADDRESS);
  });

  it("falls back to one hop when the setting is not a valid count", () => {
    process.env.TRUSTED_PROXY_HOP_COUNT = "banana";
    expect(
      clientAddress(requestWith({ "x-forwarded-for": "1.1.1.1, 203.0.113.7" })),
    ).toBe("203.0.113.7");
  });
});
