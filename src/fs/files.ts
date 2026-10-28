import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import type { FileUploader, ProtonDriveClient } from '@protontech/drive-sdk';

/**
 * File-level operations on top of the Drive SDK. These primitives are the
 * foundation for M3 (backup/restore) and M4 (bidirectional sync).
 *
 * NOTE: upload streams from disk (constant memory); download currently buffers
 * into memory and writes once (fine for M1 test files). M3 will stream download
 * to disk for large files.
 */

async function hashFile(path: string, algorithm: string): Promise<string> {
    const hash = createHash(algorithm);
    await new Promise<void>((resolve, reject) => {
        createReadStream(path)
            .on('data', (chunk) => hash.update(chunk))
            .on('end', () => resolve())
            .on('error', reject);
    });
    return hash.digest('hex');
}

export function sha1OfFile(path: string): Promise<string> {
    return hashFile(path, 'sha1');
}

export function sha256OfFile(path: string): Promise<string> {
    return hashFile(path, 'sha256');
}

export function mimeTypeFor(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
        txt: 'text/plain',
        md: 'text/markdown',
        json: 'application/json',
        html: 'text/html',
        csv: 'text/csv',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        pdf: 'application/pdf',
        mp4: 'video/mp4',
        mov: 'video/quicktime',
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        zip: 'application/zip',
        gz: 'application/gzip',
    };
    return map[ext] ?? 'application/octet-stream';
}

/**
 * Uploads a local file into `parentFolderUid`, returning the new node UID.
 * The SDK verifies size + SHA1 integrity against the declared metadata.
 */
export async function uploadFile(
    sdk: ProtonDriveClient,
    parentFolderUid: string,
    name: string,
    localPath: string,
): Promise<string> {
    const stats = await stat(localPath);
    const expectedSha1 = await sha1OfFile(localPath);

    const uploader = await sdk.getFileUploader(parentFolderUid, name, {
        mediaType: mimeTypeFor(name),
        expectedSize: stats.size,
        expectedSha1,
        modificationTime: stats.mtime,
    });

    return uploadTo(uploader, localPath);
}

/**
 * Uploads new content as a NEW REVISION of an existing file (update in place).
 * `getFileUploader` rejects when the name already exists, so an update must go
 * through `getFileRevisionUploader`.
 */
export async function uploadFileRevision(sdk: ProtonDriveClient, nodeUid: string, localPath: string): Promise<string> {
    const stats = await stat(localPath);
    const expectedSha1 = await sha1OfFile(localPath);

    const uploader = await sdk.getFileRevisionUploader(nodeUid, {
        mediaType: mimeTypeFor(basename(localPath)),
        expectedSize: stats.size,
        expectedSha1,
        modificationTime: stats.mtime,
    });

    return uploadTo(uploader, localPath);
}

async function uploadTo(uploader: FileUploader, localPath: string): Promise<string> {
    const stream = Readable.toWeb(createReadStream(localPath)) as unknown as ReadableStream<Uint8Array>;
    const controller = await uploader.uploadFromStream(stream, []);
    const { nodeUid } = await controller.completion();
    return nodeUid;
}

/**
 * Downloads a file to `localPath`, verifying integrity (signature + decryption).
 * Throws if signature verification flags an issue.
 */
export async function downloadFile(
    sdk: ProtonDriveClient,
    nodeUid: string,
    localPath: string,
): Promise<void> {
    const downloader = await sdk.getFileDownloader(nodeUid);
    const chunks: Uint8Array[] = [];
    const stream = new WritableStream<Uint8Array>({
        write: (chunk) => {
            chunks.push(chunk);
        },
    });

    const controller = downloader.downloadToStream(stream);
    await controller.completion();

    if (controller.isDownloadCompleteWithSignatureIssues()) {
        throw new Error('Download completed with signature verification issues');
    }

    await writeFile(localPath, Buffer.concat(chunks));
}

export function nodeName(name: { ok: boolean } & Record<string, unknown>): string {
    return name.ok ? String(name.value) : '(undecryptable)';
}
