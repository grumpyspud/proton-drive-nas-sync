interface ActivityItem {
    action: string;
    relPath: string;
}

interface Props {
    items: ActivityItem[];
    totalItems: number;
    onClose: () => void;
}

export function ActivityLogModal({ items, totalItems, onClose }: Props) {
    const shown = items.slice().reverse();
    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h2>Activity log</h2>
                    <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
                        ✕
                    </button>
                </div>
                <div className="logs-meta">
                    {totalItems > items.length
                        ? `Last ${items.length.toLocaleString()} of ${totalItems.toLocaleString()} events`
                        : `${items.length.toLocaleString()} event${items.length === 1 ? '' : 's'}`}
                </div>
                {shown.length === 0 ? (
                    <div className="muted">No activity yet — run a sync to see events here.</div>
                ) : (
                    <div className="activity-log-body">
                        <ul>
                            {shown.map((it, i) => (
                                <li key={i}>
                                    <span className={`tag tag-${it.action}`}>{it.action}</span>
                                    <span className="log-path">{it.relPath}</span>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        </div>
    );
}