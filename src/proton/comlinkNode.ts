/**
 * Comlink `Endpoint` bound to a `node:worker_threads` `Worker` (on the main
 * side) or `parentPort` (on the worker side).
 *
 * Replicates the function at `comlink/dist/esm/node-adapter.mjs` — the comlink
 * package has no `exports` map, so importing a `.mjs` sub-path trips up
 * TypeScript at typecheck time.  We vendor a minimal typed copy instead.
 */
import type { Endpoint } from 'comlink';

/** Minimal node-side “port”-like interface (a `Worker` or `parentPort`). */
export interface NodePort {
    postMessage(msg: unknown, transferables?: readonly Transferable[]): void;
    on(event: 'message', listener: (data: unknown) => void): void;
    off(event: 'message', listener: (data: unknown) => void): void;
    start?(): void;
}

export function nodeEndpoint(nep: NodePort): Endpoint {
    const listeners = new WeakMap<object, (data: unknown) => void>();
    return {
        postMessage: nep.postMessage.bind(nep),
        addEventListener: (_type: unknown, eh: unknown): void => {
            const l = (data: unknown): void => {
                const evt = { data };
                if (typeof eh === 'object' && eh !== null && 'handleEvent' in eh) {
                    (eh as { handleEvent(e: unknown): void }).handleEvent(evt);
                } else {
                    (eh as (e: unknown) => void)(evt);
                }
            };
            nep.on('message', l);
            listeners.set(eh as object, l);
        },
        removeEventListener: (_type: unknown, eh: unknown): void => {
            const l = listeners.get(eh as object);
            if (!l) return;
            nep.off('message', l);
            listeners.delete(eh as object);
        },
        start: nep.start ? nep.start.bind(nep) : undefined,
    } as unknown as Endpoint;
}