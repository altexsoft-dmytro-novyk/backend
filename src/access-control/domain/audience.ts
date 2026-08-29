/**
 * The Phase-0 audience columns (§3.2). Access roles are computed live from
 * relationship facts on every request and are never assigned or stored —
 * a persisted audience is a stale permission, which is a data leak (§6).
 *
 * Project line, Department and PP-HR-line remain fail-closed behind their own
 * approval gates, so they cannot appear here yet.
 */
export type Audience = 'self' | 'reporting' | 'pp' | 'colleague';
