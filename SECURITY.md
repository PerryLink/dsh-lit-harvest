# Security

## Scope

`dsh-lit-harvest` contacts exactly five hosts over HTTPS:

- `api.openalex.org`
- `api.crossref.org`
- `export.arxiv.org`
- `www.ebi.ac.uk` (Europe PMC)
- `api.unpaywall.org`

Any other host is rejected before a request is made. Redirects are refused, so
an allowed host cannot bounce the client to another origin.

## Data

- Search hits are public bibliographic metadata. The run record stores titles,
  authors, identifiers, abstracts and links — no PDFs, no credentials.
- `mailto` is sent to OpenAlex/Crossref/Unpaywall as a polite-pool contact; it
  is not written into the run record.
- Run records are written under the plugin root (`.lit-harvest` by default) or
  registered in the local REP store. Nothing is uploaded.

## Limits

- Timeouts, per-host intervals and retry budgets are enforced by the client.
- Harvest loops stop at `maxRounds` even when the evidence is still
  insufficient; a partial run is labelled partial.
- `lit_resolve_oa` accepts at most 50 items per call.

## Reporting

Open an issue at <https://github.com/PerryLink/dsh-lit-harvest/issues> without
including private data, credentials or unpublished manuscripts.
