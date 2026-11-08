'use strict';
'require baseclass';

/*
 * Shared design system for the two fan-control views (status, settings).
 *
 * Both views used to carry their own copy of isDarkMode()/injectCSS() and wrote
 * the same four names (--fan-card-bg / --fan-border / --fan-muted / --fan-text)
 * into :root through two different <style> elements. LuCI keeps both views in
 * one document, so the last injection won and any future change to one palette
 * silently recoloured the other page. Everything now lives here once: the
 * tokens are scoped to .fan-app, the dark re-tune is appended as a second rule
 * with higher specificity (same trick as view/meshconf/ds-tokens.js), and the
 * runtime appearance probe is registered once per document.
 *
 * Colour is split into two jobs. Decorative accents (3px card rails, progress
 * fills, chart strokes, icon strokes) and *text* accents used to be the same
 * neon values. Measured on the light #fff surface those were #00c8ff 1.96:1,
 * #00cc44 2.16:1, #f5a623 2.03:1 and #f97316 2.80:1 - below even the 3:1
 * large-text bar. On the dark #1e1e1e surface the warning red #d0021b measured
 * 2.94:1. The replacement ramps are dark tints on light surfaces and light
 * tints on dark surfaces; every one clears 4.5:1 on its own surface:
 *
 *   light  info #0969da 5.19:1  ok #1a7f37 5.08:1  warn #9a6700 4.87:1
 *          hot  #bc4c00 5.04:1  err #cf222e 5.35:1  custom #6f42c1 6.51:1
 *   dark   info #4d9cf6 5.87:1  ok #4ac26b 7.32:1  warn #e3934a 6.77:1
 *          hot  #f0883e 6.59:1  err #f47067 5.84:1  custom #c297ff >7:1
 *
 * Numerical readouts therefore use --fan-text (neutral), while the semantic
 * ramp only ever colours rails, fills, icons and short status labels. That
 * also fixes the WCAG 1.4.1 issue: every temperature card now carries a text
 * level beside its colour.
 *
 * Charts deliberately do NOT use the semantic ramp. Four trend/curve lines in
 * green/blue/red/purple read as a debug plot and imply health meanings the
 * data does not have. One data hue (--fan-series) marks the focused series, a
 * tinted neutral (--fan-series-idle) recedes into comparison lines, and a
 * warm accent (--fan-series-preview) marks the unsaved custom curve.
 *
 * Thresholds are the inclusive upper bound of each band: <=45 Normal,
 * 45-60 Warm, 60-75 Hot, >75 Critical. The gauge ticks, the level labels and
 * the health badge all read this same table, so a 62 C sensor can never be
 * "Hot" on one card and "Warm" on another.
 *
 * The module is a class factory because LuCI's require() instantiates what a
 * module returns (new _class()), so plain object literals are not usable here.
 */

var THRESHOLDS = [ 45, 60, 75 ];

var ICONS = {
	fan: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M12 10V4M14 13l5 3M10 13l-5 3"/>',
	pwm: '<path d="M3 12h18M7 8v8M12 5v14M17 9v6"/>',
	mode: '<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="17" r="2"/>',
	curve: '<path d="M3 18c4 0 5-12 9-12s5 8 9 8"/><circle cx="3" cy="18" r="1.5"/><circle cx="12" cy="6" r="1.5"/><circle cx="21" cy="14" r="1.5"/>'
};

/* Light palette + size/type tokens, declared on the page root only. */
var LIGHT = `
--fan-surface:#fff;
--fan-surface-2:#f7f9fb;
--fan-canvas:#fbfcfd;
--fan-track:#e9edf2;
--fan-border:#d8dee6;
--fan-text:#1f2328;
--fan-muted:#5c6773;
--fan-shadow:rgba(40,65,90,.08);
--fan-grid:rgba(80,90,100,.18);
--fan-axis:#555;
--fan-info:#0969da;--fan-info-tint:rgba(9,105,218,.10);--fan-info-soft:rgba(9,105,218,.14);
--fan-ok:#1a7f37;--fan-ok-tint:rgba(26,127,55,.10);--fan-ok-soft:rgba(26,127,55,.16);
--fan-warn:#9a6700;--fan-warn-tint:rgba(154,103,0,.10);--fan-warn-soft:rgba(154,103,0,.14);
--fan-hot:#bc4c00;--fan-hot-tint:rgba(188,76,0,.10);--fan-hot-soft:rgba(188,76,0,.14);
--fan-error:#cf222e;--fan-error-tint:rgba(207,34,46,.10);--fan-error-soft:rgba(207,34,46,.14);
--fan-custom:#6f42c1;--fan-custom-tint:rgba(111,66,193,.10);
--fan-series:#0f766e;--fan-series-soft:rgba(15,118,110,.18);--fan-series-fade:rgba(15,118,110,0);
--fan-series-idle:#94a3b8;--fan-series-preview:#b45309;
--fan-series-preview-soft:rgba(180,83,9,.18);--fan-series-preview-fade:rgba(180,83,9,0);
--fan-r-card:12px;--fan-r-md:8px;--fan-r-sm:6px;--fan-r-pill:999px;
--fan-gap:12px;--fan-gap-sm:8px;
--fan-sp-1:4px;--fan-sp-2:8px;--fan-sp-3:12px;--fan-sp-4:16px;--fan-sp-6:24px;
--fan-font-ui:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif;
--fan-font-mono:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",Menlo,monospace`;

/* Appended only while the runtime probe says dark. :root .fan-app beats the
 * .fan-app rule above regardless of stylesheet order. */
