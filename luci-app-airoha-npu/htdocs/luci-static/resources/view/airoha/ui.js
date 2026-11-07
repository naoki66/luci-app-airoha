'use strict';
'require baseclass';
'require view.airoha.ds-tokens as tokens';

/* ---------------------------------------------------------------------------
 * Shared UI kit for the unified Airoha status view.
 *
 * view/airoha_npu/status.js builds its DOM through this module so components,
 * dark-mode handling and layout helpers stay in one place.
 *
 * The kit is intentionally text-free: every user-visible string is passed in by
 * the caller, so all translatable msgids stay owned by the view file and
 * the gettext catalogue keeps a single, predictable source of truth.
 *
 * Layout follows the design reference: a `.airoha-page` token scope, an
 * auto-fit grid (so dropping the WiFi gauges on a radio-less board leaves no
 * gaps), one 720px breakpoint and data attributes (`data-on`, `data-blocked`)
 * instead of `:has()` selectors, which older LuCI browsers do not support.
 * ------------------------------------------------------------------------- */

var STYLE_ID = 'airoha-ds-css';

/* Band metadata shared by both tabs. `varName` points at the matching `--ai-*`
 * token so SVG/gauges can paint themselves with `var(--ai-band-*)`. */
var BANDS = [
	{ name: '2.4G', full: '2.4 GHz', varName: '--ai-band-24', maxMbps: 688 },
	{ name: '5G',   full: '5 GHz',   varName: '--ai-band-5',  maxMbps: 5765 },
	{ name: '6G',   full: '6 GHz',   varName: '--ai-band-6',  maxMbps: 11529 }
];

/* The `.ai-*` component stylesheet (section C of the design reference). Page
 * tokens come from ds-tokens.js and are prepended by ensureCss(). */
