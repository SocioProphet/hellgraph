/**
 * Sociosphere graph health and time service models.
 * First-class operational intelligence — not a secondary feature.
 */
export type GraphStatus = 'healthy' | 'degraded' | 'failed' | 'unknown';
export type VectorIndexStatus = 'fresh' | 'stale' | 'building' | 'failed' | 'unknown';
export interface GraphHealthStatus {
    graphId: string;
    status: GraphStatus;
    nodeCount: number;
    edgeCount: number;
    pendingIngestCount: number;
    failedIngestCount: number;
    orphanNodeCount: number;
    duplicateEntityCount: number;
    stalePartitionCount: number;
    lastIndexedAt?: string;
    lastReasonedAt?: string;
    lastSnapshotAt?: string;
    vectorIndexStatus: VectorIndexStatus;
}
export interface TimeServiceStatus {
    serviceId: string;
    status: GraphStatus;
    logicalTime: string;
    latestEventTime: string;
    ledgerLagMs: number;
    clockSkewMs: number;
    lastCheckpointAt?: string;
    replayWindowStart?: string;
    replayWindowEnd?: string;
}
export interface ConnectorHealthEntry {
    connectorId: string;
    name: string;
    status: GraphStatus;
    lastSyncAt?: string;
    failureReason?: string;
}
export interface SyncQueueEntry {
    queueId: string;
    name: string;
    pendingCount: number;
    failedCount: number;
    processingRate?: number;
    lastProcessedAt?: string;
}
//# sourceMappingURL=graph.d.ts.map