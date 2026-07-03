use hg_core::{
    clamp_unit, mean_abs, ArtifactId, AtomId, EpistemicMode, FieldState26, FieldValue,
    SecurityLabel, ValueKey, ValuePayload,
};
use hg_fieldpack::{provisional_pack_0001, FieldPack26};
use hg_kernel::{ArtifactDraft, CommitBatch, RuntimeStore, ValueDraft};
use hg_proof::{check_bounded_state, ProofArtifact};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FieldEvent {
    pub dim_index: usize,
    pub delta: f64,
}

pub trait FieldOperatorSemantics {
    fn name(&self) -> &'static str;
    fn apply(
        &self,
        pack: &FieldPack26,
        prior: &FieldState26,
        events: &[FieldEvent],
    ) -> FieldState26;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ProvisionalOperatorSemantics;

impl FieldOperatorSemantics for ProvisionalOperatorSemantics {
    fn name(&self) -> &'static str {
        "provisional_mean_abs_operator"
    }

    fn apply(
        &self,
        pack: &FieldPack26,
        prior: &FieldState26,
        events: &[FieldEvent],
    ) -> FieldState26 {
        let mut next = prior.clone();
        let mut deltas = vec![0.0_f64; pack.dims.len()];
        for event in events.iter() {
            if event.dim_index < pack.dims.len() {
                deltas[event.dim_index] += event.delta;
            }
        }

        for dim in pack.dims.iter() {
            let value = next.dims[dim.index] + deltas[dim.index];
            next.dims[dim.index] = clamp_unit(value);
        }

        let contradiction_mass = next.dims[18];
        let movement = mean_abs(&deltas);
        next.epsilon_eff = clamp_unit(movement + 0.5 * contradiction_mass);
        next
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeCommitOutput {
    pub commit_txn: u64,
    pub proof_artifact_ref: Option<ArtifactId>,
    pub next_state: FieldState26,
    pub proof: ProofArtifact,
}

pub fn apply_events(
    pack: &FieldPack26,
    prior: &FieldState26,
    events: &[FieldEvent],
) -> FieldState26 {
    ProvisionalOperatorSemantics.apply(pack, prior, events)
}

pub fn run_cycle_and_commit_with<S: RuntimeStore, O: FieldOperatorSemantics>(
    store: &mut S,
    subject_atom: AtomId,
    prior_snapshot_txn: u64,
    pack: &FieldPack26,
    operator: &O,
    events: &[FieldEvent],
    evidence_count: usize,
) -> Result<RuntimeCommitOutput, String> {
    let prior = store
        .read_field_at(subject_atom, prior_snapshot_txn)
        .map(|f| f.state.clone())
        .unwrap_or_else(FieldState26::zeroed);

    let next_state = operator.apply(pack, &prior, events);
    let proof = check_bounded_state(
        subject_atom,
        prior_snapshot_txn,
        pack,
        &next_state,
        evidence_count,
    );

    let field_value = FieldValue {
        field_pack_name: format!("{}@{}", pack.name, operator.name()),
        basis_version: pack.basis_version,
        basis_fingerprint_fnv1a64: pack.basis_fingerprint_fnv1a64(),
        state: next_state.clone(),
    };

    let receipt = store.commit_batch(CommitBatch {
        values: vec![
            ValueDraft {
                subject_atom,
                key: ValueKey::FieldCurrent,
                payload: ValuePayload::Field(field_value),
                epistemic_mode: EpistemicMode::BoundedSnapshot,
                security: SecurityLabel::Internal,
            },
            ValueDraft {
                subject_atom,
                key: ValueKey::ProofCurrent,
                payload: ValuePayload::Proof(proof.as_value_with_ref(None)),
                epistemic_mode: EpistemicMode::BoundedSnapshot,
                security: SecurityLabel::Internal,
            },
        ],
        artifacts: vec![ArtifactDraft::Proof {
            subject_atom,
            record: proof.to_record(),
        }],
    })?;

    let proof_artifact_ref = receipt
        .values
        .iter()
        .find(|v| v.subject_atom == subject_atom && v.key == ValueKey::ProofCurrent)
        .and_then(|v| match &v.payload {
            ValuePayload::Proof(p) => p.artifact_ref,
            _ => None,
        });

    Ok(RuntimeCommitOutput {
        commit_txn: receipt.txn,
        proof_artifact_ref,
        next_state,
        proof,
    })
}

pub fn run_cycle_and_commit<S: RuntimeStore>(
    store: &mut S,
    subject_atom: AtomId,
    prior_snapshot_txn: u64,
    events: &[FieldEvent],
    evidence_count: usize,
) -> Result<RuntimeCommitOutput, String> {
    let pack = provisional_pack_0001();
    let operator = ProvisionalOperatorSemantics;
    run_cycle_and_commit_with(
        store,
        subject_atom,
        prior_snapshot_txn,
        &pack,
        &operator,
        events,
        evidence_count,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use hg_core::ProofVerdict;
    use hg_fieldpack::CanonicalPackDraft;
    use hg_kernel::{JournaledStore, SpaceStore};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("{}_{}_{}.txt", name, std::process::id(), nanos))
    }

    #[derive(Debug, Clone, Copy)]
    struct MidpointOperator;

    impl FieldOperatorSemantics for MidpointOperator {
        fn name(&self) -> &'static str {
            "midpoint_operator"
        }

        fn apply(
            &self,
            pack: &FieldPack26,
            _prior: &FieldState26,
            _events: &[FieldEvent],
        ) -> FieldState26 {
            let mut next = FieldState26::zeroed();
            for dim in pack.dims.iter() {
                next.dims[dim.index] = (dim.lower + dim.upper) / 2.0;
            }
            next.epsilon_eff = 0.0;
            next
        }
    }

