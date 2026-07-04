//! Fiber-bundle ingest: rebuild the composite graph H on the hellgraph substrate.
//!
//! SP-RETR-FIBER-001. The Python `fiber_projection.to_bundle` (the reference oracle) emits a
//! language-neutral, node_id-keyed bundle:
//!
//! ```text
//! N<TAB>node_id<TAB>node_kind
//! C<TAB>parent_node_id<TAB>child_node_id           // E^⊑ containment
//! R<TAB>rel_type<TAB>src_node_id<TAB>dst_node_id    // E_R relational
//! ```
//!
//! `ingest_bundle` replays it into a `SpaceStore` via the real `create_node` /
//! `create_link_classed` path — minting the store's own `AtomId`s — so the two edge classes
//! reconstitute on the actual engine and `hg_read_kernel::incident_links_of_class` cleanly
//! separates the fibers (containment) from the cross-document links (relational). This is the
//! Rust half of the cross-impl parity contract: given the same bundle, Python and hellgraph
//! agree on the shape of H. Structural in v0 — anchors/labels/claims layer in once the value
//! write-path is bound to the bundle.

use std::collections::BTreeMap;

use hg_core::{AtomId, EdgeClass, LinkSemantics, RoleBinding};
use hg_kernel::SpaceStore;

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

/// Ingest a fiber-bundle into `store`, returning `node_id -> minted AtomId`.
///
/// Two passes: all `N` nodes first (so edges can resolve either endpoint regardless of order),
/// then `C`/`R` edges. Any edge referencing an unknown node_id, or a malformed line, is an error
/// — nothing is guessed.
pub fn ingest_bundle(
    store: &mut SpaceStore,
    text: &str,
) -> Result<BTreeMap<String, AtomId>, String> {
    let mut ids: BTreeMap<String, AtomId> = BTreeMap::new();

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
            if ids.insert(f[1].to_string(), atom_id).is_some() {
                return Err(format!("duplicate node_id: {}", f[1]));
            }
        }
    }

    // pass 2 — edges
    for line in text.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let f = fields(line);
        let lookup = |nid: &str| -> Result<AtomId, String> {
            ids.get(nid)
                .copied()
                .ok_or_else(|| format!("edge references unknown node_id: {nid}"))
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
            other => return Err(format!("unknown bundle verb: {other:?}")),
        }
    }

    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hg_read_kernel::incident_links_of_class;

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
    );

    #[test]
    fn ingest_reconstitutes_the_two_edge_classes_on_the_real_substrate() {
        let mut store = SpaceStore::new();
        let ids = ingest_bundle(&mut store, BUNDLE).unwrap();
        assert_eq!(ids.len(), 6);

        let parentco = ids["entity/parentco"];
        let subco = ids["entity/subco"];
        let s42 = ids["filing-A/s4.2"];

        // E_R: parentco --isDirectParentOf--> subco, and NOTHING containment-shaped leaks in.
        let rel = incident_links_of_class(&store, parentco, EdgeClass::Relational);
        assert_eq!(rel.len(), 1);
        assert_eq!(rel[0].link_type, "gleif-L2:isDirectParentOf");
        assert!(rel.iter().all(|l| l.edge_class == EdgeClass::Relational));

        // E^⊑: parentco is the child of exactly one containment link; no relational shows here.
        let cont = incident_links_of_class(&store, parentco, EdgeClass::Containment);
        assert_eq!(cont.len(), 1);
        assert_eq!(cont[0].link_type, "contains");

        // A mid-tree node sits on two containment links (child of root, parent of the entity)
        // and zero relational — the fibers are pure trees.
        assert_eq!(
            incident_links_of_class(&store, s42, EdgeClass::Containment).len(),
            2
        );
        assert!(incident_links_of_class(&store, s42, EdgeClass::Relational).is_empty());

        // The two entities live in different fibers, joined ONLY by the relational edge.
        assert_eq!(
            incident_links_of_class(&store, subco, EdgeClass::Relational).len(),
            1
        );
    }

    #[test]
    fn ingest_rejects_a_dangling_edge() {
        let mut store = SpaceStore::new();
        let err = ingest_bundle(&mut store, "R\towns\tghost/a\tghost/b\n").unwrap_err();
        assert!(err.contains("unknown node_id"));
    }

    #[test]
    fn ingest_rejects_an_unknown_verb() {
        let mut store = SpaceStore::new();
        assert!(ingest_bundle(&mut store, "X\tnope\n").is_err());
    }
}
