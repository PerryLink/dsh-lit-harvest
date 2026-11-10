# dsh-lit-harvest

**Search four indexes, resolve open-access PDFs, and stop when the evidence is sufficient — deterministically.**

*OpenAlex + Crossref + arXiv + Europe PMC in one call, Unpaywall for OA links, quota + subtopic coverage with explicit gaps, and a bounded harvest loop whose run record lands in REP. No LLM in the loop, no scraping, no paywall bypass.*

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24.9-brightgreen.svg)]()
[![DSH plugin](https://img.shields.io/badge/dsh--plugin-✅-green)](https://github.com/topics/dsh-plugin)

English · [简体中文](README-zh.md)

---

## What it does

| Tool | Job |
|---|---|
| `lit_search` | Fan out to the requested sources, dedupe by DOI → arXiv id → normalized title, merge source/PDF fields, report per-source errors |
| `lit_resolve_oa` | Keep the links a source already gave; look up DOIs in Unpaywall (requires `mailto`); report per-item failures |
| `lit_sufficiency` | Quota (core/total) + subtopic coverage over title/abstract/keywords, CJK unigrams + bigrams; returns `gaps[]` and `nextQueries[]` |
| `lit_harvest_run` | Bounded loop: search → sufficiency → gap-driven next round; stops at sufficiency or `maxRounds`; persists one run record |

Every hit carries its source, source id, `fetchedAt` and the query that found it. A source failure is reported as `{source, code, message}` and never becomes an empty result set.

## Data sources

| Source | Query | OA link |
|---|---|---|
| OpenAlex | `api.openalex.org/works` | `best_oa_location.pdf_url` |
| Crossref | `api.crossref.org/works` | landing page only |
| arXiv | `export.arxiv.org/api/query` | `link[title=pdf]` |
| Europe PMC | `www.ebi.ac.uk/europepmc/rest/search` | `fullTextUrlList` PDF |
| Unpaywall | `api.unpaywall.org/v2/{doi}` | `best_oa_location` + `oa_locations` |

Only these five hosts are allowed. Redirects are refused, timeouts are explicit, and requests are serialized per host with an interval.

## Install

```sh
dsh plugin --profile <name> add dsh-lit-harvest
dsh --profile <name> --dump-config | grep dsh-lit-harvest
```

Set a contact address before resolving DOIs:

```yaml
mailto: you@example.org
```

`mailto` is optional for search (OpenAlex/Crossref just lose the polite-pool benefit) and **required** for Unpaywall DOI lookups; missing it is a typed `MAILTO_REQUIRED` result, not a silent empty link list.

## Harvest record

`lit_harvest_run` persists one JSON snapshot per run:

```text
topic, subtopics, generatedAt, plugin/version, settings,
rounds[{round, query, found, newPapers, sufficient, gaps, perSource, errors}],
papers[] (merged, deduplicated),
sufficiency{coreCount, totalCount, minCore, minTotal, coverage[], gaps[], nextQueries[]}
```

- `ctx.researchEvidence` mounted → one REP evidence item (media type `application/json`) with a `source-status` check.
- Not mounted → `<root>/runs/<runId>.json` (default `.lit-harvest`).
- `persist: false` → nothing is written.

The run id is `sha256(topic, subtopics, queries, paper identifiers)[:16]`, so rerunning the same search produces the same id.

## What it does not do

- **No LLM relevance judgment.** Quota, coverage and gaps are lexical and recomputable; semantic reranking is out of scope.
- **No full-text download or parsing.** That is `dsh-doc-anchor`; this plugin returns links.
- **No CNKI scraping.** Chinese literature goes through `dsh-source-cnki` exports.
- **No paywall bypass.** Only OA links the providers expose.
- **No retraction check.** That is `dsh-retraction-watch`.
- **No silent repair.** A failed source stays in `errors[]`; a partial run is labelled partial.

## Compatibility

| | |
|---|---|
| DeepSeek Harness | `dsh-v0.2.1-rc.5` (verified on this machine) — peer line `>=0.2.1-0 <0.3.0 \|\| >=0.2.2-0 <0.3.0` |
| Node | `^22.19.0 \|\| >=24.9.0` (tested on `24.22.1`), ESM only |
| Peers | `@perrylink/dsh-research-core ^0.1.0`, `@deepseek-ai/cordis ^4.0.5-alpha.1`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery ^3.18.5-alpha.1` |
| Runtime dependencies | **zero** |

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` mounts nothing |
| `root` | `.lit-harvest` | fallback run-record root |
| `mailto` | — | polite-pool contact; required for Unpaywall |
| `userAgent` | `dsh-lit-harvest/0.1.0 (…)` | sent to every source |
| `timeoutMs` | `15000` | per-request deadline |
| `minIntervalMs` | `150` | per-host request interval |
| `retries` | `1` | retries for 429/503 |
| `maxResults` | `25` | per-source cap for `lit_search` |
| `maxRounds` / `perRound` | `3` / `10` | harvest loop bounds |
| `minCore` / `minTotal` | `5` / `10` | default quotas |

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm verify:package
```

Tests use a scripted HTTP client and inline fixtures; no network is required.

## License

Apache-2.0. See [LICENSE](LICENSE).
