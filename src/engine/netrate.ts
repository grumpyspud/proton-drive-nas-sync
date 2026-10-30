/** Container network transfer-rate sampler. Reads cumulative RX+TX byte counts
 *  from `/proc/net/dev` (Linux) and turns them into a bytes/sec rate over a
 *  sliding window. This now drives the "Overall sync" speed readout: the old
 *  per-tick estimate spiked to "—" or "1.0 GB/s" because the SDK's progress
 *  callbacks fire in bursts, whereas the NIC counters are a stable ground truth.
 *
 *  It is not exact — it includes ALL container traffic (the web UI / SSE chatter,
 *  health checks, etc.). That is a few KB/s against the MB/s–GB/s of a real
 *  transfer, so it is treated as noise. */

import { readFileSync } from 'node:fs';

/** Sum of RX+TX bytes across all non-loopback interfaces in /proc/net/dev. */
export function readNetBytes(): number {
    try {
        const text = readFileSync('/proc/net/dev', 'utf8');
        let total = 0;
        for (const line of text.split('\n')) {
            const i = line.indexOf(':');
            if (i < 0) continue; // header lines have no colon
            const iface = line.slice(0, i).trim();
            if (iface === 'lo') continue;
            const fields = line.slice(i + 1).trim().split(/\s+/);
            const rx = Number(fields[0]); // receive bytes
            const tx = Number(fields[8]); // transmit bytes
            if (Number.isFinite(rx)) total += rx;
            if (Number.isFinite(tx)) total += tx;
        }
        return total;
    } catch {
        return 0; // no /proc/net/dev (non-Linux) → report no rate
    }
}

/** Sliding-window bytes/sec meter backed by the container's NIC counters. */
export class NetRateMeter {
    private samples: Array<{ t: number; bytes: number }> = [];

    constructor(private readonly windowMs = 3000) {}

    /** Sample current NIC bytes; returns bytes/sec over the window (0 while warming up). */
    sample(): number {
        const bytes = readNetBytes();
        const t = Date.now();
        this.samples.push({ t, bytes });
        const cutoff = t - this.windowMs;
        this.samples = this.samples.filter((s) => s.t >= cutoff);
        if (this.samples.length < 2) return 0;
        const first = this.samples[0]!;
        const dt = (t - first.t) / 1000;
        const db = bytes - first.bytes;
        return dt > 0 ? db / dt : 0;
    }
}
