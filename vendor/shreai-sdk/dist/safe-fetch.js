const INTERNAL_IP_PREFIXES = ['127.', '100.', 'localhost', '::1'];
export function validateSafeUrl(urlStr) {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();
    const isInternalPrefix = INTERNAL_IP_PREFIXES.some((p) => hostname.startsWith(p));
    if (url.protocol === 'http:' && !isInternalPrefix) {
        throw new Error(`Insecure protocol: HTTP is only allowed for internal services. Use HTTPS for external requests.`);
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error(`Forbidden protocol: ${url.protocol}`);
    }
}
export async function safeFetch(input, init) {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    validateSafeUrl(urlStr);
    return fetch(input, init);
}
