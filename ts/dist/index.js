"use strict";
/**
 * @socioprophet/hellgraph — TypeScript OpenCog-compatible AtomSpace metagraph
 * engine. Public API barrel.
 *
 * Extracted from the Noetica runtime so it can be shared (e.g. prophet-platform).
 * Includes: content-addressed AtomSpace, HellGraph store, PLN forward-chaining,
 * ECAN attention, pattern matcher, SPARQL/Gremlin, SHACL validation, Turtle,
 * Atomese projection, consolidation, ingestion, Prometheus SR, sidecar bridge,
 * and the OpenCog rocks-storage-node-style StorageNode client.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require("./atomspace"), exports);
__exportStar(require("./store"), exports);
__exportStar(require("./types"), exports);
__exportStar(require("./pln"), exports);
__exportStar(require("./ecan"), exports);
__exportStar(require("./patternMatcher"), exports);
__exportStar(require("./sparql"), exports);
__exportStar(require("./gremlin"), exports);
__exportStar(require("./shacl"), exports);
__exportStar(require("./turtle"), exports);
__exportStar(require("./atomese"), exports);
__exportStar(require("./consolidate"), exports);
__exportStar(require("./ingest"), exports);
__exportStar(require("./prometheus"), exports);
__exportStar(require("./sidecar"), exports);
__exportStar(require("./storage-client"), exports);
__exportStar(require("./cogserver"), exports);
__exportStar(require("./health"), exports);
__exportStar(require("./acr"), exports);
//# sourceMappingURL=index.js.map