import { safeFetch } from './safe-fetch.js';
import { generateServiceHMAC } from './auth.js';
import { serviceUrl } from './discovery.js';
export class InternalServiceClient {
    serviceName;
    secret;
    constructor(opts) {
        this.serviceName = opts.serviceName;
        this.secret = opts.secret;
    }
    async call(targetService, path, init = {}) {
        const baseUrl = serviceUrl(targetService);
        const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
        const timestamp = Date.now().toString();
        const payload = `${this.serviceName}:${timestamp}`;
        const signature = generateServiceHMAC(this.serviceName, payload, this.secret);
        const headers = new Headers(init.headers);
        headers.set('X-Shre-Signature', signature);
        headers.set('X-Shre-Service', this.serviceName);
        headers.set('X-Shre-Timestamp', timestamp);
        headers.set('X-Shre-Internal', 'true');
        return safeFetch(url, {
            ...init,
            headers,
        });
    }
    async get(targetService, path, init = {}) {
        return this.call(targetService, path, { ...init, method: 'GET' });
    }
    async post(targetService, path, body, init = {}) {
        return this.call(targetService, path, {
            ...init,
            method: 'POST',
            headers: {
                ...init.headers,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
    }
}
export function createInternalClient(serviceName, secret) {
    return new InternalServiceClient({ serviceName, secret });
}