var DARK = `
:root .fan-app{
--fan-surface:#1e1e1e;
--fan-surface-2:#252526;
--fan-canvas:#191919;
--fan-track:#333;
--fan-border:#454545;
--fan-text:#ececec;
--fan-muted:#adb5bd;
--fan-shadow:rgba(0,0,0,.24);
--fan-grid:rgba(255,255,255,.14);
--fan-axis:#b5b5b5;
--fan-info:#4d9cf6;--fan-info-tint:rgba(77,156,246,.18);--fan-info-soft:rgba(77,156,246,.18);
--fan-ok:#4ac26b;--fan-ok-tint:rgba(74,194,107,.18);--fan-ok-soft:rgba(74,194,107,.20);
--fan-warn:#e3934a;--fan-warn-tint:rgba(227,147,74,.18);--fan-warn-soft:rgba(227,147,74,.18);
--fan-hot:#f0883e;--fan-hot-tint:rgba(240,136,62,.18);--fan-hot-soft:rgba(240,136,62,.18);
--fan-error:#f47067;--fan-error-tint:rgba(244,112,103,.18);--fan-error-soft:rgba(244,112,103,.20);
--fan-custom:#c297ff;--fan-custom-tint:rgba(194,151,255,.18);
--fan-series:#2dd4bf;--fan-series-soft:rgba(45,212,191,.22);--fan-series-fade:rgba(45,212,191,0);
--fan-series-idle:#64748b;--fan-series-preview:#fbbf24;
--fan-series-preview-soft:rgba(251,191,36,.20);--fan-series-preview-fade:rgba(251,191,36,0);
}`;

