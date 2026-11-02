import type { ProtonDriveHTTPClientBlobRequest, ProtonDriveHTTPClientJsonRequest } from '@protontech/drive-sdk';
import type { ApiClient } from '../../vendor/proton-drive-sdk-account/apiClient';
import { checkUrl } from './urlGuard';

/**
 * Adapts the vendored account module's `ApiClient` (ky-based) to the SDK's
 * `ProtonDriveHTTPClient` interface. Matching the reference CLI's `HTTPClient`.
 *
 * Every request is validated before it hits the authenticated client, so the
 * session Bearer token is never sent to a non-Proton host or over plain http.
 */
export class HTTPClient {
    constructor(private readonly apiClient: ApiClient) {}

    async fetchJson(options: ProtonDriveHTTPClientJsonRequest): Promise<Response> {
        this.assertSafeUrl(options.url);
        return this.apiClient.authenticatedRequest(options.url, {
            method: options.method,
            ...(options.json !== undefined ? { json: options.json } : {}),
            ...(options.body !== undefined && options.json === undefined ? { body: options.body } : {}),
            headers: options.headers,
            timeout: options.timeoutMs,
            signal: options.signal,
            throwHttpErrors: false,
        });
    }

    async fetchBlob(options: ProtonDriveHTTPClientBlobRequest): Promise<Response> {
        this.assertSafeUrl(options.url);
        return this.apiClient.authenticatedRequest(options.url, {
            method: options.method,
            body: options.body,
            headers: options.headers,
            timeout: options.timeoutMs,
            signal: options.signal,
            throwHttpErrors: false,
        });
    }

    private assertSafeUrl(url: string): void {
        const reason = checkUrl(url);
        if (reason) {
            throw new Error(`Refusing to send authenticated request to "${url}": ${reason}`);
        }
    }
}
