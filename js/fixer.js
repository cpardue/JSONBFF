/* ============================================================
   JSON BFF — fixer.js (repair pipeline)

   The core feature (JSONBFF-PLAN.md §5). Pure functions, zero DOM
   access: loads as a classic <script> in the browser and runs
   unmodified under Node (tests load it via fs + vm).

   Exposes: JSONBFFFix = { fix }
   API contract consumed by js/app.js (JSONBFF-PLAN.md §4):
     fix(text, indent?) → { ok, output?, message, changes?: [{pass, count}] }
   - Valid input up front → no repair passes run; the output is the
     JSON.stringify reserialization (idempotent). The one change a valid
     document can ever report is dupkeys — duplicate object keys are
     deduped natively by that reserialization and flagged so the user
     sees it (checklist §6).
   - Repair = fixed-order passes (§5.2); JSON.parse is attempted after
     each pass and the pipeline stops at the first success, so no pass
     ever runs on valid input — it cannot change its meaning (§5.3).
     Passes are monotone, so re-rounding until a round changes nothing
     (or parsing succeeds) always terminates.
   - Unrecoverable by the passes → one permissive (JSON5-style) fallback
     parse over the pre-processed input (checklist §8.1); success → a
     strict-reserialized output with a json5 change entry. If that fails
     too → ok:false citing the ORIGINAL input's first strict error plus
     line/column and a context snippet around the exact character (§8.2,
     with §1's ±20-char window); best-effort text kept in `output` (§5.3).

    Known limitations:
    - A bare apostrophe in prose is treated as the start of a
      single-quoted span (mapStrings supports ' per §5.1). An apostrophe
      span left unterminated to end-of-text is converted only when it opens
      in code context ({ , : [ or text start) — a prose apostrophe degrades
      to a clear error report instead, never a silent wrong result (§5.3).
    - Pass 2 wrapper stripping only recognizes a markdown fence when the
      paste starts with one, and prose containing unbalanced braces/brackets
      is never sliced away (bracket-free-prose rule) — such input fails
      with the plain parse error instead.
    - Missing commas/colons between members are repaired by pass 9
      passDelimiters (JSONBFF-IMPROVEMENTS.md §1.3): one grammar-driven
      left-to-right walk with a (container, role) frame stack. The only
      edits are the three insertions the JSON grammar forces — D1 `,`
      before a next key after a complete value in an object, D2 `:`
      between a key and its value, D3 `,` between array elements; every
      edit is reported. Not repaired (they fail with the clear error
      report, by design — IMPROVEMENTS §1.5): a mid-document bracket
      TYPE mismatch ({"a": [1, 2} "b": 3}); more than one missing token
      per gap ({ 1 2 3 } — at most one insertion per token boundary);
      structural nonsense in the wrong context (colon in an array
      [1, "a": 2], leading commas, missing value before a close
      { "a": , }); unquoted numeric keys ({ 1: 2 } — a number in key
      position is accepted, not quoted; still invalid); ambiguous pastes
      with several balanced containers surrounded by prose — the pass
      declines to edit at all there, since pass 2's leftmost-parseable
      slice would then guess which container is the payload (checklist §0
      no-guess policy).
    - Duplicate separators are collapsed by pass 10
      passDuplicatePunct (checklist §2.4; IMPROVEMENTS §2.2): a `,` or
      `:` whose previous code character outside string spans is the same
      punctuation is removed — runs like `,,` / `::` collapse to one,
      including pairs separated by whitespace or by a comment (pass 3
      strips comments earlier in the round). Valid JSON never places two
      separators in a row, so the edit can only fire on already-invalid
      text (§5.3). The pass carries pass 9's ambiguous-paste no-guess
      guard. Not repaired (they fail with the clear error report): a LONE
      leading comma ([,1]) and mixed sequences ({ "a", : 1 }) — §2.2
      remainder.
    - A bracket TYPE mismatch (checklist §3) is resolved by pass 11's
      two single-edit candidates — swap the closer to match the open
      frame, or remove it — each certified by a strict JSON.parse of the
      whole text (the parser itself decides; no guesswork). At most one
      candidate can ever parse: a swap keeps the outside-string bracket
      count and a removal lowers it by one, while valid JSON needs
      exactly one closer per opener. Adoption always makes the whole
      document parse, so it completes the repair in that round and only
      fires when no other defect blocks parsing; when neither single
      edit parses on its own, the mismatch is removed as a stray bracket
      and still-open brackets are closed at EOF (legacy path), or the
      clear error report ships.
     - Unescaped inner quotes (checklist §4.4) are repaired by pass 12
       passInnerQuotes: a terminated "..." span in VALUE position (right
       after a ':') immediately followed (in code) by a bare word that is NOT
       a key — no colon after the word — is read as a string that never closed
       there. For each later quote C, every unescaped " strictly between the
       opener and C is escaped and the whole-text result is strict-parsed; the
       leftmost C that parses wins (parser-certified, pass 11's policy). Not
       repaired (clean error report): breaks inside array elements or at
       object-key positions (a bare word there means a missing delimiter, not
       string content), breaks at quote adjacency (no bare word after the
       premature close), and strings that are ALSO missing their final closing
       quote.
     - Unterminated double-quoted strings (checklist §4.1) are closed by
       pass 13: each structural char ( , } ] ) inside the open span is tried
       first — insert " just before it, keep whichever whole-text result
       strict-parses (the checklist's own rule, parser-certified). If none
       parses, the string is closed at the end of its content: trailing
       whitespace stays outside the string and an odd dangling backslash run
       (which cannot escape anything) is dropped. Only spans opening in code
       context are closed — a stray " in prose degrades to the clean error
       report instead. Runs before pass 11 so the balance EOF-close cannot
       land inside the open span.
     - Raw control characters (U+0000–U+001F) inside strings are escaped by
       pass 14 to \b \t \n \f \r, others as \u00xx (checklist §4.5).
     - Malformed numbers (checklist §5) are repaired by pass 15
       passNumbers: a code-context token that reads as exactly ONE numeric
       typo end-to-end is rewritten to the unique valid JSON number it can
       mean — a leading + dropped (+5 → 5), integer leading zeros stripped
       (007 → 7, -00.25 → -0.25), a trailing dot without fraction digits
       dropped (5. → 5), or a missing integer part zeroed (.5 → 0.5); all
       four may combine in one token (+007. → 7). Exponent material is
       copied verbatim (signs inside 1e+5; leading zeros there are valid
       JSON — 1e007), so a token already matching the JSON number grammar
       is skipped and valid input can never change (§5.3). Not repaired
       (clean error report): runs that do not read as one such typo —
       1..2 (could be 1.2 or two values), identifier-like 007x, double
       signs --5, a bare . — and any token whose raw neighbor is an
       identifier character (pass 9's no-guess policy).
     - Unquoted bare words in VALUE position ({ "a": yes }) are NOT quoted
       (checklist §5 remainder): no provably-safe mapping exists — the
       word could be a mistyped true/false/null, a YAML-style boolean, or
       the intended string, and quoting it would guess which. Such input
       fails clean with the parse error at the word (fixture 60 pins it).
     - Duplicate object keys (checklist §6) are not edited in place: on
       success the output is the JSON.stringify reserialization of the
       parsed value, which keeps the LAST occurrence's value at the key's
       first position — exactly native JSON.parse behavior. The success
       path scans the final text and reports how many occurrences drop
       as a dupkeys change entry (countDuplicateKeys). No text surgery:
       a removal pass could reorder keys relative to the parse, and the
       flag is what §6 asks for.
      - Permissive fallback (checklist §8.1): when the repair pipeline
        exhausts its rounds, permissiveParse re-reads the pre-processed
        ORIGINAL text (BOM/fence/prose stripped via passes 1-2 only — the
        surgical passes may have mangled their own intermediate) with a
        recursive-descent JSON5-style parser that tolerates exactly four
        non-strict constructs, each meaning-preserving: line and block
        comments (skipped), trailing commas (dropped), single-quoted
        strings ('x' reads as "x" — JSON escape rules, \' collapsed to '),
        and unquoted identifier keys (the ASCII set pass 5 quotes; the
        identifier itself is the property name). Everything else stays
        strict: JSON numbers, double-quoted strings, true/false/null, one
        top-level value, nothing after it. The classic rescue: comments
        containing QUOTE characters — a ' or " inside a comment starts a
        fake span in mapStrings that swallows the rest of the document, so
        the span-based passes mangle such input while a real parser models
        comments as opaque text (fixtures 67-69). Still not repaired
        (clean failure): numeric keys ({ 1: 2 }), key characters outside
        the identifier set ({ my-key: 1 } — no JSON5 identifier holds '-'),
        bare words in VALUE position (see above), non-JSON numbers,
        unicode-only identifiers, multiple top-level values, and trailing
        junk after the value. Recursion depth is stack-bounded: a runaway
        document throws out of permissiveParse, fix() catches it and
        reports the fallback as failed — no hang, no guess (§5.3).
      - Failure report (checklist §8.2, carrying §1's ±20-char window):
        the message cites the FIRST strict error on the ORIGINAL input —
        coordinates must match what the user pasted, not a mangled
        intermediate — with line/column from parseErrorPosition (V8 "at
        position N" / "(line L column C)", Firefox lineNumber/column, else
        the token named in new V8's quoted-window message located inside
        that window, else end-of-text for "Unexpected end of JSON input").
        contextSnippet appends the error line (marked '>', caret under the
        exact column) plus enough neighbor lines for at least 20 chars on
        each side of the anchor (capped), with long lines horizontally
        windowed to ~80 chars centered on the column.
    ============================================================ */