var COMPONENT_CSS = `
.fan-app{box-sizing:border-box;max-width:1180px;margin:0 auto;padding:0 0 var(--fan-sp-6);font-family:var(--fan-font-ui);font-size:13px;line-height:1.5;color:var(--fan-text);-webkit-font-smoothing:antialiased}
.fan-app *,.fan-app *:before,.fan-app *:after{box-sizing:border-box}
/* Argon 3.1 styles bare h2/h3 as raised card headers (padding, surface
 * background, radius, shadow). Our panels draw their own flat titles, so
 * strip the theme card chrome first; the classes below restyle. */
.fan-app h2,.fan-app h3{margin:0;padding:0;background:none;border:0;border-radius:0;box-shadow:none;display:block;width:auto;font-family:var(--fan-font-ui)}
.fan-app h2,.fan-app h3,.fan-app .cbi-button,.fan-app input,.fan-app select{font-family:var(--fan-font-ui)}
.fan-app :focus-visible{outline:2px solid var(--fan-info);outline-offset:2px}
.fan-app .cbi-value-field input:focus-visible,.fan-app .cbi-value-field select:focus-visible{outline:0;box-shadow:0 0 0 3px var(--fan-info-soft)}
.fan-app .cbi-button:focus-visible{outline:2px solid var(--fan-info);outline-offset:2px}
.fan-summary-card,.fan-chart-card,.fan-temp-card{transition:border-color .18s,box-shadow .18s}
.fan-summary-card:hover,.fan-chart-card:hover,.fan-temp-card:hover{box-shadow:0 3px 12px var(--fan-shadow)}
.fan-panel-title{letter-spacing:.01em}
.fan-app [data-level="series"]{--fan-level:var(--fan-series);--fan-level-tint:var(--fan-series-soft);--fan-level-soft:var(--fan-series-soft)}
.fan-app [data-level="info"]{--fan-level:var(--fan-info);--fan-level-tint:var(--fan-info-tint);--fan-level-soft:var(--fan-info-soft)}
.fan-app [data-level="ok"]{--fan-level:var(--fan-ok);--fan-level-tint:var(--fan-ok-tint);--fan-level-soft:var(--fan-ok-soft)}
.fan-app [data-level="warn"]{--fan-level:var(--fan-warn);--fan-level-tint:var(--fan-warn-tint);--fan-level-soft:var(--fan-warn-soft)}
.fan-app [data-level="hot"]{--fan-level:var(--fan-hot);--fan-level-tint:var(--fan-hot-tint);--fan-level-soft:var(--fan-hot-soft)}
.fan-app [data-level="error"]{--fan-level:var(--fan-error);--fan-level-tint:var(--fan-error-tint);--fan-level-soft:var(--fan-error-soft)}
.fan-app [data-level="custom"]{--fan-level:var(--fan-custom);--fan-level-tint:var(--fan-custom-tint);--fan-level-soft:var(--fan-custom-tint)}
.fan-app [data-level="none"]{--fan-level:var(--fan-muted);--fan-level-tint:var(--fan-track);--fan-level-soft:var(--fan-grid)}

.fan-app-header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:var(--fan-sp-2);margin:0 0 var(--fan-sp-4);padding:9px var(--fan-sp-4);background:var(--fan-surface-2);border:1px solid var(--fan-border);border-radius:var(--fan-r-md)}
.fan-app-meta{display:flex;align-items:center;flex-wrap:wrap;gap:var(--fan-sp-2);font-size:12px;color:var(--fan-muted)}
/* The merged page has no tab strip to carry its name, so the header owns a
 * real title row: icon + page name, the freshness indicator beside it and the
 * context chips on the right. */
.fan-app-title{display:flex;align-items:center;flex-wrap:wrap;gap:10px;min-width:0}
.fan-app-title .fan-icon{width:28px;height:28px;border-radius:var(--fan-r-md)}
.fan-app-title .fan-icon svg{width:17px;height:17px}
.fan-app-title-text{font-size:16px;font-weight:600;line-height:1.3;color:var(--fan-text);white-space:nowrap}
.fan-app-title .fan-live,.fan-app-title .fan-app-meta{font-size:12px;color:var(--fan-muted)}
.fan-context-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.fan-context-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border:1px solid var(--fan-border);border-radius:var(--fan-r-pill);background:var(--fan-surface);font-size:11px;font-weight:500;color:var(--fan-text);white-space:nowrap}
.fan-context-chip:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--fan-info);flex:none}
.fan-context-chip[data-level="warn"]:before{background:var(--fan-warn)}
.fan-context-chip[data-level="none"]:before{background:var(--fan-muted)}
/* Only the board-temperature chip carries the temperature ramp. Preset and
 * mode chips stay informational, so the status view keeps its old dots. */
.fan-chip-temp[data-level="ok"]:before{background:var(--fan-ok)}
.fan-chip-temp[data-level="hot"]:before{background:var(--fan-hot)}
.fan-chip-temp[data-level="error"]:before{background:var(--fan-error)}
.fan-context-chip[data-level="custom"]:before{background:var(--fan-custom)}
.fan-live{display:inline-flex;align-items:center;gap:6px}
.fan-live-dot{width:8px;height:8px;border-radius:50%;background:var(--fan-ok);flex:none}
.fan-live-dot[data-state="stale"]{background:var(--fan-error)}
.fan-live-dot[data-state="pending"]{background:var(--fan-muted)}

/* One row combining the editable mode choice with the running-config
 * summary cards: segmented control first, then the four cards. */
.fan-overview-grid{display:grid;grid-template-columns:minmax(150px,.85fr) repeat(4,minmax(0,1fr));gap:var(--fan-gap);align-items:stretch}
.fan-mode-cell{display:flex;align-items:center;justify-content:center;padding:var(--fan-sp-2) var(--fan-sp-3);background:var(--fan-surface-2);border:1px solid var(--fan-border);border-left:3px solid var(--fan-level);border-radius:var(--fan-r-md);min-width:0}
.fan-seg{display:flex;gap:3px;width:100%;padding:3px;background:var(--fan-track);border-radius:var(--fan-r-md)}
.fan-seg-btn{flex:1;min-width:0;min-height:32px;padding:0 10px;border:0;border-radius:calc(var(--fan-r-md) - 2px);background:transparent;color:var(--fan-muted);font:inherit;font-size:13px;font-weight:500;line-height:1.3;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .16s,color .16s,box-shadow .16s}
.fan-seg-btn:hover{color:var(--fan-text)}
.fan-seg-btn.is-on{background:var(--fan-surface);color:var(--fan-level);box-shadow:0 1px 4px var(--fan-shadow)}
.fan-seg-btn:focus-visible{outline:2px solid var(--fan-info);outline-offset:1px}
.fan-summary-card{position:relative;background:var(--fan-surface);border:1px solid var(--fan-border);border-left:3px solid var(--fan-level);border-radius:var(--fan-r-card);padding:var(--fan-sp-3) var(--fan-sp-4);min-height:104px;display:flex;flex-direction:column;gap:5px;min-width:0}
.fan-card-top{display:flex;align-items:center;gap:var(--fan-sp-2);min-height:22px}
.fan-icon{width:22px;height:22px;border-radius:var(--fan-r-sm);background:var(--fan-level-tint);display:inline-flex;align-items:center;justify-content:center;flex:none}
.fan-icon svg{width:14px;height:14px;fill:none;stroke:var(--fan-level);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.fan-card-title{font-size:12px;font-weight:500;letter-spacing:.02em;color:var(--fan-muted);line-height:1.35}
.fan-card-value{font-size:24px;line-height:1.15;font-family:var(--fan-font-mono);font-variant-numeric:tabular-nums;font-weight:500;color:var(--fan-text)}
.fan-card-unit{font-family:var(--fan-font-ui);font-size:12px;font-weight:400;color:var(--fan-muted);margin-left:5px}
.fan-card-sub{font-size:12px;line-height:1.4;color:var(--fan-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fan-badge{margin-left:auto;flex:none;font-size:11px;line-height:1.4;padding:2px 8px;border-radius:var(--fan-r-pill);background:var(--fan-level-tint);color:var(--fan-level);font-weight:500}

.fan-panel{background:var(--fan-surface);border:1px solid var(--fan-border);border-radius:var(--fan-r-card);padding:var(--fan-sp-4);margin:var(--fan-gap) 0}
.fan-panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:var(--fan-sp-2);padding:0 0 var(--fan-sp-2);margin:0 0 var(--fan-sp-3);border-bottom:1px solid var(--fan-border)}
.fan-panel-title{font-size:16px;line-height:1.4;font-weight:500;color:var(--fan-text)}
.fan-panel-hint{font-size:12px;color:var(--fan-muted)}

.fan-chart-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--fan-gap)}
.fan-chart-card{background:var(--fan-surface-2);border:1px solid var(--fan-border);border-left:3px solid var(--fan-level);border-radius:var(--fan-r-md);padding:var(--fan-sp-3);min-width:0}
.fan-chart-value{font-size:20px;font-family:var(--fan-font-mono);font-variant-numeric:tabular-nums;font-weight:500;line-height:1.2;color:var(--fan-text)}
.fan-chart-frame{position:relative;margin-top:var(--fan-sp-2)}
.fan-chart-canvas{display:block;width:100%;height:120px;color:var(--fan-muted);background:var(--fan-canvas);border:1px solid var(--fan-border);border-radius:var(--fan-r-sm)}
.fan-chart-empty{position:absolute;inset:0;display:none;align-items:center;justify-content:center;font-size:12px;color:var(--fan-muted);pointer-events:none}
.fan-chart-empty.is-visible{display:flex}
.fan-chart-tip{position:absolute;z-index:2;top:6px;left:0;display:none;padding:5px 8px;border:1px solid var(--fan-border);border-radius:var(--fan-r-sm);background:var(--fan-surface);color:var(--fan-text);font-family:var(--fan-font-mono);font-size:11px;white-space:nowrap;pointer-events:none;box-shadow:0 2px 8px var(--fan-shadow)}
.fan-chart-tip.is-visible{display:block}
.fan-chart-legend{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:11px;color:var(--fan-muted)}
.fan-chart-swatch{width:10px;height:10px;border-radius:2px;background:var(--fan-level);flex:none}

/* Board sensor leads the panel on its own full-width row. */
.fan-temp-hero{margin:0 0 var(--fan-gap-sm)}
.fan-temp-card--hero .fan-temp-label{font-size:14px;font-weight:500}
.fan-temp-card--hero .fan-temp-value{font-size:20px}
.fan-temp-card--hero .fan-temp-track{height:14px}
.fan-temp-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--fan-sp-4)}
.fan-temp-group{min-width:0}
.fan-temp-group-title{font-size:12px;font-weight:500;letter-spacing:.02em;color:var(--fan-muted);margin:0 0 var(--fan-sp-2)}
.fan-temp-list{display:grid;gap:var(--fan-gap-sm)}
.fan-temp-card{background:var(--fan-surface-2);border:1px solid var(--fan-border);border-left:3px solid var(--fan-level);border-radius:var(--fan-r-md);padding:var(--fan-sp-2) var(--fan-sp-3);min-width:0}
.fan-temp-row{display:flex;align-items:baseline;justify-content:space-between;gap:var(--fan-sp-2);margin-bottom:6px}
.fan-temp-label{font-size:13px;line-height:1.4;color:var(--fan-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fan-temp-reading{display:inline-flex;align-items:baseline;gap:7px;white-space:nowrap}
.fan-temp-level{font-size:11px;color:var(--fan-level)}
.fan-temp-value{font-family:var(--fan-font-mono);font-size:16px;font-variant-numeric:tabular-nums;font-weight:500;color:var(--fan-text)}
.fan-temp-track{position:relative;height:12px;border-radius:var(--fan-r-pill);overflow:hidden;background:var(--fan-track)}
.fan-temp-fill{height:100%;border-radius:inherit;background:var(--fan-level);transition:width .3s,background .3s}
/* Threshold marks live OUTSIDE the bar: a 3px hairline in the gap under the
 * track. Inside-bar surface-coloured ticks cut the fill into segments and
 * read as gaps in the measurement, so the fill is kept as one shape. */
.fan-temp-scale{position:relative;height:15px;margin-top:4px;font-size:11px;font-family:var(--fan-font-mono);color:var(--fan-muted)}
.fan-temp-scale span{position:absolute;top:0;transform:translateX(-50%);white-space:nowrap}
.fan-temp-scale span[data-level="warn"]{color:var(--fan-warn);font-weight:500}
.fan-temp-scale span[data-level="hot"]{color:var(--fan-hot);font-weight:500}
.fan-temp-scale span[data-level="error"]{color:var(--fan-error);font-weight:500}
.fan-temp-scale span[data-level]:before{content:"";position:absolute;top:-4px;left:50%;width:1px;height:3px;background:currentColor;transform:translateX(-50%);opacity:.75}
.fan-temp-legend{display:flex;align-items:center;flex-wrap:wrap;gap:4px 14px;font-size:11px;color:var(--fan-muted)}
.fan-temp-legend-item{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.fan-temp-legend-dot{width:8px;height:8px;border-radius:2px;background:var(--fan-level);flex:none}
.fan-temp-scale span:first-child{left:0;transform:none}
.fan-temp-scale span:last-child{right:0;left:auto;transform:none}

.fan-app .cbi-map-descr{margin:0 0 var(--fan-sp-4);padding:var(--fan-sp-3) var(--fan-sp-4);border:1px solid var(--fan-border);border-left:3px solid var(--fan-info);border-radius:var(--fan-r-md);background:var(--fan-surface-2);color:var(--fan-muted);font-size:12px;line-height:1.6}
.fan-app .cbi-section{background:var(--fan-surface);border:1px solid var(--fan-border);border-radius:var(--fan-r-card);padding:var(--fan-sp-4);margin:var(--fan-gap) 0!important;box-shadow:0 2px 10px var(--fan-shadow);overflow:hidden}
.fan-app .cbi-section>h3{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:500;margin:0 0 var(--fan-sp-3);padding:0 0 var(--fan-sp-2);border-bottom:1px solid var(--fan-border);color:var(--fan-text)}
.fan-app .cbi-section>h3:before{content:"";display:block;width:4px;height:18px;border-radius:var(--fan-r-pill);background:var(--fan-info)}
.fan-app .fan-curve-section>h3:before{background:var(--fan-custom)}
.fan-app .cbi-section-descr{color:var(--fan-muted);font-size:12px;line-height:1.6;margin:-4px 0 var(--fan-sp-3)}
.fan-app .cbi-value{display:grid;grid-template-columns:minmax(180px,.72fr) minmax(260px,1.28fr);align-items:center;gap:var(--fan-sp-4);border-bottom:1px solid var(--fan-border);padding:var(--fan-sp-3) 0;margin:0}
.fan-app .cbi-value:last-child{border-bottom:0}
.fan-app .cbi-value-title{color:var(--fan-text);font-size:13px;font-weight:500;line-height:1.35}
.fan-app .cbi-value-description{display:block;color:var(--fan-muted);font-size:11px;font-weight:400;line-height:1.45;margin-top:5px}
.fan-app .cbi-value-field{min-width:0}
.fan-app .cbi-value-field input,.fan-app .cbi-value-field select{width:100%;min-height:38px;padding:8px 11px;border:1px solid var(--fan-border);border-radius:var(--fan-r-md);background:var(--fan-surface-2);color:var(--fan-text);font-size:13px;transition:border-color .18s,box-shadow .18s,background .18s}
.fan-app .cbi-value-field input:hover,.fan-app .cbi-value-field select:hover{border-color:var(--fan-info)}
.fan-app .cbi-value-field input:focus,.fan-app .cbi-value-field select:focus{border-color:var(--fan-info);background:var(--fan-surface);box-shadow:0 0 0 3px var(--fan-info-soft);outline:0}
.fan-app .cbi-value-field input[type=number]{font-family:var(--fan-font-mono);font-weight:500}
.fan-app .cbi-button{border-radius:var(--fan-r-md);font-weight:500;transition:transform .18s,box-shadow .18s}
.fan-app .cbi-button:hover{transform:translateY(-1px);box-shadow:0 4px 12px var(--fan-shadow)}

.fan-app .fan-control-section{background:var(--fan-surface-2)}
.fan-app [data-name="_curve_graph"]{display:block;padding:var(--fan-sp-3) 0 0;margin-top:var(--fan-sp-1);border-top:1px solid var(--fan-border)}
.fan-app [data-name="_curve_graph"] .cbi-value-title{margin-bottom:var(--fan-sp-2)}
.fan-app [data-name="_curve_graph"] .cbi-value-field{width:100%}
.fan-curve-wrap{background:var(--fan-surface);border:1px solid var(--fan-border);border-left:3px solid var(--fan-series);border-radius:var(--fan-r-md);padding:var(--fan-sp-3)}
.fan-curve-legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin:0 0 var(--fan-sp-2)}
.fan-curve-legend-item{--fan-level:var(--fan-series-idle);display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--fan-muted);cursor:default}
.fan-curve-legend-item.is-active{--fan-level:var(--fan-series);color:var(--fan-text);font-weight:500}
.fan-curve-legend-item[data-preset="preview"].is-active{--fan-level:var(--fan-series-preview)}
.fan-curve-legend-item.is-active .fan-curve-swatch{box-shadow:0 0 0 2px var(--fan-surface),0 0 0 3px var(--fan-level)}
.fan-curve-swatch{width:12px;height:12px;border-radius:3px;flex:none;background:var(--fan-level)}
.fan-curve-canvas{display:block;width:100%;height:320px;background:var(--fan-canvas);border:1px solid var(--fan-border);border-radius:var(--fan-r-sm)}
.fan-curve-error{display:none;margin-top:var(--fan-sp-2);padding:var(--fan-sp-2) var(--fan-sp-3);border:1px solid var(--fan-error);border-radius:var(--fan-r-sm);background:var(--fan-error-tint);color:var(--fan-error);font-size:12px;line-height:1.5}
.fan-curve-error.is-visible{display:block}

.fan-app .fan-curve-section{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--fan-gap-sm) var(--fan-gap);align-items:start}
.fan-app .fan-curve-section>h3,.fan-app .fan-curve-section>.cbi-section-descr,.fan-app .fan-curve-section>.fan-curve-point-head,.fan-app .fan-curve-section>.fan-curve-error{grid-column:1/-1}
.fan-app .fan-curve-section .cbi-value{display:flex;flex-direction:column;align-items:stretch;gap:var(--fan-gap-sm);width:100%;padding:var(--fan-sp-3);border:1px solid var(--fan-border);border-left:3px solid var(--fan-warn);border-radius:var(--fan-r-md);background:var(--fan-surface-2)}
.fan-app .fan-curve-section .cbi-value[data-name$="_pwm"]{border-left-color:var(--fan-info)}
.fan-app .fan-curve-section .cbi-value .cbi-value-title{display:block;flex:none;float:none;width:auto;position:static;clear:both;margin:0;line-height:1.4;white-space:normal}
.fan-app .fan-curve-section .cbi-value .cbi-value-field{display:block;flex:none;width:100%;position:static;clear:both;margin:0}
.fan-curve-point-head{display:flex;justify-content:space-between;gap:var(--fan-gap);margin:0 0 2px;font-size:11px;letter-spacing:.02em;color:var(--fan-muted)}
.fan-curve-point-head span{flex:1;text-align:center}
.fan-curve-point-head span:first-child{text-align:left}

.fan-app.is-stale .fan-summary-card,.fan-app.is-stale .fan-chart-card,.fan-app.is-stale .fan-temp-card{opacity:.68}
.fan-app .fan-curve-section .cbi-value{position:relative}
.fan-app .fan-curve-section .cbi-value[data-point]:before{content:attr(data-point);position:absolute;top:9px;right:10px;display:flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:var(--fan-track);color:var(--fan-muted);font-family:var(--fan-font-mono);font-size:11px}
.fan-app .fan-curve-section.is-hidden{display:none}
.fan-app .fan-curve-section:not(.is-hidden){animation:fan-reveal .18s ease}
@keyframes fan-reveal{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.fan-app .fan-curve-section .cbi-value.is-focused{box-shadow:0 0 0 2px var(--fan-info-soft)}
@media(prefers-reduced-motion:reduce){.fan-app .fan-curve-section:not(.is-hidden){animation:none}.fan-temp-fill,.fan-app .cbi-value-field input,.fan-app .cbi-value-field select,.fan-app .cbi-button,.fan-summary-card,.fan-chart-card,.fan-temp-card{transition:none}.fan-app .cbi-button:hover{transform:none}}
@media(pointer:coarse){.fan-app .cbi-value-field input,.fan-app .cbi-value-field select,.fan-app .cbi-button{min-height:44px}}
@media(max-width:1050px){.fan-overview-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.fan-mode-cell{grid-column:1/-1;padding:var(--fan-sp-3)}.fan-chart-grid{grid-template-columns:1fr}}
@media(max-width:760px){.fan-app .fan-curve-section{grid-template-columns:1fr}.fan-overview-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.fan-app .fan-curve-section>h3,.fan-app .fan-curve-section>.cbi-section-descr,.fan-app .fan-curve-section>.fan-curve-point-head,.fan-app .fan-curve-section>.fan-curve-error{grid-column:auto}}
@media(max-width:640px){.fan-app{padding-bottom:var(--fan-sp-3)}.fan-app-header{align-items:flex-start;flex-direction:column;gap:6px}.fan-app-meta,.fan-context-chips,.fan-panel-head{width:100%}.fan-panel-head{flex-direction:column;align-items:flex-start;gap:6px}.fan-overview-grid,.fan-temp-grid{grid-template-columns:1fr}.fan-summary-card{min-height:88px}.fan-chart-canvas{height:112px}.fan-curve-canvas{height:250px}.fan-panel{padding:var(--fan-sp-3)}}`;