var COMPONENT_CSS = [
	/* Width policy mirrors the fancontrol views: the page root carries NO
	 * width rules at all — the layout inherits the theme's content width, so
	 * a late-injected stylesheet can never change the page's geometry (no
	 * width flash on first paint). */
	'.airoha-page{color:var(--ds-text);line-height:1.5}',
	'.airoha-page :focus-visible{outline:2px solid var(--ds-primary);outline-offset:1px}',

	'.ai-lede{margin:var(--ds-sp-1) 0 0;color:var(--ds-text-muted);font-size:var(--ds-fs-sm)}',
	'.ai-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ds-sp-2);margin:var(--ds-sp-3) 0}',
	'.ai-toolbar .ai-spacer{flex:1}',
	'.ai-updated{color:var(--ds-text-muted);font-size:var(--ds-fs-sm)}',

	/* Section titles are kept as tight as the in-body .ai-subhead labels
	 * ("Frame Engine" / "EIP93") so the five section headings (Ethernet Ports
	 * / CPU Frequency / NPU & Offload Engine / WiFi Band Details / PPE
	 * Entries) stop eating vertical space above their content. Argon ships a
	 * base `h3 { padding: 1rem 1.25rem }` for its own .cbi-section headings
	 * that also hit this title and kept it tall; override its padding here.
	 * The top gap and the divider-to-content gap use --ds-sp-3, the same
	 * distance the last content row keeps from the card border, the divider
	 * hugs the text, and the horizontal padding is 0 so the title lines up
	 * with the content instead of being inset by Argon's 1.25rem. */
	'.ai-section{margin:0 0 var(--ds-sp-5);padding:0 var(--ds-sp-4) var(--ds-sp-3);border:1px solid var(--ds-border);border-radius:var(--ds-r-lg);background:var(--ds-surface);box-shadow:var(--ds-shadow-1)}',
	'.ai-section-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ds-sp-2);margin:0 0 var(--ds-sp-3);padding:0;border-bottom:1px solid var(--ds-border)}',
	'.ai-section-head h3{margin:0;padding:var(--ds-sp-3) 0 .15em;font-size:var(--ds-fs-base);line-height:1.2;font-weight:650;color:var(--ds-text)}',
	'.ai-section-head .ai-spacer{flex:1}',
	'.ai-subhead{margin:var(--ds-sp-4) 0 var(--ds-sp-2);font-size:var(--ds-fs-base);font-weight:650}',
	'.ai-subhead:first-of-type{margin-top:0}',
	'.ai-hint{margin:0 0 var(--ds-sp-2);color:var(--ds-text-muted);font-size:var(--ds-fs-xs)}',

	'.ai-grid{display:grid;gap:var(--ds-sp-2)}',
	'.ai-grid--tiles{grid-template-columns:repeat(auto-fit,minmax(11.5em,1fr))}',
	'.ai-grid--2{grid-template-columns:repeat(auto-fit,minmax(20em,1fr))}',
	'.ai-grid--2>*{display:flex;flex-direction:column}',
	'.ai-grid--2 .ai-card{flex:1}',
	'.ai-grid--3{grid-template-columns:repeat(auto-fit,minmax(15em,1fr))}',
	'.ai-grid--4{grid-template-columns:repeat(auto-fit,minmax(12em,1fr))}',
	/* Port cards: the header carries a state pill plus the netdev name, so
	 * it has to be allowed to wrap before it can push the port name out. */
	/* The port table is the one wide element on the page (8 counters per port),
	 * so it scrolls horizontally inside its own card instead of wrapping cells
	 * into unreadable stacks. */
	'.ai-port-table .ai-table{min-width:980px}',
	'.ai-port-table .ai-table td{white-space:nowrap}',
	'.ai-grid--bands{grid-template-columns:repeat(auto-fit,minmax(7.5em,1fr))}',
	'.ai-spanall{grid-column:1/-1}',

	'.ai-tile{display:flex;flex-direction:column;justify-content:center;min-height:5.6em;min-width:0;padding:var(--ds-sp-2) var(--ds-sp-3);border:1px solid var(--ds-border);border-left:3px solid var(--ai-accent,var(--ds-border));border-radius:var(--ds-r-md);background:var(--ds-surface)}',
	'.ai-tile-title{font-size:var(--ds-fs-xs);font-weight:650;color:var(--ds-text-muted);margin-bottom:var(--ds-sp-1)}',
	'.ai-tile-value{font-family:var(--ds-mono);font-variant-numeric:tabular-nums;font-size:var(--ds-fs-xl);font-weight:700;line-height:1.15;color:var(--ai-accent,var(--ds-text))}',
	'.ai-tile-value .u{font-size:.7em;font-weight:600;color:var(--ds-text-muted);margin-left:.25em}',
	'.ai-tile-sub{margin-top:var(--ds-sp-1);font-size:var(--ds-fs-xs);color:var(--ds-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

	'.ai-card{min-width:0;padding:var(--ds-sp-3);border:1px solid var(--ds-border);border-left:3px solid var(--ai-accent,var(--ds-border));border-radius:var(--ds-r-md);background:var(--ds-surface)}',
	'.ai-card-title{display:flex;align-items:baseline;justify-content:space-between;gap:var(--ds-sp-2);margin:0 0 var(--ds-sp-2)}',
	'.ai-card-name{font-size:var(--ds-fs-base);font-weight:650;color:var(--ai-accent,var(--ds-text))}',
	'.ai-card-tag{font-size:var(--ds-fs-xs);color:var(--ds-text-muted);font-family:var(--ds-mono);text-align:right}',
	'.ai-card-body{font-size:var(--ds-fs-sm)}',
	/* A card whose body must reach the card's bottom edge (a bar stack that
	 * has to fill the height its neighbour forces on the row). */
	'.ai-card--fill{display:flex;flex-direction:column}',
	'.ai-card--fill .ai-card-body{flex:1;display:flex;flex-direction:column}',
	/* Extra height goes into the gaps between the bars, not into one lump
	 * above the footer - a stretched card then reads as a deliberate
	 * distribution instead of as missing content. */
	'.ai-bars-fill{flex:1;display:flex;flex-direction:column;justify-content:space-between}',
	'.ai-row{display:flex;align-items:center;justify-content:space-between;gap:var(--ds-sp-2)}',
	'.ai-row+.ai-row{margin-top:var(--ds-sp-1)}',
	'.ai-muted{color:var(--ds-text-muted)}',
	'.ai-num{font-family:var(--ds-mono);font-variant-numeric:tabular-nums;text-align:right}',
	'.ai-err{color:var(--ds-error);font-weight:650}',

	/* Series legend for multi-line charts: the colour key and the live value in
	 * one row, so a chart that draws several series needs no second table. */
	'.ai-legend{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ds-sp-1) var(--ds-sp-3);margin:0 0 var(--ds-sp-2)}',
	'.ai-legend-item{display:inline-flex;align-items:center;gap:var(--ds-sp-1);font-size:var(--ds-fs-xs);white-space:nowrap}',
	'.ai-legend-swatch{width:1.2em;height:2px;border-radius:var(--ds-r-sm);flex:0 0 auto}',
	'.ai-legend-label{font-family:var(--ds-mono);color:var(--ds-text-muted)}',
	'.ai-legend-value{font-family:var(--ds-mono);font-variant-numeric:tabular-nums;font-weight:650}',

	'.ai-kv{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--ds-border);border:1px solid var(--ds-border);border-radius:var(--ds-r-md);overflow:hidden}',
	'.ai-kv-item{display:flex;align-items:baseline;justify-content:space-between;gap:var(--ds-sp-2);padding:var(--ds-sp-2) var(--ds-sp-3);background:var(--ds-surface-sunken);font-size:var(--ds-fs-sm);min-width:0}',
	'.ai-kv-k{color:var(--ds-text-muted);white-space:nowrap}',
	'.ai-kv-v{font-family:var(--ds-mono);font-variant-numeric:tabular-nums;font-weight:650;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

	'.ai-pill{display:inline-flex;align-items:center;gap:var(--ds-sp-2);min-height:20px;padding:0 var(--ds-sp-2);border:1px solid var(--ds-border);border-radius:var(--ds-r-pill);background:var(--ds-surface-sunken);font-size:var(--ds-fs-xs);font-weight:650;color:var(--ds-text-muted);white-space:nowrap}',
	'.ai-pill .dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto}',
	/* A count makes the header a single, never-wrapping row: the pill keeps its
	 * intrinsic width and the title ellipsises instead of pushing it to a second
	 * line. Sections without a count keep the wrapping behaviour. */
	'.ai-section-head--tight{flex-wrap:nowrap}',
	'.ai-section-head--tight h3{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
	'.ai-section-head--tight .ai-pill{flex:0 0 auto}',
	'.ai-count{font-family:var(--ds-mono);font-variant-numeric:tabular-nums}',
	'.ai-pill--ok{color:var(--ds-ok);border-color:var(--ds-ok-line);background:var(--ds-ok-tint)}',
	'.ai-pill--warn{color:var(--ds-warn);border-color:var(--ds-warn-line);background:var(--ds-warn-tint)}',
	'.ai-pill--error{color:var(--ds-error);border-color:var(--ds-error-line);background:var(--ds-error-tint)}',
	'.ai-pill--info{color:var(--ds-info);border-color:var(--ds-info-line);background:var(--ds-info-tint)}',
	'.ai-badge{display:inline-flex;align-items:center;min-height:18px;padding:0 var(--ds-sp-2);border-radius:var(--ds-r-sm);background:var(--ds-surface-sunken);color:var(--ds-text-muted);font-family:var(--ds-mono);font-size:var(--ds-fs-xs);font-weight:650}',
	'.ai-badge--bnd{background:var(--ds-ok-tint);color:var(--ds-ok);border:1px solid var(--ds-ok-line)}',
	'.ai-badge--unb{background:var(--ds-warn-tint);color:var(--ds-warn);border:1px solid var(--ds-warn-line)}',
	'.ai-badge--v6{background:var(--ds-band6-tint);color:var(--ai-band-6);border:1px solid var(--ds-band6-line)}',

	'.ai-banner{display:flex;align-items:flex-start;gap:var(--ds-sp-2);margin:0 0 var(--ds-sp-2);padding:var(--ds-sp-2) var(--ds-sp-3);border:1px solid var(--ds-warn-line);border-left:3px solid var(--ds-warn);border-radius:var(--ds-r-md);background:var(--ds-warn-tint);color:var(--ds-warn);font-size:var(--ds-fs-sm)}',
	'.ai-banner--error{border-color:var(--ds-error-line);border-left-color:var(--ds-error);background:var(--ds-error-tint);color:var(--ds-error)}',
	'.ai-banner--info{border-color:var(--ds-info-line);border-left-color:var(--ds-info);background:var(--ds-info-tint);color:var(--ds-info)}',
	'.ai-banner-title{font-weight:650}',
	'.ai-banner-msg{color:var(--ds-text-muted);font-size:var(--ds-fs-xs);margin-top:2px}',
	'.ai-banner-kind{font-family:var(--ds-mono);font-size:var(--ds-fs-xs);font-weight:700;flex:0 0 auto}',

	'.ai-empty{display:flex;align-items:center;justify-content:center;min-height:5.5em;padding:var(--ds-sp-4);border:1px dashed var(--ds-border);border-radius:var(--ds-r-md);color:var(--ds-text-muted);font-size:var(--ds-fs-sm);text-align:center}',
	'.ai-error-state{border-style:solid;border-color:var(--ds-error-line);background:var(--ds-error-tint);color:var(--ds-error)}',
	'.ai-skeleton{height:1em;border-radius:var(--ds-r-sm);background:linear-gradient(90deg,var(--ds-surface-sunken) 25%,var(--ds-border) 45%,var(--ds-surface-sunken) 65%);background-size:300% 100%;animation:ai-shimmer 1.4s linear infinite}',
	'@keyframes ai-shimmer{0%{background-position:120% 0}100%{background-position:-20% 0}}',

	'.ai-bar{margin:var(--ds-sp-1) 0 0}',
	/* A stack of bars as a card body (one per CPU core) starts flush with the
	 * card title instead of hanging by a quarter em. */
	'.ai-bar:first-child{margin-top:0}',
	'.ai-bar-head{display:flex;align-items:baseline;justify-content:space-between;gap:var(--ds-sp-2);font-size:var(--ds-fs-xs);color:var(--ds-text-muted)}',
	'.ai-bar-track{position:relative;height:.5em;margin-top:var(--ds-sp-1);border-radius:var(--ds-r-sm);background:var(--ds-surface-sunken);border:1px solid var(--ds-border);overflow:hidden}',
	'.ai-bar-fill{position:absolute;left:0;top:0;bottom:0;border-radius:var(--ds-r-sm);background:var(--ai-accent,var(--ds-primary));background-image:linear-gradient(180deg,rgba(255,255,255,.32),rgba(255,255,255,0) 62%);transition:width .4s}',
	'.ai-bar-peak{position:absolute;left:0;top:0;bottom:0;background:var(--ai-accent,var(--ds-primary));opacity:.2;pointer-events:none;transition:width .4s}',
	'.ai-bar--pill .ai-bar-track,.ai-bar--pill .ai-bar-fill,.ai-bar--pill .ai-bar-peak{border-radius:999px}',
	/* A .5em track is already fully rounded at 4px, so the capsule shape only
	 * reads once the bar is thick enough to show its straight middle section. */
	'.ai-bar--pill .ai-bar-track{height:1em}',
	'.ai-bar--tall .ai-bar-head{font-size:var(--ds-fs-sm)}',
	'.ai-bar--tall .ai-bar-track{height:3.4em}',
	'.ai-bar--tall .ai-bar-label{font-size:var(--ds-fs-base)}',
	'.ai-bar-label{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:var(--ds-mono);font-weight:700;font-size:var(--ds-fs-sm);color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.6)}',

	'.ai-gauge-row{display:grid;justify-content:center;gap:var(--ds-sp-3);grid-template-columns:repeat(auto-fit,minmax(13.5em,22em))}',
	'.ai-gauge{min-width:0;display:flex;flex-direction:column;align-items:center}',
	'.ai-gauge svg{width:100%;max-width:22em;display:block}',
	'.ai-gauge-cap{margin-top:var(--ds-sp-1);font-size:var(--ds-fs-xs);color:var(--ds-text-muted);text-align:center;line-height:1.5}',
	'.ai-gauge-cap b{color:var(--ds-text);font-family:var(--ds-mono)}',
	'.g-lbl{font-size:11px;font-weight:700}',
	'.g-cap{font-size:10px;font-weight:700}',
	'.g-num{font-size:24px;font-weight:700}',
	'.g-med{font-size:13px;font-weight:700}',
	'.g-sm{font-size:9px;font-weight:600}',
	'.g-sub{font-size:10px;font-weight:600}',

	'.ai-switch-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:var(--ds-sp-3);min-height:3.4em;padding:var(--ds-sp-2) var(--ds-sp-3);border:1px solid var(--ds-border);border-left:3px solid var(--ds-ok);border-radius:var(--ds-r-md);background:var(--ds-surface)}',
	'.ai-switch-row[data-on="false"]{border-left-color:var(--ds-border-strong)}',
	'.ai-switch-row[data-blocked="true"]{border-left-color:var(--ds-warn);background:var(--ds-warn-tint)}',
	'.ai-switch-name{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ds-sp-2);min-width:0;font-size:var(--ds-fs-sm);font-weight:600}',
	'.ai-switch-note{color:var(--ds-text-muted);font-size:var(--ds-fs-xs);font-weight:400}',
	'.ai-switch-ctl{display:flex;align-items:center;gap:var(--ds-sp-3)}',
	'.ai-toggle{position:relative;display:inline-flex;width:44px;height:26px;flex:0 0 auto;cursor:pointer}',
	'.ai-toggle input{position:absolute;width:1px;height:1px;opacity:0;margin:0}',
	'.ai-toggle .track{position:absolute;inset:0;border:1px solid var(--ds-border-strong);border-radius:var(--ds-r-pill);background:var(--ds-surface-sunken);transition:background .2s,border-color .2s}',
	'.ai-toggle .track:before{content:"";position:absolute;width:20px;height:20px;left:2px;top:2px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.24);transition:transform .2s}',
	'.ai-toggle input:checked+.track{background:var(--ds-ok);border-color:var(--ds-ok)}',
	'.ai-toggle input:checked+.track:before{transform:translateX(18px)}',
	'.ai-toggle input:disabled+.track{opacity:.5}',
	'.ai-toggle input:focus-visible+.track{box-shadow:0 0 0 3px var(--ds-focus-ring)}',

	'.ai-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:var(--ds-sp-1);min-height:26px;padding:0 var(--ds-sp-3);border:1px solid var(--ds-border-strong);border-radius:var(--ds-r-sm);background:var(--ds-surface-sunken);color:var(--ds-text);font:inherit;font-size:var(--ds-fs-sm);font-weight:600;cursor:pointer}',
	'.ai-btn--primary{background:var(--ds-primary);border-color:var(--ds-primary);color:#fff}',
	'.ai-btn--active{background:var(--ds-warn);border-color:var(--ds-warn);color:#fff}',

	'.ai-form{display:flex;flex-wrap:wrap;align-items:center;gap:var(--ds-sp-4)}',
	'.ai-field{display:flex;align-items:center;gap:var(--ds-sp-2);min-width:12em;flex:1}',
	'.ai-field-label{font-size:var(--ds-fs-sm);font-weight:500;color:var(--ds-text-muted);white-space:nowrap}',
	'.ai-field select{flex:1;min-width:0}',

	'.ai-table-wrap{overflow:auto;border:1px solid var(--ds-border);border-radius:var(--ds-r-md);max-height:24em}',
	// Same accent rule the cards, tiles and switch rows use, so a table reads
	// as one of the page's single elements instead of a bare grid.
	'.ai-table-wrap--accent{border-left:3px solid var(--ai-accent,var(--ds-border))}',
	'.ai-table{width:100%;border-collapse:collapse;font-size:var(--ds-fs-sm)}',
	'.ai-table th{position:sticky;top:0;z-index:1;background:var(--ds-surface-sunken);color:var(--ds-text-muted);font-weight:650;text-align:left;white-space:nowrap;padding:var(--ds-sp-2) var(--ds-sp-2);border-bottom:1px solid var(--ds-border)}',
	'.ai-table td{padding:var(--ds-sp-1) var(--ds-sp-2);border-bottom:1px solid var(--ds-border);vertical-align:top;overflow-wrap:anywhere;word-break:break-word}',
	'.ai-table tr:last-child td{border-bottom:0}',
	'.ai-table .ai-num,.ai-table th.ai-num{text-align:right}',
	'.ai-table--mono td{font-family:var(--ds-mono);font-variant-numeric:tabular-nums;font-size:var(--ds-fs-xs)}',
	'.ai-table tbody tr:hover{background:var(--ds-surface-sunken)}',
	/* A BND flow is one the PPE is forwarding in hardware - the good case, and
	 * the one this table exists to show. It gets the whole row, not just the
	 * state badge: green wash, a solid green edge on the index cell, and a
	 * deeper wash on hover so the highlight survives the row hover. */
	'.ai-table tbody tr[data-state="BND"]{background:var(--ds-ok-wash,var(--ds-ok-tint))}',
	'.ai-table tbody tr[data-state="BND"]:hover{background:var(--ds-ok-line)}',
	'.ai-table tbody tr[data-state="BND"] td:first-child{box-shadow:inset 3px 0 0 var(--ds-ok)}',
	'.ai-table tbody tr[data-state="BND"] td{border-bottom-color:var(--ds-ok-line)}',
	'.ai-offload-controls .ai-switch-row{grid-template-columns:minmax(0,1fr) auto}',

	'.ai-details{border:1px solid var(--ds-border);border-radius:var(--ds-r-md);background:var(--ds-surface-sunken);padding:0 var(--ds-sp-3);margin-top:var(--ds-sp-3)}',
	'.ai-details>summary{cursor:pointer;padding:var(--ds-sp-2) 0;font-size:var(--ds-fs-sm);font-weight:650}',
	'.ai-details[open]{padding-bottom:var(--ds-sp-3)}',

	'.ai-console{border:1px solid var(--ds-border);border-left:3px solid var(--ai-npu);border-radius:var(--ds-r-md);background:var(--ds-surface);overflow:hidden}',
	'.ai-console-bar{display:flex;align-items:center;gap:var(--ds-sp-2);padding:var(--ds-sp-2) var(--ds-sp-3);background:var(--ds-surface-sunken);border-bottom:1px solid var(--ds-border)}',
	'.ai-console-bar .ai-spacer{flex:1}',
	'.ai-console-title{font-size:var(--ds-fs-sm);font-weight:650}',
	'.ai-console-body{padding:var(--ds-sp-3)}',
	'.ai-dot{width:7px;height:7px;border-radius:50%;background:var(--ai-npu);flex:0 0 auto;box-shadow:0 0 0 3px var(--ds-info-tint)}',
	'.ai-dot--live{animation:ai-pulse 1.6s ease-in-out infinite}',
	'@keyframes ai-pulse{0%,100%{opacity:.35}50%{opacity:1}}',

	'.ai-wifi-only[hidden]{display:none}',
	'.airoha-page[data-wifi="false"] .ai-wifi-only{display:none}',

	'@media (prefers-reduced-motion:reduce){.ai-skeleton,.ai-dot--live,.ai-bar-fill{animation:none;transition:none}}',

	/* The page title is a bare <h2> direct child of .cbi-map (the same
	 * convention the clients view and the other Airoha pages use), so the
	 * theme's map-title treatment - the tinted bar above the page - applies to
	 * it. It was previously wrapped in a header that forced background:
	 * transparent and lost that bar. Section (h3) titles still own their own
	 * look, so they stay transparent and the only tinted element is the page
	 * heading. */
	'.airoha-page > h2{margin:0 0 var(--ds-sp-4)}',
	'.airoha-page h3,.airoha-page .ai-lede{background:transparent;border:0;box-shadow:none;text-shadow:none}',
	'.airoha-page .ai-section-head h3{background:transparent}',

	'@media (max-width:720px){.ai-table--stack thead{display:none}.ai-table--stack,.ai-table--stack tbody,.ai-table--stack tr,.ai-table--stack td{display:block;width:100%}.ai-table--stack tr{padding:var(--ds-sp-2) 0;border-bottom:1px solid var(--ds-border)}.ai-table--stack td{border:0;padding:0}.ai-table--stack td:before{display:block;content:attr(data-label);color:var(--ds-text-muted);font-size:var(--ds-fs-xs);font-weight:650}.ai-kv,.ai-switch-row{grid-template-columns:1fr}}'
].join('\n');

