/* ============================================================
   JSON BFF — fixer.js (repair pipeline)

   The core feature (JSONBFF-PLAN.md §5). Pure functions, zero DOM
   access: loads as a classic <script> in the browser and runs
   unmodified under Node (tests load it via fs + vm).

   Exposes: JSONBFFFix = { fix }
   API contract consumed by js/app.js (JSONBFF-PLAN.md §4):
     fix(text, indent?) → { ok, output?, message, changes?: [{pass, count}] }
   - Valid input up front → 0 changes, reformatted output (idempotent).
   - Repair = fixed-order passes (§5.2); JSON.parse is attempted after
     each pass and the pipeline stops at the first success, so no pass
     ever runs on valid input — it cannot change its meaning (§5.3).
     Passes are monotone, so re-rounding until a round changes nothing
     (or parsing succeeds) always terminates.
   - Unrecoverable → ok:false with the remaining parse error plus the
     passes already applied; best-effort text kept in `output` (§5.3).

   Known limitation: a bare apostrophe in prose/comments is treated as
   the start of a single-quoted span (mapStrings supports ' per §5.1).
   Such input degrades to a clear error report — never a silent wrong
   result, since passes only run on already-invalid input.

   §5.2 stretch pass 9 ("insert missing commas") intentionally dropped:
   not provably safe — clear error reporting covers it instead.
   ============================================================ */
