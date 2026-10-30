import { formatBytes } from '../format';
import type { TransferDirection } from '../types';

interface Props {
    relPath: string;
    direction: TransferDirection;
    bytes: number;
    total: number;
    percent: number;
}

export function ProgressBar({ relPath, direction, bytes, total, percent }: Props) {
    const pct = Math.max(0, Math.min(100, percent));
    return (
        <div className="transfer">
            <div className="transfer-head">
                <span className="transfer-label" title={relPath}>
                    <span className={`dot dot-${direction}`} />
                    {relPath}
                </span>
                <span className="transfer-meta">
                    {formatBytes(bytes)} / {formatBytes(total)}
                </span>
            </div>
            <div className="progress-track">
                <div className={`progress-fill fill-${direction}`} style={{ width: `${pct}%` }} />
            </div>
            <div className="transfer-foot">
                <span>{direction === 'upload' ? 'Uploading' : 'Downloading'}</span>
                <span className="pct">{pct.toFixed(1)}%</span>
            </div>
        </div>
    );
}
