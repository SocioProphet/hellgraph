use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use hg_core::{
    fnv1a64_str, ArtifactId, ArtifactPayload, Atom, AtomHeader, AtomId, AtomKind,
    BoundViolationRecord, EdgeClass, EpistemicMode, FieldValue, LinkAtom, LinkSemantics, NodeAtom,
    ProofArtifactRecord, ProofValue, ProofVerdict, RoleBinding, SecurityLabel, StoredArtifact,
    TxnId, ValueEnvelope, ValueKey, ValuePayload,
};

const JOURNAL_HEADER: &str = "HGLJ2";
const CHECKPOINT_HEADER: &str = "HGCK2";
const MANIFEST_HEADER: &str = "HGMF1";
const CHECKSUM_SCHEME: &str = "FNV1A64";

#[derive(Debug, Clone)]
pub struct ValueDraft {
    pub subject_atom: AtomId,
    pub key: ValueKey,
    pub payload: ValuePayload,
    pub epistemic_mode: EpistemicMode,
    pub security: SecurityLabel,
}

#[derive(Debug, Clone)]
pub enum ArtifactDraft {
    Proof {
        subject_atom: AtomId,
        record: ProofArtifactRecord,
    },
}

#[derive(Debug, Clone, Default)]
pub struct CommitBatch {
    pub values: Vec<ValueDraft>,
    pub artifacts: Vec<ArtifactDraft>,
}

#[derive(Debug, Clone)]
pub struct CommitReceipt {
    pub txn: TxnId,
    pub values: Vec<ValueEnvelope>,
    pub artifacts: Vec<StoredArtifact>,
}

