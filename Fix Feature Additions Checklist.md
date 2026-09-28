# Fix Feature Additions Checklist

Progress ledger for the JSONBFF `Fix` feature: spec → implementation. `[x]` = implemented, fixture-tested (`js/tests/fixtures/`) and shipped to `main`; `[ ]` = remaining. Work proceeds top-down §0→§8, one section per iteration run; §9's cases ship as fixtures alongside their fix type. Per-run decisions live in `history/jsonbff.md`.

## 0. Pre-processing (do this first, always)

- [x] Strip a leading UTF-8 BOM if present — pass 1 `passNormalize` (fixture 09)
- [x] Strip markdown code fences (```json ... ```) and any leading/trailing prose the user may have pasted alongside the JSON — pass 2 `passWrapper`: a leading fence (closed or unclosed) is stripped; when non-blank, bracket-free text surrounds the outermost balanced container, the input is sliced to it (several containers → leftmost that already parses as strict JSON; ambiguous → no slice, clean failure). Fixtures 15–22. Limits in the fixer.js header.
- [x] Trim leading/trailing whitespace — no pass needed: `JSON.parse` tolerates surrounding whitespace, fence/prose slicing drops any remainder, and every successful output is re-serialized via `JSON.stringify` (fixture 12)

## 1. Use the parser's error message to localize the problem

`JSON.parse` throws messages like:

- `Unexpected token X in JSON at position N`
- `Unexpected end of JSON input`
- `Unexpected non-whitespace character after JSON at position N`

Checklist:

- [x] Parse the error message to extract position N (if present) — `errorDetail()` regexes V8's `at position N`, with `line L column C` and Firefox `lineNumber`/`column` fallbacks
- [x] Convert N (character offset) into line/column for highlighting — same helper appends "at line L, column C" when the runtime message lacks it (newline-counting fallback from position)
- [ ] Look at the character at N and a small window before/after it (say ±20 chars) — this tells you what kind of fix to attempt → ships with §8's context snippet in the failure report
- [x] If the error is "Unexpected end of JSON input," the problem is almost always an unclosed bracket/brace/string near the end of the document, not at a specific index — handle separately (see §5) → brackets: pass 11 closes still-open ones at EOF; unterminated strings: pass 13 `passUnterminatedStrings` (fixtures 47–48, 51, 53)

## 2. Structural delimiter fixes

- [x] Missing comma between elements — pass 9 `passDelimiters` (grammar-driven, JSONBFF-IMPROVEMENTS.md §1.3): D1 inserts `,` before a next key after a complete value in an object; D3 inserts `,` between array elements — fixtures 23–26, 28, 29
- [x] Trailing comma before `}` or `]` — if a `,` is immediately followed (ignoring whitespace) by `}` or `]` → remove the comma — pass 6 `passTrailingCommas` (fixture 02)
- [x] Missing colon between key and value — same pass 9 `passDelimiters`: D2 inserts `:` after an object key, before its value (incl. container values) — fixtures 25, 27
- [x] Extra/duplicate colon or comma — collapse repeated `,,` or `::` to one — pass 10 `passDuplicatePunct`: a `,`/`:` whose previous code character outside string spans is the same punctuation is removed, so runs collapse to one (also whitespace- and comment-separated pairs, once pass 3 has stripped the comment); carries pass 9’s ambiguous-paste no-guess guard. Fixtures 34–39.

## 3. Bracket/brace balance

- [x] Walk the string tracking a stack of open `{`/`[` (ignore any inside strings) — pass 11 `passBalanceBrackets` over `mapStrings` spans
- [x] If the stack is non-empty at EOF → append the missing closing characters in reverse order — same pass, reported as `closed` (fixture 06)
- [x] If you hit an unexpected closing character (stack mismatch, e.g. `]` when top of stack is `{`) → either remove the stray closer or swap it to match, depending on which produces a valid parse (try both, keep whichever parses) — pass 11 mismatch branch: both single-edit candidates (swap to match the open frame / remove) are tested by strict JSON.parse of the whole text; at most one can ever parse (a swap keeps the bracket count, a removal lowers it), so the winner is adopted alone and always yields valid output, reported as `swapped` (removal → `stray`); neither parses → legacy stray-removal + EOF close. Fixtures 14, 40–46.

## 4. String / quote fixes

