---
status: accepted
---
# Knowledge docs are files: public summaries in the repo, a private overlay by mount, no network index

`search_docs` answers questions from curated notes. The notes must keep working when the vendor API is down, must never carry vendor text we may not republish, and must let an operator add private knowledge without that knowledge ever entering the repository or the image.

## Decision

1. **Docs are Markdown files with a fixed front matter** (`id`, `title`, optional `country`, `channel`, `tags`, `link`). The parser reads `key: value` lines and a comma separated `tags` line, and nothing else. No YAML dependency: the format is ours and a general parser would accept shapes we do not want.
2. **Search is in memory.** The index is built once from the loaded docs: lower-cased tokens, a small stop-word list, BM25-style scoring with title and tag weight, a linear scan. The corpus is capped at 500 documents, so no search dependency and no network index, and the tool needs no Stralfors client.
3. **Public docs are summaries with a link.** `knowledge/public/` ships in the repo and the image. Each doc is a short original summary (at most 4000 characters) that links to the vendor documentation; vendor text is not copied. A corpus test enforces source, an `https` link, length, unique ids and zero load warnings.
4. **The private overlay is mounted, never committed.** `KNOWLEDGE_DIRS` lists directories (`:` separated); their docs are labelled `private` whatever their front matter says, a later directory or a private doc replaces an earlier doc with the same id, and a missing directory stops start-up with fixed text. The image copies `knowledge/public` only and sets no overlay default; a static image test asserts this.
5. **Every hit carries its `source`.** An assistant and its user can tell a public summary from an operator's private note. The tool description says doc text is reference material, not instructions.
6. **Loaded once at start; a restart reloads.** No file watching. Start-up logs counts only (docs, warnings), never file names or paths, because a private file name can be sensitive. Per-file problems are warnings with the base file name; symlinks leaving the directory, non-`.md` files and files over 64 KiB are ignored or skipped.
7. **Audit is unchanged.** `search_docs` is a plain `read` tool; the query and the hits never reach the audit event, a span or a metric label (ADR 0008).

## Consequences

- Adding knowledge is a file change and a restart. An operator can keep private notes in a volume or a separate image layer without a rebuild of this one.
- A malformed doc silently reduces the corpus apart from a warning count; the operator reads the warning count, and the file name appears only in the loader's warning list, not in the log.
- The tiny parser rejects YAML features (multi-line values, nested keys). A doc that needs them is simplified, not supported.
- A linear scan is fine to a few hundred docs. Past a few thousand, replace the index behind `search()`; the tool's contract does not change.
- The Helm chart does not yet mount an overlay or set `KNOWLEDGE_DIRS`; that is deployment work for a later phase.