#[derive(Debug, Default, Clone)]
pub struct SpaceStore {
    atoms: BTreeMap<AtomId, Atom>,
    values: Vec<ValueEnvelope>,
    artifacts: BTreeMap<ArtifactId, StoredArtifact>,
    next_atom: AtomId,
    next_txn: TxnId,
    next_artifact_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalManifest {
    pub checksum_scheme: String,
    pub checkpoint_path: Option<String>,
    pub last_replayed_txn: TxnId,
    pub last_checkpoint_txn: TxnId,
    pub last_frame_seq: u64,
    pub compacted_frames: u64,
}

impl Default for JournalManifest {
    fn default() -> Self {
        Self {
            checksum_scheme: CHECKSUM_SCHEME.to_string(),
            checkpoint_path: None,
            last_replayed_txn: 0,
            last_checkpoint_txn: 0,
            last_frame_seq: 0,
            compacted_frames: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayStats {
    pub last_replayed_txn: TxnId,
    pub last_frame_seq: u64,
    pub frames_replayed: u64,
}

pub trait RuntimeStore {
    fn read_field_at(&self, subject_atom: AtomId, snapshot_txn: TxnId) -> Option<&FieldValue>;
    fn read_proof_at(&self, subject_atom: AtomId, snapshot_txn: TxnId) -> Option<&ProofValue>;
    fn commit_batch(&mut self, batch: CommitBatch) -> Result<CommitReceipt, String>;
}

impl RuntimeStore for SpaceStore {
    fn read_field_at(&self, subject_atom: AtomId, snapshot_txn: TxnId) -> Option<&FieldValue> {
        SpaceStore::read_field_at(self, subject_atom, snapshot_txn)
    }

    fn read_proof_at(&self, subject_atom: AtomId, snapshot_txn: TxnId) -> Option<&ProofValue> {
        SpaceStore::read_proof_at(self, subject_atom, snapshot_txn)
    }

    fn commit_batch(&mut self, batch: CommitBatch) -> Result<CommitReceipt, String> {
        SpaceStore::commit_batch(self, batch)
    }
}

impl SpaceStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn current_txn(&self) -> TxnId {
        self.next_txn
    }

    pub fn atoms(&self) -> &BTreeMap<AtomId, Atom> {
        &self.atoms
    }

    pub fn values(&self) -> &[ValueEnvelope] {
        &self.values
    }

    pub fn artifacts(&self) -> &BTreeMap<ArtifactId, StoredArtifact> {
        &self.artifacts
    }

    pub fn create_node(&mut self, type_name: impl Into<String>) -> (AtomId, TxnId) {
        self.next_atom += 1;
        self.next_txn += 1;
        let atom_id = self.next_atom;
        let txn = self.next_txn;
        let node = NodeAtom {
            hdr: AtomHeader {
                atom_id,
                kind: AtomKind::Node,
                type_name: type_name.into(),
                created_txn: txn,
            },
        };
        self.atoms.insert(atom_id, Atom::Node(node));
        (atom_id, txn)
    }

    pub fn create_link(
        &mut self,
        type_name: impl Into<String>,
        semantics: LinkSemantics,
        members: Vec<RoleBinding>,
    ) -> Result<(AtomId, TxnId), String> {
        self.create_link_classed(type_name, semantics, EdgeClass::Relational, members)
    }

    /// SP-RETR-FIBER-001 (WO_FIBER_002): create a link with an explicit edge class.
    /// `create_link` delegates here with `EdgeClass::Relational`, so existing callers are
    /// unchanged; containment (E^⊑) links are created by passing `EdgeClass::Containment`.
    pub fn create_link_classed(
        &mut self,
        type_name: impl Into<String>,
        semantics: LinkSemantics,
        edge_class: EdgeClass,
        members: Vec<RoleBinding>,
    ) -> Result<(AtomId, TxnId), String> {
        for member in &members {
            if !self.atoms.contains_key(&member.target) {
                return Err(format!("unknown target atom {}", member.target));
            }
        }
        self.next_atom += 1;
        self.next_txn += 1;
        let atom_id = self.next_atom;
        let txn = self.next_txn;
        let link = LinkAtom {
            hdr: AtomHeader {
                atom_id,
                kind: AtomKind::Link,
                type_name: type_name.into(),
                created_txn: txn,
            },
            semantics,
            members,
            edge_class,
        };
        self.atoms.insert(atom_id, Atom::Link(link));
        Ok((atom_id, txn))
    }

    pub fn commit_batch(&mut self, batch: CommitBatch) -> Result<CommitReceipt, String> {
        if batch.values.is_empty() && batch.artifacts.is_empty() {
            return Err("cannot commit empty batch".to_string());
        }
        for entry in &batch.values {
            if !self.atoms.contains_key(&entry.subject_atom) {
                return Err(format!("unknown subject atom {}", entry.subject_atom));
            }
        }
        for artifact in &batch.artifacts {
            match artifact {
                ArtifactDraft::Proof {
                    subject_atom,
                    record,
                } => {
                    if !self.atoms.contains_key(subject_atom) {
                        return Err(format!("unknown artifact subject atom {}", subject_atom));
                    }
                    if *subject_atom != record.subject_atom {
                        return Err("artifact subject mismatch".to_string());
                    }
                }
            }
        }

        self.next_txn += 1;
        let txn = self.next_txn;

        let mut stored_artifacts = Vec::new();
        let mut proof_artifact_for_subject = BTreeMap::<AtomId, ArtifactId>::new();
        for (ordinal, artifact) in batch.artifacts.into_iter().enumerate() {
            self.next_artifact_seq += 1;
            let artifact_id = ((txn as u128) << 64) | ((ordinal as u128) + 1);
            let stored = match artifact {
                ArtifactDraft::Proof {
                    subject_atom,
                    record,
                } => {
                    proof_artifact_for_subject.insert(subject_atom, artifact_id);
                    StoredArtifact {
                        artifact_id,
                        created_at_txn: txn,
                        payload: ArtifactPayload::Proof(record),
                    }
                }
            };
            self.artifacts.insert(artifact_id, stored.clone());
            stored_artifacts.push(stored);
        }

        let mut stored_values = Vec::new();
        for mut entry in batch.values {
            for existing in self.values.iter_mut() {
                if existing.subject_atom == entry.subject_atom
                    && existing.key == entry.key
                    && existing.retired_at_txn.is_none()
                {
                    existing.retired_at_txn = Some(txn);
                }
            }
            if let ValuePayload::Proof(ref mut p) = entry.payload {
                if p.artifact_ref.is_none() {
                    if let Some(artifact_id) = proof_artifact_for_subject.get(&entry.subject_atom) {
                        p.artifact_ref = Some(*artifact_id);
                    }
                }
            }
            let stored = ValueEnvelope {
                subject_atom: entry.subject_atom,
                key: entry.key,
                payload: entry.payload,
                committed_at_txn: txn,
                retired_at_txn: None,
                epistemic_mode: entry.epistemic_mode,
                security: entry.security,
            };
            self.values.push(stored.clone());
            stored_values.push(stored);
        }

        Ok(CommitReceipt {
            txn,
            values: stored_values,
            artifacts: stored_artifacts,
        })
    }

    pub fn read_value_at(
        &self,
        subject_atom: AtomId,
        key: &ValueKey,
        snapshot_txn: TxnId,
    ) -> Option<&ValueEnvelope> {
        self.values
            .iter()
            .filter(|v| v.subject_atom == subject_atom && &v.key == key)
            .filter(|v| v.committed_at_txn <= snapshot_txn)
            .filter(|v| v.retired_at_txn.map(|t| t > snapshot_txn).unwrap_or(true))
            .max_by_key(|v| v.committed_at_txn)
    }

    pub fn read_field_at(&self, subject_atom: AtomId, snapshot_txn: TxnId) -> Option<&FieldValue> {
        self.read_value_at(subject_atom, &ValueKey::FieldCurrent, snapshot_txn)
            .and_then(|v| match &v.payload {
                ValuePayload::Field(f) => Some(f),
                _ => None,
            })
    }

    pub fn read_proof_at(&self, subject_atom: AtomId, snapshot_txn: TxnId) -> Option<&ProofValue> {
        self.read_value_at(subject_atom, &ValueKey::ProofCurrent, snapshot_txn)
            .and_then(|v| match &v.payload {
                ValuePayload::Proof(p) => Some(p),
                _ => None,
            })
    }

    pub fn read_artifact(&self, artifact_id: ArtifactId) -> Option<&StoredArtifact> {
        self.artifacts.get(&artifact_id)
    }

    pub fn atom(&self, atom_id: AtomId) -> Option<&Atom> {
        self.atoms.get(&atom_id)
    }
}

#[derive(Debug)]
pub struct JournaledStore {
    inner: SpaceStore,
    journal_path: PathBuf,
    manifest_path: PathBuf,
    checkpoint_path: PathBuf,
    manifest: JournalManifest,
}

impl JournaledStore {
    pub fn create_new(path: impl Into<PathBuf>) -> Result<Self, String> {
        let journal_path = path.into();
        let manifest_path = manifest_path_for(&journal_path);
        let checkpoint_path = checkpoint_path_for(&journal_path);
        if let Some(parent) = journal_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        rewrite_journal_header(&journal_path)?;
        let manifest = JournalManifest {
            checkpoint_path: Some(checkpoint_path.to_string_lossy().to_string()),
            ..Default::default()
        };
        save_manifest(&manifest_path, &manifest)?;
        Ok(Self {
            inner: SpaceStore::new(),
            journal_path,
            manifest_path,
            checkpoint_path,
            manifest,
        })
    }

    pub fn open_or_replay(path: impl Into<PathBuf>) -> Result<Self, String> {
        let journal_path = path.into();
        let manifest_path = manifest_path_for(&journal_path);
        let checkpoint_path = checkpoint_path_for(&journal_path);
        if !journal_path.exists() {
            return Self::create_new(journal_path);
        }
        let mut manifest = if manifest_path.exists() {
            load_manifest(&manifest_path)?
        } else {
            JournalManifest::default()
        };
        manifest.checkpoint_path = Some(checkpoint_path.to_string_lossy().to_string());
        let mut inner = if checkpoint_path.exists() {
            load_checkpoint(&checkpoint_path)?
        } else {
            SpaceStore::new()
        };
        let stats = replay_journal_into(&journal_path, &mut inner)?;
        manifest.last_replayed_txn = stats.last_replayed_txn.max(inner.current_txn());
        manifest.last_frame_seq = stats.last_frame_seq;
        save_manifest(&manifest_path, &manifest)?;
        Ok(Self {
            inner,
            journal_path,
            manifest_path,
            checkpoint_path,
            manifest,
        })
    }

    pub fn manifest(&self) -> &JournalManifest {
        &self.manifest
    }

    pub fn journal_path(&self) -> &Path {
        &self.journal_path
    }

    pub fn checkpoint_path(&self) -> &Path {
        &self.checkpoint_path
    }

    pub fn inner(&self) -> &SpaceStore {
        &self.inner
    }

    fn append_frame(&mut self, kind: &str, txn: TxnId, payloads: &[String]) -> Result<(), String> {
        self.manifest.last_frame_seq += 1;
        let seq = self.manifest.last_frame_seq;
        let checksum = frame_checksum(payloads);
        let mut f = OpenOptions::new()
            .append(true)
            .open(&self.journal_path)
            .map_err(|e| e.to_string())?;
        writeln!(
            f,
            "FRAME\t{}\t{}\t{}\t{}\t{}",
            seq,
            kind,
            txn,
            payloads.len(),
            checksum
        )
        .map_err(|e| e.to_string())?;
        for line in payloads {
            writeln!(f, "{}", line).map_err(|e| e.to_string())?;
        }
        writeln!(f, "END\t{}", seq).map_err(|e| e.to_string())?;
        f.flush().map_err(|e| e.to_string())?;
        self.manifest.last_replayed_txn = txn;
        save_manifest(&self.manifest_path, &self.manifest)
    }

    pub fn create_node(&mut self, type_name: impl Into<String>) -> Result<(AtomId, TxnId), String> {
        let type_name = type_name.into();
        let (atom_id, txn) = self.inner.create_node(type_name.clone());
        self.append_frame(
            "ATOM",
            txn,
            &[format!("NODE\t{}\t{}\t{}", atom_id, txn, esc(&type_name))],
        )?;
        Ok((atom_id, txn))
    }

    pub fn create_link(
        &mut self,
        type_name: impl Into<String>,
        semantics: LinkSemantics,
        members: Vec<RoleBinding>,
    ) -> Result<(AtomId, TxnId), String> {
        self.create_link_classed(type_name, semantics, EdgeClass::Relational, members)
    }

    /// SP-RETR-FIBER-001 (WO_FIBER_002): journaled classed link creation. The edge class
    /// is appended as a 7th LINK field; journals written before this field decode as
    /// `Relational` (see `decode_edge_class`), so old logs replay unchanged.
    pub fn create_link_classed(
        &mut self,
        type_name: impl Into<String>,
        semantics: LinkSemantics,
        edge_class: EdgeClass,
        members: Vec<RoleBinding>,
    ) -> Result<(AtomId, TxnId), String> {
        let type_name = type_name.into();
        let members_clone = members.clone();
        let (atom_id, txn) =
            self.inner
                .create_link_classed(type_name.clone(), semantics, edge_class, members)?;
        self.append_frame(
            "ATOM",
            txn,
            &[format!(
                "LINK\t{}\t{}\t{}\t{}\t{}\t{}",
                atom_id,
                txn,
                esc(&type_name),
                encode_link_semantics(semantics),
                encode_members(&members_clone),
                encode_edge_class(edge_class),
            )],
        )?;
        Ok((atom_id, txn))
    }

    pub fn checkpoint_and_compact(&mut self) -> Result<(), String> {
        save_checkpoint(&self.inner, &self.checkpoint_path)?;
        self.manifest.last_checkpoint_txn = self.inner.current_txn();
        self.manifest.compacted_frames += self.manifest.last_frame_seq;
        self.manifest.last_frame_seq = 0;
        rewrite_journal_header(&self.journal_path)?;
        save_manifest(&self.manifest_path, &self.manifest)
    }
}

impl RuntimeStore for JournaledStore {
    fn read_field_at(&self, subject_atom: AtomId, snapshot_txn: TxnId) -> Option<&FieldValue> {
        self.inner.read_field_at(subject_atom, snapshot_txn)
    }

    fn read_proof_at(&self, subject_atom: AtomId, snapshot_txn: TxnId) -> Option<&ProofValue> {
        self.inner.read_proof_at(subject_atom, snapshot_txn)
    }

    fn commit_batch(&mut self, batch: CommitBatch) -> Result<CommitReceipt, String> {
        let receipt = self.inner.commit_batch(batch)?;
        let mut payloads = Vec::new();
        for artifact in &receipt.artifacts {
            payloads.push(encode_artifact_line(artifact));
        }
        for value in &receipt.values {
            payloads.push(encode_value_line(value));
        }
        self.append_frame("BATCH", receipt.txn, &payloads)?;
        Ok(receipt)
    }
}

fn manifest_path_for(journal_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.manifest", journal_path.to_string_lossy()))
}

fn checkpoint_path_for(journal_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.checkpoint", journal_path.to_string_lossy()))
}

fn rewrite_journal_header(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut f = File::create(path).map_err(|e| e.to_string())?;
    writeln!(f, "{}", JOURNAL_HEADER).map_err(|e| e.to_string())?;
    f.flush().map_err(|e| e.to_string())?;
    Ok(())
}

fn save_manifest(path: &Path, manifest: &JournalManifest) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut f = File::create(path).map_err(|e| e.to_string())?;
    writeln!(f, "{}", MANIFEST_HEADER).map_err(|e| e.to_string())?;
    writeln!(f, "CHECKSUM_SCHEME\t{}", esc(&manifest.checksum_scheme))
        .map_err(|e| e.to_string())?;
    writeln!(
        f,
        "CHECKPOINT_PATH\t{}",
        esc(manifest.checkpoint_path.as_deref().unwrap_or(""))
    )
    .map_err(|e| e.to_string())?;
    writeln!(f, "LAST_REPLAYED_TXN\t{}", manifest.last_replayed_txn).map_err(|e| e.to_string())?;
    writeln!(f, "LAST_CHECKPOINT_TXN\t{}", manifest.last_checkpoint_txn)
        .map_err(|e| e.to_string())?;
    writeln!(f, "LAST_FRAME_SEQ\t{}", manifest.last_frame_seq).map_err(|e| e.to_string())?;
    writeln!(f, "COMPACTED_FRAMES\t{}", manifest.compacted_frames).map_err(|e| e.to_string())?;
    f.flush().map_err(|e| e.to_string())?;
    Ok(())
}

fn load_manifest(path: &Path) -> Result<JournalManifest, String> {
    let f = File::open(path).map_err(|e| e.to_string())?;
    let mut lines = BufReader::new(f).lines();
    let header = lines
        .next()
        .ok_or_else(|| "empty manifest".to_string())?
        .map_err(|e| e.to_string())?;
    if header.trim() != MANIFEST_HEADER {
        return Err("invalid manifest header".to_string());
    }
    let mut m = JournalManifest::default();
    for line in lines {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        match parts[0] {
            "CHECKSUM_SCHEME" => m.checksum_scheme = unesc(parts.get(1).copied().unwrap_or(""))?,
            "CHECKPOINT_PATH" => {
                let s = unesc(parts.get(1).copied().unwrap_or(""))?;
                m.checkpoint_path = if s.is_empty() { None } else { Some(s) };
            }
            "LAST_REPLAYED_TXN" => m.last_replayed_txn = parse_u64(parts.get(1).copied())?,
            "LAST_CHECKPOINT_TXN" => m.last_checkpoint_txn = parse_u64(parts.get(1).copied())?,
            "LAST_FRAME_SEQ" => m.last_frame_seq = parse_u64(parts.get(1).copied())?,
            "COMPACTED_FRAMES" => m.compacted_frames = parse_u64(parts.get(1).copied())?,
            other => return Err(format!("unexpected manifest record {}", other)),
        }
    }
    Ok(m)
}

pub fn save_checkpoint(store: &SpaceStore, path: impl AsRef<Path>) -> Result<(), String> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut f = File::create(path).map_err(|e| e.to_string())?;
    writeln!(f, "{}", CHECKPOINT_HEADER).map_err(|e| e.to_string())?;
    writeln!(f, "CHECKSUM_SCHEME\t{}", CHECKSUM_SCHEME).map_err(|e| e.to_string())?;
    writeln!(
        f,
        "META\t{}\t{}\t{}",
        store.next_atom, store.next_txn, store.next_artifact_seq
    )
    .map_err(|e| e.to_string())?;
    for atom in store.atoms.values() {
        match atom {
            Atom::Node(n) => {
                writeln!(
                    f,
                    "NODE\t{}\t{}\t{}",
                    n.hdr.atom_id,
                    n.hdr.created_txn,
                    esc(&n.hdr.type_name)
                )
                .map_err(|e| e.to_string())?;
            }
            Atom::Link(l) => {
                writeln!(
                    f,
                    "LINK\t{}\t{}\t{}\t{}\t{}\t{}",
                    l.hdr.atom_id,
                    l.hdr.created_txn,
                    esc(&l.hdr.type_name),
                    encode_link_semantics(l.semantics),
                    encode_members(&l.members),
                    encode_edge_class(l.edge_class),
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    for artifact in store.artifacts.values() {
        writeln!(f, "{}", encode_artifact_line(artifact)).map_err(|e| e.to_string())?;
    }
    for value in &store.values {
        writeln!(f, "{}", encode_value_line(value)).map_err(|e| e.to_string())?;
    }
    f.flush().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn load_checkpoint(path: impl AsRef<Path>) -> Result<SpaceStore, String> {
    let f = File::open(path).map_err(|e| e.to_string())?;
    let mut lines = BufReader::new(f).lines();
    let header = lines
        .next()
        .ok_or_else(|| "empty checkpoint".to_string())?
        .map_err(|e| e.to_string())?;
    if header.trim() != CHECKPOINT_HEADER {
        return Err("invalid checkpoint header".to_string());
    }
    let mut store = SpaceStore::new();
    for line in lines {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        match parts[0] {
            "CHECKSUM_SCHEME" => {
                let scheme = parts.get(1).copied().unwrap_or("");
                if scheme != CHECKSUM_SCHEME {
                    return Err(format!("unexpected checkpoint checksum scheme {}", scheme));
                }
            }
            "META" => {
                store.next_atom = parse_u128(parts.get(1).copied())?;
                store.next_txn = parse_u64(parts.get(2).copied())?;
                store.next_artifact_seq = parse_u64(parts.get(3).copied())?;
            }
            "NODE" => restore_node_line(&mut store, &parts)?,
            "LINK" => restore_link_line(&mut store, &parts)?,
            "ART" => restore_artifact_line(&mut store, &parts)?,
            "VAL" => restore_value_line(&mut store, &parts)?,
            other => return Err(format!("unexpected checkpoint record {}", other)),
        }
    }
    Ok(store)
}

pub fn replay_journal(path: impl AsRef<Path>) -> Result<SpaceStore, String> {
    let mut store = SpaceStore::new();
    replay_journal_into(path, &mut store)?;
    Ok(store)
}

pub fn replay_journal_into(
    path: impl AsRef<Path>,
    store: &mut SpaceStore,
) -> Result<ReplayStats, String> {
    let f = File::open(path).map_err(|e| e.to_string())?;
    let lines = BufReader::new(f)
        .lines()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if lines.is_empty() {
        return Err("empty journal".to_string());
    }
    if lines[0].trim() != JOURNAL_HEADER {
        return Err("invalid journal header".to_string());
    }
    let mut i = 1usize;
    let mut stats = ReplayStats {
        last_replayed_txn: store.current_txn(),
        last_frame_seq: 0,
        frames_replayed: 0,
    };
    while i < lines.len() {
        let line = &lines[i];
        if line.trim().is_empty() {
            i += 1;
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.first().copied() != Some("FRAME") {
            return Err(format!("unexpected journal record {}", parts[0]));
        }
        let seq = parse_u64(parts.get(1).copied())?;
        let _kind = parts
            .get(2)
            .copied()
            .ok_or_else(|| "missing frame kind".to_string())?;
        let txn = parse_u64(parts.get(3).copied())?;
        let payload_count = parse_usize(parts.get(4).copied())?;
        let checksum = parse_u64(parts.get(5).copied())?;
        let start = i + 1;
        let end = start + payload_count;
        if end >= lines.len() {
            return Err("truncated frame payload".to_string());
        }
        let payloads = lines[start..end].to_vec();
        let end_parts: Vec<&str> = lines[end].split('\t').collect();
        if end_parts.first().copied() != Some("END") {
            return Err("frame missing END marker".to_string());
        }
        let end_seq = parse_u64(end_parts.get(1).copied())?;
        if end_seq != seq {
            return Err("frame END sequence mismatch".to_string());
        }
        if frame_checksum(&payloads) != checksum {
            return Err(format!("frame checksum mismatch at sequence {}", seq));
        }
        for payload in &payloads {
            let parts: Vec<&str> = payload.split('\t').collect();
            match parts[0] {
                "NODE" => restore_node_line(store, &parts)?,
                "LINK" => restore_link_line(store, &parts)?,
                "ART" => restore_artifact_line(store, &parts)?,
                "VAL" => restore_value_line(store, &parts)?,
                other => return Err(format!("unexpected payload record {}", other)),
            }
        }
        stats.last_replayed_txn = stats.last_replayed_txn.max(txn).max(store.current_txn());
        stats.last_frame_seq = seq;
        stats.frames_replayed += 1;
        i = end + 1;
    }
    Ok(stats)
}

pub fn frame_checksum(payloads: &[String]) -> u64 {
    let joined = payloads.join("\n");
    fnv1a64_str(&joined)
}

fn restore_node_line(store: &mut SpaceStore, parts: &[&str]) -> Result<(), String> {
    let atom_id = parse_u128(parts.get(1).copied())?;
    let created_txn = parse_u64(parts.get(2).copied())?;
    let type_name = unesc(
        parts
            .get(3)
            .copied()
            .ok_or_else(|| "missing node type".to_string())?,
    )?;
    let node = NodeAtom {
        hdr: AtomHeader {
            atom_id,
            kind: AtomKind::Node,
            type_name,
            created_txn,
        },
    };
    store.atoms.insert(atom_id, Atom::Node(node));
    store.next_atom = store.next_atom.max(atom_id);
    store.next_txn = store.next_txn.max(created_txn);
    Ok(())
}

fn restore_link_line(store: &mut SpaceStore, parts: &[&str]) -> Result<(), String> {
    let atom_id = parse_u128(parts.get(1).copied())?;
    let created_txn = parse_u64(parts.get(2).copied())?;
    let type_name = unesc(
        parts
            .get(3)
            .copied()
            .ok_or_else(|| "missing link type".to_string())?,
    )?;
    let semantics = decode_link_semantics(
        parts
            .get(4)
            .copied()
            .ok_or_else(|| "missing link semantics".to_string())?,
    )?;
    let members = decode_members(parts.get(5).copied().unwrap_or(""))?;
    // SP-RETR-FIBER-001 (WO_FIBER_002): the 7th field is the edge class. Journals written
    // before this field lack it → `decode_edge_class(None)` yields `Relational`.
    let edge_class = decode_edge_class(parts.get(6).copied())?;
    let link = LinkAtom {
        hdr: AtomHeader {
            atom_id,
            kind: AtomKind::Link,
            type_name,
            created_txn,
        },
        semantics,
        members,
        edge_class,
    };
    store.atoms.insert(atom_id, Atom::Link(link));
    store.next_atom = store.next_atom.max(atom_id);
    store.next_txn = store.next_txn.max(created_txn);
    Ok(())
}

fn restore_artifact_line(store: &mut SpaceStore, parts: &[&str]) -> Result<(), String> {
    let artifact_id = parse_u128(parts.get(1).copied())?;
    let created_at_txn = parse_u64(parts.get(2).copied())?;
    let kind = parts
        .get(3)
        .copied()
        .ok_or_else(|| "missing artifact kind".to_string())?;
    match kind {
        "PROOF" => {
            let record = decode_proof_artifact_record(&parts[4..])?;
            store.artifacts.insert(
                artifact_id,
                StoredArtifact {
                    artifact_id,
                    created_at_txn,
                    payload: ArtifactPayload::Proof(record),
                },
            );
            store.next_txn = store.next_txn.max(created_at_txn);
            store.next_artifact_seq = store
                .next_artifact_seq
                .max((artifact_id & 0xffff_ffff_ffff_ffff) as u64);
            Ok(())
        }
        other => Err(format!("unknown artifact kind {}", other)),
    }
}

fn restore_value_line(store: &mut SpaceStore, parts: &[&str]) -> Result<(), String> {
    let subject_atom = parse_u128(parts.get(1).copied())?;
    let key = decode_value_key(parts.get(2).copied(), parts.get(3).copied())?;
    let committed_at_txn = parse_u64(parts.get(4).copied())?;
    let retired_at_txn = parse_opt_u64(parts.get(5).copied())?;
    let epistemic_mode = decode_epistemic(
        parts
            .get(6)
            .copied()
            .ok_or_else(|| "missing epistemic mode".to_string())?,
    )?;
    let security = decode_security(
        parts
            .get(7)
            .copied()
            .ok_or_else(|| "missing security label".to_string())?,
    )?;
    let payload = decode_value_payload(&parts[8..])?;
    store.values.push(ValueEnvelope {
        subject_atom,
        key,
        payload,
        committed_at_txn,
        retired_at_txn,
        epistemic_mode,
        security,
    });
    store.next_txn = store.next_txn.max(committed_at_txn);
    Ok(())
}

fn encode_value_line(v: &ValueEnvelope) -> String {
    let (k0, k1) = match &v.key {
        ValueKey::FieldCurrent => ("FIELD_CURRENT".to_string(), String::new()),
        ValueKey::ProofCurrent => ("PROOF_CURRENT".to_string(), String::new()),
        ValueKey::Prop(name) => ("PROP".to_string(), esc(name)),
    };
    let mut parts = vec![
        "VAL".to_string(),
        v.subject_atom.to_string(),
        k0,
        k1,
        v.committed_at_txn.to_string(),
        v.retired_at_txn.map(|t| t.to_string()).unwrap_or_default(),
        encode_epistemic(v.epistemic_mode).to_string(),
        encode_security(v.security).to_string(),
    ];
    match &v.payload {
        ValuePayload::Field(f) => {
            parts.push("FIELD".to_string());
            parts.push(esc(&f.field_pack_name));
            parts.push(f.basis_version.to_string());
            parts.push(f.basis_fingerprint_fnv1a64.to_string());
            parts.push(format!("{:.17}", f.state.epsilon_eff));
            parts.push(encode_dims(&f.state));
        }
        ValuePayload::Proof(p) => {
            parts.push("PROOF".to_string());
            parts.push(encode_proof_verdict(p.verdict).to_string());
            parts.push(p.artifact_ref.map(|id| id.to_string()).unwrap_or_default());
            parts.push(p.evidence_count.to_string());
            parts.push(format!("{:.17}", p.epsilon_eff));
            parts.push(format!("{:.17}", p.max_violation_magnitude));
            parts.push(esc(p.insufficiency_reason.as_deref().unwrap_or("")));
        }
    }
    parts.join("\t")
}

fn encode_artifact_line(a: &StoredArtifact) -> String {
    match &a.payload {
        ArtifactPayload::Proof(record) => {
            let mut parts = vec![
                "ART".to_string(),
                a.artifact_id.to_string(),
                a.created_at_txn.to_string(),
                "PROOF".to_string(),
            ];
            parts.extend(encode_proof_artifact_record(record));
            parts.join("\t")
        }
    }
}

fn encode_proof_artifact_record(record: &ProofArtifactRecord) -> Vec<String> {
    vec![
        record.subject_atom.to_string(),
        record.snapshot_txn.to_string(),
        esc(&record.field_pack_name),
        record.field_pack_basis_version.to_string(),
        record.basis_fingerprint_fnv1a64.to_string(),
        record.assumptions_fingerprint_fnv1a64.to_string(),
        record.evidence_basis_fingerprint_fnv1a64.to_string(),
        encode_proof_verdict(record.verdict).to_string(),
        record.evidence_count.to_string(),
        format!("{:.17}", record.epsilon_eff),
        format!("{:.17}", record.max_violation_magnitude),
        esc(record.insufficiency_reason.as_deref().unwrap_or("")),
        esc(record.witness_summary.as_deref().unwrap_or("")),
        esc(record.counterexample_summary.as_deref().unwrap_or("")),
        encode_violations(&record.violated),
    ]
}

fn decode_proof_artifact_record(parts: &[&str]) -> Result<ProofArtifactRecord, String> {
    Ok(ProofArtifactRecord {
        subject_atom: parse_u128(parts.first().copied())?,
        snapshot_txn: parse_u64(parts.get(1).copied())?,
        field_pack_name: unesc(
            parts
                .get(2)
                .copied()
                .ok_or_else(|| "missing field pack name".to_string())?,
        )?,
        field_pack_basis_version: parse_u32(parts.get(3).copied())?,
        basis_fingerprint_fnv1a64: parse_u64(parts.get(4).copied())?,
        assumptions_fingerprint_fnv1a64: parse_u64(parts.get(5).copied())?,
        evidence_basis_fingerprint_fnv1a64: parse_u64(parts.get(6).copied())?,
        verdict: decode_proof_verdict(
            parts
                .get(7)
                .copied()
                .ok_or_else(|| "missing verdict".to_string())?,
        )?,
        evidence_count: parse_usize(parts.get(8).copied())?,
        epsilon_eff: parse_f64(parts.get(9).copied())?,
        max_violation_magnitude: parse_f64(parts.get(10).copied())?,
        insufficiency_reason: option_from_escaped(parts.get(11).copied().unwrap_or(""))?,
        witness_summary: option_from_escaped(parts.get(12).copied().unwrap_or(""))?,
        counterexample_summary: option_from_escaped(parts.get(13).copied().unwrap_or(""))?,
        violated: decode_violations(parts.get(14).copied().unwrap_or(""))?,
    })
}

fn option_from_escaped(s: &str) -> Result<Option<String>, String> {
    let value = unesc(s)?;
    if value.is_empty() {
        Ok(None)
    } else {
        Ok(Some(value))
    }
}

fn decode_value_key(kind: Option<&str>, arg: Option<&str>) -> Result<ValueKey, String> {
    match kind.ok_or_else(|| "missing value key".to_string())? {
        "FIELD_CURRENT" => Ok(ValueKey::FieldCurrent),
        "PROOF_CURRENT" => Ok(ValueKey::ProofCurrent),
        "PROP" => Ok(ValueKey::Prop(unesc(arg.unwrap_or(""))?)),
        other => Err(format!("unknown value key {}", other)),
    }
}

fn decode_value_payload(parts: &[&str]) -> Result<ValuePayload, String> {
    match parts
        .first()
        .copied()
        .ok_or_else(|| "missing payload kind".to_string())?
    {
        "FIELD" => {
            let state = hg_core::FieldState26 {
                dims: decode_dims(parts.get(5).copied().unwrap_or(""))?,
                epsilon_eff: parse_f64(parts.get(4).copied())?,
            };
            Ok(ValuePayload::Field(FieldValue {
                field_pack_name: unesc(
                    parts
                        .get(1)
                        .copied()
                        .ok_or_else(|| "missing field pack name".to_string())?,
                )?,
                basis_version: parse_u32(parts.get(2).copied())?,
                basis_fingerprint_fnv1a64: parse_u64(parts.get(3).copied())?,
                state,
            }))
        }
        "PROOF" => Ok(ValuePayload::Proof(ProofValue {
            verdict: decode_proof_verdict(
                parts
                    .get(1)
                    .copied()
                    .ok_or_else(|| "missing proof verdict".to_string())?,
            )?,
            artifact_ref: parse_opt_u128(parts.get(2).copied())?,
            evidence_count: parse_usize(parts.get(3).copied())?,
            epsilon_eff: parse_f64(parts.get(4).copied())?,
            max_violation_magnitude: parse_f64(parts.get(5).copied())?,
            insufficiency_reason: option_from_escaped(parts.get(6).copied().unwrap_or(""))?,
        })),
        other => Err(format!("unknown payload kind {}", other)),
    }
}

fn encode_dims(state: &hg_core::FieldState26) -> String {
    state
        .dims
        .iter()
        .map(|v| format!("{:.17}", v))
        .collect::<Vec<_>>()
        .join(",")
}

fn decode_dims(s: &str) -> Result<[f64; 26], String> {
    let vals: Vec<f64> = if s.is_empty() {
        Vec::new()
    } else {
        s.split(',')
            .map(|x| x.parse::<f64>().map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?
    };
    if vals.len() != 26 {
        return Err(format!("expected 26 dims, found {}", vals.len()));
    }
    let mut arr = [0.0_f64; 26];
    for (i, v) in vals.into_iter().enumerate() {
        arr[i] = v;
    }
    Ok(arr)
}

fn encode_members(members: &[RoleBinding]) -> String {
    members
        .iter()
        .map(|m| format!("{},{},{}", esc(&m.role_name), m.target, m.ordinal))
        .collect::<Vec<_>>()
        .join(";")
}

fn decode_members(s: &str) -> Result<Vec<RoleBinding>, String> {
    if s.is_empty() {
        return Ok(Vec::new());
    }
    s.split(';')
        .map(|item| {
            let mut parts = item.splitn(3, ',');
            let role_name = unesc(
                parts
                    .next()
                    .ok_or_else(|| "missing member role".to_string())?,
            )?;
            let target = parts
                .next()
                .ok_or_else(|| "missing member target".to_string())?
                .parse::<u128>()
                .map_err(|e| e.to_string())?;
            let ordinal = parts
                .next()
                .ok_or_else(|| "missing member ordinal".to_string())?
                .parse::<u16>()
                .map_err(|e| e.to_string())?;
            Ok(RoleBinding {
                role_name,
                target,
                ordinal,
            })
        })
        .collect()
}

fn encode_violations(vs: &[BoundViolationRecord]) -> String {
    vs.iter()
        .map(|v| {
            format!(
                "{},{},{:.17},{:.17},{:.17},{:.17}",
                v.dim_index,
                esc(&v.dim_name),
                v.value,
                v.lower,
                v.upper,
                v.magnitude,
            )
        })
        .collect::<Vec<_>>()
        .join(";")
}

fn decode_violations(s: &str) -> Result<Vec<BoundViolationRecord>, String> {
    if s.is_empty() {
        return Ok(Vec::new());
    }
    s.split(';')
        .map(|item| {
            let parts: Vec<&str> = item.splitn(6, ',').collect();
            if parts.len() != 6 {
                return Err(format!("invalid violation record {}", item));
            }
            Ok(BoundViolationRecord {
                dim_index: parts[0].parse::<usize>().map_err(|e| e.to_string())?,
                dim_name: unesc(parts[1])?,
                value: parts[2].parse::<f64>().map_err(|e| e.to_string())?,
                lower: parts[3].parse::<f64>().map_err(|e| e.to_string())?,
                upper: parts[4].parse::<f64>().map_err(|e| e.to_string())?,
                magnitude: parts[5].parse::<f64>().map_err(|e| e.to_string())?,
            })
        })
        .collect()
}

fn encode_epistemic(m: EpistemicMode) -> &'static str {
    match m {
        EpistemicMode::OpenWorld => "OW",
        EpistemicMode::ClosedWorld => "CW",
        EpistemicMode::BoundedSnapshot => "BS",
        EpistemicMode::Counterfactual => "CF",
        EpistemicMode::Simulation => "SIM",
    }
}

fn decode_epistemic(s: &str) -> Result<EpistemicMode, String> {
    match s {
        "OW" => Ok(EpistemicMode::OpenWorld),
        "CW" => Ok(EpistemicMode::ClosedWorld),
        "BS" => Ok(EpistemicMode::BoundedSnapshot),
        "CF" => Ok(EpistemicMode::Counterfactual),
        "SIM" => Ok(EpistemicMode::Simulation),
        other => Err(format!("unknown epistemic mode {}", other)),
    }
}

fn encode_security(s: SecurityLabel) -> &'static str {
    match s {
        SecurityLabel::Public => "PUB",
        SecurityLabel::Internal => "INT",
        SecurityLabel::Confidential => "CONF",
        SecurityLabel::Restricted => "REST",
        SecurityLabel::LocalOnly => "LOCAL",
    }
}

fn decode_security(s: &str) -> Result<SecurityLabel, String> {
    match s {
        "PUB" => Ok(SecurityLabel::Public),
        "INT" => Ok(SecurityLabel::Internal),
        "CONF" => Ok(SecurityLabel::Confidential),
        "REST" => Ok(SecurityLabel::Restricted),
        "LOCAL" => Ok(SecurityLabel::LocalOnly),
        other => Err(format!("unknown security label {}", other)),
    }
}

fn encode_proof_verdict(v: ProofVerdict) -> &'static str {
    match v {
        ProofVerdict::Proved => "PROVED",
        ProofVerdict::Violated => "VIOLATED",
        ProofVerdict::Inconclusive => "INCONCLUSIVE",
    }
}

fn decode_proof_verdict(s: &str) -> Result<ProofVerdict, String> {
    match s {
        "PROVED" => Ok(ProofVerdict::Proved),
        "VIOLATED" => Ok(ProofVerdict::Violated),
        "INCONCLUSIVE" => Ok(ProofVerdict::Inconclusive),
        other => Err(format!("unknown proof verdict {}", other)),
    }
}

fn encode_link_semantics(s: LinkSemantics) -> &'static str {
    match s {
        LinkSemantics::DirectedBinary => "DB",
        LinkSemantics::OrderedNary => "ON",
        LinkSemantics::UnorderedNary => "UN",
        LinkSemantics::SetLike => "SET",
        LinkSemantics::MultiSetLike => "MSET",
    }
}

// SP-RETR-FIBER-001 (WO_FIBER_002): edge-class journal codec.
fn encode_edge_class(c: EdgeClass) -> &'static str {
    match c {
        EdgeClass::Containment => "C",
        EdgeClass::Relational => "R",
    }
}

fn decode_edge_class(s: Option<&str>) -> Result<EdgeClass, String> {
    match s {
        // Absent or empty = a journal written before the field existed: every such link
        // is relational (E_R). This is the WO_FIBER_002 backward-compat migration.
        None | Some("") => Ok(EdgeClass::Relational),
        Some("R") => Ok(EdgeClass::Relational),
        Some("C") => Ok(EdgeClass::Containment),
        Some(other) => Err(format!("unknown edge class {}", other)),
    }
}

fn decode_link_semantics(s: &str) -> Result<LinkSemantics, String> {
    match s {
        "DB" => Ok(LinkSemantics::DirectedBinary),
        "ON" => Ok(LinkSemantics::OrderedNary),
        "UN" => Ok(LinkSemantics::UnorderedNary),
        "SET" => Ok(LinkSemantics::SetLike),
        "MSET" => Ok(LinkSemantics::MultiSetLike),
        other => Err(format!("unknown link semantics {}", other)),
    }
}

fn esc(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\t', "\\t")
        .replace('\n', "\\n")
}

fn unesc(s: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut chars = s.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.next() {
                Some('t') => out.push('\t'),
                Some('n') => out.push('\n'),
                Some('\\') => out.push('\\'),
                Some(other) => return Err(format!("invalid escape \\{}", other)),
                None => return Err("dangling escape".to_string()),
            }
        } else {
            out.push(ch);
        }
    }
    Ok(out)
}

fn parse_u128(s: Option<&str>) -> Result<u128, String> {
    s.ok_or_else(|| "missing integer".to_string())?
        .parse::<u128>()
        .map_err(|e| e.to_string())
}
fn parse_opt_u128(s: Option<&str>) -> Result<Option<u128>, String> {
    match s.unwrap_or("") {
        "" => Ok(None),
        x => Ok(Some(x.parse::<u128>().map_err(|e| e.to_string())?)),
    }
}
fn parse_u64(s: Option<&str>) -> Result<u64, String> {
    s.ok_or_else(|| "missing integer".to_string())?
        .parse::<u64>()
        .map_err(|e| e.to_string())
}
fn parse_opt_u64(s: Option<&str>) -> Result<Option<u64>, String> {
    match s.unwrap_or("") {
        "" => Ok(None),
        x => Ok(Some(x.parse::<u64>().map_err(|e| e.to_string())?)),
    }
}
fn parse_u32(s: Option<&str>) -> Result<u32, String> {
    s.ok_or_else(|| "missing integer".to_string())?
        .parse::<u32>()
        .map_err(|e| e.to_string())
}
fn parse_usize(s: Option<&str>) -> Result<usize, String> {
    s.ok_or_else(|| "missing integer".to_string())?
        .parse::<usize>()
        .map_err(|e| e.to_string())
}
fn parse_f64(s: Option<&str>) -> Result<f64, String> {
    s.ok_or_else(|| "missing float".to_string())?
        .parse::<f64>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("{}_{}_{}.txt", name, std::process::id(), nanos))
    }

    fn sample_field() -> FieldValue {
        let mut state = hg_core::FieldState26::zeroed();
        state.dims[0] = 0.8;
        state.dims[10] = 0.9;
        state.epsilon_eff = 0.1;
        FieldValue {
            field_pack_name: "FieldPack-0001-Provisional".into(),
            basis_version: 1,
            basis_fingerprint_fnv1a64: 42,
            state,
        }
    }

    fn sample_proof_record(subject_atom: AtomId) -> ProofArtifactRecord {
        ProofArtifactRecord {
            subject_atom,
            snapshot_txn: 1,
            field_pack_name: "FieldPack-0001-Provisional".into(),
            field_pack_basis_version: 1,
            basis_fingerprint_fnv1a64: 42,
            assumptions_fingerprint_fnv1a64: 99,
            evidence_basis_fingerprint_fnv1a64: 123,
            verdict: ProofVerdict::Proved,
            evidence_count: 3,
            epsilon_eff: 0.1,
            max_violation_magnitude: 0.0,
            violated: Vec::new(),
            insufficiency_reason: None,
            witness_summary: Some("ok".into()),
            counterexample_summary: None,
        }
    }

    #[test]
    fn snapshot_reads_preserve_history() {
        let mut store = SpaceStore::new();
        let (subject, _) = store.create_node("Service");
        let t1 = store
            .commit_batch(CommitBatch {
                values: vec![ValueDraft {
                    subject_atom: subject,
                    key: ValueKey::FieldCurrent,
                    payload: ValuePayload::Field(sample_field()),
                    epistemic_mode: EpistemicMode::BoundedSnapshot,
                    security: SecurityLabel::Internal,
                }],
                artifacts: vec![],
            })
            .unwrap()
            .txn;

        let mut updated = sample_field();
        updated.state.dims[0] = 0.95;
        let t2 = store
            .commit_batch(CommitBatch {
                values: vec![ValueDraft {
                    subject_atom: subject,
                    key: ValueKey::FieldCurrent,
                    payload: ValuePayload::Field(updated.clone()),
                    epistemic_mode: EpistemicMode::BoundedSnapshot,
                    security: SecurityLabel::Internal,
                }],
                artifacts: vec![],
            })
            .unwrap()
            .txn;

        assert_eq!(store.read_field_at(subject, t1).unwrap(), &sample_field());
        assert_eq!(store.read_field_at(subject, t2).unwrap(), &updated);
    }

    #[test]
    fn commit_can_publish_field_proof_and_artifact_together() {
        let mut store = SpaceStore::new();
        let (subject, _) = store.create_node("Service");
        let receipt = store
            .commit_batch(CommitBatch {
                values: vec![
                    ValueDraft {
                        subject_atom: subject,
                        key: ValueKey::FieldCurrent,
                        payload: ValuePayload::Field(sample_field()),
                        epistemic_mode: EpistemicMode::BoundedSnapshot,
                        security: SecurityLabel::Internal,
                    },
                    ValueDraft {
                        subject_atom: subject,
                        key: ValueKey::ProofCurrent,
                        payload: ValuePayload::Proof(ProofValue {
                            verdict: ProofVerdict::Proved,
                            artifact_ref: None,
                            evidence_count: 3,
                            epsilon_eff: 0.1,
                            max_violation_magnitude: 0.0,
                            insufficiency_reason: None,
                        }),
                        epistemic_mode: EpistemicMode::BoundedSnapshot,
                        security: SecurityLabel::Internal,
                    },
                ],
                artifacts: vec![ArtifactDraft::Proof {
                    subject_atom: subject,
                    record: sample_proof_record(subject),
                }],
            })
            .unwrap();

        let proof = store.read_proof_at(subject, receipt.txn).unwrap();
        assert!(proof.artifact_ref.is_some());
        let artifact = store.read_artifact(proof.artifact_ref.unwrap()).unwrap();
        match &artifact.payload {
            ArtifactPayload::Proof(record) => assert_eq!(record.subject_atom, subject),
        }
    }

    #[test]
    fn journal_checksum_detects_corruption() {
        let journal = temp_path("hellgraph_journal_corrupt");
        let mut store = JournaledStore::create_new(&journal).unwrap();
        let (_subject, _) = store.create_node("Service").unwrap();

        let mut contents = std::fs::read_to_string(&journal).unwrap();
        contents = contents.replacen("FRAME\t1\tATOM\t1\t1\t", "FRAME\t1\tATOM\t1\t1\t999", 1);
        std::fs::write(&journal, contents).unwrap();

        let replay = JournaledStore::open_or_replay(&journal);
        assert!(replay.is_err());
        std::fs::remove_file(&journal).ok();
        std::fs::remove_file(format!("{}.manifest", journal.to_string_lossy())).ok();
        std::fs::remove_file(format!("{}.checkpoint", journal.to_string_lossy())).ok();
    }

    #[test]
    fn checkpoint_compact_and_reopen_preserve_state() {
        let journal = temp_path("hellgraph_journal_compact");
        let mut store = JournaledStore::create_new(&journal).unwrap();
        let (subject, _) = store.create_node("Service").unwrap();
        let receipt = store
            .commit_batch(CommitBatch {
                values: vec![ValueDraft {
                    subject_atom: subject,
                    key: ValueKey::FieldCurrent,
                    payload: ValuePayload::Field(sample_field()),
                    epistemic_mode: EpistemicMode::BoundedSnapshot,
                    security: SecurityLabel::Internal,
                }],
                artifacts: vec![ArtifactDraft::Proof {
                    subject_atom: subject,
                    record: sample_proof_record(subject),
                }],
            })
            .unwrap();
        store.checkpoint_and_compact().unwrap();
        let manifest = store.manifest().clone();
        assert_eq!(manifest.last_checkpoint_txn, receipt.txn);
        assert_eq!(manifest.last_frame_seq, 0);

        let reopened = JournaledStore::open_or_replay(&journal).unwrap();
        assert_eq!(
            reopened
                .inner()
                .read_field_at(subject, receipt.txn)
                .unwrap()
                .state,
            sample_field().state
        );
        std::fs::remove_file(&journal).ok();
        std::fs::remove_file(format!("{}.manifest", journal.to_string_lossy())).ok();
        std::fs::remove_file(format!("{}.checkpoint", journal.to_string_lossy())).ok();
    }

    #[test]
    fn checkpoint_roundtrip_preserves_links() {
        let ckpt = temp_path("hellgraph_ckpt");
        let mut store = SpaceStore::new();
        let (a, _) = store.create_node("Service");
        let (b, _) = store.create_node("Key");
        store
            .create_link(
                "Decrypt",
                LinkSemantics::DirectedBinary,
                vec![
                    RoleBinding {
                        role_name: "caller".into(),
                        target: a,
                        ordinal: 0,
                    },
                    RoleBinding {
                        role_name: "key".into(),
                        target: b,
                        ordinal: 1,
                    },
                ],
            )
            .unwrap();
        save_checkpoint(&store, &ckpt).unwrap();
        let loaded = load_checkpoint(&ckpt).unwrap();
        assert!(loaded.atom(a).is_some());
        assert!(loaded.atom(b).is_some());
        std::fs::remove_file(ckpt).ok();
    }

    // SP-RETR-FIBER-001 (WO_FIBER_002): the edge class survives a checkpoint round-trip.
    #[test]
    fn checkpoint_roundtrip_preserves_edge_class() {
        let ckpt = temp_path("hellgraph_ckpt_edgeclass");
        let mut store = SpaceStore::new();
        let (a, _) = store.create_node("Section");
        let (b, _) = store.create_node("Entity");
        let (link, _) = store
            .create_link_classed(
                "contains",
                LinkSemantics::DirectedBinary,
                EdgeClass::Containment,
                vec![
                    RoleBinding {
                        role_name: "parent".into(),
                        target: a,
                        ordinal: 0,
                    },
                    RoleBinding {
                        role_name: "child".into(),
                        target: b,
                        ordinal: 1,
                    },
                ],
            )
            .unwrap();
        save_checkpoint(&store, &ckpt).unwrap();
        let loaded = load_checkpoint(&ckpt).unwrap();
        match loaded.atom(link).unwrap() {
            Atom::Link(l) => assert_eq!(l.edge_class, EdgeClass::Containment),
            _ => panic!("expected a link atom"),
        }
        std::fs::remove_file(ckpt).ok();
    }

    // WO_FIBER_002 backward-compat migration: a LINK line written before the edge-class
    // field (6 tab fields, no 7th) must restore as Relational, not error.
    #[test]
    fn restore_link_line_defaults_legacy_line_to_relational() {
        let mut store = SpaceStore::new();
        let legacy = ["LINK", "7", "3", "LegacyType", "DB", ""];
        restore_link_line(&mut store, &legacy).unwrap();
        match store.atom(7).unwrap() {
            Atom::Link(l) => assert_eq!(l.edge_class, EdgeClass::Relational),
            _ => panic!("expected a link atom"),
        }
    }
}
