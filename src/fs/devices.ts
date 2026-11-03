import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { nodeName } from './files';

/**
 * A Proton Drive "Computers" device (a desktop Drive app install). The device
 * sync feature mirrors one local folder to the root folder of one or more of
 * these devices.
 */
export interface DeviceInfo {
    uid: string;
    name: string;
    type: string;
    rootFolderUid: string;
    creationTime: number;
    lastSyncTime: number | null;
}

/**
 * Enumerates the user's Computers devices. `iterateDevices` fetches from the
 * server API (not a local cache), so it sees devices registered on any client.
 * Names decrypt from each device root folder's node name; an undecryptable name
 * surfaces as `(undecryptable)`.
 */
export async function listDevices(sdk: ProtonDriveClient): Promise<DeviceInfo[]> {
    const devices: DeviceInfo[] = [];
    for await (const device of sdk.iterateDevices()) {
        devices.push({
            uid: device.uid,
            name: nodeName(device.name),
            type: device.type,
            rootFolderUid: device.rootFolderUid,
            creationTime: device.creationTime.getTime(),
            lastSyncTime: device.lastSyncTime ? device.lastSyncTime.getTime() : null,
        });
    }
    return devices.sort((a, b) => a.name.localeCompare(b.name));
}
