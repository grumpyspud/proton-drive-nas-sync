export interface FrequencyOption {
    label: string;
    value: number;
}

/** Sentinel frequency value meaning "Real-time": the pair participates in the
 *  check-then-sync loop (poll the Drive event feed + scan the local dir every
 *  PDN_REALTIME_INTERVAL, sync only when a change is detected). It has no fixed
 *  interval, so it replaces the old "1 min" full-walk poll. */
export const REALTIME_VALUE = 0;

/** Auto-sync schedule choices: "Real-time" (0) plus fixed intervals in seconds.
 *  "Weekly"/"Monthly" are fixed 7- and 30-day intervals. */
export const SYNC_FREQUENCIES: FrequencyOption[] = [
    { label: 'Real-time', value: REALTIME_VALUE },
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
    if (seconds === REALTIME_VALUE) return 'Real-time';
    const match = SYNC_FREQUENCIES.find((f) => f.value === seconds);
    return match ? match.label : seconds > 0 ? `every ${Math.round(seconds / 60)} min` : '~';
}

/** A pair's effective schedule value: REALTIME_VALUE (0) for real-time, the
 *  interval in seconds for auto-sync, or null for Manual (no auto-syncing). */
export function pairInterval(p: { autoSync: boolean; intervalSeconds: number; realTime: boolean }): number | null {
    if (p.realTime) return REALTIME_VALUE;
    if (p.autoSync && p.intervalSeconds > 0) return p.intervalSeconds;
    return null;
}

/** Epoch ms when the pair next becomes due for a scheduled auto-sync, or null
 *  when it has no fixed schedule (Manual or Real-time). */
export function nextSyncAtMs(p: { autoSync: boolean; intervalSeconds: number; realTime: boolean; lastSyncAt: number | null }): number | null {
    const interval = pairInterval(p);
    if (interval === null || interval === REALTIME_VALUE) return null;
    return (p.lastSyncAt ?? 0) + interval * 1000;
}

/** Turn a schedule value (REALTIME_VALUE or an interval in seconds) into the
 *  pair settings shape the API expects. */
export function scheduleFromValue(value: number): { realTime: boolean; autoSync: boolean; intervalSeconds: number } {
    if (value === REALTIME_VALUE) return { realTime: true, autoSync: false, intervalSeconds: 0 };
    return { realTime: false, autoSync: true, intervalSeconds: value };
}