/* ── Escaping / formatting helpers ─────────────────────────────────────────
 * SVG gauges are built as strings (they must be parsed as markup, not text)
 * so any interpolated user/board value goes through esc(). */

function esc(s) {
	return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) {
		return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
	});
}

function nf(n) {
	return (n === undefined || n === null || isNaN(n)) ? '—' : Number(n).toLocaleString('en-US');
}

function fmtK(n) {
	n = Number(n) || 0;
	if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
	if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
	return String(n);
}

function fmtFreq(khz) {
	return (!khz) ? 'N/A' : Math.round(khz / 1000) + ' MHz';
}

function fmtGiB(b) {
	var v = Number(b) || 0, g = v / 1073741824;
	return g >= 1 ? g.toFixed(1) + ' GiB' : (v / 1048576).toFixed(0) + ' MiB';
}

function fmtUptime(s) {
	s = Number(s) || 0;
	var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
	return (d ? d + 'd ' : '') + (d || h ? h + 'h ' : '') + m + 'm';
}

function fmtMbps(v) {
	v = Number(v) || 0;
	return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
}

function fmtPct(v, d) {
	return (Number(v) || 0).toFixed(d === undefined ? 1 : d) + '%';
}

function clampPct(v) {
	v = Number(v) || 0;
	return Math.max(0, Math.min(100, v));
}

