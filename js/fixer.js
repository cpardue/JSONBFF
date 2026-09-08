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
      Firefox lineNumber/column; fall back to counting newlines up to the
      position when only a position is known. */
  function errorDetail(text, err) {
    var msg = (err && err.message) ? String(err.message) : String(err);
    var m = /line (\d+) column (\d+)/.exec(msg);
    if (m) return msg;
    var p = /at position (\d+)/.exec(msg);
    if (p && typeof text === 'string') {
      var pos = Math.min(parseInt(p[1], 10), text.length);
      var line = 1, lineStart = 0, i;
      for (i = 0; i < pos; i++) {
        if (text.charCodeAt(i) === 10) { line++; lineStart = i + 1; }
      }
      return msg + ' (line ' + line + ', column ' + (pos - lineStart + 1) + ')';
    }
    if (err && Number.isInteger(err.lineNumber)) {
      return msg + ' (line ' + err.lineNumber +
        (Number.isInteger(err.column) ? ', column ' + (err.column + 1) : '') + ')';
    }
    return msg;
  }

  /* ---------------- pass helpers (all string-aware via spans) ---------- */

  /** Strip a BOM and normalize CRLF/CR to LF (cosmetic, §5.2 pass 1). */
  function stripBomAndNewlines(text) {
    var changes = 0;
    if (text.charCodeAt(0) === 0xfeff) { text = text.slice(1); changes++; }
    var crlf = (text.match(/\r\n/g) || []).length;
    var cr = (text.match(/\r/g) || []).length - crlf;
    if (crlf + cr > 0) { text = text.replace(/\r\n?/g, '\n'); changes += crlf + cr; }
    return { text: text, changes: changes, key: 'bom' };
  }

  /** Remove line comments (// … EOL) and block comments (/* … *\/)
      outside string spans (§5.2 pass 2). */
  function stripComments(text) {
    var spans = mapStrings(text);
    var removed = 0;
    var out = transformOutsideSpans(text, spans, function (chunk) {
      return chunk.replace(/\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, function (m) {
        removed++;
        // keep a newline if a line comment ate to end-of-line, so lines don't merge
        return /\/\//.test(m.slice(0, 2)) ? ' ' : '';
      });
    });
    return { text: out, changes: removed, key: 'comments' };
  }

  /** Single-quoted strings → double-quoted; unescape \' inside them
      (§5.2 pass 3). Only runs on invalid input, so legit JSON (which has
      no single-quoted spans) is never touched. */
  function convertSingleQuotes(text) {
    var spans = mapStrings(text);
    var converted = 0;
    // Re-scan: a span starting with ' that contains no unescaped " becomes "…"
    var out = '';
    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      if (ge > gs) out += text.slice(gs, ge);
      if (k < spans.length) {
        var s = spans[k][0], e = spans[k][1];
        if (text.charAt(s) === "'") {
          var inner = text.slice(s + 1, e - 1);
          if (inner.indexOf('"') === -1) {
            converted++;
            out += '"' + inner.replace(/\\'/g, "'").replace(/"/g, '\\"') + '"';
            continue;
          }
        }
        out += text.slice(s, e);
      }
    }
    return { text: out, changes: converted, key: 'squote' };
  }

  /** Quote bare object keys: { key: … } / {key: …} → { "key": … }
      (§5.2 pass 4). Word-boundary aware — never touches string contents. */
  function quoteUnquotedKeys(text) {
    var spans = mapStrings(text);
    var quoted = 0;
    var out = transformOutsideSpans(text, spans, function (chunk) {
      return chunk.replace(/([{\[,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, function (_, pre, key, post) {
        quoted++;
        return pre + '"' + key + '"' + post;
      });
    });
    return { text: out, changes: quoted, key: 'keys' };
  }

  /** Remove trailing commas before } or ] (§5.2 pass 5). */
  function removeTrailingCommas(text) {
    var spans = mapStrings(text);
    var removed = 0;
    var out = transformOutsideSpans(text, spans, function (chunk) {
      return chunk.replace(/,(\s*[}\]])/g, function (_, m) {
        removed++;
        return m;
      });
    });
    return { text: out, changes: removed, key: 'trailing' };
  }

  /** Replace JS literals NaN / undefined / Infinity with null (§5.2 pass 6).
      Literal-only, word-boundary matched — "NaN" inside strings is safe. */
  function replaceJsLiterals(text) {
    var spans = mapStrings(text);
    var replaced = 0;
    var out = transformOutsideSpans(text, spans, function (chunk) {
      return chunk.replace(/-?\b(?:Infinity|NaN|undefined)\b/g, function () {
        replaced++;
        return 'null';
      });
    });
    return { text: out, changes: replaced, key: 'jslit' };
  }

  /** Replace Python-style True / False / None with true / false / null
      (§5.2 pass 7). Case-sensitive whole words outside strings only. */
  function replacePythonLiterals(text) {
    var spans = mapStrings(text);
    var replaced = 0;
    var out = transformOutsideSpans(text, spans, function (chunk) {
      return chunk.replace(/\b(?:True|False|None)\b/g, function (m) {
        replaced++;
        return m === 'True' ? 'true' : (m === 'False' ? 'false' : 'null');
      });
    });
    return { text: out, changes: replaced, key: 'pylit' };
  }

  /** Remove stray closing brackets/braces that have no open counterpart
      (§5.2 pass 8). Scans the whole text (spans included — a bare ] or }
      can never be valid JSON content); counts balance outside strings. */
  function removeStrayClosers(text) {
    var spans = mapStrings(text);
    var stack = [];
    var strayAt = -1;
    var inSpan = false;
    for (var i = 0; i < text.length; ) {
      if (!inSpan) {
        var c = text.charAt(i);
        if (c === '{' || c === '[') stack.push(c);
        else if (c === '}' || c === ']') {
          if (!stack.length) { strayAt = i; break; }
          var open = stack.pop();
          var close = (c === '}' ? '{' : '[');
          if (open !== close) { strayAt = i; break; } // mismatched → treat as stray boundary
        } else {
          if (c === '"' || c === "'") inSpan = true; // enter span (approx: recompute below)
        }
      }
      i++;
    }
    // The single-pass above can't track spans precisely; use the scanner:
    var removed = 0;
    if (strayAt !== -1) {
      var out2 = text.slice(0, strayAt) + ' ' + text.slice(strayAt + 1);
      removed = 1;
      // recursively strip any further strays (bounded: each pass removes ≥1 char)
      var guard = 0;
      while (guard < 50) {
        out2 = removeStrayClosersOnce(out2, mapStrings(out2));
        if (out2 === text.slice(0, strayAt) + ' ' + text.slice(strayAt + 1) || removed >= 50) break;
        removed++;
        guard++;
      }
      return { text: out2, changes: removed, key: 'stray' };
    }
    return { text: text, changes: 0, key: 'stray' };
  }

  function removeStrayClosersOnce(text, spans) {
    var stack = [];
    var pos = 0;
    var out = '';
    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      var chunk = text.slice(gs, ge);
      for (var i = 0; i < chunk.length; i++) {
        var c = chunk.charAt(i);
        if (c === '{' || c === '[') stack.push(c);
        else if (c === '}' || c === ']') {
          var open = stack.pop();
          if (!open || (c === '}' ? open !== '{' : open !== '[')) continue; // stray → drop
        }
        out += c;
      }
      if (k < spans.length) out += text.slice(spans[k][0], spans[k][1]);
    }
    return out;
  }

  /** Close brackets left open at end-of-text, in reverse order
      (§5.2 pass 8b). Only applied when parsing still fails. */
  function closeOpenBrackets(text) {
    var spans = mapStrings(text);
    var stack = [];
    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      for (var i = 0; i < ge - gs; i++) {
        var c = text.charAt(gs + i);
        if (c === '{' || c === '[') stack.push(c);
        else if (c === '}' || c === ']') stack.pop();
      }
    }
    var suffix = '';
    while (stack.length) {
      var o = stack.pop();
      suffix += (o === '{' ? '}' : ']');
    }
    if (!suffix) return { text: text, changes: 0, key: 'closed' };
    return { text: text.replace(/\s+$/, '') + '\n' + suffix, changes: stack.length || 1, key: 'closed' };
  }

  var PASSES = [
    stripBomAndNewlines,
    stripComments,
    convertSingleQuotes,
    quoteUnquotedKeys,
    removeTrailingCommas,
    replaceJsLiterals,
    replacePythonLiterals,
    removeStrayClosers,
    closeOpenBrackets
  ];

  /* Human-readable change summaries for the status bar (§4 "report what
     was fixed"). `count` = number of individual edits in that pass. */
  var LABELS = {
    bom: function (c) { return 'normalized line endings' + (c > 1 ? ' (' + c + ')' : ''); },
    comments: function (c) { return c === 1 ? 'removed 1 comment' : 'removed ' + c + ' comments'; },
    squote: function (c) { return c === 1 ? 'converted 1 single-quoted string' : 'converted ' + c + ' single-quoted strings'; },
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