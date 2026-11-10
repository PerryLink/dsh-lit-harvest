# dsh-lit-harvest

**一次搜四个索引，解析 OA 全文链接，证据够了就停 —— 全程确定性。**

*OpenAlex + Crossref + arXiv + Europe PMC 一次调用，Unpaywall 解析 OA 链接，配额 + 子主题覆盖与显式缺口，有界采集循环，运行记录落进 REP。循环里没有 LLM，不抓站，不绕付费墙。*

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24.9-brightgreen.svg)]()
[![DSH plugin](https://img.shields.io/badge/dsh--plugin-✅-green)](https://github.com/topics/dsh-plugin)

[English](README.md) · 简体中文

---

## 工具

| 工具 | 作用 |
|---|---|
| `lit_search` | 按请求的源并发检索，按 DOI → arXiv id → 归一化标题去重合并，保留每个来源与 PDF 字段，逐源报告错误 |
| `lit_resolve_oa` | 保留来源已给的链接；用 Unpaywall 查 DOI（需要 `mailto`）；逐项报告失败 |
| `lit_sufficiency` | 配额（core/total）+ 子主题覆盖（标题/摘要/关键词，中文单字 + 双字）；返回 `gaps[]` 与 `nextQueries[]` |
| `lit_harvest_run` | 有界循环：检索 → 充分性 → 按缺口下一轮；达标或 `maxRounds` 停止；持久化一条运行记录 |

每条命中都带来源、来源 id、`fetchedAt` 与命中它的 query。某个源失败会记成 `{source, code, message}`，绝不会变成“没有结果”。

## 数据源

| 源 | 查询 | OA 链接 |
|---|---|---|
| OpenAlex | `api.openalex.org/works` | `best_oa_location.pdf_url` |
| Crossref | `api.crossref.org/works` | 仅 landing page |
| arXiv | `export.arxiv.org/api/query` | `link[title=pdf]` |
| Europe PMC | `www.ebi.ac.uk/europepmc/rest/search` | `fullTextUrlList` 里的 PDF |
| Unpaywall | `api.unpaywall.org/v2/{doi}` | `best_oa_location` + `oa_locations` |

只允许这五个 host；拒绝重定向、显式超时、按 host 串行并限速。

## 安装

```sh
dsh plugin --profile <name> add dsh-lit-harvest
dsh --profile <name> --dump-config | grep dsh-lit-harvest
```

解析 DOI 前先配联系人：

```yaml
mailto: you@example.org
```

检索时 `mailto` 可选（只影响 polite pool）；**Unpaywall 查 DOI 必须有它**，缺了会返回 `MAILTO_REQUIRED`，而不是悄悄给空链接。

## 运行记录

`lit_harvest_run` 每次运行持久化一条 JSON 快照：

```text
topic, subtopics, generatedAt, plugin/version, settings,
rounds[{round, query, found, newPapers, sufficient, gaps, perSource, errors}],
papers[]（合并去重）,
sufficiency{coreCount, totalCount, minCore, minTotal, coverage[], gaps[], nextQueries[]}
```

- 挂了 `ctx.researchEvidence` → 一条 REP 证据（`application/json`），附一个 `source-status` 检查。
- 没挂 → `<root>/runs/<runId>.json`（默认 `.lit-harvest`）。
- `persist: false` → 不写任何东西。

run id = `sha256(topic, subtopics, queries, 论文标识)[:16]`，同一检索重跑得到同一个 id。

## 它不做什么

- **不做 LLM 相关性判断。** 配额、覆盖、缺口都是词法、可重算的；语义重排不在范围内。
- **不下载/解析全文。** 那是 `dsh-doc-anchor`；这里只给链接。
- **不抓 CNKI。** 中文文献走 `dsh-source-cnki` 的导出。
- **不绕付费墙。** 只用数据源给出的 OA 链接。
- **不查撤稿。** 那是 `dsh-retraction-watch`。
- **不静默修补。** 失败的源留在 `errors[]`；不完整的运行会标注。

## 兼容性

| | |
|---|---|
| DeepSeek Harness | `dsh-v0.2.1-rc.5`（本机实测）—— peer 区间 `>=0.2.1-0 <0.3.0 \|\| >=0.2.2-0 <0.3.0` |
| Node | `^22.19.0 \|\| >=24.9.0`（实测 `24.22.1`），仅 ESM |
| Peers | `@perrylink/dsh-research-core ^0.1.0`、`@deepseek-ai/cordis ^4.0.5-alpha.1`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery ^3.18.5-alpha.1` |
| 运行时依赖 | **零** |

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 不挂任何工具 |
| `root` | `.lit-harvest` | 运行记录兜底根目录 |
| `mailto` | — | polite pool 联系人；Unpaywall 必需 |
| `userAgent` | `dsh-lit-harvest/0.1.0 (…)` | 发给每个源 |
| `timeoutMs` | `15000` | 单请求超时 |
| `minIntervalMs` | `150` | 同 host 请求间隔 |
| `retries` | `1` | 429/503 重试次数 |
| `maxResults` | `25` | `lit_search` 单源上限 |
| `maxRounds` / `perRound` | `3` / `10` | 采集循环上限 |
| `minCore` / `minTotal` | `5` / `10` | 默认配额 |

## 开发

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm verify:package
```

测试用 scripted HTTP 与内联 fixture，不需要外网。

## 许可

Apache-2.0，见 [LICENSE](LICENSE)。
