import type { ProtonDriveHTTPClientBlobRequest, ProtonDriveHTTPClientJsonRequest } from '@protontech/drive-sdk';
import type { ApiClient } from '../../vendor/proton-drive-sdk-account/apiClient';

/**
 * Adapts the vendored account module's `ApiClient` (ky-based) to the SDK's
 * `ProtonDriveHTTPClient` interface. Matching the reference CLI's `HTTPClient`.
 */
export class HTTPClient {
    constructor(private readonly apiClient: ApiClient) {}

    async fetchJson(options: ProtonDriveHTTPClientJsonRequest): Promise<Response> {
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
        return this.apiClient.authenticatedRequest(options.url, {
            method: options.method,
            body: options.body,
            headers: options.headers,
            timeout: options.timeoutMs,
            signal: options.signal,
            throwHttpErrors: false,
        });
    }
}
