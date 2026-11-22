# Changelog

## [Unreleased]

## [0.1.2] - 2026-11-22

- Compatibility: declare DeepSeek Harness 0.2.3-alpha.1 support (>=0.2.3-0 <0.3.0-0 in engines.dsh and every @deepseek-ai/dsh-* peer range) and refresh README verification stamps.

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-10

### Added

- `lit_search`: OpenAlex / Crossref / arXiv / Europe PMC fan-out, merge by DOI →
  arXiv id → normalized title, per-source counts and typed errors.
- `lit_resolve_oa`: keep source links, resolve DOIs through Unpaywall when
  `mailto` is configured, report per-item failures.
- `lit_sufficiency`: quota plus subtopic coverage (CJK unigrams + bigrams),
  explicit `gaps[]` and deterministic `nextQueries[]`.
- `lit_harvest_run`: bounded search → sufficiency → gap-driven round loop; one
  run record persisted as a REP evidence snapshot or `<root>/runs/*.json`.
- Bounded HTTP client: five-host allowlist, refused redirects, timeouts,
  per-host interval, 429/503 retry budget.
