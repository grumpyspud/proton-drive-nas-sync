/**
 * Proton host allowlist for outbound requests. The session Bearer token, SRP
 * credentials, and refresh token must only ever be sent to Proton-owned hosts.
 *
 * Matching is by exact host or a dotted suffix so we do not have to enumerate
 * every block-storage host Proton rotates. An attacker who controls a URL can
 * never obtain a hostname under Proton's own domains, so a suffix match is
 * both safe and future-tolerant.
 *
 * Note the leading dot matters: `evilproton.me` does NOT match `.proton.me`,
 * and `proton.me.evil.com` (an attacker's domain) matches neither.
 */
const PROTON_HOSTS = new Set(['proton.me', 'proton.ch', 'protonmail.com', 'proton.black']);
const PROTON_HOST_SUFFIXES = ['.proton.me', '.proton.ch', '.protonmail.com', '.proton.black'];

function isProtonHost(hostname: string): boolean {
    const h = hostname.toLowerCase();
    return PROTON_HOSTS.has(h) || PROTON_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

/**
 * Validate an absolute URL before it is sent on the authenticated client.
 * Returns null when safe, otherwise a short reason string.
 */
export function checkUrl(rawUrl: string): string | null {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return 'unparseable URL';
    }
    if (url.protocol !== 'https:') {
        return `non-https scheme (${url.protocol})`;
    }
    if (!isProtonHost(url.hostname)) {
        return `non-Proton host (${url.hostname})`;
    }
    return null;
}

/**
 * Validate a configured base URL, which may omit the scheme (the SDK prepends
 * https:// when absent). Returns null when safe, otherwise a reason string.
 */
export function checkBaseUrl(baseUrl: string): string | null {
    const withScheme = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
    return checkUrl(withScheme);
}
