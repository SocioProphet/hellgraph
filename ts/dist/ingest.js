"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractEntities = extractEntities;
exports.ingestEntities = ingestEntities;
exports.ingestInteraction = ingestInteraction;
exports.ingestConversation = ingestConversation;
exports.ingestMessage = ingestMessage;
exports.ingestMemory = ingestMemory;
exports.ingestCausalTriad = ingestCausalTriad;
exports.ingestDocumentChunks = ingestDocumentChunks;
const store_1 = require("./store");
const patternMatcher_1 = require("./patternMatcher");
const ecan_1 = require("./ecan");
const pln_1 = require("./pln");
const sidecar_1 = require("./sidecar");
const acr_1 = require("./acr");
// ─── Async enrichment: embeddings + LLM entity extraction ────────────────────
//
// These run fire-and-forget after the synchronous ingest so the graph gets richer
// over time without blocking the response path.
const OLLAMA_BASE = process.env['OLLAMA_HOST'] ?? 'http://127.0.0.1:11434';
const EMBED_MODEL = 'nomic-embed-text';
const LLM_EXTRACT_MODEL = 'llama3.2:3b';
async function _getEmbedding(text) {
    try {
        const res = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
            signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok)
            return null;
        const j = await res.json();
        return j.embedding ?? null;
    }
    catch {
        return null;
    }
}
function _cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += (a[i] ?? 0) * (b[i] ?? 0);
        na += (a[i] ?? 0) ** 2;
        nb += (b[i] ?? 0) ** 2;
    }
    return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
async function _extractEntitiesLLM(content) {
    const prompt = `Extract named entities from the text below. Return ONLY a JSON array of objects with fields: text (string), type (one of: PERSON, ORG, ROLE, CONCEPT, TOOL, RECORD). Include technical concepts, product names, proper nouns, and domain-specific terms the user seems to care about. Omit common words. Respond with only the JSON array, no other text.

Text: ${content.slice(0, 800)}

JSON:`;
    try {
        const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: LLM_EXTRACT_MODEL, prompt, stream: false }),
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok)
            return [];
        const j = await res.json();
        const raw = (j.response ?? '').trim();
        // Extract JSON array from response (model may wrap in markdown)
        const match = raw.match(/\[[\s\S]*\]/);
        if (!match)
            return [];
        const parsed = JSON.parse(match[0]);
        return parsed
            .filter(e => e.text && e.text.length >= 2)
            .map(e => ({
            surface: String(e.text),
            normalised: String(e.text).toLowerCase().trim().replace(/\s+/g, ' '),
            kind: String(e.type ?? 'FEATURE_ATOM'),
            primeSupport: classifyPrimes(String(e.text)),
            confidence: 0.72,
        }));
    }
    catch {
        return [];
    }
}
/**
 * Async enrichment pass fired fire-and-forget from ingestEntities().
 * Two jobs: (1) replace token Jaccard MERGE_PROPOSAL with Ollama cosine similarity,
 * (2) LLM entity extraction to catch semantic entities regex missed.
 */
