import type { GraphHealthStatus, TimeServiceStatus } from './types/graph';
/**
 * Derive live operational health and Time Service status from the HellGraph
 * store. These are computed from real graph state — node/edge counts, dangling
 * references, orphans, and the append-only log clock — not stubbed constants.
 */
export declare function computeGraphHealth(): GraphHealthStatus;
export declare function computeTimeService(): TimeServiceStatus;
//# sourceMappingURL=health.d.ts.map