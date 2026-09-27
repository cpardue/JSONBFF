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

    Known limitations:
    - A bare apostrophe in prose/comments is treated as
      the start of a single-quoted span (mapStrings supports ' per §5.1).
      Such input degrades to a clear error report — never a silent wrong
      result, since passes only run on already-invalid input.
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
    ============================================================ */
(function (root) {
  'use strict';

  /* ---------------- shared scanners ---------------- */

  /** Whitespace per JSON.parse: space, tab, line feed, carriage return. */
  function isWs(c) {
    return c === ' ' || c === '\t' || c === '\n' || c === '\r';
  }

  /**
   * Map every string literal in `text` to a [start, end) span — indices
   * cover the WHOLE token including its quotes, exactly as JSON.parse
   * sees them. Handles both double-quoted JSON strings and single-quoted
   * ones (a common "almost JSON" defect): whichever quote character opens
   * a string is also the one that closes it, so apostrophes inside
   * double-quoted strings never confuse the map. Escape sequences are
   * skipped: \" or \' (and \\) do not close their string.
   *
   * Runs left to right with no backtracking — O(n) — and is the ONLY
   * place quotes are interpreted. Every repair pass below transforms
   * code outside these spans only, so a pass can never touch string
   * CONTENT: the input's meaning is preserved by construction (§5.1).
   */
  function mapStrings(text) {
    var spans = [];
    var i = 0;
    var n = text.length;
    while (i < n) {
      var c = text.charAt(i);
      if (c !== '"' && c !== "'") { i++; continue; }
      var j = i + 1;
      while (j < n) {
        var d = text.charAt(j);
        if (d === '\\') { j += 2; continue; }
        if (d === c) break;
        if (d === '\n' || d === '\r') break; // strings never span lines
        j++;
      }
      var closed = j < n && text.charAt(j) === c;
      spans.push([i, closed ? j + 1 : n]);
      i = closed ? j + 1 : n;
    }
    return spans;
  }

  /**
   * Apply `fn` to every region of `text` OUTSIDE the string spans and
   * reassemble. String spans are copied through byte-for-byte (§5.1).
   * The regions arrive left to right with their absolute start index, so
   * a pass that must see the previous code character can do so from its
   * own state.
   */
  function transformOutsideSpans(text, spans, fn) {
    var out = '';
    var pos = 0;
    for (var k = 0; k <= spans.length; k++) {
      var start = k === 0 ? 0 : spans[k - 1][1];
      var end = k < spans.length ? spans[k][0] : text.length;
      if (end > start) out += fn(text.slice(start, end), start);
      pos = end;
    }
    return out;
  }

  /** Try to parse; the error object is kept so §7 can localize it. */
  function attemptParse(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  /**
   * Localize a parse error per checklist §7: the position JSON.parse
   * reports is the CURSOR for every repair pass — "apply the single most
   * targeted fix at/near that position" (JSONBFF-IMPROVEMENTS.md §0).
   * Recent V8 messages carry "at position N"; older engines say only
   * "Unexpected token ..." so we recompute from the message text. The
   * user-facing detail always ends with line + column (§4) plus a
   * one-line snippet around the fault.
   */
  function errorDetail(text, err) {
    var msg = String(err && err.message || 'invalid JSON');
    var pos = -1;
    var m = msg.match(/at position (\d+)/);
    if (m) pos = parseInt(m[1], 10);
    // V8 also reports "line L column C" for some errors — reuse it.
    var lm = msg.match(/\(line (\d+) column (\d+)\)/);
    if (pos >= 0 && !lm) {
      var line = 1, col = 1;
      for (var i = 0; i < pos && i < text.length; i++) {
        if (text.charAt(i) === '\n') { line++; col = 1; } else col++;
      }
      lm = [null, String(line), String(col)];
    }
    var tail = '';
    if (lm) tail = ' (line ' + lm[1] + ' column ' + lm[2] + ')';
    else if (pos >= 0) tail = ' (position ' + pos + ')';
    // One-line context snippet centered on the fault.
    if (pos >= 0 && pos < text.length) {
      var from = Math.max(0, pos - 12);
      var to = Math.min(text.length, pos + 12);
      var snip = text.slice(from, to).replace(/\r/g, '');
      snip = snip.replace(/\n/g, '⏎');
      tail += ', "' + (from > 0 ? '…' : '') + snip + (to < text.length ? '…' : '') + '"';
    }
    return msg + tail;
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
    var openAt = -1;
    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      for (var i = gs; i < ge; i++) {
        var c = text.charAt(i);
        if (c === '{' || c === '[') {
          if (depth === 0) openAt = i;
          depth++;
        } else if (c === '}' || c === ']') {
          depth--;
          if (depth === 0 && openAt !== -1) { regions.push([openAt, i + 1]); openAt = -1; }
          if (depth < 0) { depth = 0; openAt = -1; }
        }
      }
    }
    return regions;
  }

  /** Whitespace/bracket census of the text OUTSIDE `regions` — does any
      real prose surround the containers? (pass 2's slice condition) */
  function outsideFlags(text, regions) {
    var nonBlank = false;
    var hasBracket = false;
    for (var k = 0; k <= regions.length; k++) {
      var gs = k === 0 ? 0 : regions[k - 1][1];
      var ge = k < regions.length ? regions[k][0] : text.length;
      for (var i = gs; i < ge; i++) {
        var c = text.charAt(i);
        if (!isWs(c)) nonBlank = true;
        if (c === '{' || c === '}' || c === '[' || c === ']') hasBracket = true;
      }
    }
    return { nonBlank: nonBlank, hasBracket: hasBracket };
  }

  /* ---------------- repair passes (§5.2, fixed order) ---------------- */

  /** Pass 1 — Normalize line endings: BOM stripped, CRLF → LF. */
  function passNormalize(text) {
    var t = text;
    var changes = [];
    if (t.charCodeAt(0) === 0xFEFF) { t = t.slice(1); changes.push({ key: 'bom', count: 1 }); }
    var crlf = 0;
    var out = '';
    for (var i = 0; i < t.length; i++) {
      if (t.charAt(i) === '\r' && t.charAt(i + 1) === '\n') { crlf++; i++; }
      out += t.charAt(i);
    }
    if (crlf) changes.push({ key: 'crlf', count: crlf });
    return changes.length ? { text: out, changes: changes } : { text: text, changes: [] };
  }

  /** Pass 2 — Strip markdown code fences and surrounding prose
      (checklist §0). A leading fence line (```json / ``` …) is dropped;
      a closing fence, if any, drops with everything after it. If the
      result then has NON-BLANK text around its outermost balanced
      container(s) — e.g. "Here is your JSON: { … } thanks" — the input
      is sliced to that container. Safety rails (JSONBFF-IMPROVEMENTS.md
      §1.2 / checklist §0): prose that itself contains braces/brackets is
      never sliced (we might eat real data), and if several balanced
      containers coexist without fences, the leftmost one that ALREADY
      parses as strict JSON is kept; if none does, nothing is guessed —
      the whole input fails with the normal parse error. */
  function passWrapper(text) {
    var changes = [];
    var t = text;

    // (a) A markdown fence opening the paste: drop it and any closing fence.
    var m = t.match(/^\uFEFF?\s*```[^\n]*\n/);
    if (m) {
      t = t.slice(m[0].length);
      changes.push({ key: 'fence', count: 1 });
      var closeRe = /\n?```\s*(?:json|js|javascript)?\s*\n?$/i;
      var cm = t.match(closeRe);
      if (cm) t = t.slice(0, t.length - cm[0].length);
    }

    // (b) Prose around the outermost balanced container(s).
    var regions = topLevelRegions(t);
    if (regions.length) {
      var flags = outsideFlags(t, regions);
      var first = regions[0][0];
      var last = regions[regions.length - 1][1];
      var before = t.slice(0, first);
      var after = t.slice(last);
      if (flags.nonBlank && !flags.hasBracket) {
        if (regions.length === 1) {
          t = t.slice(first, last);
          changes.push({ key: 'prose', count: 1 });
        } else {
          // Several containers: keep the leftmost one that already parses
          // as strict JSON. Any earlier unparseable region was rejected by
          // a prior pipeline round (its defects repaired, parse re-attempted),
          // so this never drops data the passes could have saved — and if
          // NO region parses, we decline to guess (checklist §0).
          var pick = -1;
          for (var r = 0; r < regions.length; r++) {
            var p = attemptParse(t.slice(regions[r][0], regions[r][1]));
            if (p.ok) { pick = r; break; }
          }
          if (pick !== -1) {
            t = t.slice(regions[pick][0], regions[pick][1]);
            changes.push({ key: 'prose', count: 1 });
          }
        }
      }
    }

    return changes.length ? { text: t, changes: changes } : { text: text, changes: [] };
  }

  /** Pass 3 — Strip JS/Python comments (checklist §5, line 50): `// …`
      to end of line, and `/* … */` blocks (newlines inside a block are
      kept, so line/column positions after it stay close). Both styles
      are stripped whole; nothing is reported per character run.
      String spans are protected, so "https://…" inside a string survives. */
  function passComments(text) {
    var spans = mapStrings(text);
    var removedLine = 0;
    var removedBlock = 0;
    var out = transformOutsideSpans(text, spans, function (region) {
      var s = region;
      var prevWs = true; // start of region: line comments only after whitespace or region start
      for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (c === '/' && s.charAt(i + 1) === '/') {
          var nl = s.indexOf('\n', i);
          s = s.slice(0, i) + (nl === -1 ? '' : '\n');
          removedLine++;
          break; // region after a line comment is the rest of that line's tail
        }
        if (c === '/' && s.charAt(i + 1) === '*' && prevWs) {
          var end = s.indexOf('*/', i + 2);
          if (end !== -1) {
            // Keep newlines inside the block so downstream positions match.
            var inner = s.slice(i, end + 2).replace(/[^\n]/g, '');
            s = s.slice(0, i) + (inner || ' ') + s.slice(end + 2);
            removedBlock++;
            i += (inner || ' ').length - 1;
          } else {
            // Unterminated block: treat the rest of the region as comment.
            var tail = s.slice(i).replace(/[^\n]/g, '');
            s = s.slice(0, i) + (tail || ' ');
            removedBlock++;
            break;
          }
        }
        prevWs = isWs(c);
      }
      return s;
    });
    var changes = [];
    if (removedLine) changes.push({ key: 'comments', count: removedLine, kind: 'line' });
    if (removedBlock) changes.push({ key: 'comments', count: removedBlock, kind: 'block' });
    return changes.length ? { text: out, changes: changes } : { text: text, changes: [] };
  }

  /** Pass 4 — Single-quoted strings → double-quoted (checklist §5): the
      quote TOKEN is flipped and embedded double quotes are escaped;
      apostrophes inside genuine double-quoted strings are untouched.
      A single-quoted span that never closes on its line is left alone —
      pass 2's prose rules decide what to do with it. */
  function passSingleQuotes(text) {
    var spans = mapStrings(text);
    var converted = 0;
    var out = '';
    var pos = 0;
    for (var k = 0; k <= spans.length; k++) {
      var start = k === 0 ? 0 : spans[k - 1][1];
      var end = k < spans.length ? spans[k][0] : text.length;
      if (k < spans.length) {
        out += text.slice(pos, start);
        var token = text.slice(spans[k][0], spans[k][1]);
        if (token.charAt(0) === "'" && token.charAt(token.length - 1) === "'") {
          converted++;
          var inner = token.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"');
          out += '"' + inner + '"';
        } else {
          out += token;
        }
        pos = spans[k][1];
      }
    }
    out += text.slice(pos);
    return converted ? { text: out, changes: [{ key: 'quotes', count: converted }] } : { text: text, changes: [] };
  }

  /** Pass 5 — Unquoted object keys → double-quoted (checklist §5): a
      bareword immediately after `{` or `,` (code-only, outside spans)
      followed by `:` is wrapped in quotes. Dotted or hyphenated barewords
      are NOT touched (they are not JSON keys at all — left for the error
      report), and barewords that are already quoted never match. */
  function passUnquotedKeys(text) {
    var spans = mapStrings(text);
    var quoted = 0;
    var out = transformOutsideSpans(text, spans, function (region) {
      var s = region.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, function (all, pre, key, post) {
        quoted++;
        return pre + '"' + key + '"' + post;
      });
      return s;
    });
    return quoted ? { text: out, changes: [{ key: 'keys', count: quoted }] } : { text: text, changes: [] };
  }

  /** Next non-whitespace character in code after index `from`, skipping
      string spans entirely. Returns the character, or null at end. */
  function nextCodeChar(text, spans, from) {
    var i = from + 1;
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

  /** Pass 6 — Trailing commas before `}` or `]` (checklist §2): a `,`
      whose next code character is a closer is removed. String spans
      protect commas inside values ("a,]"). Deletion only, so the pass
      cannot introduce ambiguity; re-rounding handles stacked cases. */
  function passTrailingCommas(text) {
    var spans = mapStrings(text);
    var removeAt = [];
    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      for (var i = gs; i < ge; i++) {
        if (text.charAt(i) !== ',') continue;
        var nx = nextCodeChar(text, spans, i);
        if (nx === '}' || nx === ']') removeAt.push(i);
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

  /** Pass 7 — JS-only literals → null (checklist §5): undefined, NaN,
      Infinity, -Infinity, +Infinity as WHOLE tokens (word boundary, code
      regions only). Mapping to null preserves "a value was here" without
      inventing data; dropping the key would be a guess (§5.3). */
  function passJsLiterals(text) {
    var spans = mapStrings(text);
    var replaced = 0;
    var RE = /\b(?:undefined|NaN|Infinity|-Infinity|\+Infinity)\b/g;
    var out = transformOutsideSpans(text, spans, function (region) {
      return region.replace(RE, function (w) {
        // Word-boundary matches never touch identifier chars (check).
        replaced++;
        return 'null';
      });
    });
    return replaced ? { text: out, changes: [{ key: 'jslit', count: replaced }] } : { text: text, changes: [] };
  }

  /** Pass 8 — Python-style literals → JSON (checklist §5): True → true,
      False → false, None → null. Same whole-token, code-only discipline
      as pass 7; "True" inside a string is content, never touched. */
  function passPyLiterals(text) {
    var spans = mapStrings(text);
    var replaced = 0;
    var out = transformOutsideSpans(text, spans, function (region) {
      return region.replace(/\b(?:True|False|None)\b/g, function (w) {
        replaced++;
        if (w === 'True') return 'true';
        if (w === 'False') return 'false';
        return 'null';
      });
    });
    return replaced ? { text: out, changes: [{ key: 'pylit', count: replaced }] } : { text: text, changes: [] };
  }

  /** Pass 9 — Insert missing commas/colons (checklist §2; design per
      JSONBFF-IMPROVEMENTS.md §1.3). One grammar-driven left-to-right
      walk over the non-string regions with a frame stack of
      (container, role):

        container ∈ { OBJECT, ARRAY }
        role      ∈ { KEY, COLON, VALUE, POST }
                      KEY   — inside an object, expecting a key
                      COLON — key seen, expecting `:`
                      VALUE — expecting a value (after `:` or after `[`/`,`)
                      POST  — a complete value was just seen

      The ONLY edits are the three insertions the JSON grammar forces at
      a token boundary (IMPROVEMENTS §1.3 transition table):

        D1  OBJECT/POST  + string/word key token   → insert `,` before it
        D2  OBJECT/COLON + value-start token       → insert `:` before it
        D3  ARRAY/POST   + value-start token       → insert `,` before it

      Naive lookahead cannot distinguish which separator is missing —
      `{ "a" "b": 1 }` needs `,` before "b" AND `:` after it in the next
      frame — so the frame stack decides. Everything else (colon in an
      array, bracket-type mismatch, missing value before a close, two-or-
      more missing tokens per gap) gets NO edit here: the pipeline
      re-rounds and, finding no progress, fails with the clear §8 error
      report instead of guessing (JSONBFF-IMPROVEMENTS.md §1.5).

      Tokenization follows the full JSON number grammar so `1e5`, `-1.5`
      and `.5`-style tokens never split mid-number: a fraction is part of
      a number only on `.<digit>`, an exponent only on `[eE][+-]?<digit>`,
      a sign only on `-<digit>` — so `{ "a" : 1. 2 }` does NOT become the
      garbage number `1.` swallowing the next token (IMPROVEMENTS §1.3).

      Ambiguous pastes: when ≥2 balanced containers are surrounded by
      bracket-free prose, pass 2 cannot know which one is the payload, so
      this pass declines to edit at all — repairing one container would
      let pass 2's leftmost-parseable slice guess (checklist §0 no-guess
      policy owns those: clean failure instead). The guard mirrors pass 2's
      slice condition exactly via topLevelRegions + outsideFlags. Runs after
      quotes/literals so token classes are clean, and before balance
      (pass 11) so every container is still open while it walks. O(n); one
      scan suffices (the pipeline re-rounds anyway) — insertions are
      recorded in original-text coordinates and applied only at the end,
      so offsets never shift mid-walk. */
  function passDelimiters(text) {
    // Ambiguous-paste guard — mirrors pass 2's slice condition exactly.
    var regions = topLevelRegions(text);
    if (regions.length >= 2) {
      var flags = outsideFlags(text, regions);
      if (flags.nonBlank && !flags.hasBracket) return { text: text, changes: [] };
    }

    var spans = mapStrings(text);
    var OBJ = 0, ARR = 1;          // container types
    var R_KEY = 0, R_COLON = 1, R_VALUE = 2, R_POST = 3;
    var stack = [];
    var inserts = [];              // [pos, char] in original-text coords

    function top() { return stack.length ? stack[stack.length - 1] : null; }

    function onToken(cls, isWord, pos) {
      // cls: 'string' | 'number' | 'word' | struct ch ('{','[','}',']',',',':')
      var t = top();
      if (cls === '{' || cls === '[') {
        // Container OPENING. A `{` right after a completed value or key
        // would need an inserted separator FIRST — but that boundary is
        // the PREVIOUS token's, handled when that token was classified.
        // Here we only check D2: object key directly followed by a
        // container value (`{ "a" [1,2] }`) → insert `:` before it.
        if (t && t[0] === OBJ && t[1] === R_COLON) {
          inserts.push([pos, ':']);
          t[1] = R_VALUE;
        }
        stack.push(cls === '{' ? [OBJ, R_KEY] : [ARR, R_VALUE]);
        return;
      }
      if (cls === '}' || cls === ']') {
        if (!top) return; // stray closer at root — pass 11
        if ((ch === '}') !== (top[0] === OBJ)) return; // type mismatch — pass 11 owns it
        stack.pop();
        var p = top();
        if (p) p[1] = R_POST; else return;
        return;
      }
      if (cls === ',') {
        if (top && top[1] === R_POST) {
          top[1] = (top[0] === OBJ) ? R_KEY : R_VALUE;
        }
        // leading/double comma → no edit (§1.5); duplicate separators → pass 10
        return;
      }
      if (cls === ':') {
        if (top && top[0] === OBJ && top[1] === R_COLON) top[1] = R_VALUE;
        return; // colon elsewhere → no edit (§1.5)
      }
      // Value-start token: string | number | word
      if (t) {
        if (t[0] === OBJ && t[1] === R_POST && cls !== 'number') {
          inserts.push([pos, ',']);   // D1 — next key after a complete value
          t[1] = R_KEY;               // fall through: now act as a key
        }
        if (t[0] === ARR && t[1] === R_POST) {
          inserts.push([pos, ',']);   // D3 — next element after a complete value
          t[1] = R_VALUE;
        }
        if (t[0] === OBJ && t[1] === R_COLON) {
          inserts.push([pos, ':']);   // D2 — value (or container start) after a key
          t[1] = R_VALUE;
        }
      }
      if (cls === 'string' || cls === 'number') {
        var tt = top();
        if (tt) {
          if (tt[0] === OBJ && (tt[1] === R_KEY || tt[1] === R_COLON)) tt[1] = R_COLON; // string/word key; a number is accepted as-is
          else if (tt) tt[1] = R_POST;
        }
      } else {
        var uu = top();
        if (uu) uu[1] = R_POST;
      }
    }

    for (var k = 0; k <= spans.length; k++) {
      var gs = k === 0 ? 0 : spans[k - 1][1];
      var ge = k < spans.length ? spans[k][0] : text.length;
      if (k < spans.length) onToken('string', false, spans[k][0]);
      for (var i = gs; i < ge; i++) {
        var c = text.charAt(i);
        if (c === '{' || c === '[' || c === '}' || c === ']') { onToken(c, false, i); continue; }
        if (c === ',' || c === ':') { onToken(c, false, i); continue; }
        // Numbers: full JSON grammar (IMPROVEMENTS §1.3 token table).
        if (c === '-' && ge > i + 1 && text.charCodeAt(i + 1) >= 48 && text.charCodeAt(i + 1) <= 57) {
          var j = i + 1;
          while (j < ge && text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) j++;
          if (j < ge && text.charAt(j) === '.' && j + 1 < ge && text.charCodeAt(j + 1) >= 48 && text.charCodeAt(j + 1) <= 57) {
            j += 2; while (j < ge && text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) j++;
          }
          if (j < ge && (text.charAt(j) === 'e' || text.charAt(j) === 'E')) {
            var e = j + 1;
            if (e < ge && (text.charAt(e) === '+' || text.charAt(e) === '-')) e++;
            if (e < ge && text.charCodeAt(e) >= 48 && text.charCodeAt(e) <= 57) {
              e++; while (e < ge && text.charCodeAt(e) >= 48 && text.charCodeAt(e) <= 57) e++;
              j = e;
            }
          }
          onToken('number', false, i); i = j - 1; continue;
        }
        if (c >= '0' && c <= '9') {
          var n2 = i;
          while (n2 < ge && text.charCodeAt(n2) >= 48 && text.charCodeAt(n2) <= 57) n2++;
          if (n2 < ge && text.charAt(n2) === '.' && n2 + 1 < ge && text.charCodeAt(n2 + 1) >= 48 && text.charCodeAt(n2 + 1) <= 57) {
            n2 += 2; while (n2 < ge && text.charCodeAt(n2) >= 48 && text.charCodeAt(n2) <= 57) n2++;
          }
          if (n2 < ge && (text.charAt(n2) === 'e' || text.charAt(n2) === 'E')) {
            var e2 = n2 + 1;
            if (e2 < ge && (text.charAt(e2) === '+' || text.charAt(e2) === '-')) e2++;
            if (e2 < ge && text.charCodeAt(e2) >= 48 && text.charCodeAt(e2) <= 57) {
              e2++; while (e2 < ge && text.charCodeAt(e2) >= 48 && text.charCodeAt(e2) <= 57) e2++;
              n2 = e2;
            }
          }
          onToken('number', false, i); i = n2 - 1; continue;
        }
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$') {
          var w = i;
          while (w < ge) {
            var wc = text.charAt(w);
            if ((wc >= 'a' && wc <= 'z') || (wc >= 'A' && wc <= 'Z') ||
                (wc >= '0' && wc <= '9') || wc === '_' || wc === '$') w++;
            else break;
          }
          onToken('word', true, i); i = w - 1; continue;
        }
        // Anything else (stray characters) is ignored by the walk.
      }
    }

    if (!inserts.length) return { text: text, changes: [] };
    // Apply insertions right-to-left so earlier positions stay valid.
    inserts.sort(function (a, b) { return b[0] - a[0]; });
    var out = text;
    for (var r = 0; r < inserts.length; r++) {
      out = out.slice(0, inserts[r][0]) + inserts[r][1] + out.slice(inserts[r][0]);
    }
    var commas = 0, colons = 0;
    for (var q = 0; q < inserts.length; q++) {
      if (inserts[q][1] === ',') commas++; else colons++;
    }
    var changes = [];
    if (commas) changes.push({ key: 'comma', count: commas });
    if (colons) changes.push({ key: 'colon', count: colons });
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

  /** Pass 11 — Balance brackets: a closer without a matching open is
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
          var open = stack.length ? stack[stack.length - 1] : null;
          var match = (c === '}' && open === '{') || (c === ']' && open === '[');
          if (match) stack.pop();
          else strayAt.push(i); // stray closer — remove it
        }
      }
    }
    var removedStray = 0;
    var out = text;
    if (strayAt.length) {
      var cut = '';
      var prev = 0;
      for (var r = 0; r < strayAt.length; r++) {
        cut += out.slice(prev, strayAt[r]);
        prev = strayAt[r] + 1;
      }
      cut += out.slice(prev);
      out = cut;
      removedStray = strayAt.length;
    }
    var appended = '';
    for (var s = stack.length - 1; s >= 0; s--) {
      appended += stack[s] === '{' ? '}' : ']';
    }
    if (appended) out += appended;
    var changes = [];
    if (removedStray) changes.push({ key: 'stray', count: removedStray });
    if (appended) changes.push({ key: 'closed', count: appended.length });
    return changes.length ? { text: out, changes: changes } : { text: text, changes: [] };
  }

  /* ---------------- pipeline ---------------- */

  /** Fixed repair order (checklist §5.2). Cheap normalizations first;
      structural passes (delimiters → duplicate delimiters → balance)
      last, so the grammar walk sees quote/literal-clean tokens. */
  var PASSES = [
    passNormalize,       // 1
    passWrapper,         // 2 (checklist §0 — code fences + surrounding prose)
    passComments,        // 3
    passSingleQuotes,    // 4
    passUnquotedKeys,    // 5
    passTrailingCommas,  // 6
    passJsLiterals,      // 7
    passPyLiterals,      // 8
    passDelimiters,      // 9 (checklist §2 — insert missing commas/colons, grammar-driven)
    passDuplicatePunct,  // 10 (checklist §2.4 — collapse duplicate ,, / :: separators)
    passBalanceBrackets  // 11
  ];

  /** Human labels for the change report rendered by js/app.js (§4). */
  var LABELS = {
    bom: function () { return 'removed a UTF-8 BOM'; },
    crlf: function (c) { return c === 1 ? 'normalized 1 CRLF line ending' : 'normalized ' + c + ' CRLF line endings'; },
    fence: function () { return 'stripped a markdown code fence'; },
    prose: function () { return 'removed surrounding prose'; },
    comments: function (c) { return c === 1 ? 'removed 1 comment' : 'removed ' + c + ' comments'; },
    quotes: function (c) { return c === 1 ? 'converted 1 single-quoted string' : 'converted ' + c + ' single-quoted strings'; },
    keys: function (c) { return c === 1 ? 'quoted 1 unquoted key' : 'quoted ' + c + ' unquoted keys'; },
    trailing: function (c) { return c === 1 ? 'removed 1 trailing comma' : 'removed ' + c + ' trailing commas'; },
    jslit: function (c) { return c === 1 ? 'replaced 1 JS-only literal with null' : 'replaced ' + c + ' JS-only literals with null'; },
    pylit: function (c) { return c === 1 ? 'replaced 1 Python-style literal' : 'replaced ' + c + ' Python-style literals'; },
    comma: function (c) { return c === 1 ? 'inserted 1 missing comma' : 'inserted ' + c + ' missing commas'; },
    colon: function (c) { return c === 1 ? 'inserted 1 missing colon' : 'inserted ' + c + ' missing colons'; },
    dupcomma: function (c) { return c === 1 ? 'collapsed 1 duplicate comma' : 'collapsed ' + c + ' duplicate commas'; },
    dupcolon: function (c) { return c === 1 ? 'collapsed 1 duplicate colon' : 'collapsed ' + c + ' duplicate colons'; },
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