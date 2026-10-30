import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import selfsigned from 'selfsigned';
import { configDir } from '../crypto/keySource';

/**
 * TLS mode for the web UI. The server is HTTPS by default:
 *   - PDN_HTTP=true              -> plain HTTP (opt-out, e.g. behind a reverse proxy).
 *   - PDN_TLS_CERT + PDN_TLS_KEY -> HTTPS using the provided PEM cert + key.
 *   - otherwise                  -> HTTPS with a self-signed cert generated on first
 *                                   boot and cached in the config dir.
 */
export type TlsConfig =
    | { mode: 'http'; source: 'http' }
    | { mode: 'https'; source: 'provided' | 'self-signed'; key: string; cert: string };

const CERT_FILE = 'selfsigned.crt';
const KEY_FILE = 'selfsigned.key';

function selfSignedPaths(): { certPath: string; keyPath: string } {
    const dir = configDir();
    return { certPath: join(dir, CERT_FILE), keyPath: join(dir, KEY_FILE) };
}

async function generateSelfSigned(): Promise<{ key: string; cert: string }> {
    const altNames: Array<{ type: 1 | 2 | 6 | 7; value?: string; ip?: string }> = [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        { type: 7, ip: '::1' },
    ];
    const host = os.hostname();
    if (host && host !== 'localhost' && host !== '127.0.0.1') {
        altNames.push({ type: 2, value: host });
    }
    const pems = await selfsigned.generate(
        [{ name: 'commonName', value: 'proton-drive-nas-sync' }],
        {
            keySize: 2048,
            algorithm: 'sha256',
            notAfterDate: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000),
            extensions: [
                { name: 'basicConstraints', cA: false },
                { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
                { name: 'extKeyUsage', serverAuth: true },
                { name: 'subjectAltName', altNames },
            ],
        },
    );
    return { key: pems.private, cert: pems.cert };
}

export async function resolveTls(): Promise<TlsConfig> {
    if (process.env.PDN_HTTP === 'true') {
        return { mode: 'http', source: 'http' };
    }
    const certEnv = process.env.PDN_TLS_CERT;
    const keyEnv = process.env.PDN_TLS_KEY;
    if (certEnv && keyEnv) {
        return {
            mode: 'https',
            source: 'provided',
            cert: readFileSync(certEnv, 'utf8'),
            key: readFileSync(keyEnv, 'utf8'),
        };
    }
    if (certEnv || keyEnv) {
        throw new Error('PDN_TLS_CERT and PDN_TLS_KEY must be set together (or neither).');
    }
    // Default: self-signed, generated once and cached.
    const { certPath, keyPath } = selfSignedPaths();
    if (existsSync(certPath) && existsSync(keyPath)) {
        return {
            mode: 'https',
            source: 'self-signed',
            cert: readFileSync(certPath, 'utf8'),
            key: readFileSync(keyPath, 'utf8'),
        };
    }
    const pems = await generateSelfSigned();
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(certPath, pems.cert, { mode: 0o644 });
    writeFileSync(keyPath, pems.key, { mode: 0o600 });
    return { mode: 'https', source: 'self-signed', cert: pems.cert, key: pems.key };
}