/* Settings view only: mode tiles, preset sparklines, the draggable curve
 * editor, the precise-value table and the sticky save bar. Kept in the same
 * stylesheet as the rest of the design system so both pages share one set of
 * tokens - a second <style> block would reintroduce the duplicate-palette
 * problem described at the top of this file. */
var SETTINGS_CSS = `
.fan-panel[hidden]{display:none}
.fan-curve-body[hidden]{display:none}
/* Sub-heading that splits the merged control panel: mode choice + summary
 * cards above the line, curve editor below it. */
.fan-control-subhead{display:flex;align-items:baseline;justify-content:space-between;gap:var(--fan-sp-2);margin:var(--fan-sp-4) 0 0;padding-top:var(--fan-sp-3);border-top:1px solid var(--fan-border)}
.fan-subhead-title{margin:0;font-size:14px;line-height:1.4;font-weight:500;color:var(--fan-text)}
.fan-curve-body .fan-preset-grid{margin-top:var(--fan-sp-3)}
/* Mode selection moved into the compact .fan-seg segmented control in the
 * overview row (styles live in COMPONENT_CSS next to the summary cards). */

.fan-speed{display:flex;align-items:flex-end;justify-content:space-between;gap:var(--fan-sp-3);flex-wrap:wrap}
.fan-speed-value{display:flex;align-items:baseline;gap:2px;font-family:var(--fan-font-mono);font-variant-numeric:tabular-nums;color:var(--fan-text)}
.fan-speed-value strong{font-size:34px;font-weight:500;line-height:1}
.fan-speed-value span{font-size:15px;color:var(--fan-muted)}
.fan-speed-meta{display:flex;flex-direction:column;align-items:flex-end;gap:2px;font-size:12px;line-height:1.4;color:var(--fan-muted);text-align:right}
.fan-speed-meta b{font-family:var(--fan-font-mono);font-size:13px;font-weight:500;color:var(--fan-text)}
.fan-slider{-webkit-appearance:none;appearance:none;display:block;width:100%;height:26px;margin:12px 0 0;background:transparent;cursor:pointer}
.fan-slider:focus{outline:none}
.fan-slider::-webkit-slider-runnable-track{height:8px;border-radius:var(--fan-r-pill);background:linear-gradient(90deg,var(--fan-series) 0 var(--pct,50%),var(--fan-track) var(--pct,50%) 100%)}
.fan-slider::-webkit-slider-thumb{-webkit-appearance:none;width:22px;height:22px;margin-top:-7px;border:2px solid var(--fan-series);border-radius:50%;background:var(--fan-surface);box-shadow:0 2px 6px var(--fan-shadow)}
.fan-slider:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 3px var(--fan-info-soft)}
.fan-slider::-moz-range-track{height:8px;border-radius:var(--fan-r-pill);background:var(--fan-track)}
.fan-slider::-moz-range-progress{height:8px;border-radius:var(--fan-r-pill);background:var(--fan-series)}
.fan-slider::-moz-range-thumb{width:18px;height:18px;border:2px solid var(--fan-series);border-radius:50%;background:var(--fan-surface)}
.fan-speed-scale{display:flex;justify-content:space-between;margin-top:-2px;font-family:var(--fan-font-mono);font-size:11px;color:var(--fan-muted)}
.fan-speed-quick{display:flex;flex-wrap:wrap;gap:6px;margin-top:var(--fan-sp-3)}
.fan-chip{min-height:30px;padding:0 12px;border:1px solid var(--fan-border);border-radius:var(--fan-r-pill);background:var(--fan-surface);color:var(--fan-text);font:inherit;font-size:12px;cursor:pointer;transition:border-color .16s,color .16s,background .16s}
.fan-chip:hover{border-color:var(--fan-info);color:var(--fan-info)}
.fan-chip.is-on{border-color:var(--fan-series);background:var(--fan-series-soft);color:var(--fan-text)}
.fan-note{margin:var(--fan-sp-3) 0 0;font-size:12px;line-height:1.5;color:var(--fan-muted)}
.fan-note[data-level="warn"]{color:var(--fan-warn)}

.fan-preset-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--fan-sp-2);margin:0 0 var(--fan-sp-2)}
.fan-preset{position:relative;display:flex;flex-direction:column;gap:5px;padding:10px 11px;border:1px solid var(--fan-border);border-radius:var(--fan-r-md);background:var(--fan-surface-2);color:var(--fan-text);font:inherit;text-align:left;cursor:pointer;transition:border-color .16s,background .16s,box-shadow .16s}
/* Same trick as the mode cards: the radio is invisible but stays focusable, so
 * the tile keeps its tab stop and the group keeps arrow-key selection. */
.fan-preset-input{position:absolute;width:1px;height:1px;margin:0;opacity:0;pointer-events:none;clip:rect(0 0 0 0);overflow:hidden}
.fan-preset:hover{border-color:var(--fan-info)}
.fan-preset:focus-visible,.fan-preset:has(.fan-preset-input:focus-visible){outline:2px solid var(--fan-info);outline-offset:2px}
.fan-preset.is-on{border-color:var(--fan-level);background:var(--fan-level-tint);box-shadow:inset 0 0 0 1px var(--fan-level)}
.fan-preset-name{font-size:13px;font-weight:500;line-height:1.3}
.fan-preset-spark{display:block;width:100%;height:34px}
.fan-preset-hint{font-size:11px;line-height:1.35;color:var(--fan-muted)}
.fan-preset.is-on .fan-preset-hint{color:var(--fan-level)}
.fan-curve-live{font-family:var(--fan-font-mono);font-variant-numeric:tabular-nums;white-space:nowrap}

.fan-editor{position:relative;margin-top:var(--fan-sp-3);border:1px solid var(--fan-border);border-radius:var(--fan-r-md);background:var(--fan-canvas);overflow:hidden}
.fan-editor-canvas{display:block;width:100%;height:340px;touch-action:none}
.fan-editor-canvas.is-editable{cursor:grab}
.fan-editor.is-dragging .fan-editor-canvas{cursor:grabbing}
.fan-editor-canvas:focus-visible{outline:2px solid var(--fan-info);outline-offset:-2px}
.fan-editor-tip{position:absolute;top:0;left:0;z-index:2;display:none;padding:4px 8px;border-radius:var(--fan-r-sm);background:var(--fan-text);color:var(--fan-surface);font-family:var(--fan-font-mono);font-size:11px;white-space:nowrap;pointer-events:none;transform:translate(-50%,-140%)}
.fan-editor-tip.is-visible{display:block}
.fan-editor-foot{display:flex;align-items:center;justify-content:space-between;gap:var(--fan-sp-2);flex-wrap:wrap;margin-top:var(--fan-sp-2)}
.fan-curve-tip{flex:1;min-width:200px;line-height:1.5}
.fan-link{padding:0;border:0;background:none;color:var(--fan-info);font:inherit;font-size:12px;cursor:pointer;text-decoration:underline;text-underline-offset:2px;white-space:nowrap;height:auto;line-height:1.4}
.fan-link[hidden]{display:none}

.fan-precise{margin-top:var(--fan-sp-3);border-top:1px solid var(--fan-border);padding-top:var(--fan-sp-1)}
.fan-precise>summary{display:flex;align-items:center;gap:7px;padding:5px 0;font-size:12px;color:var(--fan-muted);cursor:pointer;list-style:none}
.fan-precise>summary::-webkit-details-marker{display:none}
.fan-precise>summary:before{content:"";flex:none;width:6px;height:6px;margin-left:2px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .15s}
.fan-precise[open]>summary:before{transform:rotate(45deg)}
.fan-precise>summary:focus-visible{outline:2px solid var(--fan-info);outline-offset:2px;border-radius:var(--fan-r-sm)}
.fan-points{display:grid;gap:2px;margin-top:var(--fan-sp-2);max-width:560px}
.fan-point-head,.fan-point-row{display:grid;grid-template-columns:30px minmax(0,1fr) minmax(0,1fr) 54px;align-items:center;gap:var(--fan-sp-2)}
.fan-point-head{padding:0 2px 4px;font-size:11px;color:var(--fan-muted)}
.fan-point-head span:last-child{text-align:right}
.fan-point-row{padding:3px 2px;border-radius:var(--fan-r-sm)}
.fan-point-row.is-focus{background:var(--fan-info-tint)}
.fan-point-no{font-family:var(--fan-font-mono);font-size:12px;color:var(--fan-muted);text-align:center}
.fan-point-row input{width:100%;min-height:32px;padding:4px 8px;border:1px solid var(--fan-border);border-radius:var(--fan-r-sm);background:var(--fan-surface);color:var(--fan-text);font-family:var(--fan-font-mono);font-size:12px;font-variant-numeric:tabular-nums}
.fan-point-row input:focus{border-color:var(--fan-info);outline:0;box-shadow:0 0 0 3px var(--fan-info-soft)}
.fan-point-pct{font-family:var(--fan-font-mono);font-size:11px;color:var(--fan-muted);text-align:right}

.fan-context-chip-dirty{border-color:var(--fan-warn);color:var(--fan-warn)}
.fan-context-chip-dirty:before{background:var(--fan-warn)}
.fan-context-chip[hidden],.fan-curve-live[hidden]{display:none}

.fan-toast{position:fixed;left:50%;bottom:28px;z-index:60;display:flex;align-items:center;padding:9px 16px;border-radius:var(--fan-r-pill);background:var(--fan-text);color:var(--fan-surface);font-size:12.5px;opacity:0;transform:translate(-50%,10px);pointer-events:none;box-shadow:0 6px 24px rgba(0,0,0,.28);transition:opacity .2s,transform .2s}
.fan-toast.is-visible{opacity:1;transform:translate(-50%,0)}
.fan-toast[data-kind="error"]{background:var(--fan-error);color:#fff}
.fan-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

@media(max-width:900px){.fan-preset-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:640px){.fan-editor-canvas{height:270px}.fan-speed-meta{align-items:flex-start;text-align:left}.fan-point-head,.fan-point-row{grid-template-columns:24px minmax(0,1fr) minmax(0,1fr) 44px;gap:6px}}
@media(prefers-reduced-motion:reduce){.fan-seg-btn,.fan-preset,.fan-chip,.fan-toast{transition:none}}`;

