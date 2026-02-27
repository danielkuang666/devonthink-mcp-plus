#!/usr/bin/env node
/**
 * devonthink-plus — Supplementary MCP server for DEVONthink
 *
 * Adds three tools on top of the stock devonthink MCP:
 *   dt_search_with_excerpts  — search + inline plain-text excerpts in one call
 *   dt_get_content_chunked   — paginated reading for large documents
 *   dt_get_group_context     — load a whole project folder as context
 *
 * Implementation: uses osascript (JXA + AppleScript) to talk to DEVONthink.
 * No extra deps beyond @modelcontextprotocol/sdk.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Script runners ───────────────────────────────────────────────────────────
// Write to temp file to avoid all shell-escaping issues.

function runJXA(script, timeoutMs = 30_000) {
  const tmp = join(tmpdir(), `dt-jxa-${Date.now()}.js`);
  try {
    writeFileSync(tmp, script, 'utf8');
    return execFileSync('osascript', ['-l', 'JavaScript', tmp], {
      encoding: 'utf8',
      timeout: timeoutMs,
    }).trim();
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function runAppleScript(script, timeoutMs = 30_000) {
  const tmp = join(tmpdir(), `dt-as-${Date.now()}.applescript`);
  try {
    writeFileSync(tmp, script, 'utf8');
    return execFileSync('osascript', [tmp], {
      encoding: 'utf8',
      timeout: timeoutMs,
    }).trim();
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ── Tool definitions ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'dt_search_with_excerpts',
    description:
      'Search DEVONthink and return results WITH plain-text excerpts in a single call. ' +
      'Works for all indexed formats: Markdown, PDF, Email (.eml), Excel, Word. ' +
      'Prefer this over the stock devonthink search when you need to read content immediately ' +
      'without a second round-trip.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query. Supports DEVONthink operators: name:, tag:, kind:, etc.',
        },
        database: {
          type: 'string',
          description: 'Restrict to this database name (optional). Searches all databases if omitted.',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 10, max 50).',
        },
        excerpt_chars: {
          type: 'number',
          description: 'Plain-text characters to include per result (default 600).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'dt_get_content_chunked',
    description:
      'Get the plain-text content of a DEVONthink record in pages. ' +
      'Use offset + limit to walk through large PDFs, emails, or long notes ' +
      'without filling the context window. ' +
      'The response includes total_chars and next_offset so you know whether to keep reading.',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: {
          type: 'string',
          description: 'Record UUID (from dt_search_with_excerpts or the stock search tool).',
        },
        offset: {
          type: 'number',
          description: 'Character position to start reading from (default 0).',
        },
        limit: {
          type: 'number',
          description: 'Max characters to return in this chunk (default 4000).',
        },
      },
      required: ['uuid'],
    },
  },
  {
    name: 'dt_get_group_context',
    description:
      'Load a plain-text snapshot of every document inside a DEVONthink group/folder. ' +
      'Ideal for priming project context before starting a task ' +
      '(e.g. group_path="/ONVIF_Offering/Longse", database="Active_Work"). ' +
      'Returns the first max_chars_per_doc characters of each file plus its UUID ' +
      'so you can follow up with dt_get_content_chunked for deeper reads.',
    inputSchema: {
      type: 'object',
      properties: {
        group_path: {
          type: 'string',
          description: 'Database-relative path of the group, e.g. /ONVIF_Offering/Longse',
        },
        database: {
          type: 'string',
          description: 'Database name, e.g. Active_Work',
        },
        max_chars_per_doc: {
          type: 'number',
          description: 'Max plain-text characters to include per document (default 800).',
        },
        max_docs: {
          type: 'number',
          description: 'Max documents to include (default 20, direct children only, no sub-groups).',
        },
      },
      required: ['group_path', 'database'],
    },
  },
];

// ── Server setup ─────────────────────────────────────────────────────────────
const server = new Server(
  { name: 'devonthink-plus', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === 'dt_search_with_excerpts') return searchWithExcerpts(args);
    if (name === 'dt_get_content_chunked')  return getContentChunked(args);
    if (name === 'dt_get_group_context')    return getGroupContext(args);
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

// ── dt_search_with_excerpts ──────────────────────────────────────────────────
function searchWithExcerpts({ query, database, limit = 10, excerpt_chars = 600 }) {
  const safeLimit = Math.min(Number(limit) || 10, 50);
  const safeExcerpt = Number(excerpt_chars) || 600;

  // JXA: global search, optional database filter, inline plain-text excerpt
  const script = `
    var dt = Application("DEVONthink");
    var query      = ${JSON.stringify(String(query))};
    var dbFilter   = ${JSON.stringify(database || null)};
    var limit      = ${safeLimit};
    var excerptLen = ${safeExcerpt};

    var raw  = dt.search(query);
    var out  = [];

    for (var i = 0; i < raw.length && out.length < limit; i++) {
      var r = raw[i];

      // Optional database filter
      if (dbFilter && r.database().name() !== dbFilter) continue;

      var pt = '';
      try { pt = r.plainText() || ''; } catch (e) {}

      var excerpt = pt.length > excerptLen
        ? pt.substring(0, excerptLen) + '…'
        : pt;

      out.push({
        name:     r.name(),
        uuid:     r.uuid(),
        location: r.location(),
        database: r.database().name(),
        score:    Math.round(r.score() * 100) / 100,
        kind:     r.type(),
        excerpt:  excerpt.trim(),
      });
    }

    JSON.stringify({ total: raw.length, returned: out.length, results: out });
  `;

  const data = JSON.parse(runJXA(script));

  let text = `Found **${data.total}** results (showing ${data.returned}):\n\n`;
  for (const r of data.results) {
    text += `### ${r.name}\n`;
    text += `- **UUID**: \`${r.uuid}\`\n`;
    text += `- **Location**: ${r.database} → ${r.location}\n`;
    text += `- **Type**: ${r.kind} | **Score**: ${r.score}\n`;
    if (r.excerpt) text += `\n${r.excerpt}\n`;
    text += '\n---\n\n';
  }

  return { content: [{ type: 'text', text }] };
}

// ── dt_get_content_chunked ───────────────────────────────────────────────────
function getContentChunked({ uuid, offset = 0, limit = 4000 }) {
  const safeOffset = Number(offset) || 0;
  const safeLimit  = Number(limit)  || 4000;

  const script = `
    var dt        = Application("DEVONthink");
    var uuid      = ${JSON.stringify(String(uuid))};
    var offset    = ${safeOffset};
    var chunkSize = ${safeLimit};

    var r = dt.getRecordWithUuid(uuid);
    if (!r) throw new Error("Record not found: " + uuid);

    var pt = '';
    try { pt = r.plainText() || ''; } catch (e) {}

    var total   = pt.length;
    var chunk   = pt.substring(offset, offset + chunkSize);
    var nextOff = offset + chunk.length;

    JSON.stringify({
      name:         r.name(),
      uuid:         r.uuid(),
      kind:         r.type(),
      content:      chunk,
      offset:       offset,
      chunk_length: chunk.length,
      total_chars:  total,
      has_more:     nextOff < total,
      next_offset:  nextOff,
    });
  `;

  const d = JSON.parse(runJXA(script));

  const range  = `chars ${d.offset}–${d.offset + d.chunk_length} of ${d.total_chars}`;
  const more   = d.has_more
    ? ` | ▶ more available — use offset: ${d.next_offset}`
    : ' | ✓ end of document';
  const header = `**${d.name}** [${d.kind}] (${range}${more})\n\n`;

  return { content: [{ type: 'text', text: header + d.content }] };
}

// ── dt_get_group_context ─────────────────────────────────────────────────────
function getGroupContext({ group_path, database, max_chars_per_doc = 800, max_docs = 20 }) {
  const safeMaxChars = Number(max_chars_per_doc) || 800;
  const safeMaxDocs  = Math.min(Number(max_docs) || 20, 50);

  // Step 1 — AppleScript: navigate to group, list direct children (uuid|||name|||kind)
  // Uses string concatenation + return char (\r) — the only reliable line separator
  // when getting multi-line text back from osascript.
  const asScript = `
tell application id "DNtp"
  set g to get record at "${group_path}" in database named "${database}"
  set kids to children of g
  set out to ""
  set counter to 0
  repeat with k in kids
    if counter >= ${safeMaxDocs} then exit repeat
    set kKind to type of k as string
    if kKind is not "group" and kKind is not "smart group" then
      set out to out & uuid of k & "|||" & name of k & "|||" & kKind & return
      set counter to counter + 1
    end if
  end repeat
  return out
end tell
`;

  const asResult = runAppleScript(asScript);
  if (!asResult) {
    return {
      content: [{ type: 'text', text: `Group "${group_path}" in "${database}" is empty or not found.` }],
    };
  }

  const items = asResult
    .split('\r')  // AppleScript `return` char is \r
    .filter(Boolean)
    .map(line => {
      const [uuid, name, kind] = line.split('|||');
      return { uuid: uuid?.trim(), name: name?.trim(), kind: kind?.trim() };
    })
    .filter(i => i.uuid && i.name);

  if (items.length === 0) {
    return { content: [{ type: 'text', text: `No documents found in "${group_path}".` }] };
  }

  // Step 2 — JXA: batch-fetch plain text for all collected UUIDs
  const uuids = items.map(i => i.uuid);
  const jxaScript = `
    var dt       = Application("DEVONthink");
    var uuids    = ${JSON.stringify(uuids)};
    var maxChars = ${safeMaxChars};
    var out      = {};

    for (var i = 0; i < uuids.length; i++) {
      var r  = dt.getRecordWithUuid(uuids[i]);
      var pt = '';
      try { if (r) pt = r.plainText() || ''; } catch (e) {}
      out[uuids[i]] = pt.substring(0, maxChars).trim();
    }

    JSON.stringify(out);
  `;

  const contentMap = JSON.parse(runJXA(jxaScript, 60_000)); // allow more time for batch

  // Build output
  let text = `**Group**: \`${group_path}\` in **${database}** — ${items.length} documents\n\n`;
  for (const item of items) {
    text += `### ${item.name} [${item.kind}]\n`;
    text += `UUID: \`${item.uuid}\`\n`;
    const content = contentMap[item.uuid] || '';
    if (content) text += `\n${content}\n`;
    text += '\n---\n\n';
  }

  return { content: [{ type: 'text', text }] };
}

// ── Start ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