- [x] Unterminated string — if a `"` opens a string and no matching unescaped `"` is found before the next structural character (`,`, `}`, `]`) or EOF → insert `"` at the point just before that structural character — pass 13 `passUnterminatedStrings`: each structural char inside the open span is tried first, left-to-right, first whole-text strict-parse wins (the parser decides; e.g. `{ "a": "x }` closes at the brace in one edit); otherwise close at the end of content (trailing whitespace stays outside the string, an odd dangling backslash run drops). Only code-context spans are closed — a stray `"` in prose fails clean (header limitation). Companion: unterminated `'` spans in code context are converted by pass 4 with content preserved (data-loss bug fixed this run). Fixtures 47–48, 51, 53
- [x] Single-quoted strings — convert `'...'` to `"..."` (only when not nested inside an already-valid double-quoted string; watch for apostrophes in content) — pass 4 `passSingleQuotes` (fixture 03)
- [x] Unquoted or bareword keys — `{key: 1}` → wrap key in double quotes — pass 5 `passUnquotedKeys` (fixture 04)
- [x] Unescaped inner quotes — a `"` inside a string that isn't the terminator → escape as `\"` (use the stack/position logic from §3 to tell terminator from content) — pass 12 `passInnerQuotes`: only a value-position span (right after `:`) followed by a non-key bare word; for each later quote C it escapes every unescaped `"` strictly between opener and C and keeps the leftmost whole-text strict-parse (parser-certified, §7). Deliberately runs before pass 9 (whose D1 comma insertion would rewrite the trigger shape). Not repaired — clean failure, documented in the fixer.js header: breaks inside array elements or at object-key positions (a bare word there means a missing delimiter, not string content), breaks at quote adjacency (no bare word after the premature close), and strings that are also missing their final closing quote. Fixtures 49, 52; limits 54–55
- [x] Unescaped control characters (raw newline/tab inside a string) → escape as `\n`, `\t`, etc. — pass 14 `passEscCtrl`: raw U+0000–U+001F → `\b` `\t` `\n` `\f` `\r`, all others as `\u00xx`; existing escape pairs pass through untouched. Runs after pass 13 (so its trailing-whitespace trim sees the raw characters) and before pass 11; valid JSON never contains a raw control char in a span, so it only fires on already-invalid text (§5.3). Fixtures 50, 56

## 5. Value-token fixes

- [x] Replace JS-only literals with JSON equivalents: `undefined` → remove key or use null; `NaN`/`Infinity` → null or string — pass 7 `passJsLiterals` maps them all to `null` (fixtures 07, 10)
- [x] Strip JS-style comments (`// ...` and `/* ... */`) — not valid JSON but common in pasted config — pass 3 `passComments` (fixture 05)
- [ ] Fix numbers: strip leading `+`, strip leading zeros (`007` → `7`), strip trailing `.` (`5.` → `5`), add leading zero to `.5` → `0.5`
- [ ] Normalize NaN-like unquoted words that were meant to be strings (e.g. `value: yes` → `"yes"`) — lower priority, ambiguous

## 6. Duplicate keys

- [ ] Not a parse error in most parsers, but flag/dedupe if you want "clean" output — keep last occurrence (matches native JSON.parse behavior)

## 7. The retry loop (this is the core algorithm)

```
attempts = 0
while not valid and attempts < MAX_ATTEMPTS:
    error = try parse(text)
    if no error: break
    apply the single most targeted fix from §2–§6 based on error position/message
    attempts += 1
```

- [x] Fix one issue per pass, then re-parse — don't try to fix everything in one blind regex sweep, since fixing one thing shifts all subsequent offsets — each fixed-order pass repairs one defect class and `JSON.parse` is re-attempted after every pass; the pipeline stops at the first success
- [x] Recompute the error position after every fix (don't reuse stale offsets) — every pass scans the current text fresh each round; `errorDetail()` recomputes line/column from the latest parse error
- [x] Cap iterations (e.g. 20–30) to avoid infinite loops on unfixable input — `MAX_ROUNDS = 10` caps the outer loop and a no-progress round breaks early, so unfixable input fails clean, never hangs
- [x] If still invalid after max attempts, surface the remaining error clearly rather than silently returning garbage — `ok:false` with the parse error (message + line/column), "Repaired so far: …", best-effort text kept in `output`

## 8. Fallback tier

- [ ] If targeted patching fails, fall back to a permissive parse (JSON5-style: tolerates comments, trailing commas, unquoted keys, single quotes) and re-serialize with strict `JSON.stringify` — this alone fixes most real-world "almost JSON" input in one shot and is a good first thing to try before your manual patcher, honestly
- [ ] If that also fails, report the exact line/column and a snippet of context so the user can fix it by hand

## 9. Testing checklist (once implemented)

Ships as fixtures with their fix type (`js/tests/fixtures/`, auto-discovered by `run-tests.js`).

| Case | Status |
|---|---|
| `{"a":1 "b":2}` — missing comma | fixture 23 ✅ |
| `{"a":1,}` — trailing comma | fixture 02 ✅ |
| `{"a":"hello}` — missing closing quote | fixture 47 ✅ |
| `{"a":1` — missing closing brace | fixture 06 ✅ (nested variant) |
| `{'a':1}` — single quotes | fixture 03 ✅ |
| `{a:1}` — unquoted key | fixture 04 ✅ |
| `{"a":undefined}` — JS literal | fixture 07 ✅ |
| `{"a":1,,"b":2}` — double comma | fixture 34 ✅ |
| `{"a":"line1\nline2"}` with a raw newline instead of `\n` | fixture 50 ✅ |
| Deeply nested unbalanced brackets | fixture 06 ✅ + 10-disaster ✅ |

The key architectural point: don't try to write one giant regex that fixes everything at once. Use the parser's own error + position as your cursor, fix the single nearest issue, and loop. That's what your current Fix button is likely missing — it's probably applying fixes without re-checking position after each change, so offsets drift and subsequent fixes land in the wrong place.