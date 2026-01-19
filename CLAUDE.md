# Righter - Touch Typing Web Game

## Project Overview

A minimalist touch typing web game targeting RTL users (Persian) while remaining flexible for LTR (English). Browser-only, single user, purely text-based using only typographical techniques with Unicode.

## Core Requirements

### Technical Constraints
- Pure browser application, no backend
- Text-only, no emojis or images
- Unicode typography only
- LocalStorage for all persistence
- JSON export/import for all user data
- Web standards compliant (html dir=auto, CSS isolation for RTL/LTR)

### Languages & i18n
- Default languages: Persian and English
- Language detection from browser settings
- User preference stored in localStorage (overrides default)
- i18n texts stored in flexible, easily extendable structure
- Placeholders for additional languages

### Text Content
- Persian: Khayyam's quatrains from github.com/mehdisadeghi
- English: Public domain quotes about peace, mindfulness, solitude (non-political, non-religious, thought-provoking, simple)

### UI/UX Design
- Minimalist single-page design
- Top/upper half: Text to type (larger typography)
- Bottom/lower half: User input area
- Topmost narrow band: Metrics display (WPM, accuracy, etc.)
- Character highlighting: color changes as user types (correct vs. incorrect)
- Mismatched characters shown in different color but typing continues
- Error rate contributes to accuracy metric

### Color System
- Monochromatic scheme based on single HSL CSS variable
- All colors derived from this base
- Very few colors applied
- Simple background with card-based layout

### Typography Options (Live)
- Font size adjustment
- Color adjustment
- Custom text input (user can swap default text)

### Difficulty Levels (Future)
- Placeholder structure for difficulty tiers per language
- Levels based on: punctuation, accents, numbers, symbols
- Requires curated input data (not implemented in first draft)

### Metrics
- Words per minute (WPM)
- Accuracy (based on error rate)
- Generic touch typing metrics displayed clearly during typing

### Data Persistence
- User rankings
- Past race results
- Language preference
- All settings
- Export/import as JSON

### Build System
- Makefile for build, serve, and other tasks

## Framework

Svelte 5 with SvelteKit (static adapter) and Vite. Bun as runtime.

## Implementation Summary

**Visual design**
- Monochromatic HSL color system driven by single `--hue` CSS variable
- "Opening crawl" effect: active line scaled up (1.15x), completed lines fade/shrink/blur, upcoming lines dimmed
- Keyboard visualization showing pressed keys and next expected key with Shift/AltGr layer support

**RTL/i18n**
- Full RTL via `dir` attribute, Persian digits (۰-۹), Vazirmatn font
- ZWNJ handling with `display: contents` to preserve Arabic text shaping

**Layout**
- `max-height: 40vh` on text display to prevent cross-browser scroll issues
- JavaScript-calculated scroll offset keeps active line centered

**Data**
- LocalStorage for settings/history, JSON export/import

## Svelte 5 Runes

Runes are Svelte 5's reactivity primitives, replacing the implicit `$:` syntax:

- `$state(value)` - Declares reactive state. Changes trigger UI updates.
- `$derived(expression)` - Computed value that auto-updates when dependencies change.
- `$derived.by(() => ...)` - For complex derived computations needing statements.
- `$effect(() => ...)` - Side effects that run when dependencies change (like React's useEffect).
- `$props()` - Declares component props.

Runes make reactivity explicit and work inside regular `.js` files, not just `.svelte` components.

## Static Adapter

SvelteKit adapters transform the app for different deployment targets:

- `@sveltejs/adapter-static` - Prerenders all pages at build time into static HTML/CSS/JS files
- Output can be hosted on any static file server (GitHub Pages, Netlify, S3, etc.)
- No Node.js server needed at runtime
- All routing happens client-side after initial load

Other adapters exist for Node servers, Vercel, Cloudflare Workers, etc.

## Svelte vs React

| Aspect | Svelte | React |
|--------|--------|-------|
| **Compilation** | Compiles to vanilla JS at build time | Ships runtime library (~40kb) to browser |
| **Reactivity** | Built-in via runes/compiler magic | Manual via hooks (useState, useEffect) |
| **Syntax** | `.svelte` files with HTML-first approach | JSX (JavaScript with HTML-like syntax) |
| **Boilerplate** | Less - no `useState`, `useCallback`, `useMemo` | More - explicit hook calls, dependency arrays |
| **Bundle size** | Smaller (no runtime) | Larger (React + ReactDOM) |
| **Learning curve** | Gentler for HTML/CSS developers | Steeper, more JavaScript-centric |
| **Ecosystem** | Smaller but growing | Massive, mature |
| **State management** | Built-in stores, runes | External libs (Redux, Zustand) or Context |
| **Two-way binding** | Native (`bind:value`) | Manual (value + onChange) |

Svelte trades ecosystem size for developer ergonomics and performance. React's virtual DOM diffing happens at runtime; Svelte's compiler determines updates at build time.

## Project Structure

```
righter/
├── .claude/settings.local.json   # Claude Code local settings
├── .gitignore
├── .npmrc                        # npm/bun config (e.g., strict engines)
├── CLAUDE.md                     # This file - project context for Claude
├── Makefile                      # Build/serve commands
├── README.md
├── bun.lock                      # Bun lockfile (like package-lock.json)
├── jsconfig.json                 # JS language server config, path aliases
├── package.json                  # Dependencies and scripts
├── svelte.config.js              # SvelteKit config (adapter, aliases)
├── vite.config.js                # Vite plugins (sveltekit, yaml)
│
├── src/
│   ├── app.html                  # HTML shell template (%sveltekit.head%, %sveltekit.body%)
│   │
│   ├── lib/                      # Shared code ($lib alias)
│   │   ├── index.js              # Lib barrel export (currently empty)
│   │   ├── i18n.js               # Translations, language detection, RTL helper
│   │   ├── storage.js            # LocalStorage CRUD, export/import
│   │   ├── styles.css            # Global styles (CSS variables, reset, layout)
│   │   ├── texts.js              # Text loading, random selection by lang/difficulty
│   │   │
│   │   └── data/
│   │       ├── khayyam_en.yaml   # English Khayyam quatrains
│   │       └── khayyam_fa.yaml   # Persian Khayyam quatrains
│   │
│   └── routes/                   # SvelteKit file-based routing
│       ├── +layout.js            # Layout load function (prerender = true)
│       ├── +layout.svelte        # Root layout (imports global CSS)
│       └── +page.svelte          # Main app (all UI, state, keyboard, metrics)
│
└── static/
    └── favicon.svg               # Site icon
```

**Key conventions:**

- `+page.svelte` - Page component rendered at that route
- `+layout.svelte` - Wraps all pages (and nested layouts)
- `+layout.js` / `+page.js` - Load functions, export config like `prerender`
- `$lib` - Alias to `src/lib`, used as `import x from '$lib/...'`
- `static/` - Files served as-is at root URL

**Data flow:**

1. `+layout.js` sets `prerender = true` for static build
2. `+layout.svelte` imports global CSS
3. `+page.svelte` loads data from `storage.js`, texts from `texts.js`
4. `texts.js` imports YAML via Vite plugin, parses quatrains
5. User interactions update `$state`, triggering reactive UI updates

## Development Guidelines

- Transactions owned by callers (HTTP handlers, tasks, or tests)
- Meaningful exceptions, favor existing Python semantics (N/A for this frontend project)
- No docstrings for self-explanatory test functions
- Comments explain "why" not "what" or "how"
- DRY principle
- Idempotent operations preferred
- Minimal, meaningful tests with clear rationale