/* ── Component builders (return DOM nodes; children may be strings/nodes) ── */

function tile(o) {
	o = o || {};
	var attrs = { 'class': 'ai-tile', 'style': '--ai-accent:' + (o.accent || 'var(--ds-border)') };
	if (o.id) attrs.id = o.id;
	return E('div', attrs, [
		E('div', { 'class': 'ai-tile-title' }, o.title),
		E('div', { 'class': 'ai-tile-value' }, [
			o.value,
			o.unit ? E('span', { 'class': 'u' }, o.unit) : null
		]),
		E('div', { 'class': 'ai-tile-sub', 'title': o.sub }, o.sub)
	]);
}

function section(o) {
	o = o || {};
	var attrs = { 'class': 'ai-section' };
	if (o.id) attrs.id = o.id;
	if (o.wifiOnly) attrs['data-wifi-only'] = '1';
	/* The count rides at the far right of the title bar as a capsule rather than
	 * a second line, so the header stays one row tall. */
	return E('section', attrs, [
		E('div', { 'class': 'ai-section-head' + (o.count ? ' ai-section-head--tight' : '') }, [
			E('h3', {}, o.title),
			E('span', { 'class': 'ai-spacer' }),
			o.count ? E('span', { 'class': 'ai-pill ai-count', 'id': o.countId || null }, o.count) : null,
			o.actions || null
		]),
		o.hint ? E('p', { 'class': 'ai-hint' }, o.hint) : null,
		o.body || null
	]);
}

