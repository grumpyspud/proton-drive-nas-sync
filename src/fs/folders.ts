import { NodeType, type ProtonDriveClient } from '@protontech/drive-sdk';
import { nodeName } from './files';

/**
 * Returns the uid of the named folder under `parentUid`, creating it if it
 * does not exist. Used to map a pair's friendly Drive folder name to a uid.
 */
export async function findOrCreateFolder(sdk: ProtonDriveClient, parentUid: string, name: string): Promise<string> {
    for await (const child of sdk.iterateFolderChildren(parentUid)) {
        if (nodeName(child.name) === name && child.type === NodeType.Folder) return child.uid;
    }
    const created = await sdk.createFolder(parentUid, name);
    return created.uid;
}
