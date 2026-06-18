"use strict";
/**
 * HellGraph — Sociosphere's graph substrate.
 *
 * A dual-model graph engine: a labeled property graph (TinkerPop-style nodes and
 * typed edges with properties) that also exposes an RDF triple view, so the same
 * data is queryable via Gremlin-style traversals and via SPARQL 1.1 basic graph
 * patterns. Designed for parity with Amazon Neptune / Blazegraph on the core query
 * surface, with a durable append-only log enabling point-in-time replay (the
 * Time Service).
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=types.js.map