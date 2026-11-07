'use strict';
'require baseclass';

/* ---------------------------------------------------------------------------
 * Shared design tokens for the unified Airoha SoC/NPU view.
 *
 * This module mirrors luci-app-mesh-conf/.../view/meshconf/ds-tokens.js
 * on purpose: pages that ship in the same product read as one design language,
 * so the same token names, the same em-based scale and the same theme-variable
 * mapping are reused here instead of inventing a second vocabulary.
 *
 * `tokens` is the body of the `.airoha-page{ ... }` rule: the surfaces, borders
 * and text labels prefer Aurora variables, then Glass variables, then the
 * legacy LuCI / Argon variables. This keeps ownership of the palette with the
 * active theme - but only when the theme actually exposes one of them.
 * The shipped theme on the reference boards is Argon, and its cascade.css
 * defines NONE of `--surface` / `--color-bg-elevated` / `--background-color-high`
 * / `--surface-sunken` / `--color-bg-secondary` / `--background-color-medium` /
 * `--text` / `--color-text` / `--text-color-high` / `--text-color-low` /
 * `--hairline` / `--color-border` / `--border-color-low` / `--border-color-medium`
 * (its :root carries the Bootstrap 4 palette instead: --primary, --dark-primary,
 * --white, --background-color, --gray-dark, --light, ...), so on Argon every
 * lookup misses and the hardcoded fallbacks below are what actually apply.
 * `--background-color` is deliberately NOT part of the chain: dark.css never
 * re-assigns it (it stays #f4f5f7 in dark mode) and in light mode it equals the
 * page canvas, so panels built on it would blend into the page in both modes.
 * On top of the mesh-conf set this file adds three entries the dashboard needs:
 *   --ds-border-strong  a heavier border for the outer compass ring / toggles
 *   --ds-primary-text   a text-safe primary colour for the selected tab label
 *   --ds-ok-wash        the success green, tuned for a full-width *row*
 *                       background (a table row at the .18 dark badge tint
 *                       reads as "selected", so rows use the wash instead)
 * and the `--ai-*` dashboard accents (NPU/CPU/load + the three WiFi bands),
 * which the gauges paint with. `--ai-core-0..3` is the per-core series palette
 * the CPU usage history chart draws its one-line-per-thread curves with. The
 * first palette had three of its four hues inside 286..346 deg (blue-violet,
 * purple, magenta) and a worst pairwise CIE76 dE of only 32; under simulated
 * protanopia blue and purple collapsed to dE 5.9, i.e. the same line twice.
 * The current set sits at ~288 / 50 / 143 / 8 deg with worst-case dE 57.7 for
 * normal vision and 26.8 / 26.1 under simulated deuteranopia / protanopia,
 * and every entry keeps >= 3:1 contrast on the card surface (#fff light,
 * #252526 dark; WCAG 2.1 non-text minimum). AN7581 has four cores; the reader
 * cycles the palette, dashed, for anything beyond that.
 * They live on the token layer so a single
 * dark-mode re-tune keeps every gauge in step.
 *
 * `dark` re-tunes the surfaces and text as well as the semantic accents, the
 * `--ai-*` accents and the two border tokens for a dark background: the tints
 * get a higher alpha there, since a .08 wash is invisible on a dark surface.
 * Surfaces and text have to be re-stated here instead of being left to the
 * theme, because the lookup above misses on Argon and the page would otherwise
 * paint white panels with near-black text on a #1e1e1e canvas - the exact
 * failure this block exists to prevent. The concrete values are Argon's own
 * dark palette, so the page reads as part of the theme: page canvas #1e1e1e
 * (dark.css `body`), elevated surface #252526 (what dark.css gives `table th`
 * and the zebra rows), body text #cccccc, secondary text #adb5bd. Measured with
 * the WCAG relative-luminance formula:
 *   --ds-text       #cccccc on #252526 = 9.5:1
 *   --ds-text-muted #adb5bd on #252526 = 7.2:1
 *   --ds-border-strong #757575 on #1e1e1e = 3.62:1  (clears the 3:1 floor)
 *   --ds-border        #454545 on #1e1e1e = 1.74:1  (internal tick rings, no
 *                                                    boundary semantics)
 * The light fallbacks measure 3.65:1 on the compass' #ffffff disc and 3.35:1
 * on the #f4f5f7 page background. It is deliberately NOT gated on
 * :root[data-darkmode="true"] - only some themes set that attribute (Argon
 * never does), so the view decides at runtime with isDarkMode() and appends
 * this string only when it applies.
 *
 * Sizes are em-based, never px: the LuCI theme sets the base font size, and
 * only a relative scale keeps the page in step with it.
 *
 * view/airoha_npu/status.js consumes this through view/airoha/ui.js; keeping
 * the values in one place prevents component styles from drifting apart.
 * ------------------------------------------------------------------------- */
