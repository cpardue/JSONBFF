# JSON BFF — Beautify, Format, Fix

Free, in-browser JSON toolkit: **validate**, **format/beautify**, **fix** broken JSON, and **compact** it — no sign-up, no uploads, 100% client-side.

> **Status:** 🚧 repo scaffolded — implementation follows [`JSONBFF-PLAN.md`](./JSONBFF-PLAN.md) (a complete, step-by-step build plan).

## What it does

- **Validate** — check whether your JSON parses, with the exact line & column of any error
- **Format** — pretty-print with 2-space, 4-space, or tab indentation
- **Fix** — auto-repair common breakage: trailing commas, single quotes, unquoted keys, comments, missing/unclosed brackets, `NaN`/`undefined`, Python-style literals…
- **Compact** — minify to a single line

## Why static?

One-page vanilla HTML/CSS/JS — **no build step, no server, no dependencies**. That means:

- today it hosts on GitHub Pages (push → live), with AdSense-ready ad slots
- tomorrow it deploys unchanged to Netlify/Vercel/Cloudflare Pages/any static host if traffic grows
- the formatter/fixer modules are pure functions, so a backend can be added later without a rewrite

## Quick start (once implemented)

```bash
# Option 1 — just open it in a browser
start index.html   # Windows
open index.html    # macOS / Linux

# Option 2 — serve locally
npx serve .
```

Run the repair-pipeline tests:

```bash
node js/tests/run-tests.js
```

## Deploy (GitHub Pages)

Settings → **Pages** → Build and deployment → *Deploy from a branch* → `main` / root → live at `https://cpardue.github.io/JSONBFF/`. Full details (incl. custom domain) in [the plan, §8](./JSONBFF-PLAN.md).

## Roadmap

- [x] Repo + implementation plan
- [ ] Core app: Validate / Format / Fix / Compact
- [ ] Test suite for the repair pipeline
- [ ] SEO content (About, Privacy) + AdSense slots wired up
- [ ] Deploy to GitHub Pages
- [ ] Custom domain + Google Search Console

## Privacy

Everything runs in your browser. Your JSON is never uploaded anywhere.
