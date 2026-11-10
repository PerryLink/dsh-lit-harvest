# Changelog

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