    fn authored_pack() -> FieldPack26 {
        let provisional = provisional_pack_0001();
        let mut draft = CanonicalPackDraft::from_provisional_skeleton();
        draft.epsilon_limit = provisional.epsilon_limit;
        for row in draft.rows.iter_mut() {
            let src = &provisional.dims[row.slot];
            row.canonical_name = Some(format!("canon_{}", src.name));
            row.canonical_domain = Some("unit_interval".to_string());
            row.lower = Some(src.lower);
            row.upper = Some(src.upper);
            row.polarity = Some(src.polarity);
            row.notes = Some(format!("canonicalized from provisional slot {}", src.index));
            row.source_slots = vec![src.index];
            row.status = hg_fieldpack::CanonicalizationStatus::Mapped;
        }
        draft.build_owned().unwrap().into_static().unwrap()
    }

    #[test]
    fn cycle_commit_publishes_field_proof_and_artifact() {
        let mut store = SpaceStore::new();
        let (subject, created_txn) = store.create_node("Service");

        let output = run_cycle_and_commit(
            &mut store,
            subject,
            created_txn,
            &[
                FieldEvent {
                    dim_index: 0,
                    delta: 0.8,
                },
                FieldEvent {
                    dim_index: 10,
                    delta: 0.75,
                },
                FieldEvent {
                    dim_index: 11,
                    delta: 0.75,
                },
                FieldEvent {
                    dim_index: 12,
                    delta: 0.70,
                },
                FieldEvent {
                    dim_index: 14,
                    delta: 0.70,
                },
                FieldEvent {
                    dim_index: 16,
                    delta: 0.70,
                },
                FieldEvent {
                    dim_index: 19,
                    delta: 0.70,
                },
                FieldEvent {
                    dim_index: 20,
                    delta: 0.90,
                },
                FieldEvent {
                    dim_index: 21,
                    delta: 0.80,
                },
                FieldEvent {
                    dim_index: 22,
                    delta: 0.70,
                },
                FieldEvent {
                    dim_index: 23,
                    delta: 0.60,
                },
            ],
            3,
        )
        .unwrap();

        let field = store.read_field_at(subject, output.commit_txn).unwrap();
        let proof = store.read_proof_at(subject, output.commit_txn).unwrap();
        assert_eq!(field.state, output.next_state);
        assert_eq!(proof.verdict, output.proof.verdict);
        assert!(output.proof_artifact_ref.is_some());
        assert!(store
            .read_artifact(output.proof_artifact_ref.unwrap())
            .is_some());
    }

    #[test]
    fn violating_cycle_is_visible_at_commit_snapshot() {
        let mut store = SpaceStore::new();
        let (subject, created_txn) = store.create_node("Service");

        let _baseline = run_cycle_and_commit(
            &mut store,
            subject,
            created_txn,
            &[
                FieldEvent {
                    dim_index: 0,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 1,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 3,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 7,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 9,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 10,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 11,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 12,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 14,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 16,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 19,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 20,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 21,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 22,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 23,
                    delta: 0.9,
                },
            ],
            3,
        )
        .unwrap();

        let snapshot = store.current_txn();
        let out = run_cycle_and_commit(
            &mut store,
            subject,
            snapshot,
            &[FieldEvent {
                dim_index: 2,
                delta: 0.5,
            }],
            3,
        )
        .unwrap();

        let proof = store.read_proof_at(subject, out.commit_txn).unwrap();
        assert_eq!(proof.verdict, ProofVerdict::Violated);
    }

    #[test]
    fn injected_operator_and_authored_pack_work() {
        let mut store = SpaceStore::new();
        let (subject, created_txn) = store.create_node("Service");
        let pack = authored_pack();
        let out = run_cycle_and_commit_with(
            &mut store,
            subject,
            created_txn,
            &pack,
            &MidpointOperator,
            &[],
            3,
        )
        .unwrap();
        assert_eq!(out.proof.verdict, ProofVerdict::Proved);
        let field = store.read_field_at(subject, out.commit_txn).unwrap();
        match &field.state {
            state => assert!(state.epsilon_eff <= pack.epsilon_limit),
        }
    }

    #[test]
    fn journaled_store_supports_runtime_checkpoint_and_reopen() {
        let journal = temp_path("hellgraph_runtime_journal");
        let mut store = JournaledStore::create_new(&journal).unwrap();
        let (subject, created_txn) = store.create_node("Service").unwrap();
        let out = run_cycle_and_commit(
            &mut store,
            subject,
            created_txn,
            &[
                FieldEvent {
                    dim_index: 0,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 1,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 3,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 7,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 9,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 10,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 11,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 12,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 14,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 16,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 19,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 20,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 21,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 22,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 23,
                    delta: 0.9,
                },
                FieldEvent {
                    dim_index: 25,
                    delta: 0.9,
                },
            ],
            3,
        )
        .unwrap();
        store.checkpoint_and_compact().unwrap();
        let reopened = JournaledStore::open_or_replay(&journal).unwrap();
        let proof = reopened
            .inner()
            .read_proof_at(subject, out.commit_txn)
            .unwrap();
        assert_eq!(proof.verdict, out.proof.verdict);
        std::fs::remove_file(&journal).ok();
        std::fs::remove_file(format!("{}.manifest", journal.to_string_lossy())).ok();
        std::fs::remove_file(format!("{}.checkpoint", journal.to_string_lossy())).ok();
    }
}
