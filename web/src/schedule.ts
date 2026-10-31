export interface FrequencyOption {
    label: string;
    value: number;
}

/** Auto-sync frequencies, in seconds. "1 min" replaces the old "real-time"
 *  fixed 60s poll; "Weekly"/"Monthly" are fixed 7- and 30-day intervals. */
export const SYNC_FREQUENCIES: FrequencyOption[] = [
    { label: '1 min', value: 60 },
    { label: '15 min', value: 900 },
    { label: '30 min', value: 1800 },
    { label: '1 hour', value: 3600 },
    { label: '6 hours', value: 21600 },
    { label: '12 hours', value: 43200 },
    { label: '24 hours', value: 86400 },
    { label: 'Weekly', value: 604800 },
    { label: 'Monthly', value: 2592000 },
];

/** Human label for a frequency value, with a computed fallback for anything
 *  not in the preset list (e.g. legacy values). */
export function frequencyLabel(seconds: number): string {
    const match = SYNC_FREQUENCIES.find((f) => f.value === seconds);
    return match ? match.label : seconds > 0 ? `every ${Math.round(seconds / 60)} min` : '~';
}

/** Effective auto-sync interval for a pair, accounting for the legacy
 *  `realTime` flag (the old UI's fixed 60s poll). Returns null when the pair is
 *  Manual (no automatic syncing). */
export function pairInterval(p: { autoSync: boolean; intervalSeconds: number; realTime: boolean }): number | null {
    if (p.autoSync && p.intervalSeconds > 0) return p.intervalSeconds;
    if (p.realTime) return 60;
    return null;
}