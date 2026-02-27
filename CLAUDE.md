# CLAUDE.md — devonthink-mcp-plus

This file helps Claude Code work on this project effectively.

## What this project is

A supplementary MCP server (3 tools) that gives Claude Code access to DEVONthink document content — not just metadata. It runs alongside `mcp-server-devonthink` (which handles write operations).

Key files:
- `server.js` — entire implementation, ~350 lines
- `package.json` — single dep: `@modelcontextprotocol/sdk`

## Architecture

Two script runners communicate with DEVONthink via `osascript`:

- **`runJXA(script)`** — JavaScript for Automation. Used for search and content retrieval because it returns proper JSON via `JSON.stringify()`.
- **`runAppleScript(script)`** — Used for group/path navigation (`get record at path in database`) because it's more reliable than JXA for path-based lookups.

Both runners write scripts to temp files (not `-e` flag) to avoid shell-escaping issues entirely.

## Critical DEVONthink / osascript gotchas

These were discovered through testing. Do not undo them.

**App name**
```javascript
Application("DEVONthink")   // ✅ correct
Application("DEVONthink 3") // ❌ "Application can't be found" error
```

**JXA search — database filter doesn't work as a parameter**
```javascript
// ❌ Fails with "Invalid argument" (-50)
dt.search("query", { 'in': db })

// ✅ Search globally, filter in JS
var results = dt.search("query");
var filtered = results.filter(r => r.database().name() === "Active_Work");
```

**JXA search — `location:` operator doesn't work**
```javascript
dt.search('location:"/ONVIF_Offering/Longse/"') // returns 0 results
// Use AppleScript `get record at path` instead for group navigation
```

**AppleScript line separator is `\r`, not `\n`**
```javascript
// In Node.js, split AppleScript output with:
asResult.split('\r').filter(Boolean)
// NOT .split('\n') — osascript outputs \r for AppleScript `return` char
```

**AppleScript list-to-text with delimiter is unreliable**
```applescript
-- ❌ This silently returns empty output
set AppleScript's text item delimiters to linefeed
return out as text

-- ✅ Use string concatenation instead
set out to out & uuid of k & "|||" & name of k & return
```

**UUIDs vs numeric IDs**
```javascript
dt.getRecordWithUuid("CA5B35C5-F7B6-4F44-8EAB-AB6BAC72C3B4") // ✅ real UUID
dt.getRecordWithUuid("168035")  // ❌ numeric ID, will throw "not found"
```

**`plainText` property works for all indexed formats**
- Markdown ✅, PDF ✅ (DEVONthink OCR), Email ✅, Excel ✅, Word ✅
- Bookmarks return empty string — expected

## Tool implementation pattern

```
dt_search_with_excerpts  →  single JXA call (search + plainText in one loop)
dt_get_content_chunked   →  single JXA call (getRecordWithUuid + substring)
dt_get_group_context     →  AppleScript (get children list) → JXA (batch plainText fetch)
```

The group context two-step is intentional: AppleScript navigates by path reliably, JXA handles JSON output cleanly.

## How to test changes

Test individual JXA scripts directly before touching server.js:

```bash
osascript -l JavaScript << 'EOF'
var dt = Application("DEVONthink");
// ... your script
JSON.stringify(result);
EOF
```

Test AppleScript:
```bash
osascript << 'EOF'
tell application id "DNtp"
  -- your script
end tell
EOF
```

Run the full server manually to check it starts:
```bash
node server.js
# Should hang (waiting for MCP stdio) — Ctrl+C to exit
```

Check it's connected in Claude Code:
```bash
claude mcp list
# devonthink-plus: node ... - ✓ Connected
```

## Release workflow

```bash
# 1. Make and test changes to server.js
# 2. Commit
git add server.js
git commit -m "feat|fix|chore: description"
git push

# 3. Tag and release
git tag v0.x.0
git push origin v0.x.0
gh release create v0.x.0 --generate-notes
```

## MCP registration

Registered at user scope — available in all Claude Code sessions:
```
node /Users/daniel/.mcp-servers/devonthink-plus/server.js
```

To re-register after moving the folder:
```bash
claude mcp remove devonthink-plus
claude mcp add --scope user devonthink-plus node /new/path/server.js
```

## What this server does NOT do (by design)

- No write operations — use `mcp-server-devonthink` for create/update/delete/tag
- No semantic/vector search — DEVONthink's index is keyword-based
- No sub-group recursion in `dt_get_group_context` — direct children only (intentional, avoids slow traversal)
