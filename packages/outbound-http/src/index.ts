import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface OutboundUrlPolicy {
  /** Exact hostnames the operator intentionally permits on private networks. */
  allowedPrivateHosts?: readonly string[];
  /** Injectable for deterministic tests. */
  lookup?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
}

export class UnsafeOutboundUrlError extends Error {
  constructor(readonly reason: string) {
    super(`Unsafe outbound URL: ${reason}`);
    this.name = "UnsafeOutboundUrlError";
  }
}

function normalizeHost(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function ipv4Number(address: string): number | null {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
    return null;
  return (
    (((octets[0]! << 24) >>> 0) |
      (octets[1]! << 16) |
      (octets[2]! << 8) |
      octets[3]!) >>>
    0
  );
}

function inIpv4Range(value: number, network: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (network & mask);
}

function isPublicIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return false;
  const blocked: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return !blocked.some(([network, prefix]) =>
    inIpv4Range(value, ipv4Number(network)!, prefix),
  );
}

function ipv6Number(address: string): bigint | null {
  let source = normalizeHost(address).split("%")[0]!;
  const ipv4Tail = source.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail) {
    const value = ipv4Number(ipv4Tail);
    if (value === null) return null;
    source = `${source.slice(0, -ipv4Tail.length)}${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))
  )
    return null;
  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(`0x${group}`),
    0n,
  );
}

function isPublicIpv6(address: string): boolean {
  const value = ipv6Number(address);
  if (value === null || value === 0n || value === 1n) return false;
  if (value >> 32n === 0xffffn)
    return isPublicIpv4(
      `${Number((value >> 24n) & 255n)}.${Number((value >> 16n) & 255n)}.${Number((value >> 8n) & 255n)}.${Number(value & 255n)}`,
    );
  // Only globally routed unicast space is accepted. Explicit operator
  // allowlisting below remains available for private self-hosted services.
  if (value >> 125n !== 1n) return false;
  if (value >> 96n === 0x20010db8n) return false;
  return true;
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(normalizeHost(address));
  return family === 4
    ? isPublicIpv4(normalizeHost(address))
    : family === 6
      ? isPublicIpv6(normalizeHost(address))
      : false;
}

export function privateHostAllowlist(
  value: string | undefined,
): readonly string[] {
  return (value ?? "")
    .split(",")
    .map((host) => normalizeHost(host.trim()))
    .filter(Boolean);
}

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

/**
 * Rejects credentials, non-HTTPS URLs, local names, private IP literals, and
 * hostnames that currently resolve to any non-public address. Call this again
 * immediately before each request; validation only at configuration time is
 * insufficient because DNS answers can change.
 */
export async function assertSafeOutboundUrl(
  value: string,
  policy: OutboundUrlPolicy = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeOutboundUrlError("invalid URL");
  }
  if (url.protocol !== "https:")
    throw new UnsafeOutboundUrlError("HTTPS is required");
  if (url.username || url.password)
    throw new UnsafeOutboundUrlError("embedded credentials are not allowed");

  const hostname = normalizeHost(url.hostname);
  const allowlist = new Set(
    (policy.allowedPrivateHosts ?? []).map((host) => normalizeHost(host)),
  );
  if (allowlist.has(hostname)) return url;
  if (url.port && url.port !== "443")
    throw new UnsafeOutboundUrlError(
      "non-standard ports require an operator-allowlisted hostname",
    );
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  )
    throw new UnsafeOutboundUrlError("local hostnames are not allowed");

  if (isIP(hostname)) {
    if (!isPublicIpAddress(hostname))
      throw new UnsafeOutboundUrlError("private or reserved IP address");
    return url;
  }

  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await (policy.lookup ?? defaultLookup)(hostname);
  } catch {
    throw new UnsafeOutboundUrlError("hostname could not be resolved");
  }
  if (!addresses.length)
    throw new UnsafeOutboundUrlError("hostname resolved to no addresses");
  if (addresses.some(({ address }) => !isPublicIpAddress(address)))
    throw new UnsafeOutboundUrlError(
      "hostname resolves to a private or reserved address",
    );
  return url;
}
