use hg_core::{
    fnv1a64_str, AtomId, BoundViolationRecord, FieldState26, ProofArtifactRecord, ProofValue,
    ProofVerdict, TxnId,
};
use hg_fieldpack::FieldPack26;

#[derive(Debug, Clone, PartialEq)]
pub struct BoundViolation {
    pub dim_index: usize,
    pub dim_name: &'static str,
    pub value: f64,
    pub lower: f64,
    pub upper: f64,
    pub magnitude: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProofArtifact {
    pub subject_atom: AtomId,
    pub snapshot_txn: TxnId,
    pub field_pack_name: &'static str,
    pub field_pack_basis_version: u32,
    pub basis_fingerprint_fnv1a64: u64,
    pub assumptions_fingerprint_fnv1a64: u64,
    pub evidence_basis_fingerprint_fnv1a64: u64,
    pub verdict: ProofVerdict,
    pub evidence_count: usize,
    pub epsilon_eff: f64,
    pub max_violation_magnitude: f64,
    pub violated: Vec<BoundViolation>,
    pub insufficiency_reason: Option<&'static str>,
    pub witness_summary: Option<&'static str>,
    pub counterexample_summary: Option<String>,
}

impl ProofArtifact {
    pub fn to_record(&self) -> ProofArtifactRecord {
        ProofArtifactRecord {
            subject_atom: self.subject_atom,
            snapshot_txn: self.snapshot_txn,
            field_pack_name: self.field_pack_name.to_string(),
            field_pack_basis_version: self.field_pack_basis_version,
            basis_fingerprint_fnv1a64: self.basis_fingerprint_fnv1a64,
            assumptions_fingerprint_fnv1a64: self.assumptions_fingerprint_fnv1a64,
            evidence_basis_fingerprint_fnv1a64: self.evidence_basis_fingerprint_fnv1a64,
            verdict: self.verdict,
            evidence_count: self.evidence_count,
            epsilon_eff: self.epsilon_eff,
            max_violation_magnitude: self.max_violation_magnitude,
            violated: self
                .violated
                .iter()
                .map(|v| BoundViolationRecord {
                    dim_index: v.dim_index,
                    dim_name: v.dim_name.to_string(),
                    value: v.value,
                    lower: v.lower,
                    upper: v.upper,
                    magnitude: v.magnitude,
                })
                .collect(),
            insufficiency_reason: self.insufficiency_reason.map(|s| s.to_string()),
            witness_summary: self.witness_summary.map(|s| s.to_string()),
            counterexample_summary: self.counterexample_summary.clone(),
        }
    }

    pub fn as_value_with_ref(&self, artifact_ref: Option<u128>) -> ProofValue {
        ProofValue {
            verdict: self.verdict,
            artifact_ref,
            evidence_count: self.evidence_count,
            epsilon_eff: self.epsilon_eff,
            max_violation_magnitude: self.max_violation_magnitude,
            insufficiency_reason: self.insufficiency_reason.map(|s| s.to_string()),
        }
    }
}

fn assumptions_fingerprint(pack: &FieldPack26) -> u64 {
    fnv1a64_str(&format!(
        "bounded_state_conformance|{}|{}|{}|{:.17}",
        pack.name,
        pack.basis_version,
        pack.basis_fingerprint_fnv1a64(),
        pack.epsilon_limit
    ))
}

fn evidence_basis_fingerprint(
    subject_atom: AtomId,
    snapshot_txn: TxnId,
    state: &FieldState26,
    evidence_count: usize,
) -> u64 {
    let dims = state
        .dims
        .iter()
        .map(|v| format!("{:.17}", v))
        .collect::<Vec<_>>()
        .join(",");
    fnv1a64_str(&format!(
        "{}|{}|{}|{:.17}|{}",
        subject_atom, snapshot_txn, evidence_count, state.epsilon_eff, dims
    ))
}

pub fn check_bounded_state(
    subject_atom: AtomId,
    snapshot_txn: TxnId,
    pack: &FieldPack26,
    state: &FieldState26,
    evidence_count: usize,
) -> ProofArtifact {
    let mut violated = Vec::new();
    for dim in pack.dims.iter() {
        let value = state.dims[dim.index];
        if value < dim.lower || value > dim.upper {
            let magnitude = if value < dim.lower {
                dim.lower - value
            } else {
                value - dim.upper
            };
            violated.push(BoundViolation {
                dim_index: dim.index,
                dim_name: dim.name,
                value,
                lower: dim.lower,
                upper: dim.upper,
                magnitude,
            });
        }
    }

    let epsilon_violation = if state.epsilon_eff > pack.epsilon_limit {
        state.epsilon_eff - pack.epsilon_limit
    } else {
        0.0
    };

    let max_violation_magnitude = violated
        .iter()
        .map(|v| v.magnitude)
        .fold(epsilon_violation, f64::max);

    let (verdict, insufficiency_reason, witness_summary, counterexample_summary) = if evidence_count < 1 {
        (
            ProofVerdict::Inconclusive,
            Some("no_evidence"),
            None,
            None,
        )
    } else if !violated.is_empty() || epsilon_violation > 0.0 {
        (
            ProofVerdict::Violated,
            None,
            None,
            Some(format!(
                "violations={} epsilon_excess={:.17}",
                violated.len(), epsilon_violation
            )),
        )
    } else if evidence_count < 3 {
        (
            ProofVerdict::Inconclusive,
            Some("insufficient_positive_evidence"),
            None,
            None,
        )
    } else {
        (
            ProofVerdict::Proved,
            None,
            Some("all_dimensions_within_declared_bounds"),
            None,
        )
    };

    ProofArtifact {
        subject_atom,
        snapshot_txn,
        field_pack_name: pack.name,
        field_pack_basis_version: pack.basis_version,
        basis_fingerprint_fnv1a64: pack.basis_fingerprint_fnv1a64(),
        assumptions_fingerprint_fnv1a64: assumptions_fingerprint(pack),
        evidence_basis_fingerprint_fnv1a64: evidence_basis_fingerprint(
            subject_atom,
            snapshot_txn,
            state,
            evidence_count,
        ),
        verdict,
        evidence_count,
        epsilon_eff: state.epsilon_eff,
        max_violation_magnitude,
        violated,
        insufficiency_reason,
        witness_summary,
        counterexample_summary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hg_core::FieldState26;
    use hg_fieldpack::provisional_pack_0001;

    #[test]
    fn produces_proved() {
        let pack = provisional_pack_0001();
        let mut state = FieldState26::zeroed();
        for dim in pack.dims.iter() {
            state.dims[dim.index] = (dim.lower + dim.upper) / 2.0;
        }
        state.epsilon_eff = 0.10;
        let proof = check_bounded_state(1, 1, &pack, &state, 3);
        assert_eq!(proof.verdict, ProofVerdict::Proved);
        assert!(proof.witness_summary.is_some());
        let record = proof.to_record();
        assert_eq!(record.verdict, ProofVerdict::Proved);
    }

    #[test]
    fn produces_violated() {
        let pack = provisional_pack_0001();
        let mut state = FieldState26::zeroed();
        for dim in pack.dims.iter() {
            state.dims[dim.index] = (dim.lower + dim.upper) / 2.0;
        }
        state.dims[2] = 0.90;
        let proof = check_bounded_state(1, 1, &pack, &state, 3);
        assert_eq!(proof.verdict, ProofVerdict::Violated);
        assert!(!proof.violated.is_empty());
        assert!(proof.counterexample_summary.is_some());
    }
}
