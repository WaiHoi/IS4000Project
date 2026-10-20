// Final-URL validation (§9): http/https only, no credentials, ports
// 80/443, no private/loopback/link-local/metadata IPs. Tavily does all
// fetching, so this is officer-browser defense, not SSRF prevention —
// literal-IP + denylisted-hostname checks only, no DNS resolution.
// Ranges use node:net BlockList (no new deps); brackets/zones are stripped
// before classification so `[::1]` cannot slip through as "not an IP".
import { BlockList, isIP } from "node:net";

const DENY_HOST_RE =
	/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.invalid|.*\.example|.*\.test|.*\.corp)$/i;

const v4Deny = new BlockList();
// IANA special-purpose + private ranges (complete for literal checks):
// 0/8, 10/8, 100.64/10 CGNAT, 127/8, 169.254/16, 172.16/12,
// 192.0.0.0/24 IETF, 192.0.2.0/24 + 198.51.100.0/24 + 203.0.113.0/24
// documentation, 192.31.196.0/24 + 192.52.193.0/24 + 192.175.48.0/24 +
// 192.88.99.0/24 special relay/AMT, 192.168/16, 198.18/15 benchmark,
// 224.0.0.0/4 multicast, 240.0.0.0/4 reserved/broadcast.
for (const [addr, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.31.196.0", 24],
	["192.52.193.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["192.175.48.0", 24],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as Array<[string, number]>) {
	v4Deny.addSubnet(addr, prefix, "ipv4");
}

const v6Deny = new BlockList();
// ::/128 unspecified, ::1/128 loopback, 100::/64 discard, 2001:db8::/32
// documentation, fc00::/7 unique-local, fe80::/10 link-local, ff00::/8.
for (const [addr, prefix] of [
	["::", 128],
	["::1", 128],
	["100::", 64],
	["2001:db8::", 32],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as Array<[string, number]>) {
	v6Deny.addSubnet(addr, prefix, "ipv6");
}

/** Strip brackets + zone id (`[fe80::1%eth0]` → `fe80::1`). */
function cleanV6(host: string): string {
	let h = host.toLowerCase();
	if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
	const pct = h.indexOf("%");
	if (pct >= 0) h = h.slice(0, pct);
	return h;
}

/** Decimal/hex 32-bit integer hosts (`2130706433`, `0x7f000001`) → octets. */
function intToV4(host: string): string | null {
	if (/^[0-9]+$/.test(host)) {
		const n = Number(host);
		if (Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff) {
			return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
		}
	} else if (/^0x[0-9a-f]+$/i.test(host)) {
		const n = Number.parseInt(host, 16);
		if (Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff) {
			return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
		}
	}
	return null;
}

function hostIsBlocked(host: string): boolean {
	// IPv4-mapped IPv6: the embedded v4 decides. Node's URL parser
	// serializes the dotted form to hex (`::ffff:127.0.0.1` becomes
	// `::ffff:7f00:1`), so both spellings are decoded to octets.
	const mapped = host.match(/^::ffff:([0-9a-f.:]+)$/i);
	if (mapped) {
		const tail = mapped[1];
		if (tail.includes(".")) {
			const v4 = tail.split(":").pop() ?? "";
			if (isIP(v4) === 4) return v4Deny.check(v4, "ipv4");
			return true; // unparseable mapped form: fail closed
		}
		const groups = tail.split(":");
		if (
			groups.length >= 1 &&
			groups.length <= 2 &&
			groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))
		) {
			const n = Number.parseInt(
				groups
					.map((g) => g.padStart(4, "0"))
					.join("")
					.padStart(8, "0")
					.slice(-8),
				16,
			);
			const v4 = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
			return v4Deny.check(v4, "ipv4");
		}
		return true;
	}
	if (isIP(host) === 6) return v6Deny.check(host, "ipv6");
	if (isIP(host) === 4) return v4Deny.check(host, "ipv4");
	const asV4 = intToV4(host);
	if (asV4) return v4Deny.check(asV4, "ipv4");
	return false;
}

export type UrlVerdict =
	| { ok: true; finalUrl: string; host: string }
	| { ok: false; error: string };

export function validateFinalUrl(raw: string): UrlVerdict {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return { ok: false, error: "malformed URL" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { ok: false, error: "URL must be http(s)" };
	}
	if (url.username !== "" || url.password !== "") {
		return { ok: false, error: "URL must not carry credentials" };
	}
	if (url.port !== "" && url.port !== "80" && url.port !== "443") {
		return { ok: false, error: "URL port must be 80/443" };
	}
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	if (host === "" || DENY_HOST_RE.test(host)) {
		return { ok: false, error: "URL host is not public" };
	}
	// `URL.hostname` keeps IPv6 brackets; strip them (and any zone id)
	// before classification, else `isIP` misses and the host is allowed.
	if (hostIsBlocked(cleanV6(host))) return { ok: false, error: "URL host is not public" };
	url.hash = "";
	return { ok: true, finalUrl: url.toString(), host };
}
