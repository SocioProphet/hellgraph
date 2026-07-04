# HellGraph Roadmap — 3 Sprints

Arc: **Sprint 1 = it runs · Sprint 2 = one enterprise tenant safely · Sprint 3 = many tenants +
the moat** — mirroring the dedicated→pooled→blended tenancy sequencing. Legend: ✅ done ·
🔧 buildable-here · 🔒 needs your infra/creds · ⛔ upstream-blocked.

## Sprint 1 — Live & Operable
Goal: a real 2-node federation on GKE, observable and operable.
- ✅ Observability — Prometheus `/metrics`, request/query/rate-limit/error/denial counters.
- ✅ Rate limiting — per-principal token bucket on `/query` + `/admit` (429).
- ✅ CI image pipeline — `docker-publish.yml` (build+push to GAR on tag, WIF).
- ✅ Operator runbook — `docs/RUNBOOK.md`.
- 🔒 Live bring-up — build/push, create auth secret, `kubectl`/ArgoCD apply (needs GCP creds).
- 🔧 Backup/DR — PVC snapshot + "rebuild derived view from participant logs" restore test.

## Sprint 2 — First Tenant, Production-Grade
Goal: onboard one enterprise tenant end-to-end with real backends + isolation.
- 🔧 Residency enforcement — policy denies egress whose residency label ∉ target's allowed set.
- 🔧 Vendor Files adapters — Gemini/Claude/OpenAI over `fetch` (implement `VendorFilesClient`).
- 🔧 P5 — query responses carry proof frame-status (cut) so results are frame-relative.
- 🔒 Real object/KMS adapters — S3/BYOS (aws-sdk / MinIO), KMS tier (GCP KMS / Vault); creds-gated.
- 🔧 Per-tenant cell + tenant-scoped auth (the `tenant` claim already exists).
- 🔒 Security review — threat-model egress/masking/key-custody/auth (human sign-off).

## Sprint 3 — Scale, Conformance & the Pitch
Goal: multi-tenant scale + DAS conformance + differentiation asset.
- 🔧 Read-replica scale-out — N super-peer indexers off one federation (derived views).
- 🔧 Tenancy tiers — pooled multi-tenant + blended dedicated↔pooled router.
- 🔧 MeTTa depth — grounded conditionals/comparison, rules-in-space, conformance harness.
- ⛔ Codex G4 — CTRL243 profile allocation + `topic23.v1` freeze (TriTRPC owner; see spec 12).
- 🔧 Differentiation — "verifiable sovereign store vs Neptune" demo + benchmark.

## Cross-cutting
BYOC (substrate step 2) and air-gap (step 3) are nearly free once Sprint 2 lands — per-tenant
cells + injected backends make "where the participant node runs" a config choice.
