export interface ExtractedEntity {
    surface: string;
    normalised: string;
    kind: string;
    primeSupport: string[];
    confidence: number;
}
export declare function extractEntities(content: string): ExtractedEntity[];
export declare function ingestEntities(interactionId: string, _sessionId: string, content: string, timestamp: string): void;
/**
 * Ingestion: project Noetica runtime activity into the HellGraph substrate.
 *
 * Each governed interaction becomes a small subgraph:
 *
 *   (Session) -[:HAS_INTERACTION]-> (Interaction) -[:ROUTED_TO]-> (Model)
 *                                        |                           |
 *                                  [:PRODUCED]                 [:OFFERED_BY]
 *                                        v                           v
 *                                   (Evidence)                  (Provider)
 *
 * The Time Service is the graph's append-only log; ingestion advances the
 * logical clock, so operational health and replay windows are derived, not
 * mocked.
 */
export interface InteractionFact {
    runId: string;
    sessionId: string;
    modelRouted: string;
    provider: string;
    promptSummary: string;
    responseSummary: string;
    evidenceHash: string;
    policyAdmitted: boolean;
    steeringFeatureId?: string;
    latencyMs: number;
    timestamp: string;
}
export declare function ingestInteraction(fact: InteractionFact): void;
export interface ConversationFact {
    conversationId: string;
    title?: string;
    sessionId?: string;
    workspaceMode?: string;
}
export declare function ingestConversation(fact: ConversationFact): string;
export interface MessageFact {
    messageId: string;
    conversationId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    createdAt: string;
    /** Previous message id in the thread, for NEXT/PREV ordering edges. */
    precededBy?: string;
    modelRouted?: string;
    evidenceHash?: string;
}
export declare function ingestMessage(fact: MessageFact): string;
export interface MemoryFact {
    scopeId: string;
    contentHash: string;
    text: string;
    sessionId?: string;
    evidenceRefs?: string[];
}
export declare function ingestMemory(fact: MemoryFact): string;
export interface CausalTriadFact {
    featureId: number;
    hook: string;
    prompt: string;
    schemaVersion: string;
    ablation?: {
        completion: string;
        originalActivation?: number;
        residDeltaNorm?: number;
    };
    positive?: {
        completion: string;
        originalActivation?: number;
        residDeltaNorm?: number;
    };
    negative?: {
        completion: string;
        originalActivation?: number;
        residDeltaNorm?: number;
    };
    sessionId?: string;
    timestamp: string;
}
export declare function ingestCausalTriad(fact: CausalTriadFact): string;
export interface DocumentIngestResult {
    documentId: string;
    filename: string;
    chunks: number;
    nodeIds: string[];
    preview: string[];
    entities: number;
}
export declare function ingestDocumentChunks(content: string, filename: string, mimeType?: string): DocumentIngestResult;
//# sourceMappingURL=ingest.d.ts.map