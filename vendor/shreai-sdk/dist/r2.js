import { createLogger } from './logger.js';
import { createHmac, createHash } from 'node:crypto';
function sha256(data) {
    return createHash('sha256').update(data).digest('hex');
}
function hmacSha256(key, data) {
    return createHmac('sha256', key).update(data).digest();
}
function getSignatureKey(secretKey, date, region, service) {
    const kDate = hmacSha256(`AWS4${secretKey}`, date);
    const kRegion = hmacSha256(kDate, region);
    const kService = hmacSha256(kRegion, service);
    return hmacSha256(kService, 'aws4_request');
}
function signRequest(method, url, headers, body, accessKeyId, secretAccessKey) {
    const now = new Date();
    const amzDate = now
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, 'Z');
    const dateStamp = amzDate.slice(0, 8);
    const region = 'auto';
    const service = 's3';
    const payloadHash = sha256(typeof body === 'string' ? body : body);
    const allHeaders = {
        ...headers,
        host: url.host,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
    };
    const signedHeaderKeys = Object.keys(allHeaders)
        .sort()
        .map((k) => k.toLowerCase());
    const signedHeadersStr = signedHeaderKeys.join(';');
    const canonicalHeaders = signedHeaderKeys
        .map((k) => `${k}:${allHeaders[k] || allHeaders[Object.keys(allHeaders).find((h) => h.toLowerCase() === k)]}`)
        .join('\n') + '\n';
    const canonicalPath = url.pathname;
    const canonicalQuery = url.search ? url.search.slice(1).split('&').sort().join('&') : '';
    const canonicalRequest = [
        method,
        canonicalPath,
        canonicalQuery,
        canonicalHeaders,
        signedHeadersStr,
        payloadHash,
    ].join('\n');
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        sha256(canonicalRequest),
    ].join('\n');
    const signingKey = getSignatureKey(secretAccessKey, dateStamp, region, service);
    const signature = hmacSha256(signingKey, stringToSign).toString('hex');
    return {
        ...allHeaders,
        Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
    };
}
export function createR2Client(service, config) {
    const log = createLogger(service);
    const accountId = config?.accountId || process.env.R2_ACCOUNT_ID || '';
    const accessKeyId = config?.accessKeyId || process.env.R2_ACCESS_KEY_ID || '';
    const secretAccessKey = config?.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY || '';
    const bucket = config?.bucket || process.env.R2_BUCKET || 'shre-platform';
    const endpoint = config?.endpoint ||
        process.env.R2_ENDPOINT ||
        (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');
    const enabled = !!(endpoint && accessKeyId && secretAccessKey);
    if (!enabled) {
        log.warn('R2 not configured — archival disabled', {
            hasEndpoint: !!endpoint,
            hasAccessKey: !!accessKeyId,
        });
    }
    async function request(method, key, body = '', extraHeaders = {}, bucketOverride) {
        const b = bucketOverride || bucket;
        const url = new URL(`/${b}/${key}`, endpoint);
        const headers = signRequest(method, url, extraHeaders, body, accessKeyId, secretAccessKey);
        const res = await fetch(url.toString(), {
            method,
            headers,
            body: method !== 'GET' && method !== 'DELETE' && method !== 'HEAD'
                ? typeof body === 'string'
                    ? body
                    : new Uint8Array(body)
                : undefined,
        });
        return res;
    }
    return {
        isEnabled: () => enabled,
        async put(key, body, opts) {
            if (!enabled)
                return;
            const extra = {};
            if (opts?.contentType)
                extra['content-type'] = opts.contentType;
            if (opts?.metadata) {
                for (const [k, v] of Object.entries(opts.metadata)) {
                    extra[`x-amz-meta-${k}`] = v;
                }
            }
            const res = await request('PUT', key, body, extra, opts?.bucket);
            if (!res.ok) {
                const text = await res.text();
                log.error('R2 PUT failed', { key, status: res.status, body: text.slice(0, 200) });
                throw new Error(`R2 PUT ${key}: ${res.status}`);
            }
            log.info('R2 PUT ok', {
                key,
                size: typeof body === 'string' ? body.length : body.byteLength,
            });
        },
        async get(key, bucketOverride) {
            if (!enabled)
                return null;
            const res = await request('GET', key, '', {}, bucketOverride);
            if (res.status === 404)
                return null;
            if (!res.ok) {
                log.error('R2 GET failed', { key, status: res.status });
                return null;
            }
            const ab = await res.arrayBuffer();
            return Buffer.from(ab);
        },
        async head(key, bucketOverride) {
            if (!enabled)
                return null;
            const res = await request('HEAD', key, '', {}, bucketOverride);
            if (res.status === 404)
                return null;
            if (!res.ok)
                return null;
            return {
                size: parseInt(res.headers.get('content-length') || '0', 10),
                lastModified: res.headers.get('last-modified') || '',
            };
        },
        async list(prefix, maxKeys = 1000, bucketOverride) {
            if (!enabled)
                return [];
            const b = bucketOverride || bucket;
            const url = new URL(`/${b}?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=${maxKeys}`, endpoint);
            const headers = signRequest('GET', url, {}, '', accessKeyId, secretAccessKey);
            const res = await fetch(url.toString(), { method: 'GET', headers });
            if (!res.ok) {
                log.error('R2 LIST failed', { prefix, status: res.status });
                return [];
            }
            const xml = await res.text();
            const results = [];
            const regex = /<Contents><Key>([^<]+)<\/Key>.*?<LastModified>([^<]+)<\/LastModified>.*?<Size>(\d+)<\/Size>/gs;
            let match;
            while ((match = regex.exec(xml)) !== null) {
                results.push({ key: match[1], lastModified: match[2], size: parseInt(match[3], 10) });
            }
            return results;
        },
        async delete(key, bucketOverride) {
            if (!enabled)
                return;
            const res = await request('DELETE', key, '', {}, bucketOverride);
            if (!res.ok && res.status !== 404) {
                log.error('R2 DELETE failed', { key, status: res.status });
            }
        },
    };
}