(function (root) {
  'use strict';

  /* ---------------- shared string-aware scanner (§5.1) ----------------
     Spans are [start, end, terminated] including delimiters; escape-aware
     for both " and ' delimiters; an unterminated string (terminated false)
     extends to end-of-text — a span whose closing quote is the last char
     of the text still reads terminated true. Transforms act only outside
     spans, so JSON content containing //, #, brackets or quotes is never
     mangled (§5.1, §5.3). */
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
        spans.push([i, end, j < n]);   // [start, end, terminated]
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

  /** 1-based { line, col } of character offset `off` in `text`. */
  function lineColOf(text, off) {
    var o = Math.max(0, Math.min(off, text.length));
    var line = 1;
    var lineStart = 0;
    for (var i = 0; i < o; i++) {
      if (text.charCodeAt(i) === 10) { line++; lineStart = i + 1; }
    }
    return { line: line, col: o - lineStart + 1 };
  }

  /** { pos, line, col } (all non-null) from a JSON.parse error. Sources,
      in order: V8 message parts ("at position N", "(line L column C)"),
      Firefox-style err.lineNumber/err.column properties, then the quoted
      window newer V8 embeds instead of a position —
      Unexpected token '}', "<window>" is not valid JSON — where the window
      (or its elision-free pieces) is located in `text` and anchored at the
      unexpected token the message names. Last resort: end of text
      ("Unexpected end of JSON input" points at the end, checklist §1). */
  function parseErrorPosition(text, err) {
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
    if (pos != null && line == null) {
      var lc2 = lineColOf(text, pos);
      line = lc2.line; col = lc2.col;
    }
    if (pos == null && line != null && col != null) {
      // runtime gave line/column but no offset — scan to it
      var l2 = 1, s2 = 0;
      for (var j = 0; j < text.length && l2 < line; j++) {
        if (text.charCodeAt(j) === 10) l2++;
      }
      if (l2 >= line) pos = j + Math.max(0, col - 1);
    }
    if (pos == null) {
      // New V8 quoted-window shape: anchor the named token inside the
      // window (or its longest elision-free piece found in the text).
      var tok = /Unexpected token '([^']*)'/.exec(msg);
      var a = msg.indexOf("', \"");
      var b = msg.lastIndexOf('\" is not valid JSON');
      if (tok && tok[1] && a !== -1 && b > a + 4) {
        var win = msg.slice(a + 4, b);
        var pieces = win.split('...');
        for (var k = 0; k < pieces.length; k++) {
          var piece = pieces[k];
          if (!piece) continue;
          var ix = piece.indexOf(tok[1]);
          var at = text.indexOf(piece);
          if (at !== -1 && ix !== -1) { pos = at + ix; break; }
        }
      }
    }
    if (pos == null) pos = text.length;
    if (line == null || col == null) {
      var lc3 = lineColOf(text, pos);
      if (line == null) line = lc3.line;
      if (col == null) col = lc3.col;
    }
    return { pos: Math.max(0, Math.min(pos, text.length)), line: line, col: col };
  }

  /** "<error message> at line L, column C" — position from
      parseErrorPosition (same approach as js/formatter.js; duplicated to
      keep this file self-contained). No duplicate location when the
      runtime message already carries one. */
  function errorDetail(text, err) {
    var msg = (err && err.message) ? String(err.message) : String(err);
    if (!/line \d+ column \d+/.test(msg)) {
      var pc = parseErrorPosition(text, err);
      msg += ' at line ' + pc.line + ', column ' + pc.col;
    }
    return msg;
  }

  function spaces(n) {
    var s = '';
    while (s.length < n) s += ' ';
    return s;
  }

  /** Multi-line context snippet around an error position (checklist §1
      ±20-char window, delivered with the §8.2 failure report): the error
      line marked '>' with a caret under the exact column, plus enough
      neighbor lines that at least 20 chars of text on each side of the
      anchor are visible (capped at 4 extra lines per side) — short-line
      documents show a real neighborhood, minified one-line documents show
      an ~80-char window centered on the column. Long lines are
      horizontally windowed without ellipses (the caret must stay aligned).
      Display-only sanitation: \r dropped, other raw control chars escaped
      as \u00xx (escapes shift displayed width, so the caret then aims at
      the original column minus any escapes before it). Never throws — the
      position is clamped to the text. */
  function contextSnippet(text, pc) {
    var lines = text.split('\n');
    var total = lines.length;
    var L = Math.max(1, Math.min(pc.line || 1, total));
    var col = Math.max(1, pc.col || 1);

    var lo = L, hi = L;
    var before = col - 1;
    var after = lines[L - 1].length - col + 1;
    var up = 0;
    while (before < 20 && lo > 1 && up < 4) { lo--; before += lines[lo - 1].length + 1; up++; }
    var down = 0;
    while (after < 20 && hi < total && down < 4) { hi++; after += lines[hi - 1].length + 1; down++; }

    var MAXL = 80;
    var el = lines[L - 1];
    var S = 0;
    if (el.length > MAXL) S = Math.max(0, Math.min(el.length - MAXL, col - 32));

    function esc(s) {
      var out = '';
      for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (c === '\r') continue;
        var code = s.charCodeAt(i);
        if (code < 32) {
          var h = code.toString(16);
          out += '\\u00' + (h.length < 2 ? '0' : '') + h;
        } else {
          out += c;
        }
      }
      return out;
    }

    var digits = String(total).length;
    function gut(num, mark) { return mark + spaces(digits - String(num).length) + num + ' | '; }

    var head = 'Around the error, ' + (lo === hi ? 'line ' + lo : 'lines ' + lo + '-' + hi) + ' of ' + total + ':';
    var out = [head];
    for (var li = lo; li <= hi; li++) {
      out.push(gut(li, li === L ? '> ' : '  ') + esc(lines[li - 1].slice(S, S + MAXL)));
    }
    out.push('   ' + spaces(digits) + ' | ' + spaces(Math.max(0, col - 1 - S)) + '^');
    return out.join('\n');
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

  /** Top-level balanced container regions (string-aware depth walk) →
      [ [start, end), … ] left-to-right; a closer below depth 0 resets the
      current region. Shared by pass 2 (prose slicing) and passes 9–10
      (their ambiguous-paste guards must mirror pass 2's slice condition
      exactly — one source of truth for all three). */
  function topLevelRegions(text) {
    var spans = mapStrings(text);
    var regions = [];
    var depth = 0;
    var start = -1;
    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      for (var i = gs; i < ge; i++) {
        var ch = text.charAt(i);
        if (ch === '{' || ch === '[') {
          if (depth === 0) start = i;
          depth++;
        } else if (ch === '}' || ch === ']') {
          depth--;
          if (depth < 0) { depth = 0; start = -1; }
          else if (depth === 0) { regions.push([start, i + 1]); start = -1; }
        }
      }
    }
    return regions;
  }

  /** Is there non-blank text outside every region, and does it contain a
      bracket char? (prefix/gaps/suffix — regions are disjoint, left-to-right) */
  function outsideFlags(text, regions) {
    var nonBlank = false, hasBracket = false;
    var ri = 0;
    for (var p = 0; p < text.length; p++) {
      while (ri < regions.length && p >= regions[ri][1]) ri++;
      var covered = ri < regions.length && p >= regions[ri][0] && p < regions[ri][1];
      if (!covered) {
        var oc = text.charAt(p);
        if (!isWs(oc)) {
          nonBlank = true;
          if (oc === '{' || oc === '}' || oc === '[' || oc === ']') hasBracket = true;
        }
      }
    }
    return { nonBlank: nonBlank, hasBracket: hasBracket };
  }

  /** Pass 2 — Strip paste wrappers (checklist §0): a leading markdown
      code fence (```json … ```, closed or unclosed) and any surrounding
      prose outside the outermost balanced JSON container. Runs only on
      already-invalid text, so valid input is untouched (§5.3).

      Prose-slicing policy (conservative by design — no guessing):
        - slice only when non-blank text surrounds the container region(s)
          AND that outside text holds no { } [ ] characters — a bracket
          outside every balanced region is broken structure, not prose;
        - one balanced region → slice to it; several regions → slice to
          the leftmost region that already parses as strict JSON; none
          parse → no edit and the pipeline fails clean with the parse
          error;
        - a fence is recognized only when the first non-empty line is a
          ``` line (see header limitation).
      Monotone: every edit strictly shrinks the text, so re-rounds see a
      smaller or identical document — no oscillation. */
  function passWrapper(text) {
    var changes = [];
    var t = text;

    // -- fence: first non-empty line is a ``` line → payload is the block
    //    content between it and the next ``` line (or to end-of-text when
    //    the fence was left unclosed).
    var lines = t.split('\n');
    var f = -1;
    for (var li = 0; li < lines.length; li++) {
      if (lines[li].trim() !== '') { f = li; break; }
    }
    if (f !== -1 && lines[f].trim().indexOf('```') === 0) {
      var c = -1;
      for (var lj = f + 1; lj < lines.length; lj++) {
        if (lines[lj].trim().indexOf('```') === 0) { c = lj; break; }
      }
      var inner = lines.slice(f + 1, c === -1 ? lines.length : c).join('\n');
      if (inner.trim() !== '') {
        t = inner;
        changes.push({ key: 'fence', count: 1 });
      }
    }

    // -- prose: outermost balanced container regions (shared walker).
    var regions = topLevelRegions(t);

    var pick = -1;
    if (regions.length) {
      var flags = outsideFlags(t, regions);
      if (flags.nonBlank && !flags.hasBracket) {
        if (regions.length === 1) {
          pick = 0;
        } else {
          for (var r = 0; r < regions.length && pick === -1; r++) {
            try {
              JSON.parse(t.slice(regions[r][0], regions[r][1]));
              pick = r;
            } catch (err) { /* region does not parse — try the next */ }
          }
        }
      }
    }
    if (pick !== -1) {
      t = t.slice(regions[pick][0], regions[pick][1]);
      changes.push({ key: 'prose', count: 1 });
    }

    return changes.length ? { text: t, changes: changes } : { text: text, changes: [] };
  }

  /** Pass 3 — Strip // line comments and /* block comments (outside spans). */
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

  /** Pass 4 — Single-quoted spans → double: swap delimiters, escape any
      inner "; \' (escaped apostrophe) collapses to '. All other escapes
      pass through untouched. An unterminated span (content runs to
      end-of-text) is converted only when it opens in code context
      ({ , : [ or text start) — a prose apostrophe is left alone and the
      document fails with the clean error report (header limitation); its
      dangling trailing backslash run (odd count) cannot escape anything and
      is dropped. */
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
      var unterminated = !spans[k][2];
      var inner;
      if (unterminated) {
        var pc = prevCodeChar(text, spans, s);
        if (pc !== null && pc !== '{' && pc !== ',' && pc !== ':' && pc !== '[') continue;
        inner = text.slice(s + 1, e); // no closing delimiter — content runs to end-of-text
        var be = inner.length;
        while (be > 0 && inner.charAt(be - 1) === '\\') be--;
        if ((inner.length - be) % 2 === 1) inner = inner.slice(0, be); // dangling escape
      } else {
        inner = text.slice(s + 1, e - 1);
      }
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

  /** Pass 5 — Quote unquoted keys after { or , (§5.2 safe heuristic).
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

  /** Pass 6 — Trailing commas: drop a comma when the next code character
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

  /** Passes 7/8 helper — replace whole tokens outside spans; a match is
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

  /** Pass 7 — Invalid JS literals → null (outside spans). */
  function passJsLiterals(text) {
    return wordSwapPass(text, /NaN|-Infinity|Infinity|undefined/g,
      { 'NaN': 'null', '-Infinity': 'null', 'Infinity': 'null', 'undefined': 'null' }, 'jslit');
  }

  /** Pass 8 — Python/other literals (outside spans). */
  function passPyLiterals(text) {
    return wordSwapPass(text, /True|False|None/g,
      { 'True': 'true', 'False': 'false', 'None': 'null' }, 'pylit');
  }

  /** Pass 15 — Repair malformed number tokens (checklist §5): a token in
      code context that reads as exactly ONE numeric typo end-to-end is
      rewritten to the unique valid JSON number it can mean — a leading `+`
      dropped (+5 → 5), integer leading zeros stripped (007 → 7, -00.25 →
      -0.25), a trailing dot with no fraction digits dropped (5. → 5), or
      a missing integer part zeroed (.5 → 0.5); all four may combine in
      one token (+007. → 7). Exponent material is copied verbatim — signs
      inside 1e+5 and leading zeros there (1e007 is valid JSON) — so a
      token that already matches the JSON number grammar is skipped: valid
      input can never change (§5.3). A token is edited only when both raw
      neighbors are clean boundaries (text start/end, or on the left
      whitespace / { [ , : and on the right whitespace / , } ] :), so
      identifier-looking runs (007x, 1..2, --5) fail clean instead of
      being guessed (pass 9's no-guess policy). Carries the standard
      ambiguous-paste guard (checklist §0). One scan records every fix in
      original-text coordinates and applies them at the end — a fix only
      ever canonicalizes a token to a shape the scanner then reads as
      valid, so re-rounds never re-fire on their own output (monotone). */
  function passNumbers(text) {
    // Ambiguous-paste guard — same reasoning as pass 9.
    var regions = topLevelRegions(text);
    if (regions.length >= 2) {
      var gflags = outsideFlags(text, regions);
      if (gflags.nonBlank && !gflags.hasBracket) return { text: text, changes: [] };
    }

    var spans = mapStrings(text);
    var edits = []; // [start, end, replacement] — disjoint, in text order
    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      var i = gs;
      while (i < ge) {
        var c = text.charAt(i);
        var starts = (c >= '0' && c <= '9') ||
          (c === '.' && text.charAt(i + 1) >= '0' && text.charAt(i + 1) <= '9') ||
          ((c === '+' || c === '-') &&
            (text.charAt(i + 1) >= '0' && text.charAt(i + 1) <= '9' ||
             (text.charAt(i + 1) === '.' && text.charAt(i + 2) >= '0' && text.charAt(i + 2) <= '9')));
        if (!starts) { i++; continue; }
        var s0 = i;
        var t = scanNumberToken(text, s0, ge);
        i = t.end; // walk past the whole token — valid or not, never rescan inside it
        if (t.ok || t.fixed === text.slice(s0, t.end)) continue; // already canonical
        var before = s0 > 0 ? text.charAt(s0 - 1) : null;
        if (before !== null && !isWs(before) &&
            before !== '{' && before !== '[' && before !== ',' && before !== ':') continue;
        var after = t.end < text.length ? text.charAt(t.end) : null;
        if (after !== null && !isWs(after) &&
            after !== ',' && after !== '}' && after !== ']' && after !== ':') continue;
        edits.push([s0, t.end, t.fixed]);
      }
    }
    if (!edits.length) return { text: text, changes: [] };
    var out = '';
    var prev = 0;
    for (var r = 0; r < edits.length; r++) {
      out += text.slice(prev, edits[r][0]) + edits[r][2];
      prev = edits[r][1];
    }
    out += text.slice(prev);
    return { text: out, changes: [{ key: 'number', count: edits.length }] };
  }

  /** Scan one number-ish token starting at index i (region end ge caps the
      walk) → { end, ok, fixed }. `ok` is true when the token already
      matches the JSON number grammar — -?(0|[1-9]digits)(.digits)?
      ([eE][+-]?digits)? — and it is then never edited (a leading + is the
      one sign the grammar rejects). Otherwise `fixed` is the unique
      rewrite from the four allowed typos (leading +, integer leading
      zeros, trailing dot without fraction digits, missing integer part).
      A trailing dot is read INTO the token only when followed by a clean
      right boundary; otherwise the token ends before it, so 1..2 stays
      unfixable garbage for the clean error report. */
  function scanNumberToken(text, i, ge) {
    var j = i;
    var sign = '';
    if (text.charAt(j) === '+' || text.charAt(j) === '-') { sign = text.charAt(j); j++; }
    var intStart = j, intLen = 0;
    while (j < ge && text.charAt(j) >= '0' && text.charAt(j) <= '9') { intLen++; j++; }
    var dotAt = -1, fracStart = -1, fracLen = 0;
    if (j < ge && text.charAt(j) === '.') {
      if (text.charAt(j + 1) >= '0' && text.charAt(j + 1) <= '9') {
        dotAt = j;
        fracStart = j + 1;
        j++;
        while (j < ge && text.charAt(j) >= '0' && text.charAt(j) <= '9') { fracLen++; j++; }
      } else if (isNumberEndAfter(text, j + 1)) {
        dotAt = j; // trailing dot — part of the token so it can be dropped
        j++;
      }
    }
    var expStart = -1, expEnd = -1;
    if (j < ge && (text.charAt(j) === 'e' || text.charAt(j) === 'E')) {
      var e = j + 1;
      if (e < ge && (text.charAt(e) === '+' || text.charAt(e) === '-')) e++;
      if (e < ge && text.charAt(e) >= '0' && text.charAt(e) <= '9') {
        while (e < ge && text.charAt(e) >= '0' && text.charAt(e) <= '9') e++;
        expStart = j;
        expEnd = e;
        j = e;
      }
    }
    var canonicalInt = intLen > 0 &&
      (intLen === 1 || text.charAt(intStart) !== '0');
    var ok = sign !== '+' && canonicalInt && (dotAt === -1 || fracLen > 0);
    var fixed = '';
    if (!ok) {
      if (sign === '-') fixed += '-';
      if (intLen > 0) {
        var m = 0;
        while (m < intLen - 1 && text.charAt(intStart + m) === '0') m++;
        fixed += text.slice(intStart + m, intStart + intLen);
      } else {
        fixed += '0';
      }
      if (dotAt !== -1 && fracLen > 0) fixed += '.' + text.slice(fracStart, fracStart + fracLen);
      if (expStart !== -1) fixed += text.slice(expStart, expEnd);
    }
    return { end: j, ok: ok, fixed: fixed };
  }

  /** Clean right boundary for a number token ending before index i: text
      end, or whitespace / , } ] : — the same set pass 15's caller checks. */
  function isNumberEndAfter(text, i) {
    var c = text.charAt(i);
    return c === '' || isWs(c) || c === ',' || c === '}' || c === ']' || c === ':';
  }

  /** Is the char at index i an escaped quote — odd number of consecutive
      backslashes immediately before it? (\" is content; \\" is not.) */
  function escapesAt(text, i) {
    var n = 0;
    while (i - 1 - n >= 0 && text.charAt(i - 1 - n) === '\\') n++;
    return n % 2 === 1;
  }

  /** Pass 12 — Escape unescaped inner double quotes (checklist §4.4): a
      TERMINATED "..." span that opens in VALUE position (right after a ':')
      and is immediately followed (in code, whitespace ignored) by a bare
      word that is NOT a key — no colon after the word — can only be read as
      a string that never closed at its apparent end: the closer is content.
      A span preceded by { , [ is skipped — a bare word after THAT is a
      missing delimiter (pass 9) or structural nonsense, and merging it into
      one string would corrupt the document. Repair candidates: every later
      quote position C (capped), and for each one escape every unescaped "
      strictly between the opener s and C, so s..C becomes one string; each
      candidate is certified by a strict JSON.parse of the WHOLE text (the
      parser itself decides — pass 11's policy) and the leftmost certifying
      C wins. The no-colon rule keeps this off missing-comma keys (pass 9's
      job), and the trigger can only fire on already-invalid text, so valid
      input is untouched (§5.3). Carries pass 9's ambiguous-paste no-guess
      guard. Not repaired (clean error report): breaks inside array elements
      or at key positions, breaks at quote adjacency (no bare word after the
      premature close), and strings that are ALSO missing their final closing
      quote — all documented in the header. Placed in PASSES before pass 9
      despite its number: pass 9's D1 insertion would rewrite this trigger
      shape (a comma inside what was string content). */
  function passInnerQuotes(text) {
    // Ambiguous-paste guard — same reasoning as pass 9.
    var regions = topLevelRegions(text);
    if (regions.length >= 2) {
      var gflags = outsideFlags(text, regions);
      if (gflags.nonBlank && !gflags.hasBracket) return { text: text, changes: [] };
    }

    var spans = mapStrings(text);
    var MAX_CANDIDATES = 16;
    for (var k = 0; k < spans.length; k++) {
      var s = spans[k][0], e = spans[k][1];
      if (text.charAt(s) !== '"' || !spans[k][2]) continue; // unterminated → pass 13
      // VALUE position only: the span must open right after a ':' (an object
      // value). A span preceded by { , [ is a key or an array element — a bare
      // word after THAT is a missing delimiter (pass 9's job) or structural
      // nonsense, and merging it into one string would corrupt the document.
      if (prevCodeChar(text, spans, s) !== ':') continue;
      var f = e;
      while (f < text.length && isWs(text.charAt(f))) f++;
      if (f >= text.length || !isWordChar(text.charAt(f))) continue;
      var w1 = f;
      while (w1 < text.length && isWordChar(text.charAt(w1))) w1++;
      var g = w1;
      while (g < text.length && isWs(text.charAt(g))) g++;
      if (g < text.length && text.charAt(g) === ':') continue; // a key — pass 9's shape

      var q = text.indexOf('"', e + 1);
      var tried = 0;
      while (q !== -1 && tried < MAX_CANDIDATES) {
        tried++;
        var target = [];
        for (var p = s + 1; p < q; p++) {
          if (text.charAt(p) === '"' && !escapesAt(text, p)) target.push(p);
        }
        var out = '';
        var prev = 0;
        for (var t = 0; t < target.length; t++) {
          // Insert '\' just before the quote at target[t]; keep the quote.
          out += text.slice(prev, target[t]) + '\\';
          prev = target[t];
        }
        out += text.slice(prev);
        if (attemptParse(out).ok) {
          return { text: out, changes: [{ key: 'innerquote', count: target.length }] };
        }
        q = text.indexOf('"', q + 1);
      }
    }
    return { text: text, changes: [] };
  }

  /** Pass 9 — Insert missing delimiters (checklist §2; JSONBFF-IMPROVEMENTS.md
      §1.3): one left-to-right grammar walk over the non-string regions with
      a frame stack ([container, role]). Containers: OBJECT|ARRAY. Roles:
      KEY (awaiting key or close), COLON (key seen, awaiting ":"), VALUE
      (value expected), POST (value complete, awaiting "," or close). Edits
      only where the JSON grammar forces exactly one minimal fix — three
      insertion-only edits, nothing else:
        D1  OBJECT/POST + key-start token (string|word) → insert ","
        D2  OBJECT/COLON + value-start token            → insert ":"
        D3  ARRAY/POST  + value-start token             → insert ","
      Everything else — a mismatched closer, a colon inside an array, a
      leading comma, a second bare value at POST, a numeric key
      (accepted as-is), root-level tokens — gets no edit and is left to
      the other passes or the failure report (§1.5). It also declines to
      edit an ambiguous paste — several balanced containers surrounded by
      bracket-free prose — because pass 2's leftmost-parseable slice would
      then guess which container is the payload; checklist §0's no-guess
      policy owns those (clean failure instead). The guard mirrors pass 2's
      slice condition exactly via topLevelRegions + outsideFlags. Runs after
      quotes/literals so token classes are clean, and before balance
      (pass 11) so every container is still open while it walks. O(n); one
      scan suffices (the pipeline re-rounds anyway) — insertions are
      recorded in original-text coordinates and applied only at the end,
      so offsets never shift mid-walk. */
  function passDelimiters(text) {
    // Ambiguous-paste guard (checklist §0 no-guess policy): several balanced
    // containers surrounded by bracket-free prose — pass 2 could later slice
    // to whichever one our own repairs made parseable, i.e. it would guess
    // which container is the payload. Decline to edit at all in that shape;
    // the document fails clean instead. Mirrors pass 2's condition exactly.
    var regions = topLevelRegions(text);
    if (regions.length >= 2) {
      var gflags = outsideFlags(text, regions);
      if (gflags.nonBlank && !gflags.hasBracket) return { text: text, changes: [] };
    }

    var spans = mapStrings(text);
    var OBJ = 0, ARR = 1;                                  // container types
    var R_KEY = 0, R_COLON = 1, R_VALUE = 2, R_POST = 3;   // frame roles
    var T_STRING = 0, T_NUMBER = 1, T_STRUCT = 2, T_WORD = 3;
    var stack = [];      // frames [type, role]
    var inserts = [];    // [offset, char] in original-text coordinates
    var commaCount = 0, colonCount = 0;

    function topFrame() { return stack.length ? stack[stack.length - 1] : null; }

    /** React to one token starting at `pos` (string | number | word | struct). */
    function onToken(cls, pos) {
      var ch = text.charAt(pos);
      var top = topFrame();
      if (cls === T_STRUCT) {
        if (ch === '{' || ch === '[') {
          if (top && top[0] === OBJ && top[1] === R_COLON) {
            inserts.push([pos, ':']); colonCount++; top[1] = R_VALUE; // D2 before a container value
          } else if (top && top[0] === ARR && top[1] === R_POST) {
            inserts.push([pos, ',']); commaCount++; top[1] = R_VALUE; // D3 before an element container
          }
          stack.push(ch === '{' ? [OBJ, R_KEY] : [ARR, R_VALUE]);
          return;
        }
        if (ch === '}' || ch === ']') {
          if (!top) return; // stray closer at root — pass 11
          if ((ch === '}') !== (top[0] === OBJ)) return; // type mismatch — pass 11 owns it
          stack.pop();
          var parent = topFrame();
          if (parent) parent[1] = R_POST; // a closed container was a value
          return;
        }
        if (ch === ':') {
          if (top && top[0] === OBJ && top[1] === R_COLON) top[1] = R_VALUE;
          return; // colon elsewhere → no edit (§1.5)
        }
        if (ch === ',') {
          if (top && top[1] === R_POST) top[1] = (top[0] === OBJ) ? R_KEY : R_VALUE;
          return; // leading comma → no edit (§1.5); duplicate separators → pass 10
        }
        return;
      }
      // Value tokens: string | number | word
      if (!top) return; // root level — edits are container-scoped; bare "1 2" fails clean
      if (top[0] === OBJ) {
        if (top[1] === R_KEY) top[1] = R_COLON; // string/word key; a number is accepted as-is
        else if (top[1] === R_COLON) { inserts.push([pos, ':']); colonCount++; top[1] = R_POST; } // D2
        else if (top[1] === R_VALUE) top[1] = R_POST; // value complete
        else if (top[1] === R_POST && cls !== T_NUMBER) { // D1 — key-start only
          inserts.push([pos, ',']); commaCount++; top[1] = R_COLON;
        }
      } else {
        if (top[1] === R_VALUE) top[1] = R_POST; // value complete
        else if (top[1] === R_POST) { inserts.push([pos, ',']); commaCount++; } // D3 (stays POST)
      }
    }

    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      var i = gs;
      while (i < ge) {
        var c = text.charAt(i);
        if (isWs(c)) { i++; continue; }
        if (c === '{' || c === '}' || c === '[' || c === ']' || c === ':' || c === ',') {
          onToken(T_STRUCT, i); i++; continue;
        }
        if ((c >= '0' && c <= '9') || (c === '-' && text.charAt(i + 1) >= '0' && text.charAt(i + 1) <= '9')) {
          // Number — full JSON grammar (§1.3 token table): digits, a
          // fraction only when "." is followed by a digit, and an exponent
          // only when [eE][+-]? is followed by at least one digit — so
          // "1. 2" does not swallow the space and "1e5" tokenizes whole.
          var j = i + 1;
          while (j < ge && text.charAt(j) >= '0' && text.charAt(j) <= '9') j++;
          if (text.charAt(j) === '.' && text.charAt(j + 1) >= '0' && text.charAt(j + 1) <= '9') {
            j++;
            while (j < ge && text.charAt(j) >= '0' && text.charAt(j) <= '9') j++;
          }
          if (text.charAt(j) === 'e' || text.charAt(j) === 'E') {
            var e = j + 1;
            if (text.charAt(e) === '+' || text.charAt(e) === '-') e++;
            if (text.charAt(e) >= '0' && text.charAt(e) <= '9') {
              while (e < ge && text.charAt(e) >= '0' && text.charAt(e) <= '9') e++;
              j = e;
            }
          }
          onToken(T_NUMBER, i); i = j; continue;
        }
        if (isWordChar(c)) {
          var w = i + 1;
          while (w < ge && isWordChar(text.charAt(w))) w++;
          onToken(T_WORD, i); i = w; continue;
        }
        i++; // unrecognized punctuation — skip without edit (§1.5)
      }
      if (k < spans.length) onToken(T_STRING, spans[k][0]); // a span is one atomic token
    }

    if (!inserts.length) return { text: text, changes: [] };
    var out = '';
    var prev = 0;
    for (var r = 0; r < inserts.length; r++) {
      out += text.slice(prev, inserts[r][0]) + inserts[r][1];
      prev = inserts[r][0];
    }
    out += text.slice(prev);
    var changes = [];
    if (commaCount) changes.push({ key: 'comma', count: commaCount });
    if (colonCount) changes.push({ key: 'colon', count: colonCount });
    return { text: out, changes: changes };
  }

  /** Previous non-whitespace character in code before index `from`,
      skipping string spans entirely. Returns the character, or null at
      start. Mirror of nextCodeChar (pass 6 helper). */
  function prevCodeChar(text, spans, from) {
    var i = from - 1;
    while (i >= 0) {
      for (var k = 0; k < spans.length; k++) {
        if (i >= spans[k][0] && i < spans[k][1]) { i = spans[k][0] - 1; break; }
      }
      var c = text.charAt(i);
      if (isWs(c)) { i--; continue; }
      return c;
    }
    return null;
  }

  /** Pass 10 — Collapse duplicate delimiters (checklist §2.4;
      JSONBFF-IMPROVEMENTS.md §2.2): a `,` or `:` whose PREVIOUS code
      character outside string spans is the same punctuation is removed,
      so runs like `,,` / `::` collapse to one — including pairs separated
      by whitespace or with a comment between them (pass 3 strips comments
      earlier in the same round). Valid JSON never places
      two separators in a row, so the edit can only fire on already-
      invalid text (§5.3) — valid input is untouched. Carries pass 9's
      ambiguous-paste guard: collapsing could make one container of a
      multi-container prose paste parseable, and pass 2's leftmost-
      parseable slice would then guess which is the payload — checklist
      §0 no-guess policy; the guard mirrors pass 2's condition exactly
      via topLevelRegions + outsideFlags. Deletion-only → monotone; one
      scan marks every removable separator in original-text coordinates
      and applies the removals at the end, so decisions never see their
      own effects. A lone leading comma ([,1]) and mixed sequences
      ({ "a", : 1 }) get no edit — they fail with the clear error report
      (IMPROVEMENTS §2.2 remainder). Runs after pass 9 (insertions) and
      before balance (pass 11); either ordering with pass 9 converges
      within one round. */
  function passDuplicatePunct(text) {
    // Ambiguous-paste guard — same reasoning as pass 9.
    var regions = topLevelRegions(text);
    if (regions.length >= 2) {
      var gflags = outsideFlags(text, regions);
      if (gflags.nonBlank && !gflags.hasBracket) return { text: text, changes: [] };
    }

    var spans = mapStrings(text);
    var removeAt = [];
    var commaCount = 0;
    var colonCount = 0;
    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      for (var i = gs; i < ge; i++) {
        var c = text.charAt(i);
        if (c !== ',' && c !== ':') continue;
        if (prevCodeChar(text, spans, i) === c) {
          removeAt.push(i);
          if (c === ',') commaCount++; else colonCount++;
        }
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
    var changes = [];
    if (commaCount) changes.push({ key: 'dupcomma', count: commaCount });
    if (colonCount) changes.push({ key: 'dupcolon', count: colonCount });
    return { text: out, changes: changes };
  }

  /** Pass 13 — Close unterminated double-quoted strings (checklist §4.1):
      a " span that mapStrings extends to end-of-text has NO unescaped
      closer anywhere in the remainder of the document; it is closed by
      inserting one. Positions tried, in order:
        1. every structural char ( , } ] ) inside the open span, left to
           right (capped) — insert " just before it; the FIRST whole-text
           result that strict-parses wins (the checklist's own rule, same
           parser-certified policy as pass 11 — e.g. { "a": "x } closes at
           the brace in one edit);
        2. otherwise: the end of the span's content — trailing whitespace
           stays OUTSIDE the string, and an odd dangling backslash run (it
           cannot escape anything) is dropped.
      Only a span that opens in code context ({ , : [ or text start) is
      closed — a stray " in prose degrades to the clean error report
      (header limitation). The trigger can only fire on already-invalid
      text, so valid input is untouched (§5.3). Placed in PASSES before
      pass 11 despite its number: the balance EOF-close would otherwise
      land INSIDE the open span and corrupt it. */
  function passUnterminatedStrings(text) {
    var spans = mapStrings(text);
    var s = -1;
    for (var k = 0; k < spans.length; k++) {
      if (text.charAt(spans[k][0]) === '"' && !spans[k][2]) { s = spans[k][0]; break; }
    }
    if (s === -1) return { text: text, changes: [] };
    var pc = prevCodeChar(text, spans, s);
    if (pc !== null && pc !== '{' && pc !== ',' && pc !== ':' && pc !== '[') return { text: text, changes: [] };

    var p = text.length;
    while (p > s + 1 && isWs(text.charAt(p - 1))) p--; // trailing whitespace stays outside
    var be = p;
    while (be > s + 1 && text.charAt(be - 1) === '\\') be--;
    if ((p - be) % 2 === 1) p = be; // odd dangling backslash run — drop it

    var tested = 0;
    for (var m = s + 1; m < p && tested < 16; m++) {
      var c = text.charAt(m);
      if ((c !== ',' && c !== '}' && c !== ']') || escapesAt(text, m)) continue;
      var cand = text.slice(0, m) + '"' + text.slice(m);
      if (attemptParse(cand).ok) return { text: cand, changes: [{ key: 'strclose', count: 1 }] };
      tested++;
    }

    return { text: text.slice(0, p) + '"' + text.slice(p), changes: [{ key: 'strclose', count: 1 }] };
  }

  /** Pass 14 — Escape unescaped control characters inside string spans
      (checklist §4.5): raw U+0000–U+001F → the JSON escapes \b \t \n \f
      \r, all others as \u00xx. Existing escape pairs pass through
      untouched. Placed after pass 13 (so its trailing-whitespace trim sees
      the raw characters) and before pass 11. Valid JSON never contains a
      raw control character in a span, so this only fires on already-
      invalid text (§5.3). */
  function passEscCtrl(text) {
    var spans = mapStrings(text);
    var count = 0;
    var out = '';
    var last = 0;
    for (var k = 0; k < spans.length; k++) {
      var s = spans[k][0], e = spans[k][1];
      var cEnd = spans[k][2] ? e - 1 : e; // content excludes the closing delimiter (unterminated: to EOF)
      out += text.slice(last, s + 1);
      var b = '';
      for (var i = s + 1; i < cEnd; i++) {
        var ch = text.charAt(i);
        if (ch === '\\' && i + 1 < cEnd) { b += ch + text.charAt(i + 1); i++; continue; } // keep existing escape
        var code = text.charCodeAt(i);
        if (code < 32) {
          count++;
          if (ch === '\b') b += '\\b';
          else if (ch === '\t') b += '\\t';
          else if (ch === '\n') b += '\\n';
          else if (ch === '\f') b += '\\f';
          else if (ch === '\r') b += '\\r';
          else { var h = code.toString(16); b += '\\u00' + (h.length < 2 ? '0' : '') + h; }
          continue;
        }
        b += ch;
      }
      out += b;
      if (cEnd < e) out += text.charAt(e - 1); // closing delimiter
      last = e;
    }
    out += text.slice(last);
    return count ? { text: out, changes: [{ key: 'ctrl', count: count }] } : { text: text, changes: [] };
  }

  /** Pass 11 — Balance brackets (checklist §3): a closer without a
      matching open is removed ("stray"); at end-of-text the still-open
      brackets are closed in reverse order. A type mismatch (e.g. `]`
      when the top frame is `{`) gets the checklist's two single-edit
      candidates — swap the closer to match the open frame, or remove it
      — each certified by a strict JSON.parse of the WHOLE text (the
      parser itself decides; no guesswork). At most one candidate can
      ever parse: a swap keeps the outside-string bracket count and a
      removal lowers it by one, while valid JSON needs exactly one
      closer per opener. The first adoptable position in text order wins
      and is the ONLY edit this invocation makes (one targeted fix per
      round, §7) — adoption always makes the whole document parse, so it
      completes the repair. If no candidate parses on its own, behavior
      is unchanged from the legacy path: every stray/mismatch closer is
      removed and still-open brackets are closed at EOF (which may then
      compose with other passes in later rounds). Candidate tests are
      capped (MAX_MISMATCH_TESTS strict parses) so a pathological input
      reaches the legacy path instead of churning. */
  function passBalanceBrackets(text) {
    var spans = mapStrings(text);
    var stack = [];
    var strayAt = [];       // ALL unmatched closer positions (removal list)
    var mismatchOpen = [];  // parallel: top-frame opener for TYPE mismatches ('' = empty-stack stray)
    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      for (var i = gs; i < ge; i++) {
        var c = text.charAt(i);
        if (c === '{' || c === '[') stack.push(c);
        else if (c === '}' || c === ']') {
          var want = c === '}' ? '{' : '[';
          var top = stack.length ? stack[stack.length - 1] : null;
          if (top === want) stack.pop();
          else {
            strayAt.push(i);
            mismatchOpen.push(top === null ? '' : top);
          }
        }
      }
    }
    // Candidate decision for type mismatches ("try both, keep whichever
    // parses", checklist §3). Swap is tested before removal; the order is
    // immaterial to correctness (at most one can parse) — swap-first just
    // prefers keeping the author's bracket count. Empty-stack strays have
    // no frame to match, so removal only, exactly as the legacy path did.
    var MAX_MISMATCH_TESTS = 32;
    var tested = 0;
    for (var m = 0; m < mismatchOpen.length && tested < MAX_MISMATCH_TESTS; m++) {
      if (!mismatchOpen[m]) continue;
      var mi = strayAt[m];
      var swapText = text.slice(0, mi) + (mismatchOpen[m] === '{' ? '}' : ']') + text.slice(mi + 1);
      tested++;
      if (attemptParse(swapText).ok) {
        return { text: swapText, changes: [{ key: 'swapped', count: 1 }] };
      }
      var rmText = text.slice(0, mi) + text.slice(mi + 1);
      tested++;
      if (attemptParse(rmText).ok) {
        return { text: rmText, changes: [{ key: 'stray', count: 1 }] };
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

  /* Duplicate-key detection (checklist §6) — success path only, over
     text that has JUST strict-parsed, so it may assume a valid-JSON
     shape: mapStrings spans are exactly the string literals, brackets
     balance, and every object key is a "..." span. Counts, per object,
     how many DIRECT members repeat a key already seen in that same
     object — keys compare by DECODED value (JSON.parse of the key
     span), so "\u0061" and "a" are one key, and the same key in two
     different objects never counts. The return is the number of
     occurrences the JSON.stringify reserialization in fix() drops
     (native keep-last: last value wins, at the key's first position) —
     reported as a dupkeys change entry. No text surgery here: a removal
     pass could reorder keys relative to the parse and is not needed for
     "clean" output (§5.3). */
  function countDuplicateKeys(text) {
    var spans = mapStrings(text);
    var n = text.length;
    var total = 0;

    /** Span containing position i, or null (spans are sorted — the linear
        scan is the file's convention, cf. nextCodeChar). */
    function spanAt(i) {
      for (var k = 0; k < spans.length; k++) {
        if (i >= spans[k][0] && i < spans[k][1]) return spans[k];
        if (spans[k][0] > i) break;
      }
      return null;
    }

    function skipWs(p) {
      while (p < n && isWs(text.charAt(p))) p++;
      return p;
    }

    /** Position just past the value starting at p: one string span, a
        balanced container, or a scalar that in valid JSON can never
        contain , } ]. */
    function skipValue(p) {
      var sp = spanAt(p);
      if (sp) return sp[1];
      var c = text.charAt(p);
      if (c === '{' || c === '[') {
        var depth = 1;
        p++;
        while (depth > 0) {
          var s2 = spanAt(p);
          if (s2) { p = s2[1]; continue; }
          var d = text.charAt(p);
          if (d === '{' || d === '[') depth++;
          else if (d === '}' || d === ']') depth--;
          p++;
        }
        return p;
      }
      while (p < n) {
        var sc = text.charAt(p);
        if (sc === ',' || sc === '}' || sc === ']') break;
        p++;
      }
      return p;
    }

    /** The object whose '{' sits at openPos: visit its DIRECT members
        only (nested containers are skipped whole by skipValue) and count
        every direct key repeated within this object. Bails without
        counting when the shape is unexpected — unreachable on text that
        just strict-parsed, but it must never guess. */
    function countObject(openPos) {
      var seen = Object.create(null);
      var p = skipWs(openPos + 1);
      if (text.charAt(p) === '}') return; // empty object
      for (;;) {
        var sp = spanAt(p);
        if (!sp || text.charAt(p) !== '"') break;
        var key;
        try { key = JSON.parse(text.slice(p, sp[1])); } catch (err) { break; }
        p = skipWs(sp[1]);
        if (text.charAt(p) !== ':') break;
        p = skipValue(skipWs(p + 1));
        if (seen[key]) total++;
        else seen[key] = true;
        p = skipWs(p);
        if (text.charAt(p) !== ',') break; // '}' ends the object (valid JSON)
        p++;
      }
    }

    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : n;
      for (var i = gs; i < ge; i++) {
        if (text.charAt(i) === '{') countObject(i); // every object, at every depth — each counted once
      }
    }
    return total;
  }

  /* Permissive (JSON5-style) fallback parse (checklist §8.1). Recursive
     descent over the raw text, tolerating exactly four non-strict
     constructs — comments, trailing commas, single-quoted strings, and
     unquoted identifier keys — everything else stays strict JSON (JSON
     numbers, double-quoted strings, true/false/null, ONE top-level value,
     nothing after it). Every tolerance is meaning-preserving: comments are
     skipped, a trailing comma is dropped, 'x' decodes exactly like "x"
     under the JSON escape rules (\' collapses to '), and a bare key IS the
     identifier — so a successful parse re-serializes to unambiguous strict
     JSON with no guessing. Runs only after the repair pipeline failed, and
     only over the pre-processed ORIGINAL text (BOM/fence/prose stripped —
     passes 1-2, the safe ones; the surgical passes may have mangled their
     intermediate, which is discarded). Classic rescue: comments containing
     QUOTE characters, which start fake spans in mapStrings and defeat the
     span-based passes (header limitation, fixtures 67-69). Still rejected
     (clean failure): numeric keys { 1: 2 }, non-identifier key characters
     { my-key: 1 }, bare words in VALUE position, non-JSON numbers,
     unicode-only identifiers, multiple top-level values, trailing junk.
     Returns { ok:true, value, deviations } or { ok:false }; throws only on
     runaway recursion depth, which fix() catches as a failed fallback. */
  function permissiveParse(text) {
    var n = text.length;
    var p = 0;
    var deviations = 0;

    function fail(at) {
      var err = new Error('Permissive parse failed at position ' + (at == null ? p : at));
      err.pos = at == null ? p : at;
      throw err;
    }
    function ch(i) { return i < n ? text.charAt(i) : ''; }

    /** Skip whitespace AND comments (comments are one of the four
        tolerated constructs — counted). An unterminated block comment runs
        to end-of-text; the following value check then fails cleanly. */
    function ws() {
      while (p < n) {
        var c = ch(p);
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') p++;
        else if (c === '/' && ch(p + 1) === '/') {
          while (p < n && ch(p) !== '\n') p++;
          deviations++;
        }
        else if (c === '/' && ch(p + 1) === '*') {
          var q = text.indexOf('*/', p + 2);
          p = q === -1 ? n : q + 2;
          deviations++;
        }
        else break;
      }
    }

    /** One string: p sits on the opening quote; returns its decoded value.
        Double-quoted → decoded by JSON.parse of the exact span (strict
        JSON escape rules). Single-quoted → JSON5: same escapes, plus \'
        collapsing to ', with unescaped " left as content; re-wrapped and
        decoded by JSON.parse so the browser's own decoder stays the source
        of truth. Unterminated span or an escape JSON itself rejects
        (raw line terminator, bad escape pair) → fail. */
    function string(single) {
      var start = p;
      p++;
      var end = -1;
      while (p < n) {
        var c = ch(p);
        if (c === '\\') { p += 2; continue; }
        if (c === (single ? "'" : '"')) { end = p; break; }
        p++;
      }
      if (end === -1) fail(start);
      p = end + 1; // advance past the closing quote
      var value;
      try {
        if (!single) {
          value = JSON.parse(text.slice(start, end + 1));
        } else {
          var inner = '';
          for (var i = start + 1; i < end; i++) {
            var d = text.charAt(i);
            if (d === '\\') {
              var nx = text.charAt(i + 1);
              inner += (nx === "'") ? "'" : (d + nx);
              i++;
              continue;
            }
            inner += (d === '"') ? '\\"' : d;
          }
          value = JSON.parse('"' + inner + '"');
        }
      } catch (err) { fail(start); }
      if (single) deviations++;
      return value;
    }

    /** true | false | null — exact literal with a clean right boundary;
        any other bare word in VALUE position fails (no guess, header). */
    function wordValue() {
      var lits = ['true', 'false', 'null'];
      for (var k = 0; k < 3; k++) {
        if (text.substr(p, lits[k].length) === lits[k] && !isWordChar(ch(p + lits[k].length))) {
          p += lits[k].length;
          return lits[k] === 'true' ? true : (lits[k] === 'false' ? false : null);
        }
      }
      fail(p);
    }

    function number() {
      // Strict JSON number grammar only — pass 15's own classifier; the
      // fallback never REPAIRS numbers (that is a surgical-pass job).
      var t = scanNumberToken(text, p, n);
      if (!t.ok) fail(p);
      var v = Number(text.slice(p, t.end));
      p = t.end;
      return v;
    }

    /** A property name: "..." | '...' | an ASCII identifier (the same set
        pass 5 quotes). Digits do not start identifiers, so numeric keys
        fail clean — JSON5 agrees. */
    function key() {
      var c = ch(p);
      if (c === '"') return string(false);
      if (c === "'") return string(true);
      if (isWordChar(c) && !(c >= '0' && c <= '9')) {
        var s = p;
        while (p < n && isWordChar(ch(p))) p++;
        deviations++;
        return text.slice(s, p);
      }
      fail(p);
    }

    function value() {
      ws();
      var c = ch(p);
      if (c === '"') return string(false);
      if (c === "'") return string(true);
      if (c === '{') return obj();
      if (c === '[') return arr();
      if (c === '-' || (c >= '0' && c <= '9')) return number();
      if (isWordChar(c)) return wordValue();
      fail(p);
    }

    function obj() {
      var o = {};
      p++; // consume {
      ws();
      if (ch(p) === '}') { p++; return o; }
      for (;;) {
        ws();
        var k = key();
        ws();
        if (ch(p) !== ':') fail(p);
        p++;
        o[k] = value(); // duplicate keys: last wins, exactly native semantics
        ws();
        var c = ch(p);
        if (c === ',') {
          p++;
          ws();
          if (ch(p) === '}') { deviations++; p++; return o; } // trailing comma
          continue;
        }
        if (c === '}') { p++; return o; }
        fail(p);
      }
    }

    function arr() {
      var a = [];
      p++; // consume [
      ws();
      if (ch(p) === ']') { p++; return a; }
      for (;;) {
        a.push(value());
        ws();
        var c = ch(p);
        if (c === ',') {
          p++;
          ws();
          if (ch(p) === ']') { deviations++; p++; return a; } // trailing comma
          continue;
        }
        if (c === ']') { p++; return a; }
        fail(p);
      }
    }

    var v = value();
    ws();
    if (p !== n) fail(p); // trailing junk — strict like JSON.parse
    return { ok: true, value: v, deviations: deviations };
  }

  /* ---------------- pipeline + status messages (§5.1, §4) ------------- */
  var PASSES = [
    passNormalize,       // 1
    passWrapper,         // 2 (checklist §0 — code fences + surrounding prose)
    passComments,        // 3
    passSingleQuotes,    // 4
    passUnquotedKeys,    // 5
    passTrailingCommas,  // 6
    passJsLiterals,      // 7
    passPyLiterals,      // 8
    passNumbers,         // 15 (checklist §5 — malformed number tokens: +5, 007, 5., .5)
    passInnerQuotes,     // 12 (checklist §4.4 — early by design: pass 9's D1 would rewrite its trigger shape)
    passDelimiters,      // 9 (checklist §2 — insert missing commas/colons, grammar-driven)
    passDuplicatePunct,  // 10 (checklist §2.4 — collapse duplicate ,, / :: separators)
    passUnterminatedStrings, // 13 (checklist §4.1 — before balance: the EOF-close must not land inside an open span)
    passEscCtrl,         // 14 (checklist §4.5 — after 13 so its trailing-ws trim sees raw chars)
    passBalanceBrackets  // 11 (checklist §3 — stray removal, mismatch swap/remove candidates, EOF close)
  ];

  var LABELS = {
    normalize: function (c) { return c === 1 ? 'stripped 1 BOM/line-ending' : 'stripped ' + c + ' BOMs/line-endings'; },
    fence: function (c) { return c === 1 ? 'stripped 1 markdown code fence' : 'stripped ' + c + ' markdown code fences'; },
    prose: function (c) { return c === 1 ? 'removed 1 block of surrounding prose' : 'removed ' + c + ' blocks of surrounding prose'; },
    comments: function (c) { return c === 1 ? 'removed 1 comment' : 'removed ' + c + ' comments'; },
    quotes: function (c) { return c === 1 ? 'converted 1 single-quoted string' : 'converted ' + c + ' single-quoted strings'; },
    keys: function (c) { return c === 1 ? 'quoted 1 key' : 'quoted ' + c + ' keys'; },
    trailing: function (c) { return c === 1 ? 'removed 1 trailing comma' : 'removed ' + c + ' trailing commas'; },
    jslit: function (c) { return c === 1 ? 'replaced 1 invalid literal' : 'replaced ' + c + ' invalid literals'; },
    pylit: function (c) { return c === 1 ? 'replaced 1 Python-style literal' : 'replaced ' + c + ' Python-style literals'; },
    number: function (c) { return c === 1 ? 'fixed 1 malformed number' : 'fixed ' + c + ' malformed numbers'; },
    comma: function (c) { return c === 1 ? 'inserted 1 missing comma' : 'inserted ' + c + ' missing commas'; },
    colon: function (c) { return c === 1 ? 'inserted 1 missing colon' : 'inserted ' + c + ' missing colons'; },
    dupcomma: function (c) { return c === 1 ? 'collapsed 1 duplicate comma' : 'collapsed ' + c + ' duplicate commas'; },
    dupcolon: function (c) { return c === 1 ? 'collapsed 1 duplicate colon' : 'collapsed ' + c + ' duplicate colons'; },
    stray: function (c) { return c === 1 ? 'removed 1 stray bracket' : 'removed ' + c + ' stray brackets'; },
    swapped: function (c) { return c === 1 ? 'corrected 1 mismatched bracket' : 'corrected ' + c + ' mismatched brackets'; },
    closed: function (c) { return c === 1 ? 'closed 1 open bracket' : 'closed ' + c + ' open brackets'; },
    innerquote: function (c) { return c === 1 ? 'escaped 1 unescaped inner quote' : 'escaped ' + c + ' unescaped inner quotes'; },
    strclose: function (c) { return c === 1 ? 'closed 1 unterminated string' : 'closed ' + c + ' unterminated strings'; },
    ctrl: function (c) { return c === 1 ? 'escaped 1 raw control character in a string' : 'escaped ' + c + ' raw control characters in strings'; },
    dupkeys: function (c) { return c === 1 ? 'removed 1 duplicate key' : 'removed ' + c + ' duplicate keys'; },
    json5: function (c) { return c === 1 ? 'tolerated 1 non-strict construct via the permissive (JSON5-style) fallback parse'
                                        : 'tolerated ' + c + ' non-strict constructs via the permissive (JSON5-style) fallback parse'; }
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
    // §8.2 — the failure report anchors on the FIRST strict error of the
    // ORIGINAL input (coordinates must match what the user pasted, not a
    // pass-produced intermediate).
    var firstError = parsed.ok ? null : parsed.error;
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
      // §6 — duplicate object keys: the reserialization below already
      // dedupes them natively (keep-last); count how many occurrences
      // drop so the user sees it. `current` is exactly the text that
      // just strict-parsed, which countDuplicateKeys requires.
      var dupKeys = countDuplicateKeys(current);
      if (dupKeys) changes.push({ key: 'dupkeys', count: dupKeys });
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

    /* §8.1 — permissive fallback, one shot: over the pre-processed
       ORIGINAL text (safe passes 1-2 only — the surgical passes may have
       mangled `current`, which is discarded; a recovery must read the
       user's document, not the wreckage). Never reached on valid input
       (§5.3); a throw (runaway recursion) counts as a failed fallback. */
    var fbChanges = [];
    var pre = passNormalize(text);
    if (pre.changes.length) fbChanges = fbChanges.concat(pre.changes);
    pre = passWrapper(pre.text);
    if (pre.changes.length) fbChanges = fbChanges.concat(pre.changes);
    var pp = { ok: false };
    try { pp = permissiveParse(pre.text); } catch (err) { pp = { ok: false }; }
    if (pp.ok) {
      fbChanges.push({ key: 'json5', count: pp.deviations });
      var fSpace = indent;
      if (!(typeof fSpace === 'string' || (typeof fSpace === 'number' && fSpace > 0))) fSpace = 2;
      var fEdits = totalEdits(fbChanges);
      return {
        ok: true,
        output: JSON.stringify(pp.value, null, fSpace),
        message: '🔧 Fixed ' + fbChanges.length + (fbChanges.length === 1 ? ' issue: ' : ' issues: ') +
                 changePhrases(fbChanges) + ' (' + fEdits + (fEdits === 1 ? ' edit' : ' edits') + ').',
        changes: fbChanges
      };
    }

    /* §8.2 — clean failure with the exact location and a context snippet,
       so the user can fix it by hand (best-effort repaired text stays in
       `output`; the snippet reads the ORIGINAL input it cites). */
    var phrases = changePhrases(changes);
    var pc = parseErrorPosition(text, firstError);
    return {
      ok: false,
      output: current,
      message: '✗ Could not fully fix — ' + errorDetail(text, firstError) + '.' +
               (phrases ? ' Repaired so far: ' + phrases + '.' : ' No safe repair matched.') +
               ' The permissive (JSON5-style) fallback parse failed too.' +
               '\n' + contextSnippet(text, pc),
      changes: changes
    };
  }

  root.JSONBFFFix = {
    fix: fix,
    // Scanner internals exposed for tests (§5.1 names them as the API):
    _internal: { mapStrings: mapStrings, transformOutsideSpans: transformOutsideSpans }
  };
})(typeof window !== 'undefined' ? window : globalThis);