/**
 * ECAN — Economic Attention Allocation for HellGraph.
 *
 * Implements a lightweight ECAN-inspired attention layer over FeatureAtom nodes:
 *   - STI (short-term importance): spikes on mention, spreads to neighbors, decays per session
 *   - LTI (long-term importance): accumulates slowly across sessions, never decays fast
 *   - VLTI (very-long-term): permanently important atoms (set manually or via LTI threshold)
 *
 * STI is the working-memory signal: what the graph is "thinking about" right now.
 * LTI is the semantic memory signal: what has consistently mattered over time.
 * Retrieval scoring multiplies base token score by (1 + sti_norm) so active concepts surface.
 */
export declare function getSTI(atomId: string): number;
export declare function getLTI(atomId: string): number;
export declare function getVLTI(atomId: string): boolean;
/** Normalized STI in [0,1] for use as a retrieval score multiplier. */
export declare function stiNorm(atomId: string): number;
/**
 * Stimulate an atom: bump STI by `amount`, accumulate LTI at 10% rate.
 * Call this every time an entity is mentioned in a message.
 */
export declare function stimulate(atomId: string, amount?: number): void;
/**
 * Spread attention from a stimulated atom to its neighbors.
 * Called after stimulate() for high-STI atoms.
 */
export declare function spreadAttention(atomId: string, decayFactor?: number): void;
export declare function setAdaptiveDecayFactor(factor: number): void;
export declare function getAdaptiveDecayFactor(): number;
/**
 * Decay all FeatureAtom STI values by `factor`.
 * Call at session boundary to simulate forgetting.
 * VLTI atoms are exempt — they never decay below 10% of STI_MAX.
 * If Prometheus SINDy has fitted a decay coefficient, uses it automatically.
 */
export declare function decayAll(factor?: number): number;
//# sourceMappingURL=ecan.d.ts.map