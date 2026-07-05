//! Fiber-bundle ingest + cross-fiber verdict on the hellgraph substrate.
//!
//! SP-RETR-FIBER-001. The Python `fiber_projection.to_bundle` (the reference oracle) emits a
//! language-neutral, node_id-keyed bundle:
//!
//! ```text
//! N<TAB>node_id<TAB>node_kind                        // atom
//! C<TAB>parent_node_id<TAB>child_node_id             // E^⊑ containment
//! R<TAB>rel_type<TAB>src_node_id<TAB>dst_node_id     // E_R relational
//! A<TAB>node_id<TAB>anchor_ref                       // page anchor (provenance-of-location)
//! K<TAB>node_id<TAB>claim_var<TAB>value<TAB>egrade   // claim atom (fiber-product input)
//! ```
//!
//! `ingest_bundle` replays N/C/R into a `SpaceStore` via the real `create_node` /
//! `create_link_classed` path — minting the store's own `AtomId`s — so the two edge classes
//! reconstitute on the actual engine and `hg_read_kernel::incident_links_of_class` cleanly
//! separates the fibers (containment) from the cross-document links (relational).
//!
//! N/C/R are graph STRUCTURE and live in the real store. A/K are fiber-retrieval DOMAIN data:
//! hellgraph's `ValuePayload` models only `Field`/`Proof`, not arbitrary strings/scalars, so
//! page anchors and ownership claims ride an [`IngestResult`] SIDECAR next to the store rather
//! than being forced into core graph values. That sidecar is what lets the cross-fiber
//! fiber-product verdict ([`glue_verdict`], [`verdict_relational`]) and double grounding run on
//! the substrate — not just in Python. Same bundle in, same verdict out: cross-impl parity.

use std::collections::BTreeMap;

use hg_core::{AtomId, EdgeClass, LinkSemantics, RoleBinding};
use hg_kernel::SpaceStore;
use hg_read_kernel::incident_links_of_class;

/// A claim atom evidenced at a node: a canonical `(var)` slot bound to a `value` at an `egrade`.
#[derive(Debug, Clone, PartialEq)]
pub struct Claim {
    pub var: String,
    pub value: f64,
    pub egrade: String,
}

/// The result of ingesting a bundle: the graph is in the store; this holds the id map plus the
/// fiber-retrieval sidecar (anchors + claims) that hellgraph's value system cannot represent.
#[derive(Debug, Default)]
pub struct IngestResult {
    pub ids: BTreeMap<String, AtomId>,     // node_id -> minted AtomId
    pub anchors: BTreeMap<AtomId, String>, // provenance-of-location
    pub claims: BTreeMap<AtomId, Vec<Claim>>, // fiber-product verdict inputs
}

/// The cross-fiber verdict — the status of the constraint fiber product over shared claim vars.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Pos,  // fibers agree on the overlap (a global section glues)
    Zero, // vacuous cover: no shared claim variable, no test possible
    Neg,  // overlap exists but the fibers provably disagree (obstruction)
}

/// A verdicted relational edge, doubly grounded when both endpoints are anchor-reachable.
#[derive(Debug, Clone, PartialEq)]
pub struct EdgeVerdict {
    pub src: AtomId,
    pub dst: AtomId,
    pub rel_type: String,
    pub verdict: Verdict,
    pub witness: Option<(String, f64, f64)>, // (var, src_value, dst_value)
    pub doubly_grounded: bool,               // both endpoints have a page anchor
}

fn role(name: &str, target: AtomId, ordinal: u16) -> RoleBinding {
    RoleBinding {
        role_name: name.to_string(),
        target,
        ordinal,
    }
}

fn fields(line: &str) -> Vec<&str> {
    line.split('\t').collect()
}

