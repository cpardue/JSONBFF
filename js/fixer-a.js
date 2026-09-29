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
      - Mismatched closing quote ("...') is detected BEFORE the pipeline
        runs (checklist §11): the ' that closes what opened as " starts a
        fake multi-line span in mapStrings that swallows structure; left
        to the pipeline, pass 14 escapes its raw newlines and the grammar
        passes force a parse around it — a green "success" with the
        document's data swallowed into one string.
        findMismatchedQuotes tests the two one-character repairs per
        candidate (swap ' → " ; add " after ') against a strict
        whole-text parse: exactly one parseable repair → applied
        (quotefix change entry, normal flow continues); two or more →
        both readings are valid JSON → precise clean failure naming the
        character, its line/column and both values — no guess. A
        legitimate multi-line string that merely contains an apostrophe
        can never parse here and falls through to the normal pipeline
        (fixture 77 pins it; §4.5 raw-newline escapes unaffected).
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


  /* ---- split point: the module continues in fixer-b.js / fixer-c.js (three
   classic scripts stand in for one fixer.js — a push-transport cap, not an
   architecture change). Every top-level function defined above is exported on
   root.__JBF so the later parts can alias it back into scope verbatim. ---- */
  root.__JBF = { mapStrings: mapStrings, transformOutsideSpans: transformOutsideSpans,
               isWs: isWs, isWordChar: isWordChar, attemptParse: attemptParse,
               lineColOf: lineColOf, parseErrorPosition: parseErrorPosition,
               errorDetail: errorDetail, spaces: spaces, contextSnippet: contextSnippet,
               passNormalize: passNormalize, topLevelRegions: topLevelRegions,
               outsideFlags: outsideFlags, passWrapper: passWrapper, passComments: passComments,
               passSingleQuotes: passSingleQuotes, passUnquotedKeys: passUnquotedKeys,
               nextCodeChar: nextCodeChar, passTrailingCommas: passTrailingCommas,
               wordSwapPass: wordSwapPass, passJsLiterals: passJsLiterals,
               prevCodeChar: prevCodeChar };
})(typeof window !== 'undefined' ? window : globalThis);