function pill(text, kind) {
	return E('span', { 'class': 'ai-pill' + (kind ? ' ai-pill--' + kind : '') }, [
		E('span', { 'class': 'dot' }),
		text
	]);
}

function badge(text, kind) {
	return E('span', { 'class': 'ai-badge' + (kind ? ' ai-badge--' + kind : '') }, text);
}

function banner(kind, title, msg) {
	return E('div', { 'class': 'ai-banner' + (kind ? ' ai-banner--' + kind : '') }, [
		E('span', { 'class': 'ai-banner-kind' }, kind === 'error' ? '!!' : kind === 'info' ? 'i' : '!'),
		E('div', {}, [
			E('div', { 'class': 'ai-banner-title' }, title),
			E('div', { 'class': 'ai-banner-msg' }, msg)
		])
	]);
}

function bar(o) {
	o = o || {};
	var pct = clampPct(o.pct);
	var head = (o.title || o.right)
		? E('div', { 'class': 'ai-bar-head' }, [
			E('span', {}, o.title),
			E('span', { 'class': 'ai-num' }, o.right)
		])
		: null;
	var fillAttrs = { 'class': 'ai-bar-fill', 'style': 'width:' + pct.toFixed(1) + '%' };
	if (o.fillId) fillAttrs.id = o.fillId;
	var track = E('div', {
		'class': 'ai-bar-track', 'role': 'progressbar', 'aria-valuemin': '0',
		'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-label': o.title || ''
	}, [
		o.peak != null ? E('div', {
			'class': 'ai-bar-peak',
			'style': 'width:' + clampPct(o.peak).toFixed(1) + '%'
		}) : null,
		E('div', fillAttrs),
		o.label ? E('span', { 'class': 'ai-bar-label', 'id': o.labelId || null }, o.label) : null
	]);
	var attrs = { 'class': 'ai-bar' + (o.tall ? ' ai-bar--tall' : '') + (o.pill ? ' ai-bar--pill' : ''), 'style': '--ai-accent:' + (o.accent || 'var(--ds-primary)') };
	if (o.id) attrs.id = o.id;
	return E('div', attrs, [ head, track ]);
}

