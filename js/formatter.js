/* ============================================================
   JSON BFF — formatter.js (validate / format / compact)

   Pure functions, zero DOM access: runs unmodified as a classic
   <script> in the browser (JSONBFF-PLAN.md §2) and under Node,
   where the test runner loads it via fs + vm.

   Exposes: JSONBFFFormat = { validate, format, compact }
   API contract consumed by js/app.js (JSONBFF-PLAN.md §4):
     validate(text)        → { ok, message }
     format(text, indent)  → { ok, output?, message }
     compact(text)         → { ok, output?, message }
   `indent` is 2 | 4 | "\t"; `message` is a ready-to-show status
   string. Failure results carry no `output` so the UI never
   clobbers the last good output pane (app.js enforces that too).

   Notes:
   - Strict by design: BOM stripping, comment removal etc. belong
     to the Fix pipeline (js/fixer.js, JSONBFF-PLAN.md §5).
   - Re-serializing is the only transform, so Format/Compact can
     never change meaning — only whitespace (JSONBFF-PLAN.md §5.3).
   ============================================================ */
(function (root) {
  'use strict';

  /** UTF-8 byte length of a string (JSON payloads can be non-ASCII).
      TextEncoder in modern browsers/Node; Buffer in bare Node contexts;
      manual count as a last resort. */
  function toBytes(str) {
    try { return new TextEncoder().encode(str).length; } catch (e) { /* fall through */ }
    if (typeof Buffer !== 'undefined' && Buffer.byteLength) return Buffer.byteLength(str);
    var n = 0, c;
    for (var i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length &&
               str.charCodeAt(i + 1) >= 0xdc00 && str.charCodeAt(i + 1) <= 0xdfff) {
        n += 4; i++; // surrogate pair = 4 bytes
      } else n += 3; // BMP ≥ U+0800, or a lone surrogate encoded as one code unit
    }
    return n;
  }

  /** 12345 → "12,345" (grouped sizes per the §4 "1,204 → 318 bytes" example). */
  function fmt(n) { return n.toLocaleString('en-US'); }

  /* ---------------- error location (JSONBFF-PLAN.md §4) ----------------
     V8 SyntaxError messages embed either "line N column M",
     "at position P" or both — regex both. Firefox puts exact
     lineNumber/column on the error object itself. When only a
     position is known, line/col are derived by counting newlines
     in [0, position). Position is 0-based; line/col 1-based. */
  function locateError(text, err) {
    var msg = (err && err.message) ? String(err.message) : String(err);
    var pos = null, line = null, col = null;

    var lc = /line (\d+) column (\d+)/.exec(msg);
    if (lc) { line = parseInt(lc[1], 10); col = parseInt(lc[2], 10); }

    var p = /at position (\d+)/.exec(msg);
    if (p) pos = parseInt(p[1], 10);

    // Firefox exposes the exact location on the error object.
    if (!line && err && Number.isInteger(err.lineNumber)) {
      line = err.lineNumber;
      if (Number.isInteger(err.column)) col = err.column;
    }

    // Fallback: derive line/col from the character offset.
    if (pos != null && line == null && typeof text === 'string' && text.length > 0) {
      var off = Math.min(pos, text.length); // V8 may point just past the end
      line = 1;
      var lineStart = 0;
      for (var i = 0; i < off; i++) {
        if (text.charCodeAt(i) === 10) { line++; lineStart = i + 1; }
      }
      col = off - lineStart + 1;
    }

    return { pos: pos, line: line, col: col };
  }

  /** Status string per §4: "✗ Invalid — <error message> at line L, column C (position P)".
      Recent V8/Node messages already carry the location — don't duplicate it;
      only append what the runtime left out. */
  function invalidMessage(text, err) {
    var raw = (err && err.message) ? String(err.message) : String(err);
    var loc = locateError(text, err);
    var hasColInMsg = /line \d+ column \d+/.test(raw);
    var hasPosInMsg = /at position \d+/.test(raw);

    var suffix;
    if (hasColInMsg) {
      suffix = ''; // runtime already reports line + column
    } else if (loc.line != null && loc.col != null && !hasPosInMsg) {
      suffix = ' at line ' + loc.line + ', column ' + loc.col;
    } else if (loc.line != null && loc.col != null) {
      suffix = ' (line ' + loc.line + ', column ' + loc.col + ')'; // msg had position only
    } else if (loc.pos != null && !hasPosInMsg) {
      suffix = ' at position ' + loc.pos;
    } else {
      suffix = '';
    }
    return '✗ Invalid — ' + raw + suffix;
  }

  /** Parse once, share across validate/format/compact. */
  function tryParse(text) {
    if (typeof text !== 'string' || text.trim() === '') {
      return { ok: false, message: 'Input is empty — paste JSON first.' };
    }
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (err) {
      return { ok: false, message: invalidMessage(text, err) };
    }
  }

  /** One-line shape summary for the status bar (step 4 detail): "object with
      5 keys", "array of 12 items", "primitive string"… */
  function shapeSummary(value) {
    if (value === null) return 'null value';
    if (Array.isArray(value)) {
      return 'array of ' + fmt(value.length) + (value.length === 1 ? ' item' : ' items');
    }
    var t = typeof value;
    if (t === 'object') {
      var n = Object.keys(value).length;
      return 'object with ' + fmt(n) + (n === 1 ? ' key' : ' keys');
    }
    return 'primitive ' + t; // string / number / boolean
  }

  /** Validate: §4 — success reports byte size, failure reports location. */
  function validate(text) {
    var r = tryParse(text);
    if (!r.ok) return { ok: false, message: r.message };
    return { ok: true, message: '✓ Valid JSON — ' + fmt(toBytes(text)) + ' bytes · ' + shapeSummary(r.value) };
  }

  /** Format (beautify): §4 — JSON.stringify(parse(input), null, indent). */
  function format(text, indent) {
    var r = tryParse(text);
    if (!r.ok) return { ok: false, message: r.message };
    var space = indent;
    if (!(typeof space === 'string' || (typeof space === 'number' && space > 0))) space = 2;
    var out = JSON.stringify(r.value, null, space);
    var lines = 1;
    for (var i = 0; i < out.length; i++) {
      if (out.charCodeAt(i) === 10) lines++;
    }
    var indentLabel = space === '\t' ? 'tabs' : space + ' spaces';
    return {
      ok: true,
      output: out,
      message: '✓ Formatted (' + indentLabel + ') — ' + fmt(lines) + ' lines, ' + fmt(toBytes(out)) + ' bytes'
    };
  }

  /** Compact: §4 — no whitespace; status shows the size delta. */
  function compact(text) {
    var r = tryParse(text);
    if (!r.ok) return { ok: false, message: r.message };
    var out = JSON.stringify(r.value);
    var oldB = toBytes(text), newB = toBytes(out);
    var extra;
    if (oldB === newB) extra = ' (already compact)';
    else extra = ' (−' + Math.round((1 - newB / oldB) * 100) + '%)';
    return {
      ok: true,
      output: out,
      message: '✓ Compacted — ' + fmt(oldB) + ' → ' + fmt(newB) + ' bytes' + extra
    };
  }

  root.JSONBFFFormat = { validate: validate, format: format, compact: compact };
})(typeof window !== 'undefined' ? window : globalThis);