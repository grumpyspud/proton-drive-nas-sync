import { stat } from 'node:fs/promises';

export class SafetyError extends Error {}

/** Structured summary of a deletion pass that tripped the rate guard. */
export interface DeletionTripwireInfo {
    totalTracked: number;
    deletions: number;
    thresholdPct: number;
    pct: number;
    /** relPaths whose Drive copy will be trashed (local copy was deleted). */
    driveTrash: string[];
    /** relPaths whose local copy will be recycled to .pdn-trash (Drive copy was deleted). */
    localRecycle: string[];
}

/** Thrown when a deletion pass exceeds the rate threshold and needs human
 *  confirmation before proceeding. Carries enough detail for the UI to show a
 *  review/confirm prompt. */
export class DeletionTripwireError extends Error {
    readonly info: DeletionTripwireInfo;
    constructor(info: DeletionTripwireInfo) {
        super(
            `Deletion tripwire: ${info.deletions} of ${info.totalTracked} tracked items (${info.pct.toFixed(1)}%) ` +
                `would be deleted, exceeding the ${info.thresholdPct}% threshold.`,
        );
        this.name = 'DeletionTripwireError';
        this.info = info;
    }
}

/**
 * Source-availability gate: refuse to proceed if the local source folder is
 * missing or not a directory. This is the guard against a NAS volume that
 * unmounts or is otherwise unavailable: without it, the engine would mistake
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
export interface DeletionTripwireResult {
    tripped: boolean;
    pct: number;
    threshold: number;
}

export function checkDeletionTripwire(options: {
    totalTracked: number;
    deletions: number;
    thresholdPct?: number;
    /** Minimum absolute deletions before the tripwire can fire (default 5). */
    minDeletions?: number;
}): DeletionTripwireResult {
    const threshold = options.thresholdPct ?? 25;
    const min = options.minDeletions ?? 5;
    if (options.deletions === 0) return { tripped: false, pct: 0, threshold };
    if (options.totalTracked === 0) {
        throw new SafetyError(
            `Deletion tripwire: ${options.deletions} deletion(s) requested but zero items are tracked. Refusing.`,
        );
    }
    // Small deletions (a handful of files) are normal and never trip.
    if (options.deletions < min) return { tripped: false, pct: 0, threshold };
    const pct = (options.deletions / options.totalTracked) * 100;
    return { tripped: pct > threshold, pct, threshold };
}