(function (root) {
  'use strict';

  /* ---------------- shared string-aware scanner (§5.1) ----------------
     Spans are [start, end) including delimiters; escape-aware for both
     " and ' delimiters; an unterminated string extends to end-of-text.
     Transforms act only outside spans, so JSON content containing //,
     #, brackets or quotes is never mangled (§5.1, §5.3). */
  function mapStrings(text) {
    var spans = [];
    var i = 0;
    var n = text.length;
    while (i < n) {
      var c = text.charAt(i);
      if (c === '"' || c === "'") {
        var j = i + 1;
        while (j < n) {
          if (text.charAt(j) === '\\') { j += 2; continue; }
          if (text.charAt(j) === c) break;
          j++;
        }
        var end = (j < n) ? j + 1 : n; // unterminated → to end-of-text
        spans.push([i, end]);
        i = end;
      } else {
        i++;
      }
    }
    return spans;
  }

  /** Apply fn to every non-string region; string spans are copied into
      the result byte-for-byte (§5.1). */
  function transformOutsideSpans(text, spans, fn) {
    var out = '';
    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      if (ge > gs) out += fn(text.slice(gs, ge));
      if (k < spans.length) out += text.slice(spans[k][0], spans[k][1]);
    }
    return out;
  }

  function isWs(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r'; }

  function isWordChar(c) {
    if (c == null) return false;
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
           (c >= '0' && c <= '9') || c === '_' || c === '$';
  }

  /** Parse once. → { ok, value? } or { ok:false, error? }. */
  function attemptParse(text) {
    try { return { ok: true, value: JSON.parse(text) }; }
    catch (err) { return { ok: false, error: err }; }
  }

  /** "<error message> at line L, column C" — regex V8 position/line-col,
      Firefox lineNumber/column props, newline-counting fallback (same
      approach as js/formatter.js; duplicated to keep this file
      self-contained). No duplicate location when the runtime message
      already carries one. */
  function errorDetail(text, err) {
    var msg = (err && err.message) ? String(err.message) : String(err);
    var pos = null, line = null, col = null;
    var lc = /line (\d+) column (\d+)/.exec(msg);
    if (lc) { line = parseInt(lc[1], 10); col = parseInt(lc[2], 10); }
    var p = /at position (\d+)/.exec(msg);
    if (p) pos = parseInt(p[1], 10);
    if (!line && err && Number.isInteger(err.lineNumber)) {
      line = err.lineNumber;
      if (Number.isInteger(err.column)) col = err.column;
    }
    if (pos != null && line == null && text.length) {
      var off = Math.min(pos, text.length);
      line = 1;
      var lineStart = 0;
      for (var i = 0; i < off; i++) {
        if (text.charCodeAt(i) === 10) { line++; lineStart = i + 1; }
      }
      col = off - lineStart + 1;
    }
    if (line != null && col != null && !/line \d+ column \d+/.test(msg)) {
      msg += ' at line ' + line + ', column ' + col;
    }
    return msg;
  }

  /* ---------------- passes (§5.2, fixed order) ----------------
     Each pass: text → { text, changes: [{key, count}] }; a pass reports
     only what it actually changed. */

  /** Pass 1 — Normalize: strip UTF-8 BOM, convert CRLF/CR → LF. */
  function passNormalize(text) {
    var count = 0;
    var t = text;
    if (t.charCodeAt(0) === 0xFEFF) { t = t.slice(1); count++; }
    t = t.replace(/\r\n?/g, function () { count++; return '\n'; });
    return count ? { text: t, changes: [{ key: 'normalize', count: count }] } : { text: text, changes: [] };
  }

  /** Pass 2 — Strip // line comments and /* block comments (outside spans). */
  function passComments(text) {
    var spans = mapStrings(text);
    var count = 0;
    var out = transformOutsideSpans(text, spans, function (region) {
      var s = '';
      var i = 0;
      var n = region.length;
      while (i < n) {
        if (region.charAt(i) === '/' && region.charAt(i + 1) === '/') {
          while (i < n && region.charAt(i) !== '\n') i++;
          count++;
          continue;
        }
        if (region.charAt(i) === '/' && region.charAt(i + 1) === '*') {
          i += 2;
          var close = region.indexOf('*/', i);
          i = close === -1 ? n : close + 2;
          s += ' ';
          count++;
          continue;
        }
        s += region.charAt(i++);
      }
      return s;
    });
    return count ? { text: out, changes: [{ key: 'comments', count: count }] } : { text: text, changes: [] };
  }

  /** Pass 3 — Single-quoted spans → double: swap delimiters, escape any
      inner "; \' (escaped apostrophe) collapses to '. All other escapes
      pass through untouched. */
  function passSingleQuotes(text) {
    var spans = mapStrings(text);
    var hasSingle = false;
    for (var q = 0; q < spans.length; q++) {
      if (text.charAt(spans[q][0]) === "'") { hasSingle = true; break; }
    }
    if (!hasSingle) return { text: text, changes: [] };
    var out = '';
    var last = 0;
    var converted = 0;
    for (var k = 0; k < spans.length; k++) {
      var s = spans[k][0];
      var e = spans[k][1];
      if (text.charAt(s) !== "'") continue;
      var inner = text.slice(s + 1, e - 1);
      var b = '';
      for (var i = 0; i < inner.length; i++) {
        var ch = inner.charAt(i);
        if (ch === '\\' && i + 1 < inner.length) {
          var nx = inner.charAt(i + 1);
          b += (nx === "'") ? "'" : (ch + nx);
          i++;
          continue;
        }
        b += (ch === '"') ? '\\"' : ch;
      }
      out += text.slice(last, s) + '"' + b + '"';
      last = e;
      converted++;
    }
    out += text.slice(last);
    return { text: out, changes: [{ key: 'quotes', count: converted }] };
  }

  /** Pass 4 — Quote unquoted keys after { or , (§5.2 safe heuristic).
      Note: replace() callback receives (fullMatch, p1, p2, p3, …). */
  function passUnquotedKeys(text) {
    var spans = mapStrings(text);
    var count = 0;
    var out = transformOutsideSpans(text, spans, function (region) {
      return region.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, function (full, a, key, c) {
        count++;
        return a + '"' + key + '"' + c;
      });
    });
    return count ? { text: out, changes: [{ key: 'keys', count: count }] } : { text: text, changes: [] };
  }

  /** Next non-whitespace character in code after index `from`, skipping
      string spans entirely. Returns the character, or null at end. */
  function nextCodeChar(text, spans, from) {
    var i = from;
    while (i < text.length) {
      for (var k = 0; k < spans.length; k++) {
        if (i >= spans[k][0] && i < spans[k][1]) { i = spans[k][1]; break; }
      }
      var c = text.charAt(i);
      if (isWs(c)) { i++; continue; }
      return c;
    }
    return null;
  }

  /** Pass 5 — Trailing commas: drop a comma when the next code character
      outside spans is } or ]. */
  function passTrailingCommas(text) {
    var spans = mapStrings(text);
    var removeAt = [];
    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      for (var i = gs; i < ge; i++) {
        if (text.charAt(i) !== ',') continue;
        var next = nextCodeChar(text, spans, i + 1);
        if (next === '}' || next === ']') removeAt.push(i);
      }
    }
    if (!removeAt.length) return { text: text, changes: [] };
    var out = '';
    var prev = 0;
    for (var r = 0; r < removeAt.length; r++) {
      out += text.slice(prev, removeAt[r]);
      prev = removeAt[r] + 1;
    }
    out += text.slice(prev);
    return { text: out, changes: [{ key: 'trailing', count: removeAt.length }] };
  }

  /** Passes 6/7 helper — replace whole tokens outside spans; a match is
      skipped when an identifier character touches either side. */
  function wordSwapPass(text, pattern, map, key) {
    var spans = mapStrings(text);
    var count = 0;
    var out = transformOutsideSpans(text, spans, function (region) {
      return region.replace(pattern, function (tok, off) {
        var before = off > 0 ? region.charAt(off - 1) : null;
        var after = off + tok.length < region.length ? region.charAt(off + tok.length) : null;
        if (isWordChar(before) || isWordChar(after)) return tok;
        count++;
        return map[tok];
      });
    });
    return count ? { text: out, changes: [{ key: key, count: count }] } : { text: text, changes: [] };
  }

  /** Pass 6 — Invalid JS literals → null (outside spans). */
  function passJsLiterals(text) {
    return wordSwapPass(text, /NaN|-Infinity|Infinity|undefined/g,
      { 'NaN': 'null', '-Infinity': 'null', 'Infinity': 'null', 'undefined': 'null' }, 'jslit');
  }

  /** Pass 7 — Python/other literals (outside spans). */
  function passPyLiterals(text) {
    return wordSwapPass(text, /True|False|None/g,
      { 'True': 'true', 'False': 'false', 'None': 'null' }, 'pylit');
  }

  /** Pass 8 — Balance brackets: a closer without a matching open is
      removed ("stray"); at end-of-text the still-open brackets are
      closed in reverse order. */
  function passBalanceBrackets(text) {
    var spans = mapStrings(text);
    var stack = [];
    var strayAt = [];
    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      for (var i = gs; i < ge; i++) {
        var c = text.charAt(i);
        if (c === '{' || c === '[') stack.push(c);
        else if (c === '}' || c === ']') {
          var want = c === '}' ? '{' : '[';
          if (stack[stack.length - 1] === want) stack.pop();
          else strayAt.push(i);
        }
      }
    }
    var changes = [];
    var out = text;
    if (strayAt.length) {
      out = '';
      var prev = 0;
      for (var r = 0; r < strayAt.length; r++) {
        out += text.slice(prev, strayAt[r]);
        prev = strayAt[r] + 1;
      }
      out += text.slice(prev);
      changes.push({ key: 'stray', count: strayAt.length });
    }
    var missing = '';
    for (var s2 = stack.length - 1; s2 >= 0; s2--) {
      missing += stack[s2] === '{' ? '}' : ']';
    }
    if (missing) {
      out += missing;
      changes.push({ key: 'closed', count: missing.length });
    }
    return changes.length ? { text: out, changes: changes } : { text: text, changes: [] };
  }

  /* ---------------- pipeline + status messages (§5.1, §4) ------------- */
  var PASSES = [
    passNormalize,       // 1
    passComments,        // 2
    passSingleQuotes,    // 3
    passUnquotedKeys,    // 4
    passTrailingCommas,  // 5
    passJsLiterals,      // 6
    passPyLiterals,      // 7
    passBalanceBrackets  // 8 (stretch pass 9 dropped — see header)
  ];

  var LABELS = {
    normalize: function (c) { return c === 1 ? 'stripped 1 BOM/line-ending' : 'stripped ' + c + ' BOMs/line-endings'; },
    comments: function (c) { return c === 1 ? 'removed 1 comment' : 'removed ' + c + ' comments'; },
    quotes: function (c) { return c === 1 ? 'converted 1 single-quoted string' : 'converted ' + c + ' single-quoted strings'; },
    keys: function (c) { return c === 1 ? 'quoted 1 key' : 'quoted ' + c + ' keys'; },
    trailing: function (c) { return c === 1 ? 'removed 1 trailing comma' : 'removed ' + c + ' trailing commas'; },
    jslit: function (c) { return c === 1 ? 'replaced 1 invalid literal' : 'replaced ' + c + ' invalid literals'; },
    pylit: function (c) { return c === 1 ? 'replaced 1 Python-style literal' : 'replaced ' + c + ' Python-style literals'; },
    stray: function (c) { return c === 1 ? 'removed 1 stray bracket' : 'removed ' + c + ' stray brackets'; },
    closed: function (c) { return c === 1 ? 'closed 1 open bracket' : 'closed ' + c + ' open brackets'; }
  };

  function changePhrases(changes) {
    var out = [];
    for (var i = 0; i < changes.length; i++) {
      var label = LABELS[changes[i].key];
      if (label) out.push(label(changes[i].count));
    }
    return out.join(', ');
  }

  function totalEdits(changes) {
    var n = 0;
    for (var i = 0; i < changes.length; i++) n += changes[i].count;
    return n;
  }

  /** Fix (repair) per §4: repaired output formatted at `indent`; status
      lists what was fixed; idempotent on valid input (0 changes). */
  function fix(text, indent) {
    if (typeof text !== 'string' || text.trim() === '') {
      return { ok: false, message: 'Input is empty — paste JSON first.' };
    }
    var current = text;
    var parsed = attemptParse(current);
    var changes = [];
    // Rounds of the fixed-order passes. Passes are monotone, but cap the
    // rounds anyway: a logic bug must fail clean, never hang the tab.
    var MAX_ROUNDS = 10;
    var round = 0;
    while (!parsed.ok && round < MAX_ROUNDS) {
      round++;
      var progressed = false;
      for (var i = 0; i < PASSES.length && !parsed.ok; i++) {
        var r = PASSES[i](current);
        if (r.changes.length) {
          changes = changes.concat(r.changes);
          current = r.text;
          parsed = attemptParse(current);
          progressed = true;
        }
      }
      if (!progressed) break; // no pass can help — stop and report (§5.3)
    }

    if (parsed.ok) {
      var space = indent;
      if (!(typeof space === 'string' || (typeof space === 'number' && space > 0))) space = 2;
      var message;
      if (!changes.length) {
        message = '✓ Already valid JSON — no fixes needed (reformatted).';
      } else {
        var edits = totalEdits(changes);
        message = '🔧 Fixed ' + changes.length + (changes.length === 1 ? ' issue: ' : ' issues: ') +
                  changePhrases(changes) + ' (' + edits + (edits === 1 ? ' edit' : ' edits') + ').' +
                  (round > 1 ? ' Took ' + round + ' repair rounds.' : '');
      }
      return { ok: true, output: JSON.stringify(parsed.value, null, space), message: message, changes: changes };
    }

    var phrases = changePhrases(changes);
    return {
      ok: false,
      output: current,
      message: '✗ Could not fully fix — ' + errorDetail(current, parsed.error) + '.' +
               (phrases ? ' Repaired so far: ' + phrases + '.' : ' No safe repair matched.'),
      changes: changes
    };
  }

  root.JSONBFFFix = {
    fix: fix,
    // Scanner internals exposed for tests (§5.1 names them as the API):
    _internal: { mapStrings: mapStrings, transformOutsideSpans: transformOutsideSpans }
  };
})(typeof window !== 'undefined' ? window : globalThis);