function kv(rows) {
	return E('div', { 'class': 'ai-kv' }, (rows || []).map(function(r) {
		var vAttrs = { 'class': 'ai-kv-v' };
		if (r[2]) vAttrs.style = 'color:' + r[2];
		return E('div', { 'class': 'ai-kv-item' }, [
			E('span', { 'class': 'ai-kv-k' }, r[0]),
			E('span', vAttrs, r[1])
		]);
	}));
}

function card(o) {
	o = o || {};
	var attrs = { 'class': 'ai-card' + (o.cls ? ' ' + o.cls : ''), 'style': '--ai-accent:' + (o.accent || 'var(--ds-border)') };
	if (o.id) attrs.id = o.id;
	return E('div', attrs, [
		E('div', { 'class': 'ai-card-title' }, [
			E('span', { 'class': 'ai-card-name' }, o.name),
			o.tag ? E('span', { 'class': 'ai-card-tag' }, o.tag) : null
		]),
		E('div', { 'class': 'ai-card-body' }, o.body || null)
	]);
}

function row(k, v, cls) {
	return E('div', { 'class': 'ai-row' }, [
		E('span', { 'class': 'ai-muted' }, k),
		E('span', { 'class': 'ai-num' + (cls ? ' ' + cls : '') }, v)
	]);
}

function empty(text, isError) {
	return E('div', { 'class': 'ai-empty' + (isError ? ' ai-error-state' : '') }, text);
}

/* Colour-keyed legend for a multi-series chart. `items` is an array of
 * { label, value, color, dashed }: `color` is any CSS colour (in practice a
 * var(--ai-*) token) and paints both the swatch and the value; `dashed` only
 * dims the swatch, mirroring how the reader draws a repeated-palette series. */
function legend(items) {
	return E('div', { 'class': 'ai-legend' }, (items || []).map(function(item) {
		var color = item.color || 'var(--ds-text-muted)';
		return E('div', { 'class': 'ai-legend-item' }, [
			E('span', {
				'class': 'ai-legend-swatch',
				'style': 'background:' + color + (item.dashed ? ';opacity:.55' : '')
			}),
			E('span', { 'class': 'ai-legend-label' }, item.label),
			E('span', { 'class': 'ai-legend-value', 'style': 'color:' + color }, item.value)
		]);
	}));
}

function details(title, body) {
	return E('details', { 'class': 'ai-details' }, [
		E('summary', {}, title),
		body
	]);
}

