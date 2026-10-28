import { stat } from 'node:fs/promises';

export class SafetyError extends Error {}

/**
 * Source-availability gate: refuse to proceed if the local source folder is
 * missing or not a directory. This is the guard against a NAS volume that
 * unmounts or is otherwise unavailable — without it, the engine would mistake
 * "source gone" for "everything deleted" and start mass-deleting from Drive.
 */
export async function assertSourceAvailable(sourceDir: string): Promise<void> {
    let st;
    try {
        st = await stat(sourceDir);
    } catch {
        throw new SafetyError(
            `Source unavailable: "${sourceDir}" does not exist (unmounted volume? wrong path?). ` +
                `Aborting instead of treating this as "everything was deleted".`,
        );
    }
    if (!st.isDirectory()) {
        throw new SafetyError(`Source unavailable: "${sourceDir}" is not a directory. Aborting.`);
    }
}

/**
 * Deletion-rate tripwire: refuses any deletion pass whose deletion count would
 * exceed a percentage of the tracked items. Catastrophic data loss usually
 * shows up as an abnormally large deletion batch, so this forces a human to
 * look before the deletions proceed.
 */
export function checkDeletionTripwire(options: {
    totalTracked: number;
    deletions: number;
    thresholdPct?: number;
    /** Minimum absolute deletions before the tripwire can fire (default 5). */
    minDeletions?: number;
}): void {
    const threshold = options.thresholdPct ?? 25;
    const min = options.minDeletions ?? 5;
    if (options.deletions === 0) return;
    if (options.totalTracked === 0) {
        throw new SafetyError(
            `Deletion tripwire: ${options.deletions} deletion(s) requested but zero items are tracked. Refusing.`,
        );
    }
    // Small deletions (a handful of files) are normal and never trip.
    if (options.deletions < min) return;
    const pct = (options.deletions / options.totalTracked) * 100;
    if (pct > threshold) {
        throw new SafetyError(
            `Deletion tripwire: ${options.deletions} of ${options.totalTracked} tracked items (${pct.toFixed(1)}%) ` +
                `would be deleted, exceeding the ${threshold}% threshold. Refusing — this usually means the source became ` +
                `unavailable. Review manually and confirm before retrying.`,
        );
    }
}
