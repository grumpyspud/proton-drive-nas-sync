import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { OpenPGPCryptoWithCryptoProxy } from '@protontech/drive-sdk';

/**
 * Initialises the OpenPGP crypto endpoint and returns the SDK crypto module.
 *
 * Mirrors the reference CLI's `initOpenPGPCryptoModule()`: the crypto package
 * keeps its endpoint in module-level state, so the endpoint is initialised here
 * once, and the same `CryptoProxy` singleton is shared with the account module
 * (address keyring unlock) and the Drive SDK.
 */
export function initOpenPGPCryptoModule(): OpenPGPCryptoWithCryptoProxy {
    CryptoApi.init({});
    CryptoProxy.setEndpoint(new CryptoApi(), (endpoint) => endpoint.clearKeyStore());
    return new OpenPGPCryptoWithCryptoProxy(CryptoProxy);
}