/// Ingest a fiber-bundle into `store`, returning the graph id-map + the anchor/claim sidecar.
///
/// Two passes: all `N` nodes first (so edges/anchors/claims resolve regardless of order), then
/// `C`/`R` edges and `A`/`K` sidecar data. Any line referencing an unknown node_id, or a
/// malformed line, is an error — nothing is guessed.
pub fn ingest_bundle(store: &mut SpaceStore, text: &str) -> Result<IngestResult, String> {
    let mut out = IngestResult::default();

    // pass 1 — nodes
    for line in text.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let f = fields(line);
        if f[0] == "N" {
            if f.len() != 3 {
                return Err(format!("malformed N line: {line:?}"));
            }
            let (atom_id, _) = store.create_node(f[2].to_string());
            if out.ids.insert(f[1].to_string(), atom_id).is_some() {
                return Err(format!("duplicate node_id: {}", f[1]));
            }
        }
    }

    // pass 2 — edges (C/R) + sidecar (A/K)
    for line in text.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let f = fields(line);
        let lookup = |nid: &str| -> Result<AtomId, String> {
            out.ids
                .get(nid)
                .copied()
                .ok_or_else(|| format!("line references unknown node_id: {nid}"))
        };
        match f[0] {
            "N" => {}
            "C" => {
                if f.len() != 3 {
                    return Err(format!("malformed C line: {line:?}"));
                }
                let (parent, child) = (lookup(f[1])?, lookup(f[2])?);
                store.create_link_classed(
                    "contains",
                    LinkSemantics::DirectedBinary,
                    EdgeClass::Containment,
                    vec![role("parent", parent, 0), role("child", child, 1)],
                )?;
            }
            "R" => {
                if f.len() != 4 {
                    return Err(format!("malformed R line: {line:?}"));
                }
                let (src, dst) = (lookup(f[2])?, lookup(f[3])?);
                store.create_link_classed(
                    f[1],
                    LinkSemantics::DirectedBinary,
                    EdgeClass::Relational,
                    vec![role("src", src, 0), role("dst", dst, 1)],
                )?;
            }
            "A" => {
                if f.len() != 3 {
                    return Err(format!("malformed A line: {line:?}"));
                }
                out.anchors.insert(lookup(f[1])?, f[2].to_string());
            }
            "K" => {
                if f.len() != 5 {
                    return Err(format!("malformed K line: {line:?}"));
                }
                let atom = lookup(f[1])?;
                let value = f[3]
                    .parse::<f64>()
                    .map_err(|_| format!("K line has non-numeric value: {line:?}"))?;
                out.claims.entry(atom).or_default().push(Claim {
                    var: f[2].to_string(),
                    value,
                    egrade: f[4].to_string(),
                });
            }
            other => return Err(format!("unknown bundle verb: {other:?}")),
        }
    }

    Ok(out)
}

/// Verdict configuration (mirrors the Python `glue_verdict` params, axis-binding §2.2).
#[derive(Debug, Clone)]
pub struct VerdictCfg {
    /// Reject a shared claim graded below this (`exact` > `verified` > `sampled`) — the
    /// forced-ZERO extraction floor (§3.4.3): a below-floor claim means no test is possible.
    pub e_floor: String,
    /// Value-agreement tolerance; `0.0` = exact. `|a - b| <= tol` counts as agreement.
    pub tol: f64,
}

impl Default for VerdictCfg {
    fn default() -> Self {
        Self {
            e_floor: "sampled".to_string(),
            tol: 0.0,
        }
    }
}

/// Evidence-grade rank (axis-binding §2.2). Unknown grades rank below the floor (untrusted).
fn egrade_rank(g: &str) -> i8 {
    match g {
        "exact" => 2,
        "verified" => 1,
        "sampled" => 0,
        _ => -1,
    }
}

/// The fiber-product verdict over two endpoints' claims (§3.3/§3.4): POS if every shared claim
/// variable agrees (within `cfg.tol`), NEG (with a disagreeing witness) if any shared variable
/// provably differs, ZERO if there is no shared variable — or if any shared claim is below
/// `cfg.e_floor` (the forced-ZERO floor: an untrusted claim can't settle the test).
pub fn glue_verdict(
    a: &[Claim],
    b: &[Claim],
    cfg: &VerdictCfg,
) -> (Verdict, Option<(String, f64, f64)>) {
    let floor = egrade_rank(&cfg.e_floor);
    let bmap: BTreeMap<&str, &Claim> = b.iter().map(|c| (c.var.as_str(), c)).collect();
    let mut agree: Option<(String, f64, f64)> = None;
    let mut shared = false;
    for c in a {
        if let Some(cb) = bmap.get(c.var.as_str()) {
            shared = true;
            // forced-ZERO floor (§3.4.3): a below-floor claim on either side ⇒ no test possible.
            if egrade_rank(&c.egrade) < floor || egrade_rank(&cb.egrade) < floor {
                return (Verdict::Zero, None);
            }
            if (c.value - cb.value).abs() > cfg.tol {
                return (Verdict::Neg, Some((c.var.clone(), c.value, cb.value)));
            }
            agree = Some((c.var.clone(), c.value, cb.value));
        }
    }
    if shared {
        (Verdict::Pos, agree)
    } else {
        (Verdict::Zero, None)
    }
}

