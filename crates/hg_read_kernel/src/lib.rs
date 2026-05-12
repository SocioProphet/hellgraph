use hg_core::{Atom, AtomId, FieldValue, LinkSemantics, ProofValue, TxnId, ValueEnvelope};
use hg_kernel::{JournaledStore, RuntimeStore, SpaceStore};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncidentLinkSummary {
    pub link_atom: AtomId,
    pub link_type: String,
    pub semantics: LinkSemantics,
    pub roles: Vec<(String, AtomId, u16)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SubjectSnapshotSummary {
    pub subject_atom: AtomId,
    pub snapshot_txn: TxnId,
    pub atom_type: Option<String>,
    pub field: Option<FieldValue>,
    pub proof: Option<ProofValue>,
    pub active_value_count: usize,
    pub incident_links: Vec<IncidentLinkSummary>,
}

pub trait ReadKernelStore {
    fn atom_by_id(&self, atom_id: AtomId) -> Option<&Atom>;
    fn all_values(&self) -> &[ValueEnvelope];
    fn all_atoms(&self) -> Vec<&Atom>;
    fn read_field_at(&self, subject_atom: AtomId, snapshot_txn: TxnId) -> Option<&FieldValue>;
    fn read_proof_at(&self, subject_atom: AtomId, snapshot_txn: TxnId) -> Option<&ProofValue>;
}

impl ReadKernelStore for SpaceStore {
    fn atom_by_id(&self, atom_id: AtomId) -> Option<&Atom> {
        self.atom(atom_id)
    }

    fn all_values(&self) -> &[ValueEnvelope] {
        self.values()
    }

    fn all_atoms(&self) -> Vec<&Atom> {
        self.atoms().values().collect()
    }

    fn read_field_at(&self, subject_atom: AtomId, snapshot_txn: TxnId) -> Option<&FieldValue> {
        SpaceStore::read_field_at(self, subject_atom, snapshot_txn)
    }

    fn read_proof_at(&self, subject_atom: AtomId, snapshot_txn: TxnId) -> Option<&ProofValue> {
        SpaceStore::read_proof_at(self, subject_atom, snapshot_txn)
    }
}

impl ReadKernelStore for JournaledStore {
    fn atom_by_id(&self, atom_id: AtomId) -> Option<&Atom> {
        self.inner().atom(atom_id)
    }

    fn all_values(&self) -> &[ValueEnvelope] {
        self.inner().values()
    }

    fn all_atoms(&self) -> Vec<&Atom> {
        self.inner().atoms().values().collect()
    }

    fn read_field_at(&self, subject_atom: AtomId, snapshot_txn: TxnId) -> Option<&FieldValue> {
        RuntimeStore::read_field_at(self, subject_atom, snapshot_txn)
    }

    fn read_proof_at(&self, subject_atom: AtomId, snapshot_txn: TxnId) -> Option<&ProofValue> {
        RuntimeStore::read_proof_at(self, subject_atom, snapshot_txn)
    }
}

pub fn incident_links<S: ReadKernelStore>(store: &S, subject_atom: AtomId) -> Vec<IncidentLinkSummary> {
    let mut out = store
        .all_atoms()
        .into_iter()
        .filter_map(|atom| match atom {
            Atom::Link(link) => {
                let matches = link.members.iter().any(|m| m.target == subject_atom);
                if !matches {
                    return None;
                }
                Some(IncidentLinkSummary {
                    link_atom: link.hdr.atom_id,
                    link_type: link.hdr.type_name.clone(),
                    semantics: link.semantics,
                    roles: link
                        .members
                        .iter()
                        .map(|m| (m.role_name.clone(), m.target, m.ordinal))
                        .collect(),
                })
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    out.sort_by_key(|l| l.link_atom);
    out
}

pub fn active_value_count_at<S: ReadKernelStore>(store: &S, subject_atom: AtomId, snapshot_txn: TxnId) -> usize {
    store
        .all_values()
        .iter()
        .filter(|v| v.subject_atom == subject_atom)
        .filter(|v| v.committed_at_txn <= snapshot_txn)
        .filter(|v| v.retired_at_txn.map(|t| t > snapshot_txn).unwrap_or(true))
        .count()
}

pub fn snapshot_subject<S: ReadKernelStore>(store: &S, subject_atom: AtomId, snapshot_txn: TxnId) -> SubjectSnapshotSummary {
    let atom_type = store.atom_by_id(subject_atom).map(|atom| match atom {
        Atom::Node(n) => n.hdr.type_name.clone(),
        Atom::Link(l) => l.hdr.type_name.clone(),
    });
    SubjectSnapshotSummary {
        subject_atom,
        snapshot_txn,
        atom_type,
        field: store.read_field_at(subject_atom, snapshot_txn).cloned(),
        proof: store.read_proof_at(subject_atom, snapshot_txn).cloned(),
        active_value_count: active_value_count_at(store, subject_atom, snapshot_txn),
        incident_links: incident_links(store, subject_atom),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hg_core::{LinkSemantics, RoleBinding};
    use hg_kernel::JournaledStore;
    use hg_runtime::{run_cycle_and_commit, FieldEvent};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("{}_{}_{}.log", name, std::process::id(), nanos))
    }

    #[test]
    fn snapshot_subject_reports_field_proof_and_links_for_space_store() {
        let mut store = SpaceStore::new();
        let (service, service_txn) = store.create_node("Service");
        let (artifact, _) = store.create_node("Artifact");
        store
            .create_link(
                "Owns",
                LinkSemantics::DirectedBinary,
                vec![
                    RoleBinding { role_name: "src".into(), target: service, ordinal: 0 },
                    RoleBinding { role_name: "dst".into(), target: artifact, ordinal: 1 },
                ],
            )
            .unwrap();

        let out = run_cycle_and_commit(
            &mut store,
            service,
            service_txn,
            &[FieldEvent { dim_index: 0, delta: 0.85 }, FieldEvent { dim_index: 20, delta: 0.9 }, FieldEvent { dim_index: 21, delta: 0.9 }],
            3,
        )
        .unwrap();

        let snap = snapshot_subject(&store, service, out.commit_txn);
        assert_eq!(snap.subject_atom, service);
        assert!(snap.field.is_some());
        assert!(snap.proof.is_some());
        assert_eq!(snap.active_value_count, 2);
        assert_eq!(snap.incident_links.len(), 1);
    }

    #[test]
    fn snapshot_subject_survives_journal_reopen() {
        let path = temp_path("hg_read_kernel_reopen");
        let mut store = JournaledStore::create_new(&path).unwrap();
        let (service, service_txn) = store.create_node("Service").unwrap();
        let (peer, _) = store.create_node("Peer").unwrap();
        store
            .create_link(
                "Trusts",
                LinkSemantics::DirectedBinary,
                vec![
                    RoleBinding { role_name: "src".into(), target: service, ordinal: 0 },
                    RoleBinding { role_name: "dst".into(), target: peer, ordinal: 1 },
                ],
            )
            .unwrap();
        let out = run_cycle_and_commit(
            &mut store,
            service,
            service_txn,
            &[FieldEvent { dim_index: 0, delta: 0.9 }, FieldEvent { dim_index: 20, delta: 0.9 }, FieldEvent { dim_index: 21, delta: 0.9 }],
            3,
        )
        .unwrap();
        drop(store);

        let reopened = JournaledStore::open_or_replay(&path).unwrap();
        let snap = snapshot_subject(&reopened, service, out.commit_txn);
        assert!(snap.field.is_some());
        assert!(snap.proof.is_some());
        assert_eq!(snap.incident_links.len(), 1);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}.manifest", path.to_string_lossy()));
        let _ = std::fs::remove_file(format!("{}.checkpoint", path.to_string_lossy()));
    }
}
