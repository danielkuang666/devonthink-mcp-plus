# devonthink-mcp-plus

Supplementary [MCP](https://modelcontextprotocol.io) server for [DEVONthink](https://www.devontechnologies.com/apps/devonthink), designed to work alongside the stock [`mcp-server-devonthink`](https://www.npmjs.com/package/mcp-server-devonthink).

The stock MCP handles write operations (create, update, delete, tag, classify). This server fills the **read gap**: returning document content alongside search results, paginating large files, and loading entire project folders as context — all without extra round-trips.

## Why this exists

The stock `mcp-server-devonthink` search returns only metadata (name, path, score). To actually read a document you need a second tool call. For large PDFs or emails the full content blows out the context window with no way to paginate. This server fixes both problems by surfacing DEVONthink's existing full-text index directly.

## Tools

### `dt_search_with_excerpts`

Search DEVONthink and get plain-text excerpts inline — one call, no follow-up needed.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Search query. Supports DEVONthink operators: `name:`, `tag:`, `kind:`, etc. |
| `database` | string | all | Restrict to a specific database name |
| `limit` | number | 10 | Max results (capped at 50) |
| `excerpt_chars` | number | 600 | Plain-text characters to include per result |

**Supported formats:** Markdown, PDF, Email (.eml), Excel (.xlsx), Word (.docx) — anything DEVONthink has indexed.

---

### `dt_get_content_chunked`

Read a document in pages. Use `offset` + `limit` to walk through large files without filling the context window. The response includes `total_chars`, `has_more`, and `next_offset` so you know whether to keep reading.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `uuid` | string | required | Record UUID (from search results) |
| `offset` | number | 0 | Character position to start from |
| `limit` | number | 4000 | Max characters to return |

---

### `dt_get_group_context`

Load a plain-text snapshot of every document inside a DEVONthink group. Useful for priming project context before starting a task.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `group_path` | string | required | Database-relative path, e.g. `/ONVIF_Offering/Longse` |
| `database` | string | required | Database name, e.g. `Active_Work` |
| `max_chars_per_doc` | number | 800 | Max plain-text chars per document |
| `max_docs` | number | 20 | Max documents (direct children only, no sub-groups) |

---

## Requirements

- macOS (uses `osascript` to talk to DEVONthink)
- DEVONthink 3 or later, running
- Node.js 18+

## Installation

```bash
git clone https://github.com/danielkuang666/devonthink-mcp-plus.git
cd devonthink-mcp-plus
npm install
```

Register with Claude Code:

```bash
claude mcp add --scope user devonthink-plus node /path/to/devonthink-mcp-plus/server.js
```

Verify it's connected:

```bash
claude mcp list
```

## Usage with Claude Code

```
# Search with content
dt_search_with_excerpts(query="ONVIF ProfileM", database="Active_Work")

# Read a large PDF in pages
dt_get_content_chunked(uuid="CA5B35C5-...", offset=0, limit=4000)
dt_get_content_chunked(uuid="CA5B35C5-...", offset=4000, limit=4000)  # next page

# Load a project folder as context
dt_get_group_context(group_path="/ONVIF_Offering/Longse", database="Active_Work")
```

## How it works

- **JXA (JavaScript for Automation)**: used for search and content retrieval, returns structured JSON
- **AppleScript**: used for group navigation (`get record at path`), which is more reliable than JXA for path-based lookups
- Scripts are written to temp files before execution to avoid shell-escaping issues
- DEVONthink's `plainText` property provides already-extracted text for all indexed formats — no separate OCR or parsing needed

## Pair with the stock MCP

This server is read-only. For write operations, keep `mcp-server-devonthink` installed alongside it:

| Need | Use |
|------|-----|
| Search + read content | `devonthink-plus` (this server) |
| Create / update / delete records | `mcp-server-devonthink` |
| Add tags, set properties | `mcp-server-devonthink` |
| Classify, compare, AI summarize | `mcp-server-devonthink` |

## Versioning

```bash
# After making changes
git add server.js
git commit -m "feat: description"
git push
git tag v0.x.0
git push origin v0.x.0
gh release create v0.x.0 --generate-notes
```