function table(o) {
	o = o || {};
	var cols = o.cols || [];
	var rows = o.rows || [];
	var headRow = E('tr', {}, cols.map(function(c) {
		return E('th', { 'class': c.num ? 'ai-num' : null, 'scope': 'col' }, c.t);
	}));
	var bodyRows;
	if (rows.length) {
		bodyRows = rows.map(function(r) {
			return E('tr', {}, r.map(function(cell, i) {
				var attrs = {};
				if (cols[i] && cols[i].num) attrs['class'] = 'ai-num';
				if (o.stack && cols[i]) attrs['data-label'] = cols[i].t;
				return E('td', attrs, cell);
			}));
		});
	} else {
		bodyRows = [ E('tr', {}, [ E('td', { 'colspan': String(cols.length) }, empty(o.emptyText || '')) ]) ];
	}
	var wrapAttrs = {
		'class': 'ai-table-wrap' + (o.accent ? ' ai-table-wrap--accent' : '')
	};
	if (o.accent) wrapAttrs.style = '--ai-accent:' + o.accent;
	return E('div', wrapAttrs, [
		E('table', { 'class': 'ai-table' + (o.mono ? ' ai-table--mono' : '') + (o.stack ? ' ai-table--stack' : '') }, [
			E('thead', {}, headRow),
			E('tbody', {}, bodyRows)
		])
	]);
}

/* An offload switch row. Live state is driven by the caller via the returned
 * ids: `inputId` is the checkbox, `badgeId` is the state pill, `rowId` is the
 * row itself (its data-on / data-blocked attributes drive the accent). */
function switchState(o) {
	if (o.blocked) return { kind: 'warn', text: o.blockedLabel || '' };
	if (o.on) return { kind: 'ok', text: o.onLabel || '' };
	return { kind: '', text: o.offLabel || '' };
}

function switchRow(o) {
	o = o || {};
	var state = switchState(o);
	var name = E('div', { 'class': 'ai-switch-name' }, [
		E('span', {}, o.name),
		E('span', { 'class': 'ai-pill' + (state.kind ? ' ai-pill--' + state.kind : ''), 'id': o.badgeId }, [
			E('span', { 'class': 'dot' }),
			state.text
		]),
		o.note ? E('span', { 'class': 'ai-switch-note' }, o.note) : null
	]);
	var inputAttrs = {
		'id': o.inputId, 'type': 'checkbox', 'class': 'ai-toggle-input'
	};
	if (o.on) inputAttrs.checked = '';
	if (o.blocked && !o.on) inputAttrs.disabled = '';
	var input = E('input', inputAttrs);
	input.checked = !!o.on;
	input.disabled = !!(o.blocked && !o.on);
	input.setAttribute('data-blocked', o.blocked ? '1' : '0');
	if (typeof o.onChange === 'function')
		input.addEventListener('change', function(ev) { o.onChange(ev.target); });
	var ctl = E('div', { 'class': 'ai-switch-ctl' }, [
		E('label', { 'class': 'ai-toggle', 'title': o.title || '' }, [ input, E('span', { 'class': 'track' }) ])
	]);
	return E('div', { 'class': 'ai-switch-row', 'id': o.rowId || null, 'data-on': o.on ? 'true' : 'false', 'data-blocked': o.blocked ? 'true' : 'false' }, [ name, ctl ]);
}

/* Build a gauge wrapper: an `.ai-gauge` holding the SVG string plus a caption
 * built from an array of strings / DOM nodes. */
function gauge(svgHtml, cap, id) {
	var wrap = E('div', { 'class': 'ai-gauge' });
	if (id) wrap.id = id;
	wrap.innerHTML = svgHtml;
	var capEl = E('div', { 'class': 'ai-gauge-cap' });
	var parts = Array.isArray(cap) ? cap : (cap == null ? [] : [ cap ]);
	parts.forEach(function(part) {
		if (part == null) return;
		capEl.appendChild(typeof part === 'string' ? document.createTextNode(part) : part);
	});
	wrap.appendChild(capEl);
	return wrap;
}

/* ── Wireless presence (authoritative when the backend reports it) ──────────
 * Priority: backend `has_wifi` → live bands → `available === false` → fail open.
 * Fail-open matters: a single failed RPC must never make a radio-equipped
 * board look radio-less and silently drop its gauges. */
function hasWifiRadio(o) {
	o = o || {};
	if (typeof o.has_wifi === 'boolean') return o.has_wifi;
	if (Array.isArray(o.bands) && o.bands.length > 0) return true;
	if (o.available === false) return false;
	return true;
}

/* ── Dark-mode probe ───────────────────────────────────────────────────────
 * Prefer explicit theme state, then inspect the rendered page background and
 * finally fall back to an active dark stylesheet or the OS preference. */
