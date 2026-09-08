/* ============================================================
   JSON BFF — webmcp.js (WebMCP agent-facing tools)
   JSONBFF-PLAN.md §12 (investigated 2026-09-08), step 7.

   Exposes the site's core actions as WebMCP tools so agent browsers
   (Chrome/Edge origin trials, ChatGPT Desktop, …) can validate /
   format / compact / fix JSON in-page — no network, no UI actuation.

   Pure progressive enhancement: this whole file is a silent no-op
   wherever document.modelContext is absent (Firefox, Safari, file://,
   Chrome/Edge without the origin trial), so the zero-console-errors
   DoD (§11) holds in every environment.

   Zero dependencies: inputSchema objects are plain JSON Schema per the
   current spec (Zod not required). Loaded after js/formatter.js +
   js/fixer.js, which provide the pure functions wrapped below. All
   coupling to the (draft) WebMCP API lives in this one file so future
   spec churn stays a one-file change (§12 risks).
   ============================================================ */
(function () {
  'use strict';

  var mc = (typeof document !== 'undefined') ? document.modelContext : undefined;
  if (!mc || typeof mc.registerTool !== 'function') return; // unsupported → silent no-op

  /* §12: cap tool input (~50 KB, same scale as the share-link limit). */
  var MAX_INPUT = 50000;

  function withinLimit(text) {
    return typeof text === 'string' && text.length <= MAX_INPUT;
  }

  function tooLargeMessage() {
    return 'Input too large for this tool (limit ' + MAX_INPUT + ' characters).';
  }

  /* "2" | "4" | "tab" (tool schema) → 2 | 4 | "\t" (formatter API). */
  function indentFrom(value) {
    if (value === '4') return 4;
    if (value === 'tab') return '\t';
    return 2;
  }

  var TEXT_PROP = {
    type: 'string',
    description: 'Raw JSON text. May be valid or broken.'
  };
  var INDENT_PROP = {
    type: 'string',
    enum: ['2', '4', 'tab'],
    description: 'Output indent style: "2" (default), "4", or "tab".'
  };

  function baseSchema(extra) {
    var props = { text: TEXT_PROP };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) props[k] = extra[k];
      }
    }
    return { type: 'object', properties: props, required: ['text'], additionalProperties: false };
  }

  var tools = [
    {
      name: 'json_validate',
      description: 'Validates JSON text. Returns { valid, message }; on failure the message includes the parse error with line and column.',
      inputSchema: baseSchema(),
      execute: async function (input) {
        if (!withinLimit(input && input.text)) return { valid: false, message: tooLargeMessage() };
        var r = window.JSONBFFFormat.validate(input.text);
        return { valid: r.ok, message: r.message };
      }
    },
    {
      name: 'json_format',
      description: 'Parses and beautifies valid JSON text with the chosen indent. Returns { ok, formatted?, message }; if ok is false the input was not valid JSON — json_fix repairs broken input.',
      inputSchema: baseSchema({ indent: INDENT_PROP }),
      execute: async function (input) {
        if (!withinLimit(input && input.text)) return { ok: false, message: tooLargeMessage() };
        var r = window.JSONBFFFormat.format(input.text, indentFrom(input && input.indent));
        if (!r.ok) return { ok: false, message: r.message };
        return { ok: true, formatted: r.output, message: r.message };
      }
    },
    {
      name: 'json_compact',
      description: 'Compacts valid JSON text to a single line (no whitespace). Returns { ok, compacted?, message }; the message shows the byte-size delta.',
      inputSchema: baseSchema(),
      execute: async function (input) {
        if (!withinLimit(input && input.text)) return { ok: false, message: tooLargeMessage() };
        var r = window.JSONBFFFormat.compact(input.text);
        if (!r.ok) return { ok: false, message: r.message };
        return { ok: true, compacted: r.output, message: r.message };
      }
    },
    {
      name: 'json_fix',
      description: 'Repairs common JSON breakage (trailing commas, single quotes, unquoted keys, comments, missing brackets, NaN/undefined, Python True/False/None) and returns the repaired text formatted. Returns { ok, fixed?, message, changes? }; when ok is false the message reports the remaining parse error plus what was already repaired.',
      inputSchema: baseSchema({ indent: INDENT_PROP }),
      execute: async function (input) {
        if (!withinLimit(input && input.text)) return { ok: false, message: tooLargeMessage() };
        var r = window.JSONBFFFix.fix(input.text, indentFrom(input && input.indent));
        var out = { ok: r.ok, message: r.message };
        if (typeof r.output === 'string' && r.output) out.fixed = r.output;
        if (r.changes && r.changes.length) out.changes = r.changes;
        return out;
      }
    }
  ];

  for (var i = 0; i < tools.length; i++) {
    try {
      var result = mc.registerTool(tools[i]);
      if (result && typeof result.then === 'function') result.catch(function () {}); // never surface a console error
    } catch (e) { /* registration race / unsupported option — stay silent */ }
  }
})();