var styleEl = null;
var lastDark = null;
var watching = false;
var listeners = [];

function luminanceIsDark() {
	var html = document.documentElement;
	var argon = html && html.getAttribute && html.getAttribute('data-argon-mode');
	if (argon === 'dark') return true;
	if (argon === 'light') return false;

	var els = [ document.body, document.querySelector('.main-content'),
		document.querySelector('#maincontent'), document.querySelector('.cbi-map') ];
	for (var i = 0; i < els.length; i++) {
		if (!els[i]) continue;
		var rgb = window.getComputedStyle(els[i]).backgroundColor.match(/\d+/g);
		if (!rgb || rgb.length < 3) continue;
		/* A transparent surface tells us nothing about the page behind it. */
		if (rgb.length > 3 && parseFloat(rgb[3]) < 0.5) continue;
		return (parseInt(rgb[0]) * 299 + parseInt(rgb[1]) * 587 + parseInt(rgb[2]) * 114) / 1000 < 128;
	}
	if (document.querySelectorAll('link[href*="dark"],link[href*="glass"]').length > 0) return true;
	try {
		return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
	} catch (e) {
		return false;
	}
}

return baseclass.extend({
	THRESHOLDS: THRESHOLDS,

	icon: function(name) {
		var el = document.createElement('span');
		el.className = 'fan-icon';
		el.setAttribute('aria-hidden', 'true');
		el.innerHTML = '<svg viewBox="0 0 24 24" focusable="false">' + (ICONS[name] || ICONS.fan) + '</svg>';
		return el;
	},

	isDarkMode: luminanceIsDark,

	/* Read a token off an element inside the page root so canvas strokes follow
	 * the live theme. Passing the canvas itself avoids a lookup before LuCI has
	 * inserted the view into the document. */
	color: function(name, fallback, el) {
		var target = el || document.querySelector('.fan-app') || document.body;
		var value = window.getComputedStyle(target).getPropertyValue(name);
		return (value && value.trim()) || fallback;
	},

	onThemeChange: function(fn) {
		if (typeof fn === 'function') listeners.push(fn);
	},

	/* Inject once per document. A later appearance change re-writes the same
	 * <style> node, so there is never a second copy of the tokens in :root. */
	apply: function() {
		if (!styleEl) {
			styleEl = document.getElementById('fan-theme-css');
			if (!styleEl) {
				styleEl = document.createElement('style');
				styleEl.id = 'fan-theme-css';
				document.head.appendChild(styleEl);
			}
		}

		var dark = luminanceIsDark();
		if (dark !== lastDark || styleEl.textContent === '') {
			var previous = lastDark;
			lastDark = dark;
			styleEl.textContent = '.fan-app{' + LIGHT + '}\n' + COMPONENT_CSS +
				SETTINGS_CSS + (dark ? '\n' + DARK : '');
			if (previous !== null && previous !== dark) {
				for (var i = 0; i < listeners.length; i++) listeners[i](dark);
			}
		}

		if (!watching) {
			watching = true;
			var self = this;
			try {
				var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
				if (mq && mq.addEventListener) mq.addEventListener('change', function() { self.apply(); });
			} catch (e) {}
			try {
				if (window.MutationObserver) {
					new MutationObserver(function() { self.apply(); }).observe(document.documentElement, {
						attributes: true,
						attributeFilter: [ 'data-argon-mode', 'data-darkmode', 'class' ]
					});
				}
			} catch (e) {}
		}
		return dark;
	},

	/* Inclusive upper bounds: <=45 Normal ('正常'), <=60 Warm ('偏高'),
	 * <=75 Hot ('高温'), >75 Critical ('过热'). The status health badge calls
	 * this too, so it can never disagree with the per-sensor labels. */
	tempLevel: function(temp) {
		if (!(temp > 0)) return { key: 'none', label: _('No data') };
		if (temp <= THRESHOLDS[0]) return { key: 'ok', label: _('Normal') };
		if (temp <= THRESHOLDS[1]) return { key: 'warn', label: _('Warm') };
		if (temp <= THRESHOLDS[2]) return { key: 'hot', label: _('Hot') };
		return { key: 'error', label: _('Overheated') };
	},

	/* The old gauge used `temp` directly as a percentage, so 55 C filled 55%
	 * of a track with no stated range. The gauge is a 0-100 C scale now. */
	tempPercent: function(temp) {
		if (!(temp > 0)) return 0;
		return Math.max(2, Math.min(100, temp));
	},

	tempTicks: function() {
		return THRESHOLDS.slice();
	}
});
