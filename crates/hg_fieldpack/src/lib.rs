use std::convert::TryInto;

use hg_core::{DimSpec, Polarity, FIELD_DIMENSIONS};

#[derive(Debug, Clone)]
pub struct FieldPack26 {
    pub artifact_id: u128,
    pub name: &'static str,
    pub basis_version: u32,
    pub epsilon_limit: f64,
    pub dims: [DimSpec; FIELD_DIMENSIONS],
}

impl FieldPack26 {
    pub fn validate(&self) -> Result<(), String> {
        for (expected, dim) in self.dims.iter().enumerate() {
            if dim.index != expected {
                return Err(format!(
                    "dimension index mismatch at slot {}: found {}",
                    expected, dim.index
                ));
            }
            if dim.lower < 0.0 || dim.upper > 1.0 || dim.lower > dim.upper {
                return Err(format!("invalid bounds for {}", dim.name));
            }
        }
        if !(0.0..=1.0).contains(&self.epsilon_limit) {
            return Err("epsilon_limit must be in [0,1]".to_string());
        }
        Ok(())
    }

    pub fn basis_fingerprint_fnv1a64(&self) -> u64 {
        fn mix_u64(mut h: u64, x: u8) -> u64 {
            h ^= x as u64;
            h = h.wrapping_mul(0x100000001b3);
            h
        }
        let mut h: u64 = 0xcbf29ce484222325;
        for dim in self.dims.iter() {
            for b in dim.name.as_bytes() {
                h = mix_u64(h, *b);
            }
            for b in dim.notes.as_bytes() {
                h = mix_u64(h, *b);
            }
            for b in dim.index.to_le_bytes() {
                h = mix_u64(h, b);
            }
            for b in dim.lower.to_le_bytes() {
                h = mix_u64(h, b);
            }
            for b in dim.upper.to_le_bytes() {
                h = mix_u64(h, b);
            }
            let pol = match dim.polarity {
                Polarity::HigherIsBetter => 1u8,
                Polarity::LowerIsBetter => 2u8,
            };
            h = mix_u64(h, pol);
        }
        h
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OwnedDimSpec {
    pub index: usize,
    pub name: String,
    pub lower: f64,
    pub upper: f64,
    pub polarity: Polarity,
    pub notes: String,
    pub domain: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OwnedFieldPack26 {
    pub artifact_id: u128,
    pub name: String,
    pub basis_version: u32,
    pub epsilon_limit: f64,
    pub dims: [OwnedDimSpec; FIELD_DIMENSIONS],
}

impl OwnedFieldPack26 {
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errs = Vec::new();
        if !(0.0..=1.0).contains(&self.epsilon_limit) {
            errs.push("epsilon_limit must be in [0,1]".to_string());
        }
        for (expected, dim) in self.dims.iter().enumerate() {
            if dim.index != expected {
                errs.push(format!(
                    "dimension index mismatch at slot {}: found {}",
                    expected, dim.index
                ));
            }
            if dim.name.trim().is_empty() {
                errs.push(format!("dimension {} has empty canonical name", expected));
            }
            if dim.domain.trim().is_empty() {
                errs.push(format!("dimension {} has empty canonical domain", expected));
            }
            if dim.lower < 0.0 || dim.upper > 1.0 || dim.lower > dim.upper {
                errs.push(format!("dimension {} has invalid bounds", dim.name));
            }
        }
        if errs.is_empty() {
            Ok(())
        } else {
            Err(errs)
        }
    }

    pub fn into_static(self) -> Result<FieldPack26, Vec<String>> {
        self.validate()?;
        let name: &'static str = Box::leak(self.name.into_boxed_str());
        let dims_vec = self
            .dims
            .into_iter()
            .map(|dim| DimSpec {
                index: dim.index,
                name: Box::leak(dim.name.into_boxed_str()),
                lower: dim.lower,
                upper: dim.upper,
                polarity: dim.polarity,
                notes: Box::leak(dim.notes.into_boxed_str()),
            })
            .collect::<Vec<_>>();
        let dims: [DimSpec; FIELD_DIMENSIONS] = dims_vec.try_into().expect("26 dims");
        Ok(FieldPack26 {
            artifact_id: self.artifact_id,
            name,
            basis_version: self.basis_version,
            epsilon_limit: self.epsilon_limit,
            dims,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanonicalizationStatus {
    Unmapped,
    Mapped,
    Deprecated,
    Split,
    Merged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalizationRow {
    pub slot: usize,
    pub provisional_name: &'static str,
    pub canonical_name: Option<String>,
    pub canonical_domain: Option<String>,
    pub status: CanonicalizationStatus,
    pub notes: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackMigrationSkeleton {
    pub from_pack_name: &'static str,
    pub to_pack_name: &'static str,
    pub row_count: usize,
    pub rows: Vec<CanonicalizationRow>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalPackAuthoringRow {
    pub slot: usize,
    pub provisional_hint: &'static str,
    pub canonical_name: Option<String>,
    pub canonical_domain: Option<String>,
    pub lower: Option<f64>,
    pub upper: Option<f64>,
    pub polarity: Option<Polarity>,
    pub notes: Option<String>,
    pub source_slots: Vec<usize>,
    pub status: CanonicalizationStatus,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalPackDraft {
    pub artifact_id: u128,
    pub name: String,
    pub basis_version: u32,
    pub epsilon_limit: f64,
    pub rows: Vec<CanonicalPackAuthoringRow>,
}

impl CanonicalPackDraft {
    pub fn from_provisional_skeleton() -> Self {
        let pack = provisional_pack_0001();
        let rows = pack
            .dims
            .iter()
            .map(|dim| CanonicalPackAuthoringRow {
                slot: dim.index,
                provisional_hint: dim.name,
                canonical_name: None,
                canonical_domain: None,
                lower: None,
                upper: None,
                polarity: None,
                notes: None,
                source_slots: Vec::new(),
                status: CanonicalizationStatus::Unmapped,
            })
            .collect();
        Self {
            artifact_id: 1001,
            name: "FieldPack-0001-Canonical".to_string(),
            basis_version: 1,
            epsilon_limit: pack.epsilon_limit,
            rows,
        }
    }

    pub fn validate_ready(&self) -> Result<(), Vec<String>> {
        let mut errs = Vec::new();
        if self.rows.len() != FIELD_DIMENSIONS {
            errs.push(format!(
                "expected {} canonical rows, found {}",
                FIELD_DIMENSIONS,
                self.rows.len()
            ));
        }
        let mut seen = vec![0usize; FIELD_DIMENSIONS];
        for row in &self.rows {
            if row.slot >= FIELD_DIMENSIONS {
                errs.push(format!("slot {} out of range", row.slot));
                continue;
            }
            seen[row.slot] += 1;
            if matches!(row.status, CanonicalizationStatus::Unmapped) {
                errs.push(format!("slot {} is still unmapped", row.slot));
            }
            if row
                .canonical_name
                .as_ref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
            {
                errs.push(format!("slot {} missing canonical_name", row.slot));
            }
            if row
                .canonical_domain
                .as_ref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
            {
                errs.push(format!("slot {} missing canonical_domain", row.slot));
            }
            if row
                .notes
                .as_ref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
            {
                errs.push(format!("slot {} missing notes", row.slot));
            }
            match (row.lower, row.upper) {
                (Some(l), Some(u)) => {
                    if l < 0.0 || u > 1.0 || l > u {
                        errs.push(format!(
                            "slot {} has invalid bounds [{}, {}]",
                            row.slot, l, u
                        ));
                    }
                }
                _ => errs.push(format!("slot {} missing bounds", row.slot)),
            }
            if row.polarity.is_none() {
                errs.push(format!("slot {} missing polarity", row.slot));
            }
            if row.source_slots.is_empty() {
                errs.push(format!("slot {} missing source slot mapping", row.slot));
            }
        }
        for (slot, count) in seen.into_iter().enumerate() {
            if count != 1 {
                errs.push(format!("slot {} occurs {} times", slot, count));
            }
        }
        if !(0.0..=1.0).contains(&self.epsilon_limit) {
            errs.push("epsilon_limit must be in [0,1]".to_string());
        }
        if errs.is_empty() {
            Ok(())
        } else {
            Err(errs)
        }
    }

    pub fn build_owned(&self) -> Result<OwnedFieldPack26, Vec<String>> {
        self.validate_ready()?;
        let mut rows = self.rows.clone();
        rows.sort_by_key(|r| r.slot);
        let dims_vec = rows
            .into_iter()
            .map(|row| OwnedDimSpec {
                index: row.slot,
                name: row.canonical_name.expect("validated"),
                lower: row.lower.expect("validated"),
                upper: row.upper.expect("validated"),
                polarity: row.polarity.expect("validated"),
                notes: row.notes.expect("validated"),
                domain: row.canonical_domain.expect("validated"),
            })
            .collect::<Vec<_>>();
        let dims: [OwnedDimSpec; FIELD_DIMENSIONS] = dims_vec.try_into().expect("26 dims");
        let owned = OwnedFieldPack26 {
            artifact_id: self.artifact_id,
            name: self.name.clone(),
            basis_version: self.basis_version,
            epsilon_limit: self.epsilon_limit,
            dims,
        };
        owned.validate()?;
        Ok(owned)
    }
}

pub fn provisional_to_canonical_skeleton() -> PackMigrationSkeleton {
    let pack = provisional_pack_0001();
    let rows = pack
        .dims
        .iter()
        .map(|dim| CanonicalizationRow {
            slot: dim.index,
            provisional_name: dim.name,
            canonical_name: None,
            canonical_domain: None,
            status: CanonicalizationStatus::Unmapped,
            notes: "populate from canonical field calculus manuscript".to_string(),
        })
        .collect::<Vec<_>>();

    PackMigrationSkeleton {
        from_pack_name: pack.name,
        to_pack_name: "FieldPack-0001-Canonical",
        row_count: rows.len(),
        rows,
    }
}

pub fn provisional_pack_0001() -> FieldPack26 {
    use Polarity::{HigherIsBetter as Hi, LowerIsBetter as Lo};
    FieldPack26 {
        artifact_id: 1,
        name: "FieldPack-0001-Provisional",
        basis_version: 1,
        epsilon_limit: 0.45,
        dims: [
            DimSpec {
                index: 0,
                name: "identity_integrity",
                lower: 0.70,
                upper: 1.00,
                polarity: Hi,
                notes: "principal identity coherence",
            },
            DimSpec {
                index: 1,
                name: "capability_scope",
                lower: 0.60,
                upper: 1.00,
                polarity: Hi,
                notes: "least privilege quality",
            },
            DimSpec {
                index: 2,
                name: "credential_exposure",
                lower: 0.00,
                upper: 0.35,
                polarity: Lo,
                notes: "credential exposure pressure",
            },
            DimSpec {
                index: 3,
                name: "secret_residency",
                lower: 0.70,
                upper: 1.00,
                polarity: Hi,
                notes: "secrets remain in approved residency domains",
            },
            DimSpec {
                index: 4,
                name: "boundary_permeability",
                lower: 0.00,
                upper: 0.35,
                polarity: Lo,
                notes: "boundary leakage permeability",
            },
            DimSpec {
                index: 5,
                name: "privilege_gradient",
                lower: 0.00,
                upper: 0.40,
                polarity: Lo,
                notes: "privilege discontinuity",
            },
            DimSpec {
                index: 6,
                name: "egress_pressure",
                lower: 0.00,
                upper: 0.55,
                polarity: Lo,
                notes: "outbound transfer pressure",
            },
            DimSpec {
                index: 7,
                name: "ingress_trust",
                lower: 0.55,
                upper: 1.00,
                polarity: Hi,
                notes: "quality of inbound trust anchors",
            },
            DimSpec {
                index: 8,
                name: "data_sensitivity",
                lower: 0.00,
                upper: 0.65,
                polarity: Lo,
                notes: "sensitivity burden in active scope",
            },
            DimSpec {
                index: 9,
                name: "policy_conformance",
                lower: 0.75,
                upper: 1.00,
                polarity: Hi,
                notes: "declared policy conformance",
            },
            DimSpec {
                index: 10,
                name: "provenance_coverage",
                lower: 0.70,
                upper: 1.00,
                polarity: Hi,
                notes: "provenance completeness",
            },
            DimSpec {
                index: 11,
                name: "evidence_completeness",
                lower: 0.70,
                upper: 1.00,
                polarity: Hi,
                notes: "evidentiary coverage",
            },
            DimSpec {
                index: 12,
                name: "temporal_freshness",
                lower: 0.65,
                upper: 1.00,
                polarity: Hi,
                notes: "freshness of evidence and state",
            },
            DimSpec {
                index: 13,
                name: "topology_reachability",
                lower: 0.20,
                upper: 0.85,
                polarity: Lo,
                notes: "reachable attack/service surface",
            },
            DimSpec {
                index: 14,
                name: "service_health",
                lower: 0.60,
                upper: 1.00,
                polarity: Hi,
                notes: "health of governed service",
            },
            DimSpec {
                index: 15,
                name: "load_saturation",
                lower: 0.00,
                upper: 0.80,
                polarity: Lo,
                notes: "saturation/backlog pressure",
            },
            DimSpec {
                index: 16,
                name: "isolation_distance",
                lower: 0.55,
                upper: 1.00,
                polarity: Hi,
                notes: "isolation from forbidden domains",
            },
            DimSpec {
                index: 17,
                name: "dependency_fragility",
                lower: 0.00,
                upper: 0.55,
                polarity: Lo,
                notes: "dependency-chain fragility",
            },
            DimSpec {
                index: 18,
                name: "contradiction_mass",
                lower: 0.00,
                upper: 0.25,
                polarity: Lo,
                notes: "explicit contradiction burden",
            },
            DimSpec {
                index: 19,
                name: "truth_confidence",
                lower: 0.55,
                upper: 1.00,
                polarity: Hi,
                notes: "confidence derived from truth valuations",
            },
            DimSpec {
                index: 20,
                name: "replay_determinism",
                lower: 0.85,
                upper: 1.00,
                polarity: Hi,
                notes: "replay stability",
            },
            DimSpec {
                index: 21,
                name: "recovery_integrity",
                lower: 0.75,
                upper: 1.00,
                polarity: Hi,
                notes: "checkpoint/recovery integrity",
            },
            DimSpec {
                index: 22,
                name: "observability_density",
                lower: 0.65,
                upper: 1.00,
                polarity: Hi,
                notes: "observability richness",
            },
            DimSpec {
                index: 23,
                name: "recommendation_stability",
                lower: 0.55,
                upper: 1.00,
                polarity: Hi,
                notes: "stability of recommended actions",
            },
            DimSpec {
                index: 24,
                name: "counterexample_pressure",
                lower: 0.00,
                upper: 0.40,
                polarity: Lo,
                notes: "unresolved adversarial pressure",
            },
            DimSpec {
                index: 25,
                name: "operator_alignment",
                lower: 0.65,
                upper: 1.00,
                polarity: Hi,
                notes: "operator/order alignment quality",
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provisional_pack_validates() {
        provisional_pack_0001().validate().unwrap();
    }

    #[test]
    fn migration_skeleton_has_26_rows() {
        let skel = provisional_to_canonical_skeleton();
        assert_eq!(skel.row_count, 26);
        assert!(skel
            .rows
            .iter()
            .all(|r| r.status == CanonicalizationStatus::Unmapped));
    }

    #[test]
    fn canonical_pack_draft_rejects_incomplete_mapping() {
        let draft = CanonicalPackDraft::from_provisional_skeleton();
        let errs = draft.validate_ready().unwrap_err();
        assert!(errs.iter().any(|e| e.contains("still unmapped")));
    }

    #[test]
    fn canonical_pack_draft_builds_when_fully_populated() {
        let pack = provisional_pack_0001();
        let mut draft = CanonicalPackDraft::from_provisional_skeleton();
        draft.epsilon_limit = pack.epsilon_limit;
        for row in draft.rows.iter_mut() {
            let src = &pack.dims[row.slot];
            row.canonical_name = Some(format!("canon_{}", src.name));
            row.canonical_domain = Some("unit_interval".to_string());
            row.lower = Some(src.lower);
            row.upper = Some(src.upper);
            row.polarity = Some(src.polarity);
            row.notes = Some(format!("canonicalized from provisional slot {}", src.index));
            row.source_slots = vec![src.index];
            row.status = CanonicalizationStatus::Mapped;
        }
        let owned = draft.build_owned().unwrap();
        let static_pack = owned.into_static().unwrap();
        static_pack.validate().unwrap();
        assert_eq!(static_pack.dims[0].name, "canon_identity_integrity");
    }
}
