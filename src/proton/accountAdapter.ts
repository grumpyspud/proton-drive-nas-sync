import type { ProtonDriveAccount, ProtonDriveAccountAddress } from '@protontech/drive-sdk';
import type { Addresses } from '../../vendor/proton-drive-sdk-account/addresses';

/**
 * Adapts the vendored account module's `Addresses` to the SDK's
 * `ProtonDriveAccount` interface. Straight pass-through, matching the
 * reference CLI's `DriveAccountAdapter`.
 */
export class DriveAccountAdapter implements ProtonDriveAccount {
    constructor(private readonly addresses: Addresses) {}

    getOwnPrimaryAddress(): Promise<ProtonDriveAccountAddress> {
        return this.addresses.getOwnPrimaryAddress();
    }

    getOwnAddresses(): Promise<ProtonDriveAccountAddress[]> {
        return this.addresses.getOwnAddresses();
    }

    getOwnAddress(emailOrAddressId: string): Promise<ProtonDriveAccountAddress> {
        return this.addresses.getOwnAddress(emailOrAddressId);
    }

    hasProtonAccount(email: string): Promise<boolean> {
        return this.addresses.hasProtonAccount(email);
    }

    getPublicKeys(email: string, forceRefresh?: boolean) {
        return this.addresses.getPublicKeys(email, forceRefresh);
    }
}