async function _enrichAsync(atomIds, entities, timestamp) {
    const g = (0, store_1.getHellGraph)();
    // ── Job 1: Embedding-based MERGE_PROPOSAL ──────────────────────────────────
    // Fetch embeddings for all new entities, compare against cached embeddings on
    // existing atoms. nomic-embed-text is 274MB and fast locally.
    const embeddingCache = new Map();
    for (let i = 0; i < entities.length && i < atomIds.length; i++) {
        const atomId = atomIds[i];
        const ent = entities[i];
        const emb = await _getEmbedding(ent.normalised);
        if (!emb)
            continue;
        embeddingCache.set(atomId, emb);
        // Cache on the atom node so future comparisons can skip the Ollama call
        g.setNodeProperty(atomId, 'ecan:embedding', JSON.stringify(emb));
    }
    if (embeddingCache.size === 0)
        return; // Ollama not available — skip
    // Compare new embeddings against all existing FeatureAtoms that have cached embeddings
    const existingAtoms = g.allNodes().filter(n => n.labels.includes('FeatureAtom') && n.properties['ecan:embedding']);
    const highSimEdges = [];
    for (const [newId, newEmb] of embeddingCache) {
        for (const candidate of existingAtoms) {
            if (candidate.id === newId)
                continue;
            const cachedRaw = candidate.properties['ecan:embedding'];
            if (!cachedRaw || typeof cachedRaw !== 'string')
                continue;
            let candEmb;
            try {
                candEmb = JSON.parse(cachedRaw);
            }
            catch {
                continue;
            }
            const sim = _cosine(newEmb, candEmb);
            if (sim >= 0.92) {
                // Very high similarity — promote directly to RELATED_TO + queue for CSKG normalization
                g.addEdge('RELATED_TO', newId, candidate.id, {
                    epistemicClass: 'semantic',
                    confidence: sim,
                    promotionState: 'confirmed',
                    createdAt: timestamp,
                });
                highSimEdges.push({ node1: newId, relation: 'RELATED_TO', node2: candidate.id, sim });
            }
            else if (sim >= 0.85) {
                g.addEdge('MERGE_PROPOSAL', newId, candidate.id, {
                    epistemicClass: 'semantic',
                    confidence: sim,
                    promotionState: 'candidate',
                    createdAt: timestamp,
                });
            }
        }
    }
    // CSKG normalization: canonicalize new high-confidence RELATED_TO edges via sidecar.
    // Best-effort — normalizer failure never breaks the graph write.
    if (highSimEdges.length > 0) {
        (0, sidecar_1.normalizeThroughSidecar)(highSimEdges.map(e => ({ node1: e.node1, relation: e.relation, node2: e.node2 }))).then(normalized => {
            if (!normalized)
                return;
            for (const edge of normalized) {
                // addEdge is idempotent (AtomSpace structural hash) — merge cskg metadata back
                g.addEdge('RELATED_TO', edge.node1, edge.node2, {
                    epistemicClass: 'semantic',
                    promotionState: 'confirmed',
                    createdAt: timestamp,
                    cskg_edge_id: edge.edge_id,
                    cskg_normalized: true,
                });
            }
        }).catch(() => { });
    }
    // ── Job 2: LLM entity extraction ──────────────────────────────────────────
    // Fire llama3.2:3b to find semantic entities the regex pass missed.
    const llmEntities = await _extractEntitiesLLM(entities.map(e => e.surface).join(', '));
    for (const ent of llmEntities) {
        const atomId = `urn:regis:feature-atom:${ent.normalised.replace(/[^a-z0-9]/g, '-').slice(0, 80)}`;
        if (g.getNode(atomId))
            continue; // already in graph from regex pass — skip
        const existing = g.getNode(atomId);
        const existingPrimes = existing
            ? String(existing.properties['prime_support'] ?? '').split(',').filter(Boolean)
            : [];
        const mergedPrimes = [...new Set([...existingPrimes, ...ent.primeSupport])].join(',');
        g.addNode(atomId, [ent.kind, 'FeatureAtom'], {
            surface: ent.surface,
            normalised: ent.normalised,
            prime_support: mergedPrimes,
            confidence: ent.confidence,
            kind: ent.kind,
            extractedBy: 'llm',
        });
        (0, ecan_1.stimulate)(atomId, Math.round(ent.confidence * 100));
    }
}
// ─── Prime topic vocabulary ───────────────────────────────────────────────────
// Used to tag extracted entities with the prime context they belong to.
// Aligned to Identity Is Prime prime-topic decomposition.
const ENGINEER_TERMS = new Set([
    'api', 'sdk', 'cli', 'git', 'repo', 'branch', 'commit', 'merge', 'deploy', 'build',
    'docker', 'kubernetes', 'k8s', 'terraform', 'ci', 'cd', 'pipeline', 'webhook',
    'function', 'class', 'interface', 'type', 'schema', 'endpoint', 'middleware',
    'database', 'migration', 'query', 'index', 'cache', 'redis', 'postgres', 'mysql',
    'typescript', 'javascript', 'python', 'rust', 'go', 'java', 'c++', 'swift',
    'react', 'nextjs', 'node', 'bun', 'deno', 'webpack', 'vite', 'tailwind',
    'algorithm', 'complexity', 'runtime', 'memory', 'thread', 'async', 'promise',
    'test', 'spec', 'lint', 'typecheck', 'coverage', 'benchmark',
]);
const RESEARCHER_TERMS = new Set([
    'paper', 'arxiv', 'doi', 'citation', 'hypothesis', 'experiment', 'dataset',
    'model', 'training', 'fine-tuning', 'inference', 'embedding', 'vector',
    'neural', 'transformer', 'attention', 'layer', 'weight', 'gradient',
    'loss', 'accuracy', 'precision', 'recall', 'f1', 'benchmark', 'evaluation',
    'ablation', 'baseline', 'sota', 'prior work', 'related work',
]);
const SECURITY_TERMS = new Set([
    'vulnerability', 'cve', 'exploit', 'payload', 'injection', 'xss', 'sqli',
    'overflow', 'rop', 'shellcode', 'backdoor', 'malware', 'ransomware',
    'pentest', 'red team', 'blue team', 'ctf', 'reverse engineering',
    'fuzzing', 'afl', 'sanitizer', 'heap', 'stack', 'canary', 'aslr', 'pie',
    'authentication', 'authorization', 'privilege', 'escalation', 'bypass',
    'cipher', 'hash', 'signature', 'certificate', 'tls', 'ssl', 'mitm',
]);
const HEALTH_TERMS = new Set([
    'patient', 'diagnosis', 'treatment', 'medication', 'dosage', 'symptom',
    'clinical', 'trial', 'ehr', 'icd', 'cpt', 'hipaa', 'phi', 'fhir',
    'drug', 'therapy', 'protocol', 'biomarker', 'genomics', 'phenotype',
]);
function classifyPrimes(text) {
    const lower = text.toLowerCase();
    const tokens = lower.split(/[\s\-_./\\()[\]{},;:'"!?<>@#$%^&*+=|~`]+/);
    const primes = new Set();
    for (const tok of tokens) {
        if (ENGINEER_TERMS.has(tok))
            primes.add('ENGINEER');
        if (RESEARCHER_TERMS.has(tok))
            primes.add('RESEARCHER');
        if (SECURITY_TERMS.has(tok))
            primes.add('SECURITY_RESEARCHER');
        if (HEALTH_TERMS.has(tok))
            primes.add('HEALTH');
    }
    if (primes.size === 0)
        primes.add('CITIZEN');
    return [...primes];
}
function classifyNodeKind(text, _tokens) {
    // File paths
    if (/^[~/.]/.test(text) || /\.(ts|js|py|rs|go|json|yaml|md|sh|txt)$/.test(text))
        return 'RECORD';
    // URLs
    if (/^https?:\/\//.test(text))
        return 'RECORD';
    // Person-like: "First Last" pattern
    if (/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(text))
        return 'PERSON';
    // Role-like: ends with common role suffixes
    if (/(?:engineer|researcher|developer|manager|analyst|scientist|architect|founder|cto|ceo|vp|director)$/i.test(text))
        return 'ROLE';
    // Org-like: Inc, LLC, Corp, Ltd suffix
    if (/(?:inc\.?|llc\.?|corp\.?|ltd\.?|company|organization|foundation)$/i.test(text))
        return 'ORG';
    // Default: FEATURE_ATOM
    return 'FEATURE_ATOM';
}
function extractEntities(content) {
    const results = [];
    const seen = new Set();
    function add(surface, confidence) {
        const norm = surface.trim().toLowerCase().replace(/\s+/g, ' ');
        if (norm.length < 3 || seen.has(norm))
            return;
        seen.add(norm);
        const kind = classifyNodeKind(surface.trim(), norm.split(' '));
        const primeSupport = classifyPrimes(surface.trim());
        results.push({ surface: surface.trim(), normalised: norm, kind, primeSupport, confidence });
    }
    // Quoted strings (highest confidence — user explicitly named them)
    const quotedRe = /"([^"]{2,80})"|'([^']{2,80})'/g;
    let m;
    while ((m = quotedRe.exec(content)) !== null) {
        const s = m[1] ?? m[2] ?? '';
        if (s)
            add(s, 0.9);
    }
    // Backtick code references
    const btRe = /`([^`]{2,60})`/g;
    while ((m = btRe.exec(content)) !== null) {
        if (m[1])
            add(m[1], 0.85);
    }
    // File paths
    const pathRe = /(?:^|\s)((?:[~.]\/|\/)[^\s,;:'"(){}\[\]]{3,80})/gm;
    while ((m = pathRe.exec(content)) !== null) {
        if (m[1])
            add(m[1], 0.8);
    }
    // CamelCase identifiers (code symbols)
    const camelRe = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;
    while ((m = camelRe.exec(content)) !== null) {
        if (m[1] && m[1].length <= 60)
            add(m[1], 0.75);
    }
    // snake_case / kebab-case identifiers
    const snakeRe = /\b([a-z][a-z0-9]*(?:[_-][a-z][a-z0-9]+){1,8})\b/g;
    while ((m = snakeRe.exec(content)) !== null) {
        if (m[1] && m[1].length >= 6 && m[1].length <= 60)
            add(m[1], 0.7);
    }
    // Capitalised multi-word phrases (project names, people, orgs)
    const capRe = /\b([A-Z][a-zA-Z]{1,}(?:\s+[A-Z][a-zA-Z]{1,}){1,4})\b/g;
    while ((m = capRe.exec(content)) !== null) {
        if (m[1] && m[1].length <= 80)
            add(m[1], 0.65);
    }
    return results;
}
function ingestEntities(interactionId, _sessionId, content, timestamp) {
    const g = (0, store_1.getHellGraph)();
    const entities = extractEntities(content);
    for (const ent of entities) {
        const atomId = `urn:regis:feature-atom:${ent.normalised.replace(/[^a-z0-9]/g, '-').slice(0, 80)}`;
        // Upsert the FEATURE_ATOM node — prime_support is cumulative across sessions
        const existing = g.getNode(atomId);
        const existingPrimes = existing
            ? String(existing.properties['prime_support'] ?? '').split(',').filter(Boolean)
            : [];
        const mergedPrimes = [...new Set([...existingPrimes, ...ent.primeSupport])].join(',');
        const isNew = !existing;
        g.addNode(atomId, [ent.kind, 'FeatureAtom'], {
            surface: ent.surface,
            normalised: ent.normalised,
            prime_support: mergedPrimes,
            confidence: ent.confidence,
            kind: ent.kind,
        });
        // Epistemic MENTIONED_IN edge: atom → interaction
        g.addEdge('MENTIONED_IN', atomId, `urn:noetica:interaction:${interactionId}`, {
            epistemicClass: 'graph_extraction',
            confidence: ent.confidence,
            promotionState: 'confirmed',
            createdAt: timestamp,
        });
        // ECAN: stimulate attention on this atom, scaled by extraction confidence
        (0, ecan_1.stimulate)(atomId, Math.round(ent.confidence * 120));
        if (ent.confidence >= 0.8)
            (0, ecan_1.spreadAttention)(atomId);
        // ACR: record full extraction lifecycle for new high-confidence entities
        if (isNew && ent.confidence >= 0.8) {
            try {
                (0, acr_1.recordEntityExtraction)({
                    surface: ent.surface,
                    normalised: ent.normalised,
                    kind: ent.kind,
                    confidence: ent.confidence,
                    extractedBy: 'regex',
                    interactionId,
                    primeScopes: ent.primeSupport,
                    timestamp,
                });
            }
            catch { /* ACR failure must never break the ingest path */ }
        }
    }
    // ─── Async enrichment: embedding similarity + LLM extraction ──────────────────
    // Fire-and-forget: enriches the graph after the synchronous pass without blocking.
    const _atomIds = entities.map(ent => `urn:regis:feature-atom:${ent.normalised.replace(/[^a-z0-9]/g, '-').slice(0, 80)}`);
    _enrichAsync(_atomIds, entities, timestamp).catch(() => { });
    // ─── Derive COOCCURS_WITH edges for entities co-occurring in this interaction ─
    // Entities mentioned in the same exchange are structurally related — linking them
    // enables the pattern matcher to expand retrieval context across co-occurrence chains.
    const atomIds = entities.map(ent => `urn:regis:feature-atom:${ent.normalised.replace(/[^a-z0-9]/g, '-').slice(0, 80)}`);
    const coMax = Math.min(atomIds.length, 20); // cap to keep edge growth linear
    for (let i = 0; i < coMax; i++) {
        for (let j = i + 1; j < coMax; j++) {
            g.addEdge('COOCCURS_WITH', atomIds[i], atomIds[j], {
                epistemicClass: 'co_occurrence',
                confidence: 0.8,
                promotionState: 'confirmed',
                createdAt: timestamp,
            });
        }
    }
    // ─── Promote high-confidence MERGE_PROPOSAL → RELATED_TO via pattern matcher ─
    // Jaccard ≥ 0.7 is strong enough to treat as a confirmed semantic relation.
    // Promotes candidates to a traversable RELATED_TO edge that retrieval uses directly.
    const as = g.atomspace();
    const mergePattern = {
        clauses: [
            (0, patternMatcher_1.L)('EvaluationLink', (0, patternMatcher_1.N)('PredicateNode', 'MERGE_PROPOSAL'), (0, patternMatcher_1.L)('ListLink', (0, patternMatcher_1.V)('src'), (0, patternMatcher_1.V)('tgt'))),
        ],
        select: ['src', 'tgt'],
    };
    try {
        const mergeResult = (0, patternMatcher_1.findMatches)(as, mergePattern);
        for (const grounding of mergeResult.groundings) {
            const srcAtom = grounding['src'] ? as.getAtom(grounding['src']) : undefined;
            const tgtAtom = grounding['tgt'] ? as.getAtom(grounding['tgt']) : undefined;
            if (!srcAtom?.name || !tgtAtom?.name)
                continue;
            const edges = g.outEdges(srcAtom.name, 'MERGE_PROPOSAL');
            const edge = edges.find(e => e.to === tgtAtom.name);
            if (edge && Number(edge.properties['confidence'] ?? 0) >= 0.7) {
                const conf = Number(edge.properties['confidence'] ?? 0);
                g.addEdge('RELATED_TO', srcAtom.name, tgtAtom.name, {
                    epistemicClass: 'semantic',
                    confidence: conf,
                    promotionState: 'confirmed',
                    createdAt: timestamp,
                });
                // ACR: every merge requires a DecisionLedgerEntry per contract invariant
                try {
                    (0, acr_1.assertDecisionLedgerEntry)({
                        decision_id: `${srcAtom.name.split(':').pop()}:${tgtAtom.name.split(':').pop()}:${Date.now()}`,
                        decision_type: 'merge',
                        subject_refs: [srcAtom.name, tgtAtom.name],
                        confidence: conf,
                        reason: 'merge_proposal_promotion',
                        policy_id: 'policy://hellgraph/default-promotion@0.1.0',
                        created_by: 'system',
                        created_at: timestamp,
                    });
                }
                catch { /* governance failure must never break ingest */ }
            }
        }
    }
    catch { /* skip if pattern space is empty */ }
    // PLN forward chaining: run every 5th ingest to derive 2-hop RELATED_TO edges.
    // Throttled because it scans all RELATED_TO edges — too expensive per message.
    _ingestCount++;
    if (_ingestCount % 5 === 0) {
        try {
            (0, pln_1.forwardChain)();
        }
        catch { /* skip if graph is empty */ }
    }
    // Sync to sidecar every 10th ingest, then pull back any PLN-derived edges the Python
    // side computed that the TypeScript graph doesn't have yet (bidirectional sync).
    if (_ingestCount % 10 === 0) {
        (0, sidecar_1.syncToSidecar)()
            .then(() => (0, sidecar_1.pullFromSidecar)())
            .catch(() => { });
    }
}
let _ingestCount = 0;
function ingestInteraction(fact) {
    const g = (0, store_1.getHellGraph)();
    const sessionNode = `urn:noetica:session:${fact.sessionId}`;
    const interactionNode = `urn:noetica:interaction:${fact.runId}`;
    const modelNode = `urn:noetica:model:${fact.modelRouted}`;
    const providerNode = `urn:noetica:provider:${fact.provider}`;
    const evidenceNode = `urn:noetica:evidence:${fact.evidenceHash}`;
    g.addNode(sessionNode, ['Session'], { sessionId: fact.sessionId });
    g.addNode(interactionNode, ['Interaction', 'ProviderCall'], {
        runId: fact.runId,
        promptSummary: fact.promptSummary.slice(0, 280),
        responseSummary: fact.responseSummary.slice(0, 280),
        policyAdmitted: fact.policyAdmitted,
        latencyMs: fact.latencyMs,
        timestamp: fact.timestamp,
    });
    g.addNode(modelNode, ['Model'], { modelId: fact.modelRouted });
    g.addNode(providerNode, ['Provider'], { providerId: fact.provider });
    g.addNode(evidenceNode, ['Evidence'], { hash: fact.evidenceHash });
    g.addEdge('HAS_INTERACTION', sessionNode, interactionNode, { at: fact.timestamp });
    g.addEdge('ROUTED_TO', interactionNode, modelNode);
    g.addEdge('OFFERED_BY', modelNode, providerNode);
    g.addEdge('PRODUCED', interactionNode, evidenceNode, { at: fact.timestamp });
    if (fact.steeringFeatureId) {
        const featureNode = `urn:noetica:sae-feature:${fact.steeringFeatureId}`;
        g.addNode(featureNode, ['SaeFeature'], { featureId: fact.steeringFeatureId });
        g.addEdge('STEERED_BY', interactionNode, featureNode);
    }
}
function ingestConversation(fact) {
    const g = (0, store_1.getHellGraph)();
    const convNode = `urn:noetica:conversation:${fact.conversationId}`;
    g.addNode(convNode, ['Conversation'], {
        conversationId: fact.conversationId,
        ...(fact.title ? { title: fact.title.slice(0, 200) } : {}),
        ...(fact.workspaceMode ? { workspaceMode: fact.workspaceMode } : {}),
    });
    if (fact.sessionId) {
        const sessionNode = `urn:noetica:session:${fact.sessionId}`;
        g.addNode(sessionNode, ['Session'], { sessionId: fact.sessionId });
        g.addEdge('IN_SESSION', convNode, sessionNode);
    }
    return convNode;
}
function ingestMessage(fact) {
    const g = (0, store_1.getHellGraph)();
    const convNode = `urn:noetica:conversation:${fact.conversationId}`;
    const msgNode = `urn:noetica:message:${fact.messageId}`;
    g.addNode(convNode, ['Conversation'], { conversationId: fact.conversationId });
    g.addNode(msgNode, ['Message', roleLabel(fact.role)], {
        messageId: fact.messageId,
        role: fact.role,
        content: fact.content.slice(0, 2000),
        createdAt: fact.createdAt,
    });
    g.addEdge('HAS_MESSAGE', convNode, msgNode, { at: fact.createdAt });
    if (fact.precededBy) {
        const prevNode = `urn:noetica:message:${fact.precededBy}`;
        g.addEdge('NEXT', prevNode, msgNode);
    }
    if (fact.modelRouted) {
        const modelNode = `urn:noetica:model:${fact.modelRouted}`;
        g.addNode(modelNode, ['Model'], { modelId: fact.modelRouted });
        g.addEdge('GENERATED_BY', msgNode, modelNode);
    }
    if (fact.evidenceHash) {
        const evidenceNode = `urn:noetica:evidence:${fact.evidenceHash}`;
        g.addNode(evidenceNode, ['Evidence'], { hash: fact.evidenceHash });
        g.addEdge('PRODUCED', msgNode, evidenceNode);
    }
    return msgNode;
}
function ingestMemory(fact) {
    const g = (0, store_1.getHellGraph)();
    const scopeNode = `urn:noetica:memory-scope:${fact.scopeId}`;
    const memNode = `urn:noetica:memory:${fact.contentHash}`;
    g.addNode(scopeNode, ['MemoryScope'], { scopeId: fact.scopeId });
    g.addNode(memNode, ['MemoryEntry'], {
        contentHash: fact.contentHash,
        text: fact.text.slice(0, 1000),
    });
    g.addEdge('IN_SCOPE', memNode, scopeNode);
    for (const ref of fact.evidenceRefs ?? []) {
        const evidenceNode = `urn:noetica:evidence:${ref}`;
        g.addNode(evidenceNode, ['Evidence'], { hash: ref });
        g.addEdge('GROUNDED_BY', memNode, evidenceNode);
    }
    return memNode;
}
function ingestCausalTriad(fact) {
    const g = (0, store_1.getHellGraph)();
    const triadId = `${fact.featureId}:${fact.timestamp}`;
    const triadNode = `urn:noetica:causal-triad:${triadId}`;
    const featureNode = `urn:noetica:sae-feature:${fact.featureId}`;
    g.addNode(featureNode, ['SaeFeature'], { featureId: String(fact.featureId) });
    g.addNode(triadNode, ['CausalTriad', 'M1Certification'], {
        featureId: String(fact.featureId),
        hook: fact.hook,
        prompt: fact.prompt.slice(0, 280),
        schemaVersion: fact.schemaVersion,
        timestamp: fact.timestamp,
    });
    g.addEdge('HAS_TRIAD', featureNode, triadNode, { at: fact.timestamp });
    for (const [armName, edge] of [
        ['ablation', 'ABLATION_ARM'],
        ['positive', 'POSITIVE_ARM'],
        ['negative', 'NEGATIVE_ARM'],
    ]) {
        const arm = fact[armName];
        if (!arm)
            continue;
        const armNode = `urn:noetica:triad-arm:${triadId}:${armName}`;
        g.addNode(armNode, ['TriadArm'], {
            arm: armName,
            completion: arm.completion.slice(0, 500),
            ...(arm.originalActivation !== undefined ? { originalActivation: arm.originalActivation } : {}),
            ...(arm.residDeltaNorm !== undefined ? { residDeltaNorm: arm.residDeltaNorm } : {}),
        });
        g.addEdge(edge, triadNode, armNode);
    }
    if (fact.sessionId) {
        const sessionNode = `urn:noetica:session:${fact.sessionId}`;
        g.addNode(sessionNode, ['Session'], { sessionId: fact.sessionId });
        g.addEdge('IN_SESSION', triadNode, sessionNode);
    }
    return triadNode;
}
function roleLabel(role) {
    return role === 'user' ? 'UserMessage' : role === 'assistant' ? 'AssistantMessage' : 'SystemMessage';
}
// ─── Document ingest ──────────────────────────────────────────────────────────
// Chunks a document, stores each chunk as a RECORD node in HellGraph,
// and extracts entities from the full text. Returns a preview for the UI.
const CHUNK_SIZE = 1500; // chars per chunk
const CHUNK_OVERLAP = 200; // overlap between adjacent chunks
function chunkText(text) {
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        const end = Math.min(start + CHUNK_SIZE, text.length);
        chunks.push(text.slice(start, end));
        if (end === text.length)
            break;
        start = end - CHUNK_OVERLAP;
    }
    return chunks;
}
function ingestDocumentChunks(content, filename, mimeType = 'text/plain') {
    const g = (0, store_1.getHellGraph)();
    const timestamp = new Date().toISOString();
    const docId = `urn:regis:record:${filename.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${Date.now()}`;
    // Root document node
    g.addNode(docId, ['RECORD', 'Document'], {
        filename,
        mimeType,
        ingestedAt: timestamp,
        charCount: content.length,
    });
    const chunks = chunkText(content);
    const nodeIds = [docId];
    for (let i = 0; i < chunks.length; i++) {
        const chunkId = `${docId}:chunk:${i}`;
        g.addNode(chunkId, ['RECORD', 'DocumentChunk'], {
            filename,
            chunkIndex: i,
            content: chunks[i].slice(0, 800), // store first 800 chars per chunk
            charCount: chunks[i].length,
            createdAt: timestamp,
        });
        g.addEdge('HAS_CHUNK', docId, chunkId, {
            chunkIndex: i,
            epistemicClass: 'confirmed_relation',
            confidence: 1.0,
            promotionState: 'confirmed',
            createdAt: timestamp,
        });
        nodeIds.push(chunkId);
    }
    // Entity extraction on full document text
    const entities = extractEntities(content);
    for (const ent of entities) {
        const atomId = `urn:regis:feature-atom:${ent.normalised.replace(/[^a-z0-9]/g, '-').slice(0, 80)}`;
        const existing = g.getNode(atomId);
        const existingPrimes = existing
            ? String(existing.properties['prime_support'] ?? '').split(',').filter(Boolean)
            : [];
        const mergedPrimes = [...new Set([...existingPrimes, ...ent.primeSupport])].join(',');
        g.addNode(atomId, [ent.kind, 'FeatureAtom'], {
            surface: ent.surface,
            normalised: ent.normalised,
            prime_support: mergedPrimes,
            confidence: ent.confidence,
            kind: ent.kind,
        });
        g.addEdge('MENTIONED_IN', atomId, docId, {
            epistemicClass: 'graph_extraction',
            confidence: ent.confidence,
            promotionState: 'confirmed',
            createdAt: timestamp,
        });
    }
    return {
        documentId: docId,
        filename,
        chunks: chunks.length,
        nodeIds,
        preview: chunks.slice(0, 3).map((c) => c.slice(0, 120).replace(/\n+/g, ' ')),
        entities: entities.length,
    };
}
//# sourceMappingURL=ingest.js.map