/// Verdict every `rel_type` relational edge on the real substrate: find the edge via
/// `incident_links_of_class(Relational)`, pull both endpoints' claims from the sidecar, and mark
/// it doubly grounded iff both endpoints are anchor-reachable. Deterministic order (by src,dst).
pub fn verdict_relational(
    store: &SpaceStore,
    r: &IngestResult,
    rel_type: &str,
    cfg: &VerdictCfg,
) -> Vec<EdgeVerdict> {
    let mut edges: BTreeMap<AtomId, (AtomId, AtomId)> = BTreeMap::new(); // link_atom -> (src,dst)
    for &atom in r.ids.values() {
        for l in incident_links_of_class(store, atom, EdgeClass::Relational) {
            if l.link_type != rel_type {
                continue;
            }
            let src = l
                .roles
                .iter()
                .find(|(n, _, _)| n == "src")
                .map(|(_, t, _)| *t);
            let dst = l
                .roles
                .iter()
                .find(|(n, _, _)| n == "dst")
                .map(|(_, t, _)| *t);
            if let (Some(s), Some(d)) = (src, dst) {
                edges.insert(l.link_atom, (s, d));
            }
        }
    }
    let empty: Vec<Claim> = Vec::new();
    let mut out: Vec<EdgeVerdict> = edges
        .into_values()
        .map(|(src, dst)| {
            let (verdict, witness) = glue_verdict(
                r.claims.get(&src).unwrap_or(&empty),
                r.claims.get(&dst).unwrap_or(&empty),
                cfg,
            );
            EdgeVerdict {
                src,
                dst,
                rel_type: rel_type.to_string(),
                verdict,
                witness,
                doubly_grounded: r.anchors.contains_key(&src) && r.anchors.contains_key(&dst),
            }
        })
        .collect();
    out.sort_by_key(|e| (e.src, e.dst));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // The golden parity vector — byte-identical to agentplane
    // tools/tests/fixtures/fiber_ownership.bundle (emitted by fiber_projection.to_bundle).
    const BUNDLE: &str = concat!(
        "N\tentity/parentco\torganization\n",
        "N\tentity/subco\torganization\n",
        "N\tfiling-A/root\tdocument\n",
        "N\tfiling-A/s4.2\tclause\n",
        "N\tfiling-B/root\tdocument\n",
        "N\tfiling-B/s2.1\tclause\n",
        "C\tfiling-A/root\tfiling-A/s4.2\n",
        "C\tfiling-A/s4.2\tentity/parentco\n",
        "C\tfiling-B/root\tfiling-B/s2.1\n",
        "C\tfiling-B/s2.1\tentity/subco\n",
        "R\tgleif-L2:isDirectParentOf\tentity/parentco\tentity/subco\n",
        "A\tentity/parentco\tfiling-A#p87§4.2\n",
        "A\tentity/subco\tfiling-B#p14§2.1\n",
        "K\tentity/parentco\towns_pct:parentco|subco\t100\tverified\n",
        "K\tentity/subco\towns_pct:parentco|subco\t100\tverified\n",
    );

    const REL: &str = "gleif-L2:isDirectParentOf";

    #[test]
    fn ingest_reconstitutes_structure_and_sidecar() {
        let mut store = SpaceStore::new();
        let r = ingest_bundle(&mut store, BUNDLE).unwrap();
        assert_eq!(r.ids.len(), 6);

        let parentco = r.ids["entity/parentco"];
        let subco = r.ids["entity/subco"];
        let s42 = r.ids["filing-A/s4.2"];

        // structure lives in the real store; edge classes separate cleanly.
        let rel = incident_links_of_class(&store, parentco, EdgeClass::Relational);
        assert_eq!(rel.len(), 1);
        assert_eq!(rel[0].link_type, REL);
        assert_eq!(
            incident_links_of_class(&store, parentco, EdgeClass::Containment).len(),
            1
        );
        assert_eq!(
            incident_links_of_class(&store, s42, EdgeClass::Containment).len(),
            2
        );

        // sidecar carries anchors + claims (what the value system can't).
        assert_eq!(r.anchors[&parentco], "filing-A#p87§4.2");
        assert_eq!(r.anchors[&subco], "filing-B#p14§2.1");
        assert_eq!(r.claims[&parentco][0].var, "owns_pct:parentco|subco");
        assert_eq!(r.claims[&parentco][0].value, 100.0);
        assert_eq!(r.claims[&subco][0].egrade, "verified");
    }

    #[test]
    fn verdict_is_pos_and_doubly_grounded_on_agreement() {
        let mut store = SpaceStore::new();
        let r = ingest_bundle(&mut store, BUNDLE).unwrap();
        let verdicts = verdict_relational(&store, &r, REL, &VerdictCfg::default());
        assert_eq!(verdicts.len(), 1);
        let e = &verdicts[0];
        assert_eq!(e.verdict, Verdict::Pos);
        assert_eq!(
            e.witness,
            Some(("owns_pct:parentco|subco".to_string(), 100.0, 100.0))
        );
        // both endpoints are anchor-reachable → the answer is doubly grounded (§6.3).
        assert!(e.doubly_grounded);
        assert_eq!(e.src, r.ids["entity/parentco"]);
        assert_eq!(e.dst, r.ids["entity/subco"]);
    }

    #[test]
    fn verdict_is_neg_with_witness_on_cross_document_contradiction() {
        // SubCo's filing disagrees on the ownership percentage.
        let bundle = BUNDLE.replace(
            "K\tentity/subco\towns_pct:parentco|subco\t100\tverified",
            "K\tentity/subco\towns_pct:parentco|subco\t60\tverified",
        );
        let mut store = SpaceStore::new();
        let r = ingest_bundle(&mut store, &bundle).unwrap();
        let e = &verdict_relational(&store, &r, REL, &VerdictCfg::default())[0];
        assert_eq!(e.verdict, Verdict::Neg);
        assert_eq!(
            e.witness,
            Some(("owns_pct:parentco|subco".to_string(), 100.0, 60.0))
        );
        assert!(e.doubly_grounded); // a contradiction is still a grounded finding
    }

    #[test]
    fn verdict_is_zero_without_a_shared_claim() {
        // Drop SubCo's claim → no shared variable → no test possible.
        let bundle = BUNDLE.replace(
            "K\tentity/subco\towns_pct:parentco|subco\t100\tverified\n",
            "",
        );
        let mut store = SpaceStore::new();
        let r = ingest_bundle(&mut store, &bundle).unwrap();
        let e = &verdict_relational(&store, &r, REL, &VerdictCfg::default())[0];
        assert_eq!(e.verdict, Verdict::Zero);
        assert_eq!(e.witness, None);
    }

    #[test]
    fn forced_zero_when_a_shared_claim_is_below_the_e_floor() {
        // SubCo's claim is only `sampled`; with an E_floor of `verified` the claim can't
        // settle the test → ZERO (not a POS on an untrusted number).
        let bundle = BUNDLE.replace(
            "K\tentity/subco\towns_pct:parentco|subco\t100\tverified",
            "K\tentity/subco\towns_pct:parentco|subco\t100\tsampled",
        );
        let mut store = SpaceStore::new();
        let r = ingest_bundle(&mut store, &bundle).unwrap();
        let cfg = VerdictCfg {
            e_floor: "verified".to_string(),
            tol: 0.0,
        };
        let e = &verdict_relational(&store, &r, REL, &cfg)[0];
        assert_eq!(e.verdict, Verdict::Zero);
        // ...but at the default `sampled` floor the same data is testable, and agrees → POS.
        let e2 = &verdict_relational(&store, &r, REL, &VerdictCfg::default())[0];
        assert_eq!(e2.verdict, Verdict::Pos);
    }

    #[test]
    fn tolerance_turns_a_small_disagreement_into_agreement() {
        // SubCo reports 100.4 vs ParentCo's 100.
        let bundle = BUNDLE.replace(
            "K\tentity/subco\towns_pct:parentco|subco\t100\tverified",
            "K\tentity/subco\towns_pct:parentco|subco\t100.4\tverified",
        );
        let mut store = SpaceStore::new();
        let r = ingest_bundle(&mut store, &bundle).unwrap();
        // exact (tol 0.0) → NEG (a real 0.4 disagreement)
        let exact = &verdict_relational(&store, &r, REL, &VerdictCfg::default())[0];
        assert_eq!(exact.verdict, Verdict::Neg);
        // within a 0.5 tolerance → POS
        let loose = VerdictCfg {
            e_floor: "sampled".to_string(),
            tol: 0.5,
        };
        assert_eq!(
            verdict_relational(&store, &r, REL, &loose)[0].verdict,
            Verdict::Pos
        );
    }

    #[test]
    fn ingest_rejects_a_dangling_edge() {
        let mut store = SpaceStore::new();
        let err = ingest_bundle(&mut store, "R\towns\tghost/a\tghost/b\n").unwrap_err();
        assert!(err.contains("unknown node_id"));
    }

    #[test]
    fn ingest_rejects_a_malformed_claim() {
        let mut store = SpaceStore::new();
        let bundle = "N\ta\torg\nK\ta\tv\tNOTANUMBER\tverified\n";
        assert!(ingest_bundle(&mut store, bundle).is_err());
    }
}
