import { NodeType, type ProtonDriveClient } from '@protontech/drive-sdk';
import { nodeName } from './files';

/**
 * Finds the uid of a folder named `name` directly under `parentUid`, or
 * `null` if it does not exist.
 */
export async function findFolder(sdk: ProtonDriveClient, parentUid: string, name: string): Promise<string | null> {
    for await (const child of sdk.iterateFolderChildren(parentUid)) {
        if (nodeName(child.name) === name && child.type === NodeType.Folder) return child.uid;
    }
    return null;
}

/**
 * Returns the uid of the named folder under `parentUid`, creating it if it
 * does not exist. Used to map a pair's friendly Drive folder name to a uid.
 */
export async function findOrCreateFolder(sdk: ProtonDriveClient, parentUid: string, name: string): Promise<string> {
    const existing = await findFolder(sdk, parentUid, name);
    if (existing) return existing;
    const created = await sdk.createFolder(parentUid, name);
    return created.uid;
}

/**
 * Resolves (and creates as needed) a slash-separated folder path under
 * `rootUid`, returning the uid of the final folder (e.g. "Backups/Photos").
 */
export async function findOrCreateFolderPath(sdk: ProtonDriveClient, rootUid: string, path: string): Promise<string> {
    const segments = path.split('/').map((s) => s.trim()).filter(Boolean);
    let parent = rootUid;
    for (const segment of segments) {
        parent = await findOrCreateFolder(sdk, parent, segment);
    }
    return parent;
}
