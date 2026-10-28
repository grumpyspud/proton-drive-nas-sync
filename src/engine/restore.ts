import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { downloadFile } from '../fs/files';
import { walkDriveTree } from './walk';

export interface RestoreOptions {
    sdk: ProtonDriveClient;
    driveFolderUid: string;
    destDir: string;
    log?: (msg: string) => void;
}

export interface RestoreResult {
    filesDownloaded: number;
    foldersCreated: number;
}

/** One-way Drive -> NAS restore: downloads the Drive tree into `destDir`. */
export async function restore(options: RestoreOptions): Promise<RestoreResult> {
    const { sdk, driveFolderUid, destDir, log = () => {} } = options;
    const entries = await walkDriveTree(sdk, driveFolderUid);
    const result: RestoreResult = { filesDownloaded: 0, foldersCreated: 0 };

    // Folders first (shallow-first), then files.
    const folders = entries
        .filter((e) => e.kind === 'folder')
        .sort((a, b) => a.relPath.split('/').length - b.relPath.split('/').length);
    for (const folder of folders) {
        await mkdir(path.join(destDir, folder.relPath), { recursive: true });
        result.foldersCreated++;
    }

    for (const file of entries.filter((e) => e.kind === 'file')) {
        const localPath = path.join(destDir, file.relPath);
        await mkdir(path.dirname(localPath), { recursive: true });
        await downloadFile(sdk, file.uid, localPath);
        result.filesDownloaded++;
        log(`restored ${file.relPath}`);
    }

    return result;
}
