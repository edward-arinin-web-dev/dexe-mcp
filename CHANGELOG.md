# Changelog

## 0.1.1

### Added
- `dexe_get_methods` introspection tool — returns per-contract methods partitioned into `read` (view/pure) and `write` (nonpayable/payable). Each entry includes `name`, canonical `signature`, 4-byte `selector`, `stateMutability`, and structured `inputs`/`outputs` with `internalType` preserved (so tuple-typed args like `IGovPool.ProposalView[]` survive intact). Designed for generating TypeScript interfaces or ethers wrappers without re-parsing raw ABIs. Supports `kind` filter (`read`/`write`/`all`) and optional `includeEvents`/`includeErrors`.

Tool count: 14 → 15.

## 0.1.0

Initial public release (Phase A): build/test, contract introspection, read-only governance tools. 14 tools.