function isDarkMode() {
	var root = document.documentElement;
	var auroraMode = root ? String(root.getAttribute('data-darkmode') || '').toLowerCase() : '';
	if (auroraMode === 'true') return true;
	if (auroraMode === 'false') return false;

	var glassMode = root ? String(root.getAttribute('data-theme') || '').toLowerCase() : '';
	if (glassMode === 'dark') return true;
	if (glassMode === 'light') return false;

	/* Probe order matters: the first element with an opaque background wins.
	 * - body / html carry the theme background in modern LuCI themes.
	 * - .main-right and the content wrappers carry the rendered page surface.
	 * - .main-left is Argon's sidebar: var(--menu-bg-color) (#ffffff) when
	 *   light, #333333 when dark. It is the only other always-opaque surface
	 *   Argon has, and it matters because Argon inlines css/dark.css into a
	 *   <style> block (header.ut readfile()) instead of linking it, so the
	 *   stylesheet fallback below can never match Argon.
	 * header is deliberately NOT probed: Argon paints it with var(--primary)
	 * (#5e72e4, luminance ~121), which would read as dark in light mode. */
	var els = [document.body, root, document.querySelector('.main-right'), document.querySelector('.main-content'),
		document.querySelector('#maincontent'), document.querySelector('.cbi-map'), document.querySelector('.main-left')];
	for (var i = 0; i < els.length; i++) {
		if (!els[i]) continue;
		/* Parse rgb()/rgba() explicitly. Matching with /\d+/g splits the
		 * fractional alpha 0.6 into "0" and "6", so m[3] reads 0 and every
		 * semi-transparent background is mistaken for a fully transparent one
		 * and skipped - semi-transparent dark surfaces then fell through to the
		 * stylesheet fallback and were reported as light. */
		var bg = window.getComputedStyle(els[i]).backgroundColor;
		var m = bg.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?/i);
		if (m) {
			var a = m[4] === undefined ? 1 : parseFloat(m[4]);
			if (a < 0.1) continue;
			var lum = (parseFloat(m[1]) * 299 + parseFloat(m[2]) * 587 + parseFloat(m[3]) * 114) / 1000;
			return lum < 128;
		}
	}
	var sheets = document.querySelectorAll('link[rel~="stylesheet"][href], style[id]');
	for (var j = 0; j < sheets.length; j++) {
		var sheet = sheets[j];
		var marker = String(sheet.getAttribute('href') || sheet.getAttribute('id') || '').toLowerCase();
		if (marker.indexOf('dark') < 0)
			continue;
		if (sheet.disabled || (sheet.sheet && sheet.sheet.disabled))
			continue;

		var media = String(sheet.getAttribute('media') ||
			(sheet.sheet && sheet.sheet.media ? sheet.sheet.media.mediaText : '') || '').trim();
		if (!media || media.toLowerCase() === 'all')
			return true;
		try {
			if (window.matchMedia && window.matchMedia(media).matches)
				return true;
		} catch (e) {}
	}
	/* Last resort: follow the OS preference. This is exactly what Argon's
	 * default mode='normal' does - it wraps the inlined dark.css in
	 * @media (prefers-color-scheme: dark) - and it also covers any theme that
	 * leaves every probed surface transparent. */
	try {
		if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return true;
	} catch (e) {}
	return false;
}

/* ── Stylesheet injection ──────────────────────────────────────────────────
 * One shared <style> node per document, holding the page token scope, its
 * dark-mode re-tune and the component rules. cssText() rebuilds that body from
 * scratch so the re-tune always reflects the current probe: tokens.dark has to
 * be appended *after* the `.airoha-page` scope and can never be merged into it,
 * because it carries the concrete dark surfaces/text the theme lookup cannot
 * provide on Argon (see ds-tokens.js).
 *
 * The re-tune is gated by the runtime isDarkMode() probe (see above), not by a
 * CSS attribute selector, so it applies on Argon too - and it is re-evaluated
 * when the OS colour scheme flips: with Argon's default mode='normal' the dark
 * palette is delivered inside `@media (prefers-color-scheme: dark)`, so a user
 * who switches their system theme expects the page to follow without a reload.
 *
 * ensureCss() stays idempotent - the getElementById hit returns the existing
 * node untouched - so the listener below is registered exactly once per
 * document, however often the view re-renders. */
function cssText() {
	return '.airoha-page{' + tokens.tokens + ';line-height:1.5;color:var(--ds-text)}\n'
		+ (isDarkMode() ? tokens.dark + '\n' : '') + COMPONENT_CSS;
}

function ensureCss() {
	var el = document.getElementById(STYLE_ID);
	if (el) return el;
	el = document.createElement('style');
	el.id = STYLE_ID;
	el.textContent = cssText();
	document.head.appendChild(el);
	try {
		var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
		if (mq && mq.addEventListener) {
			mq.addEventListener('change', function() {
				var node = document.getElementById(STYLE_ID);
				if (node) node.textContent = cssText();
			});
		}
	} catch (e) {}
	return el;
}

function bandColor(band) {
	var info = BANDS[band];
	return info ? 'var(' + info.varName + ')' : 'var(--ds-text-muted)';
}

return baseclass.extend({
	CSS: COMPONENT_CSS,
	BANDS: BANDS,
	ensureCss: ensureCss,
	isDarkMode: isDarkMode,
	hasWifiRadio: hasWifiRadio,
	bandColor: bandColor,
	esc: esc,
	nf: nf,
	fmtK: fmtK,
	fmtFreq: fmtFreq,
	fmtGiB: fmtGiB,
	fmtUptime: fmtUptime,
	fmtMbps: fmtMbps,
	fmtPct: fmtPct,
	clampPct: clampPct,
	tile: tile,
	section: section,
	pill: pill,
	badge: badge,
	banner: banner,
	bar: bar,
	kv: kv,
	card: card,
	row: row,
	empty: empty,
	legend: legend,
	details: details,
	table: table,
	switchRow: switchRow,
	gauge: gauge
});