return baseclass.extend({
	tokens: '--ds-surface:var(--surface,var(--color-bg-elevated,var(--background-color-high,#fff)));--ds-surface-sunken:var(--surface-sunken,var(--color-bg-secondary,var(--background-color-medium,#f6f8fa)));--ds-border:var(--hairline,var(--color-border,var(--border-color-low,#d8dee4)));--ds-border-strong:var(--hairline,var(--color-border,var(--border-color-medium,#7d8792)));--ds-text:var(--text,var(--color-text,var(--text-color-high,#1f2328)));--ds-text-muted:var(--text,var(--color-text,var(--text-color-low,#5c6773)));--ds-primary:var(--brand,var(--primary-color-high,#0969da));--ds-primary-text:var(--brand,var(--primary-color-high,#0969da));--ds-ok:#1a7f37;--ds-ok-tint:rgba(26,127,55,.08);--ds-ok-wash:rgba(26,127,55,.07);--ds-ok-line:rgba(26,127,55,.35);--ds-warn:#bc4c00;--ds-warn-tint:rgba(188,76,0,.08);--ds-warn-line:rgba(188,76,0,.35);--ds-error:#cf222e;--ds-error-tint:rgba(207,34,46,.08);--ds-error-line:rgba(207,34,46,.40);--ds-info:#0969da;--ds-info-tint:rgba(9,105,218,.08);--ds-info-line:rgba(9,105,218,.35);--ds-focus-ring:rgba(9,105,218,.32);--ds-band6-tint:rgba(124,58,237,.10);--ds-band6-line:rgba(124,58,237,.32);--ai-npu:#0e7490;--ai-cpu:#c2410c;--ai-load:#a16207;--ai-band-24:#b45309;--ai-band-5:#1d4ed8;--ai-band-6:#7c3aed;--ai-core-0:#1663d6;--ai-core-1:#e8590c;--ai-core-2:#2f9e44;--ai-core-3:#c2255c;--ds-mono:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",Menlo,monospace;--ds-r-sm:4px;--ds-r-md:6px;--ds-r-lg:8px;--ds-r-pill:999px;--ds-sp-1:.25em;--ds-sp-2:.5em;--ds-sp-3:.75em;--ds-sp-4:1em;--ds-sp-5:1.5em;--ds-fs-xs:.8em;--ds-fs-sm:.88em;--ds-fs-base:1em;--ds-fs-lg:1.1em;--ds-fs-xl:1.35em;--ds-fs-2xl:1.6em;--ds-shadow-1:0 1px 2px rgba(16,24,40,.04)',

	dark: ':root .airoha-page{--ds-surface:var(--surface,var(--color-bg-elevated,var(--background-color-high,#252526)));--ds-surface-sunken:var(--surface-sunken,var(--color-bg-secondary,var(--background-color-medium,#1e1e1e)));--ds-border:var(--hairline,var(--color-border,var(--border-color-low,#454545)));--ds-border-strong:var(--hairline,var(--color-border,var(--border-color-medium,#757575)));--ds-text:var(--text,var(--color-text,var(--text-color-high,#cccccc)));--ds-text-muted:var(--text,var(--color-text,var(--text-color-low,#adb5bd)));--ds-ok:#4ac26b;--ds-ok-tint:rgba(74,194,107,.18);--ds-ok-wash:rgba(74,194,107,.10);--ds-ok-line:rgba(74,194,107,.45);--ds-warn:#e3934a;--ds-warn-tint:rgba(227,147,74,.18);--ds-warn-line:rgba(227,147,74,.45);--ds-error:#f47067;--ds-error-tint:rgba(244,112,103,.18);--ds-error-line:rgba(244,112,103,.5);--ds-info:#4d9cf6;--ds-info-tint:rgba(77,156,246,.18);--ds-info-line:rgba(77,156,246,.45);--ds-focus-ring:rgba(77,156,246,.45);--ds-primary-text:var(--brand,var(--primary-color-high,#4d9cf6));--ds-band6-tint:rgba(124,58,237,.28);--ds-band6-line:rgba(124,58,237,.55);--ai-npu:#22d3ee;--ai-cpu:#fb923c;--ai-load:#fde047;--ai-band-24:#fbbf24;--ai-band-5:#60a5fa;--ai-band-6:#c4b5fd;--ai-core-0:#5aa9f8;--ai-core-1:#ff922b;--ai-core-2:#69db7c;--ai-core-3:#f06595;--ds-shadow-1:none}'
});
