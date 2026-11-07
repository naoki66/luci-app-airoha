'use strict';
'require view';
'require poll';
'require rpc';
'require ui';
'require view.airoha.ui as aui';

/* ── RPC declarations ── */
var callNpuStatus = rpc.declare({ object: 'luci.airoha_npu', method: 'getStatus' });
var callDashboard = rpc.declare({ object: 'luci.airoha_npu', method: 'getDashboard', params: ['ppe'] });
var callPpeEntries = rpc.declare({ object: 'luci.airoha_npu', method: 'getPpeEntries' });
var callTokenInfo = rpc.declare({ object: 'luci.airoha_npu', method: 'getTokenInfo' });
// VLAN Offload is an independent switch again (it owns the VLAN passthrough
// pair), so its declares are live here. PPPoE passthrough is owned by AP Mode
// Acceleration on this page - nothing below drives setPppoeOffload, so this
// view keeps no PPPoE declares at all.
var callGetVlanOffload = rpc.declare({ object: 'luci.airoha_npu', method: 'getVlanOffload' });
var callSetVlanOffload = rpc.declare({ object: 'luci.airoha_npu', method: 'setVlanOffload', params: ['enabled'] });
var callGetFlowOffload = rpc.declare({ object: 'luci.airoha_npu', method: 'getFlowOffload' });
var callSetFlowOffload = rpc.declare({ object: 'luci.airoha_npu', method: 'setFlowOffload', params: ['enabled'] });
var callGetApModeOffload = rpc.declare({ object: 'luci.airoha_npu', method: 'getApModeOffload' });
var callSetApModeOffload = rpc.declare({ object: 'luci.airoha_npu', method: 'setApModeOffload', params: ['enabled'] });
var callGetDeviceMode = rpc.declare({ object: 'luci.airoha_npu', method: 'getDeviceMode' });
var callGetTopology = rpc.declare({ object: 'luci.airoha_npu', method: 'getTopology' });
var callGetWifiStats = rpc.declare({ object: 'luci.airoha_npu', method: 'getWifiStats' });
var callFrameEngine = rpc.declare({ object: 'luci.airoha_npu', method: 'getFrameEngine' });
var callCryptoInfo = rpc.declare({ object: 'luci.airoha_npu', method: 'getCryptoInfo' });

/* The CPU governor / max-freq setters (setGovernor, setMaxFreq,
 * setCpuSettings) are gone from this view on purpose: this page is a status
 * surface, and a control that writes scaling_governor is the one thing on it
 * that can silently make the router slower. The backend still exposes all
 * three RPCs, so a board that really wants them can be given a settings page
 * without touching this file. What the page keeps is the *reading* -
 * current frequency, governor and range - which is what an operator actually
 * opens it for. */

/* ── Shared state vocabulary ────────────────────────────────────────────── */

function isEnabled(value) {
	return value === true || value === 1 || value === '1';
}

/* The frequency the cores are actually running at: the hardware clock
 * (cpuinfo_cur_freq) when the driver exports it, the scaling target
 * (scaling_cur_freq) otherwise. On the fixed-clock boards this app ships on
 * there is nothing to read and the row is simply absent. */
function cpuCurrentFreq(st) {
	st = st || {};
	var hw = Number(st.cpu_hw_freq) || 0;
	return hw > 0 ? hw : (Number(st.cpu_cur_freq) || 0);
}

function isBridgeOffloadBlocked(mode) {
	mode = mode || {};
	return isEnabled(mode.bridge_offload_blocked);
}

/* Token-pool occupancy → { text, kind }. */
function tokenHealth(c, s) {
	if (!s) return { text: _('Unknown'), kind: '' };
	var p = c / s * 100;
	return p < 50 ? { text: _('Normal'), kind: 'ok' }
		: p < 80 ? { text: _('Warning'), kind: 'warn' }
			: { text: _('Critical'), kind: 'error' };
}

function getTxQueue(ti, b) {
	var q = Array.isArray(ti.tx_queues) ? ti.tx_queues : [];
	for (var i = 0; i < q.length; i++) if (q[i].band === b) return q[i];
	return null;
}

/* ── Port labels ──────────────────────────────────────────────────────────
 * External port names are pinned per board model ("10G WAN", "2.5G LAN3"…)
 * because they describe the port's design identity, not the momentary PHY
 * result — a label must not change just because a link negotiated down.
 * Boards are matched on the getTopology compatible/model string and ports on
 * their netdev name; anything unmapped (unknown board or netdev) falls back
 * to the topology-derived label. Technical tokens (GDM1, the netdev names)
 * stay untranslated, exactly as the file already treats them. */

/* Human-readable role/mode summary for one topology port. The role tokens
 * (WAN / LAN / PON) are deliberately passed through untranslated like the
 * other technical tokens below: they are standard abbreviations, and every
 * catalog on the device has its own idea of what a bare "LAN" means
 * (base.lmo maps it to a bandwidth word, some vendor catalogs to
 * "LAN 流量"), so translating them only produces wrong labels. */
function portLabel(p) {
	p = p || {};
	var role = String(p.role || '').toLowerCase();
	var mode = String(p.mode || '');
	var netdev = String(p.netdev || '');
	var parts = [];
	if (mode === 'internal' || !netdev) parts.push(_('Internal Switch'));
	else if (role === 'wan') parts.push('WAN');
	else if (role === 'lan') parts.push('LAN');
	else parts.push(_('No netdev'));
	if (mode && mode !== 'internal') parts.push(mode.toUpperCase());
	if (netdev) parts.push(netdev);
	return parts.join(' · ');
}

function portName(p) {
	if (p && p.kind === 'gdm') return 'GDM' + p.reg;
	return String((p && p.key) || '').toUpperCase();
}

/* Link speed (Mbps) → compact tag: 10000 → "10G", 1000 → "1G". */
function speedTag(mbps) {
	mbps = Number(mbps) || 0;
	if (mbps >= 10000) return '10G';
	if (mbps >= 5000) return '5G';
	// 2488 is GPON downstream: at a flat 2500 floor it would read as "1G".
	if (mbps >= 2400) return '2.5G';
	// 2000 is NG-PON2 2G/2G and turbo-EPON - also would have read as "1G".
	if (mbps >= 1900) return '2G';
	if (mbps >= 1000) return '1G';
	if (mbps >= 100) return '100M';
	return '';
}

/* Static per-mode speed fallback (Mbps) for ports whose link is down, so a
 * "1G LAN4" label still reads as 1G before the PHY negotiates. */
function modeFallbackMbps(mode) {
	switch (String(mode || '').toLowerCase()) {
		case 'usxgmii': case 'dxa': return 10000;
		case '2500base-x': return 2500;
		case 'sgmii': case 'internal': return 1000;
		default: return 0;
	}
}

/* Best-known speed tag for a port: negotiated speed wins, else the mode's
 * static capability. */
function portSpeedTag(p) {
	return speedTag(p && p.speed_mbps) || speedTag(modeFallbackMbps(p && p.mode));
}

/* A port that fronts the internal switch CPU (no netdev of its own). */
function isSwitchCpuPort(p) {
	return !(p && p.netdev) || p.role === 'conduit' || String(p.netdev) === 'cpu';
}

/* LAN netdevs behind the internal switch sharing the same GDM data path. */
function switchLanNetdevs(pse, topo) {
	var out = [];
	(Array.isArray(topo && topo.ports) ? topo.ports : []).forEach(function(q) {
		if (q && q.kind === 'gsw' && q.pse === pse && q.netdev) out.push(q.netdev);
	});
	return out;
}

/* Fixed per-board port labels, keyed by netdev. Speeds are the ports' design
 * capability — deliberately not live negotiation, so a label never flips
 * between "10G" and "1G" while a link renegotiates.
 *   XR1710G: 10G WAN / 10G LAN2 / 1G LAN3 / 1G LAN4 (+WiFi via CDM4)
 *   XG2010G: 10G LAN1 / 10G LAN2 / 2.5G LAN3 / 1G LAN4 (uplink is the PON card) */
var BOARD_PORT_NAMES = {
	xr1710: { wan: '10G WAN', lan2: '10G LAN2', lan3: '1G LAN3', lan4: '1G LAN4' },
	xg2010: { lan1: '10G LAN1', lan2: '10G LAN2', lan3: '2.5G LAN3', lan4: '1G LAN4' }
};

/* Pick the fixed label table for this board, or null when the board is not
 * one of the pinned models (unknown boards keep the topology-derived label). */
function boardPortNames(topo) {
	var id = (((topo && topo.compatible) || '') + ' ' + ((topo && topo.model) || '')).toLowerCase();
	var keys = Object.keys(BOARD_PORT_NAMES);
	for (var i = 0; i < keys.length; i++) {
		if (id.indexOf(keys[i]) >= 0) return BOARD_PORT_NAMES[keys[i]];
	}
	return null;
}

/* Human-facing name for a topology port: "10G WAN", "10G LAN2", "1G LAN3". */
function humanPortName(p, topo) {
	p = p || {};
	if (p.role === 'pon') return 'PON';
	if (isSwitchCpuPort(p)) {
		var lans = switchLanNetdevs(p.pse, topo);
		if (!lans.length) return _('Internal Switch');
		var fixedLans = boardPortNames(topo);
		return 'LAN · ' + lans.map(function(x) {
			return (fixedLans && fixedLans[String(x).toLowerCase()]) || x;
		}).join(', ');
	}
	var fixed = boardPortNames(topo);
	if (fixed) {
		var nd = String(p.netdev || '').toLowerCase();
		if (fixed[nd]) return fixed[nd];
	}
	var speed = portSpeedTag(p);
	if (String(p.role || '').toLowerCase() === 'wan')
		return (speed ? speed + ' ' : '') + 'WAN';
	return (speed ? speed + ' ' : '') + 'LAN' + String(p.netdev).replace(/^lan/i, '');
}

/* Accent colour for a GDM card: CPU/internal-facing MACs are amber, the
 * externally-facing LAN/WAN MACs are green. */
function portAccent(p) {
	p = p || {};
	if (String(p.mode || '') === 'internal' || !p.netdev) return 'var(--ds-warn)';
	return 'var(--ds-ok)';
}

/* ── Summary tiles ── */
function npuSummaryTiles(st, ti) {
	st = st || {}; ti = ti || {};
	var active = isEnabled(st.npu_loaded);
	var clock = st.npu_clock ? Math.round(st.npu_clock / 1000000) : 0;
	var bound = st.offload_bound || 0;
	var total = st.offload_total || 0;

	// TX token pool — the hardware send tokens the NPU/WDMA draws from. This is
	// the reading the old view never surfaced.
	var tokCount = Number(ti.token_count) || 0;
	var tokSize = Number(ti.token_size) || 0;
	var tokPct = tokSize > 0 ? tokCount / tokSize * 100 : 0;
	var tokAccent = !tokSize ? 'var(--ds-text-muted)'
		: tokPct < 50 ? 'var(--ds-ok)'
			: tokPct < 80 ? 'var(--ds-warn)' : 'var(--ds-error)';

	var temp = (st.cpu_temp && st.cpu_temp !== 'N/A') ? st.cpu_temp : '';

	var tiles = {
		'npu-summary-status': aui.tile({
			id: 'npu-summary-status', title: _('NPU Status'),
			value: active ? _('Activated') : _('Not Activated'),
			accent: active ? 'var(--ai-npu)' : 'var(--ds-text-muted)',
			sub: active ? (st.npu_device || _('NPU device ready')) : _('Driver unavailable')
		}),
		'npu-summary-clock': aui.tile({
			id: 'npu-summary-clock', title: _('NPU Clock / Cores'),
			value: clock ? clock + ' MHz' : 'N/A', accent: 'var(--ds-ok)',
			sub: (st.npu_cores || 0) + ' ' + _('cores')
		}),
		'npu-summary-flows': aui.tile({
			id: 'npu-summary-flows', title: _('Offload Statistics'),
			value: bound + ' / ' + total,
			accent: total > 0 ? 'var(--ai-npu)' : 'var(--ds-text-muted)',
			sub: _('Bound / total PPE flows')
		}),
		// The reserved-memory regions tile was dropped: region count/size means
		// nothing to an operator and the DTS never changes after boot.
		'npu-summary-temp': aui.tile({
			id: 'npu-summary-temp', title: _('CPU Temperature'),
			value: temp ? temp.replace(/[^\d.]/g, '') : '—', unit: temp ? '°C' : '',
			accent: 'var(--ds-ok)',
			sub: (st.cpu_count || 0) + ' ' + _('cores') + ' · ' + (st.soc_compat || '')
		})
	};

	// The TX token pool tile only carries meaning when the driver exposes the
	// probe (mt76's token_info debugfs node). On builds without it the tile
	// would sit at "N/A / Unknown" forever — hide it instead.
	if (tokSize > 0) {
		tiles['npu-summary-token'] = aui.tile({
			id: 'npu-summary-token', title: _('TX Token Pool'),
			value: tokCount + ' / ' + tokSize,
			accent: tokAccent,
			sub: _('used') + ' ' + aui.fmtPct(tokPct, 0)
		});
	}

	return tiles;
}

var SUMMARY_IDS = [
	'npu-summary-status', 'npu-summary-clock', 'npu-summary-flows',
	'npu-summary-token', 'npu-summary-temp'
];

function renderSummary(st, ti) {
	var tiles = npuSummaryTiles(st, ti);
	return E('div', { 'class': 'ai-grid ai-grid--tiles', 'id': 'npu-summary-grid' },
		SUMMARY_IDS.map(function(id) { return tiles[id]; }).filter(Boolean));
}

function updateSummary(st, ti) {
	var grid = document.getElementById('npu-summary-grid');
	if (!grid) return;
	var tiles = npuSummaryTiles(st, ti);
	grid.innerHTML = '';
	SUMMARY_IDS.forEach(function(id) { if (tiles[id]) grid.appendChild(tiles[id]); });
}

/* ── CPU cards ──
 * What is left of the old "CPU Control" card is a reading, not a control:
 * frequency, governor and range are shown where they belong (inside the info
 * card and on the history curve), and the governor / max-freq selects plus
 * their Save button are gone. That card used to be the reason this section
 * carried a dead slot: on a board whose kernel exposes no cpufreq policy it
 * degraded into a disabled select pair under the line "CPU frequency scaling
 * is not available on this board" - a permanent warning about a feature the
 * page no longer offers.
 *
 * The section is therefore built as a *list of cards that may or may not
 * exist*, laid out by the auto-fit `.ai-grid--2`. One card left in a row
 * spans the full width, so dropping the frequency cards on a fixed-clock
 * board reflows the section instead of leaving a hole. */
function renderCpuInfo(st) {
	st = st || {};
	var rows = [
		aui.row(_('Model'), st.soc_compat || '—'),
		aui.row(_('Architecture'), st.cpu_arch || '—'),
		aui.row(_('Core Count'), (st.cpu_count || 0))
	];
	/* Both extra rows are readings. On a board without cpufreq they are simply
	 * absent - no placeholder, no explanation: a status page does not owe the
	 * user a warning about telemetry it never had. */
	/* The clock and the governor that shapes it are one fact, so they share one
	 * row: "1200 MHz · ondemand". Two rows made this card a row taller than the
	 * core-load card beside it on every DVFS board. */
	var freq = cpuCurrentFreq(st);
	var gov = (st.cpu_governor && st.cpu_governor !== 'unknown') ? governorLabel(st.cpu_governor) : '';
	if (freq)
		rows.push(aui.row(_('Current Frequency'), aui.fmtFreq(freq) + (gov ? ' · ' + gov : '')));
	/* Two readings the page had nowhere else to put, and the ones that make the
	 * card the same height as the per-core bars next to it. Both come from a
	 * single /proc read in the backend; a backend that predates them simply
	 * leaves the rows out. */
	var loadavg = String(st.loadavg == null ? '' : st.loadavg).trim();
	if (loadavg)
		rows.push(aui.row(_('Load Average'), loadavg.split(/\s+/).join(' / ')));
	if (Number(st.sys_uptime) > 0)
		rows.push(aui.row(_('Uptime'), aui.fmtUptime(st.sys_uptime)));
	rows.push(aui.row(_('Temperature'), (st.cpu_temp && st.cpu_temp !== 'N/A') ? st.cpu_temp : 'N/A'));
	return aui.card({
		name: _('CPU Info'),
		accent: 'var(--ai-npu)',
		body: rows
	});
}

/* Instant per-core utilisation, drawn as one bar per thread from the newest
 * backend sample. It is the "state" half of the pair whose "trend" half is the
 * usage history card below - the same split every OS task monitor uses. */
function renderCoreLoad(st) {
	st = st || {};
	var sample = loadHistory.length ? loadHistory[loadHistory.length - 1].u : [];
	var cores = Math.max(Number(st.cpu_count) || 0, sample.length);
	if (!cores)
		return aui.card({ name: _('Core Load'), accent: 'var(--ai-load)', body: aui.empty(_('No data')) });

	var bars = [], sum = 0, cnt = 0;
	for (var c = 0; c < cores; c++) {
		var v = isPercent(sample[c]) ? sample[c] : null;
		if (v !== null) { sum += v; cnt++; }
		bars.push(aui.bar({
			title: 'cpu' + c,
			right: (v === null) ? '—' : aui.fmtPct(v),
			pct: (v === null) ? 0 : v,
			accent: coreColor(c)
		}));
	}
	/* The bars live in their own flex box so the card can distribute whatever
	 * height the info card next to it dictates: the gaps between the bars grow,
	 * the average row stays pinned to the bottom edge. */
	var footer = E('div', {
		'style': 'margin-top:var(--ds-sp-2);padding-top:var(--ds-sp-2);border-top:1px solid var(--ds-border)'
	}, [
		aui.row(_('Average'), cnt ? aui.fmtPct(sum / cnt) : '—')
	]);
	return aui.card({
		name: _('Core Load'), accent: 'var(--ai-load)', cls: 'ai-card--fill',
		body: [ E('div', { 'class': 'ai-bars-fill' }, bars), footer ]
	});
}

/* ── History data (backend ring buffers) ──
 * Both curves are sampled by the RPC backend into bounded files under /tmp
 * (see `_cpu_hist` in luci.airoha_npu) and arrive with every status reply.
 * That is why there is no storage bookkeeping here at all: a reload, a second
 * tab, or a tab reopened later all read the same window, and the /proc/stat
 * subtraction that produces a utilisation percentage is done by the sampler
 * instead of once per tab.
 *
 * HIST_WINDOW mirrors HIST_MAX in the backend, including its cadence: one
 * point per poll, i.e. 120 x 10 s = 20 minutes. The charts use it
 * as the fixed x window, so a buffer that is only partly filled grows in from
 * the right edge and the newest sample always lands on the right border.
 *
 * A backend that predates `cpu_history` publishes nothing, and the charts stay
 * empty instead of showing a curve measured on a different clock than the
 * backend's - a stale rpcd must be redeployed, not silently worked around. */
var HIST_WINDOW = 120;
/* A gap this long means nobody was sampling in between: no page was open, the
 * browser throttled the poll, or the board rebooted. The plot is broken there
 * rather than bridging time that was never measured.
 *
 * Four samples, not two: the backend writes one point per poll (10 s), so a
 * single missed round produces a 20 s spacing and must still be joined - only a
 * real absence (>= 40 s) is worth a break. */
var HIST_GAP_MS = 40000;

var loadHistory = [];   /* [ { t: ms, u: [pct|null, ...] } ], oldest first */

function histNum(v) {
	return (typeof v === 'number' && isFinite(v)) ? v : null;
}

/* Sort by time and drop the duplicate timestamps a double sample can leave
 * behind (two tabs that poll on the same phase write the same second twice). */
function histNormalise(samples) {
	samples.sort(function(a, b) { return a.t - b.t; });
	for (var i = samples.length - 1; i > 0; i--)
		if (samples[i].t === samples[i - 1].t) samples.splice(i, 1);
	return samples.slice(-HIST_WINDOW);
}

/* Both parsers return null - not an empty array - when the payload is missing
 * or unusable, so the caller can keep the curve that is already on screen: one
 * failed poll must never blank 120 valid points. */
function parseLoadHistory(raw) {
	if (!Array.isArray(raw)) return null;
	var out = [];
	for (var i = 0; i < raw.length; i++) {
		var s = raw[i];
		if (!Array.isArray(s) || !Array.isArray(s[1])) continue;
		var t = histNum(s[0]);
		if (!t) continue;
		var u = [];
		for (var c = 0; c < s[1].length; c++) {
			var v = histNum(s[1][c]);
			/* Values arrive in tenths of a percent: rpcd parses the backend's
			 * reply and re-serialises it, and an integer survives that trip
			 * verbatim while 4.3 comes back as 4.2999999999999998. null marks
			 * a core that was not measurable in that interval (hotplug, or a
			 * counter that went backwards): the line breaks there instead of
			 * being drawn through a fake 0. */
			u.push(v === null ? null : Math.min(100, Math.max(0, v / 10)));
		}
		if (!u.length) continue;
		out.push({ t: t * 1000, u: u });
	}
	return histNormalise(out);
}

function adoptHistory(st) {
	var h = st && st.cpu_history;
	if (!h) return;
	var l = parseLoadHistory(h.load);
	if (l) loadHistory = l;
}

/* LuCI's E() uses document.createElement() and cannot create SVG-namespace
 * elements, so build chart nodes with createElementNS. */
var SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, children) {
	var el = document.createElementNS(SVG_NS, tag);
	if (attrs) for (var k in attrs) el.setAttribute(k, attrs[k]);
	if (children) for (var i = 0; i < children.length; i++) el.appendChild(children[i]);
	return el;
}

/* ── Chart hover readout ──
 * Both history charts are plain SVG rebuilt on every poll, so the hover layer
 * is rebuilt with them: a dashed crosshair, one dot per series, and an HTML
 * readout. The readout is HTML rather than SVG text because its size is not
 * known until it is rendered - placing an SVG text box would need a measuring
 * pass on every mousemove. Coordinates go through getScreenCTM() when the
 * browser supports it, with a viewBox fallback for engines that do not. */
function fmtSampleClock(ms) {
	var d = new Date(ms);
	function p(n) { return n < 10 ? '0' + n : String(n); }
	return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function chartPointer(svg, evt) {
	try {
		if (typeof svg.createSVGPoint === 'function' && svg.getScreenCTM) {
			var m = svg.getScreenCTM();
			if (m) {
				var pt = svg.createSVGPoint();
				pt.x = evt.clientX; pt.y = evt.clientY;
				return pt.matrixTransform(m.inverse());
			}
		}
	} catch (err) {
		// Fall through to the viewBox mapping below.
	}
	var rect = svg.getBoundingClientRect();
	var vb = String(svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
	if (!rect.width || vb.length !== 4 || !isFinite(vb[2]) || !isFinite(vb[3])) return null;
	return {
		x: (evt.clientX - rect.left) / rect.width * vb[2],
		y: (evt.clientY - rect.top) / Math.max(1, rect.height) * vb[3]
	};
}

function chartNearest(xs, x) {
	var best = 0, bestD = Infinity;
	for (var i = 0; i < xs.length; i++) {
		var d = Math.abs(xs[i] - x);
		if (d < bestD) { bestD = d; best = i; }
	}
	return best;
}

function chartTipNode() {
	return E('div', {
		'style': 'position:absolute;display:none;z-index:3;pointer-events:none;min-width:6.5em;'
			+ 'padding:.3em .5em;border:1px solid var(--ds-border,#d1d9e0);border-radius:6px;'
			+ 'background:var(--ds-surface,#fff);color:var(--ds-text,#1f2328);'
			+ 'box-shadow:0 2px 8px rgba(15,23,42,.18);font-size:11px;line-height:1.5;'
			+ 'font-variant-numeric:tabular-nums;text-align:left'
	});
}

function chartPlaceTip(tip, wrap, evt) {
	var wr = wrap.getBoundingClientRect();
	var px = evt.clientX - wr.left, py = evt.clientY - wr.top;
	tip.style.display = 'block';
	var tw = tip.offsetWidth, th = tip.offsetHeight;
	var left = Math.min(Math.max(0, px - tw / 2), Math.max(0, wr.width - tw));
	var top = py - th - 10;
	if (top < 0) top = py + 12;
	tip.style.left = left + 'px';
	tip.style.top = top + 'px';
}

/* `o` = { svg, wrap, xs, guideTop, guideBottom, dotColors,
 *         time(i) -> epoch ms, points(i) -> [{x,y}|null] per dot, rows(i) }.
 * points() and rows() are called per mousemove so the readout always reflects
 * the sample the crosshair currently sits on. */
function attachChartHover(o) {
	var svg = o.svg, wrap = o.wrap, xs = o.xs || [];
	var tip = chartTipNode();
	wrap.appendChild(tip);

	var guide = svgEl('line', {
		'x1': 0, 'x2': 0, 'y1': o.guideTop, 'y2': o.guideBottom,
		'style': 'stroke:var(--ds-text-muted,#656d76);stroke-width:1;stroke-dasharray:3 3;pointer-events:none',
		'visibility': 'hidden'
	});
	svg.appendChild(guide);

	var dots = (o.dotColors || []).map(function(color) {
		var dot = svgEl('circle', {
			'cx': 0, 'cy': 0, 'r': '3.5',
			'style': 'fill:' + color + ';stroke:var(--ds-surface,#fff);stroke-width:1.5;pointer-events:none',
			'visibility': 'hidden'
		});
		svg.appendChild(dot);
		return dot;
	});

	function hide() {
		tip.style.display = 'none';
		guide.setAttribute('visibility', 'hidden');
		for (var i = 0; i < dots.length; i++) dots[i].setAttribute('visibility', 'hidden');
	}

	function show(evt) {
		var p = chartPointer(svg, evt);
		if (!p || !xs.length) return;
		var i = chartNearest(xs, p.x);
		guide.setAttribute('x1', xs[i].toFixed(1));
		guide.setAttribute('x2', xs[i].toFixed(1));
		guide.setAttribute('visibility', 'visible');

		var points = o.points(i) || [];
		for (var d = 0; d < dots.length; d++) {
			var point = points[d];
			if (point) {
				dots[d].setAttribute('cx', point.x.toFixed(1));
				dots[d].setAttribute('cy', point.y.toFixed(1));
				dots[d].setAttribute('visibility', 'visible');
			} else {
				dots[d].setAttribute('visibility', 'hidden');
			}
		}

		tip.innerHTML = '';
		tip.appendChild(E('div', {
			'style': 'color:var(--ds-text-muted,#656d76);font-weight:650;margin-bottom:2px'
		}, fmtSampleClock(o.time(i))));
		(o.rows(i) || []).forEach(function(row) {
			tip.appendChild(E('div', {
				'style': 'display:flex;align-items:center;gap:.4em;white-space:nowrap'
			}, [
				row.color ? E('span', {
					'style': 'width:.9em;height:2px;border-radius:2px;background:' + row.color + ';flex:0 0 auto'
				}) : null,
				row.label ? E('span', {
					'style': 'color:var(--ds-text-muted,#656d76);font-family:var(--ds-mono,monospace)'
				}, row.label) : null,
				E('span', {
					'style': 'margin-left:auto;padding-left:.6em;font-family:var(--ds-mono,monospace);font-weight:700'
				}, row.value)
			]));
		});
		chartPlaceTip(tip, wrap, evt);
	}

	svg.addEventListener('mousemove', show);
	svg.addEventListener('mouseleave', hide);
}

/* ── CPU usage history chart ──
 * The frequency curve answers "how fast are the cores running", which only
 * becomes readable next to "how busy were they"; this card is that second half.
 *
 * A utilisation percentage needs two /proc/stat snapshots, and the backend
 * owns both: it keeps the previous reference in /tmp, differentiates it on the
 * poll (once every 10 s) and publishes the finished percentages here. The view
 * therefore holds no baseline and no clock - which is what makes a reload, a
 * second tab and a reopened tab agree instead of each measuring its own
 * interval.
 *
 * A sample is one array entry per core (index = core number, so the chart can
 * draw one coloured line per thread). A null entry marks a core that was not
 * measurable in that interval (hotplug, or a counter that went backwards): the
 * line breaks there rather than being drawn through a fake 0.
 */
function isPercent(v) {
	return typeof v === 'number' && isFinite(v) && v >= 0 && v <= 100;
}
/* Palette + dash policy for the per-core series (see ds-tokens.js). Every entry
 * carries a literal fallback inside the var(): these boards are deployed by
 * hand, so a stale ds-tokens.js can outlive this file, and an unresolvable
 * token would paint the curves in the SVG default (no stroke at all). The
 * literals mirror the light-mode palette - it is the one that needs the aid. */
var CORE_COLORS = [
	'var(--ai-core-0, #1663d6)', 'var(--ai-core-1, #e8590c)',
	'var(--ai-core-2, #2f9e44)', 'var(--ai-core-3, #c2255c)'
];
function coreColor(i) { return CORE_COLORS[i % CORE_COLORS.length]; }
function coreDashed(i) { return i >= CORE_COLORS.length; }

function loadCoreCount() {
	var cores = 0;
	for (var i = 0; i < loadHistory.length; i++)
		cores = Math.max(cores, loadHistory[i].u.length);
	return cores;
}

function renderLoadLegend() {
	var n = loadHistory.length;
	var latest = n ? loadHistory[n - 1].u : [];
	var items = [];
	for (var c = 0; c < loadCoreCount(); c++) {
		var v = latest[c];
		/* Core labels stay untranslated technical tokens, like GDM1 or the
		 * netdev names elsewhere on this page. */
		items.push({
			label: 'cpu' + c,
			value: isPercent(v) ? aui.fmtPct(v) : '—',
			color: coreColor(c),
			dashed: coreDashed(c)
		});
	}
	/* aui.legend() arrived together with this card, but the two files can drift
	 * apart in a hand deployment (a stale ui.js served under the same resource
	 * version). The throw would come out of render() and blank the whole page,
	 * so degrade to a plain row: the card loses its colours, not the view. */
	if (typeof aui.legend === 'function') return aui.legend(items);
	return E('div', { 'class': 'ai-legend' }, items.map(function(item) {
		/* The .ai-legend spacing lives in the same stale file, so the fallback
		 * carries its own gap instead of relying on a stylesheet. */
		return E('span', { 'class': 'ai-legend-item', 'style': 'margin-right:.75em' },
			item.label + ' ' + item.value);
	}));
}

/* Multi-line usage chart: fixed 0-100 % scale, one line per core. No area fill
 * (several stacked washes would muddy the colours) and no right-hand axis -
 * 100 % is the only ceiling that matters here. */
function renderLoadChart(containerW) {
	var n = loadHistory.length;
	var cores = loadCoreCount();
	if (!n || !cores) return aui.empty(_('No data'));

	var W = Math.round(containerW > 0 ? containerW : 600);
	var H = 240, padX = 6, padT = 14, padB = 6;
	var innerW = W - padX * 2, innerH = H - padT - padB;
	function xOf(i) { return padX + (HIST_WINDOW - n + i) / (HIST_WINDOW - 1) * innerW; }
	function yOf(pct) { return padT + innerH - aui.clampPct(pct) / 100 * innerH; }

	var gridStyle = 'stroke:var(--ds-border);stroke-width:1;stroke-dasharray:3 3';
	var lblStyle = 'fill:var(--ds-text-muted);font-size:9px;font-family:var(--ds-mono)';
	var nodes = [];

	[0, 25, 50, 75, 100].forEach(function(pct) {
		nodes.push(svgEl('line', {
			'x1': padX, 'y1': yOf(pct).toFixed(1),
			'x2': W - padX, 'y2': yOf(pct).toFixed(1),
			'style': gridStyle
		}));
	});
	/* Three anchor labels only: one per gridline would crowd a card that shares
	 * the row with the frequency chart. Each sits just above its own line. */
	[100, 50, 0].forEach(function(pct) {
		nodes.push(svgEl('text', { 'x': padX + 2, 'y': (yOf(pct) - 4).toFixed(1), 'style': lblStyle },
			[ document.createTextNode(pct + '%') ]));
	});

	for (var c = 0; c < cores; c++) {
		var segs = [], seg = [];
		for (var i = 0; i < n; i++) {
			/* A run boundary is unmeasured time, exactly like an unmeasurable
			 * core: break the line instead of bridging it. */
			if (i && loadHistory[i].t - loadHistory[i - 1].t > HIST_GAP_MS) {
				if (seg.length) { segs.push(seg); seg = []; }
			}
			var v = loadHistory[i].u[c];
			if (!isPercent(v)) {
				if (seg.length) { segs.push(seg); seg = []; }
				continue;
			}
			seg.push(xOf(i).toFixed(1) + ',' + yOf(v).toFixed(1));
		}
		if (seg.length) segs.push(seg);

		var lineStyle = 'fill:none;stroke:' + coreColor(c) +
			';stroke-width:2;stroke-linejoin:round;stroke-linecap:round' +
			(coreDashed(c) ? ';stroke-dasharray:5 3' : '');
		for (var s = 0; s < segs.length; s++) {
			/* A one-point segment has no length to stroke - draw the dot, which
			 * is also the whole curve during the first seconds of a run. */
			if (segs[s].length === 1) {
				var xy = segs[s][0].split(',');
				nodes.push(svgEl('circle', { 'cx': xy[0], 'cy': xy[1], 'r': '2.5', 'style': 'fill:' + coreColor(c) }));
			} else {
				nodes.push(svgEl('polyline', { 'points': segs[s].join(' '), 'style': lineStyle }));
			}
		}

		var headPct = loadHistory[n - 1].u[c];
		if (isPercent(headPct))
			nodes.push(svgEl('circle', {
				'cx': xOf(n - 1).toFixed(1), 'cy': yOf(headPct).toFixed(1),
				'r': '3', 'style': 'fill:' + coreColor(c)
			}));
	}

	var svg = svgEl('svg', {
		'viewBox': '0 0 ' + W + ' ' + H,
		'width': '100%', 'height': H,
		'style': 'display:block;cursor:crosshair',
		'role': 'img', 'aria-label': _('CPU Usage History')
	}, nodes);

	var hoverXs = [];
	for (var i = 0; i < n; i++) hoverXs.push(xOf(i));

	var dotColors = [];
	for (var c = 0; c < cores; c++) dotColors.push(coreColor(c));

	var wrap = E('div', { 'style': 'position:relative' }, [ svg ]);
	attachChartHover({
		svg: svg, wrap: wrap, xs: hoverXs,
		guideTop: padT, guideBottom: padT + innerH,
		dotColors: dotColors,
		time: function(i) { return loadHistory[i].t; },
		points: function(i) {
			var out = [];
			for (var c = 0; c < cores; c++) {
				var v = loadHistory[i].u[c];
				out.push(isPercent(v) ? { x: hoverXs[i], y: yOf(v) } : null);
			}
			return out;
		},
		rows: function(i) {
			var out = [];
			for (var c = 0; c < cores; c++) {
				var v = loadHistory[i].u[c];
				out.push({
					label: 'cpu' + c,
					value: isPercent(v) ? aui.fmtPct(v) : '—',
					color: coreColor(c)
				});
			}
			return out;
		}
	});
	return wrap;
}

/* ── Governor label ──
 * A read-only vocabulary now: the strings are the kernel's own governor names,
 * translated where the catalogue has them. */
function governorLabel(governor) {
	var labels = {
		conservative: _('conservative'), ondemand: _('ondemand'), performance: _('performance'),
		powersave: _('powersave'), schedutil: 'schedutil', userspace: _('userspace')
	};
	return labels[governor] || governor;
}

/* ── CPU section assembly ──
 * Everything here is fixed for the life of the page: the utilisation curve on
 * top, then the two cards. There is no frequency curve and no frequency card
 * any more - the boards this app ships on are fixed-clock, and an OPP graph of
 * a constant is a straight line that tells nobody anything - so nothing in this
 * section depends on board capability any more, and the poll can refresh the
 * card bodies in place instead of re-laying the grid. */
function renderLoadChartCard() {
	var host = document.getElementById('cpu-load-history-content');
	var w = (host && host.clientWidth) || 0;
	return aui.card({
		name: _('CPU Usage History'), accent: 'var(--ai-cpu)',
		body: E('div', { 'id': 'cpu-load-history-chart' }, [
			renderLoadLegend(), renderLoadChart(w)
		])
	});
}

function renderCpuSection(st) {
	var body = [
		E('div', { 'class': 'ai-grid ai-grid--2' }, [
			E('div', { 'id': 'cpu-load-history-content' }, [ renderLoadChartCard() ])
		]),
		E('div', {
			'class': 'ai-grid ai-grid--2', 'style': 'margin-top:var(--ds-sp-2)'
		}, [
			E('div', { 'id': 'cpu-info-content' }, [ renderCpuInfo(st) ]),
			E('div', { 'id': 'cpu-load-content' }, [ renderCoreLoad(st) ])
		])
	];
	return E('div', { 'id': 'cpu-body' }, body);
}

/* ── Offload switches ── */
function offloadState(enabled, blocked) {
	enabled = isEnabled(enabled);
	blocked = isEnabled(blocked);
	if (blocked) return { kind: 'warn', text: _('Router mode restricted') };
	return enabled ? { kind: 'ok', text: _('Enabled') } : { kind: '', text: _('Disabled') };
}

function renderOffloadSwitch(cfg) {
	return aui.switchRow({
		rowId: cfg.rowId,
		inputId: cfg.inputId,
		badgeId: cfg.badgeId,
		name: cfg.name,
		note: cfg.note,
		on: isEnabled(cfg.enabled),
		blocked: isEnabled(cfg.blocked),
		onLabel: _('Enabled'),
		offLabel: _('Disabled'),
		blockedLabel: _('Router mode restricted'),
		title: isEnabled(cfg.blocked)
			? (isEnabled(cfg.enabled) ? _('Suggested off in router mode') : _('Use hardware flow offload in router mode'))
			: (isEnabled(cfg.enabled) ? _('Click to disable') : _('Click to enable')),
		onChange: function(input) {
			var val = input.checked ? 1 : 0;
			var blocked = input.getAttribute('data-blocked') === '1';
			if (blocked && val === 1) {
				input.checked = false;
				ui.addNotification(null, E('p', {}, _('Use hardware flow offload in router mode')), 'warning');
				return;
			}
			input.disabled = true;
			cfg.callFn(val).then(function(r) {
				input.disabled = false;
				if (r && r.error) {
					input.checked = !val;
					ui.addNotification(null, E('p', {}, _('Error: ') + r.error), 'error');
				} else {
					updateOffloadControl(cfg.inputId, cfg.badgeId, cfg.rowId, val, blocked);
				}
			}).catch(function() {
				input.checked = !val;
				input.disabled = false;
			});
		}
	});
}

function renderOffloadControls(topo, vo, flo, apo, blocked) {
	// 单一事实来源：是否显示桥卸载开关完全由后端 airoha_bridge_offload_supported
	// 决定（vo.supported / apo.supported），不再按 compatible 字符串硬编码排除。
	var bridge = vo.supported !== false && apo.supported !== false;
	if (!bridge) return null;
	var controls = [
		renderOffloadSwitch({ rowId: 'flow-offload-row', inputId: 'flow-offload-select', badgeId: 'flow-offload-badge',
			name: _('Flow Offload'), enabled: flo.enabled, blocked: false, callFn: callSetFlowOffload })
	];
	if (bridge) {
		controls.unshift(renderOffloadSwitch({ rowId: 'vlan-offload-row', inputId: 'vlan-offload-select', badgeId: 'vlan-offload-badge',
			name: _('VLAN Offload'), enabled: vo.enabled, blocked: blocked, callFn: callSetVlanOffload }));
		controls.push(renderOffloadSwitch({ rowId: 'apmode-offload-row', inputId: 'apmode-offload-select', badgeId: 'apmode-offload-badge',
			name: _('AP Mode Acceleration'), enabled: apo.enabled, blocked: blocked, callFn: callSetApModeOffload }));
	}
	return E('div', { 'class': 'ai-offload-controls ai-grid' + (bridge ? ' ai-grid--3' : '') }, controls);
}

function updateOffloadControl(inputId, badgeId, rowId, enabled, blocked) {
	enabled = isEnabled(enabled);
	blocked = isEnabled(blocked);
	var input = document.getElementById(inputId);
	if (input) {
		input.setAttribute('data-blocked', blocked ? '1' : '0');
		if (!input.matches(':focus')) input.checked = enabled;
		input.disabled = blocked && !enabled;
	}
	var row = document.getElementById(rowId);
	if (row) {
		row.setAttribute('data-on', enabled ? 'true' : 'false');
		row.setAttribute('data-blocked', blocked ? 'true' : 'false');
	}
	var b = document.getElementById(badgeId);
	if (b) {
		var state = offloadState(enabled, blocked);
		b.className = 'ai-pill' + (state.kind ? ' ai-pill--' + state.kind : '');
		// Keep the leading dot; only the label text is swapped.
		b.textContent = '';
		b.appendChild(E('span', { 'class': 'dot' }));
		b.appendChild(document.createTextNode(state.text));
	}
}

function renderEthernetPorts(topo) {
	topo = topo || {};
	var ports = (Array.isArray(topo.ports) ? topo.ports : []).filter(function(p) {
		return p && p.netdev && !isSwitchCpuPort(p);
	}).sort(function(a, b) {
		var aUp = a.role === 'wan' || a.role === 'pon';
		var bUp = b.role === 'wan' || b.role === 'pon';
		return aUp !== bUp ? (aUp ? -1 : 1) : a.netdev.localeCompare(b.netdev, undefined, { numeric: true });
	});
	function count(value) {
		return typeof value === 'number' && isFinite(value) ? value.toLocaleString() : 'N/A';
	}
	/* A PON netdev reports carrier=1 as soon as the interface exists, which
	 * says nothing about whether the ONU ever reached the OLT - a stuck ONU
	 * therefore still showed "Link up". For the PON port derive the state from
	 * the registration data instead: no light (LOS), and any ONU state other
	 * than O5, mean the link is not actually carrying service. "LOS" and the
	 * O1-O7 codes are industry notation, so they need no translation and no
	 * new catalogue entry - which matters because a hand-deployed build never
	 * carries a rebuilt .lmo. */
	function ponLink(p) {
		var pon = topo.pon;
		if (!pon || pon.present !== 1 || !p) return null;
		if (p.role !== 'pon' && p.netdev !== pon.netdev) return null;
		if (pon.los === 1) return { text: _('Link down') + ' (LOS)', ok: false };
		var os = String(pon.onu_state || '').toUpperCase();
		if (os === 'O5') return { text: _('Link up') + ' (O5)', ok: true };
		if (/^O[1-7]$/.test(os)) return { text: _('Link down') + ' (' + os + ')', ok: false };
		return { text: _('Unknown'), ok: false };
	}
	function bytes(value) {
		return typeof value === 'number' && isFinite(value) ? '%1024.2mB'.format(value) : 'N/A';
	}
	/* Same 3px accent stripe the cards, tiles and switch rows carry, so the
	 * port table reads as one of the page's single elements instead of a bare
	 * grid. Ports are NPU-side hardware (GDM/GSW, the frame engine's own
	 * counters), so they take --ai-npu rather than the CPU/load accents. */
	var table = aui.table({
		accent: 'var(--ai-npu)',
		cols: [
			{ t: _('Port') }, { t: _('Path') }, { t: _('Link') }, { t: _('Speed / Duplex') },
			{ t: _('RX / TX bytes'), num: true }, { t: _('RX / TX packets'), num: true },
			{ t: _('RX / TX errors'), num: true }, { t: _('RX / TX dropped'), num: true }
		],
		rows: ports.map(function(p) {
			var state = p.present === false ? _('Unavailable') :
				p.carrier === 1 ? _('Link up') : p.carrier === 0 ? _('Link down') : _('Unknown');
			var up = p.carrier === 1;
			var plink = ponLink(p);
			if (plink) { state = plink.text; up = plink.ok; }
			// PON is asymmetric, so the backend reports its upstream rate
			// alongside the downstream one; every other port leaves it null.
			var speed = 'N/A';
			if (p.carrier === 1 && p.speed_mbps > 0 && p.speed_up_mbps > 0)
				speed = speedTag(p.speed_mbps) + '\u2193 / ' + speedTag(p.speed_up_mbps) + '\u2191';
			else if (p.carrier === 1 && p.speed_mbps > 0)
				// Same port capability tag the card labels use: "10G" next to a
				// column header that already says 协商速率 / 双工, instead of the
				// raw "10000 Mbps" the column used to carry.
				speed = speedTag(p.speed_mbps) || (p.speed_mbps + ' Mbps');
			var path = (p.kind === 'gsw' ? 'GSW' : 'GDM') + p.reg;
			if (p.nbq !== null && p.nbq !== undefined) path += ' / NBQ' + p.nbq;
			/* The name alone. It already carries the netdev for every board this
			 * ships on ("10G WAN" for wan, "1G LAN2" for lan2), so the old
			 * "10G WAN (wan)" printed the same word twice; the netdev is still
			 * one hover away, which is where a technical token belongs. */
			return [
				E('span', { 'title': p.netdev }, humanPortName(p, topo)),
				path, aui.pill(state, up ? 'ok' : ''),
				speed + (p.carrier === 1 && p.duplex ? ' / ' + p.duplex : ''),
				bytes(p.rx_bytes) + ' / ' + bytes(p.tx_bytes),
				count(p.rx_packets) + ' / ' + count(p.tx_packets),
				count(p.rx_errors) + ' / ' + count(p.tx_errors),
				count(p.rx_dropped) + ' / ' + count(p.tx_dropped)
			];
		}),
		emptyText: _('Port data unavailable')
	});
	table.classList.add('ai-port-table');
	return table;
}

/* Detailed MT7996 per-band health. The backend's has_wifi flag is
 * authoritative, so radio-less XG2010G systems do not render an empty
 * section.
 *
 * One card per radio band, laid out exactly like the NPU & Offload Engine
 * block above: the left border carries the band's own accent
 * (--ai-band-24 / -5 / -6, the same tokens the band gauges use) so the three
 * bands stay distinguishable at a glance instead of being three anonymous
 * table rows. Every value the old per-band table showed is still here - the
 * path moved into the card's right-hand tag, the airtime column became the
 * bar, and the rest are rows. */
function renderWifiDetails(wifi, ppe, ti, st) {
	wifi = wifi || {};
	if (!aui.hasWifiRadio(wifi)) return null;
	var bands = Array.isArray(wifi.bands) ? wifi.bands : [];
	var bandBnd = ppe && ppe.bnd && Array.isArray(ppe.bnd.band_bnd) ? ppe.bnd.band_bnd : [];
	var bandUnb = ppe && ppe.unb && Array.isArray(ppe.unb.band_unb) ? ppe.unb.band_unb : [];
	var cards = bands.map(function(bd) {
		var info = aui.BANDS[bd.band];
		var accent = info ? 'var(' + info.varName + ')' : 'var(--ds-border-strong)';
		var name = info ? info.full : _('Frequency band') + ' ' + bd.band;
		var txPackets = Number(bd.tx_packets) || 0;
		var txRetries = Number(bd.tx_retries) || 0;
		var retry = txPackets + txRetries > 0 ? txRetries / (txPackets + txRetries) * 100 : (Number(bd.retry_pct) || 0);
		var retryColor = retry > 20 ? 'var(--ds-error)' : retry > 5 ? 'var(--ds-warn)' : 'var(--ds-ok)';
		var health = (bd.stations || 0) === 0 ? { text: _('No clients'), kind: '' } :
			retry > 50 ? { text: _('Poor'), kind: 'error' } :
				retry > 20 ? { text: _('Fair'), kind: 'warn' } : { text: _('Good'), kind: 'ok' };
		var txQueue = getTxQueue(ti, bd.band);
		var queueType = txQueue && txQueue.type ? String(txQueue.type).toUpperCase() :
			(isEnabled(st && st.npu_loaded) ? 'NPU' : 'DMA');
		var signal = (bd.stations || 0) > 0 ? (bd.avg_signal || 0) + ' / ' + (bd.min_signal || 0) : 'N/A';
		var airtime = Number(bd.airtime_efficiency) || 0;
		return aui.card({
			name: name,
			tag: 'P7 / ' + queueType,
			accent: accent,
			body: [
				aui.bar({
					pct: airtime,
					accent: accent,
					title: _('Airtime'),
					right: airtime + '%'
				}),
				aui.row(_('Status'), aui.pill(health.text, health.kind)),
				aui.row(_('Clients'), String(bd.stations || 0)),
				aui.row(_('Retry'), E('span', { 'style': 'color:' + retryColor }, retry.toFixed(1) + '%')),
				aui.row(_('PHY / Expected'), aui.fmtMbps(bd.avg_phy_rate) + ' / ' + aui.fmtMbps(bd.avg_exp_throughput)),
				aui.row(_('Failed'), String(bd.tx_failed || 0)),
				aui.row(_('Signal'), signal),
				aui.row(_('TX'), aui.fmtMbps(bd.tx_mbps) + ' Mbps'),
				aui.row('BND / UNB', (bandBnd[bd.band] || 0) + ' / ' + (bandUnb[bd.band] || 0))
			]
		});
	});
	var body = cards.length
		? E('div', {}, [
			E('div', { 'class': 'ai-subhead', 'style': 'margin-top:0' }, _('Frequency band')),
			E('div', { 'class': 'ai-grid ai-grid--3' }, cards)
		])
		: aui.empty(_('No entries'));
	return aui.section({
		title: _('WiFi Band Details'),
		body: body
	});
}

/* ── Frame Engine (GDM ports + CDM engines) ──────────────────────────────
 * The GDM data MACs and the CDM DMA engines have no debugfs node, so the
 * backend reads their counters straight from the frame-engine registers.
 * Those addresses belong to the SoC, not the board, so the same
 * GDM1/GDM2/GDM4 and CDM1/CDM2 set decodes on both boards this app ships to:
 * the XR1710G (WiFi router: switch CPU port, USXGMII WAN, USXGMII LAN2) and
 * the Nokia XG-040G-MD (PON ONU: switch CPU port, PON uplink, lan1). Only the
 * port *names* differ, and those come from the device-tree topology, exactly
 * like the Ethernet-ports table, so each card labels itself per board.
 *
 * The counters are free-running 32-bit registers: they wrap and reset only on
 * reboot, so they are shown as plain totals, never as rates. */

/* First topology entry behind a GDM register index, or null. Used both to keep
 * the GDM cards limited to the ports this board exposes and to give each card
 * the same board-aware name the port table uses. */
function gdmPort(topo, reg) {
	var ports = (topo && Array.isArray(topo.ports)) ? topo.ports : [];
	for (var i = 0; i < ports.length; i++) {
		var p = ports[i];
		if (p && p.kind === 'gdm' && Number(p.reg) === Number(reg)) return p;
	}
	return null;
}

/* Share of a CDM's RX frames the PPE forwarded without the CPU ever seeing
 * them. A HIGH share is the good case here - it is work the CPU never did -
 * which is the opposite of every load gauge elsewhere on the page. A low share
 * is deliberately NOT an error: the engine also carries control/host traffic
 * the PPE is never meant to touch, so it stays neutral rather than red. */
function cdmOffloadAccent(pct, total) {
	if (total <= 0) return 'var(--ds-border-strong)';
	if (pct >= 80) return 'var(--ds-ok)';
	if (pct >= 50) return 'var(--ds-warn)';
	return 'var(--ai-npu)';
}

function renderGdmCard(g, topo) {
	g = g || {};
	var tx = Number(g.tx) || 0, rx = Number(g.rx) || 0;
	var txDrop = Number(g.tx_drop) || 0, rxDrop = Number(g.rx_drop) || 0;
	// The three RX reasons behind +0x50/+0x54/+0x58: resource (no buffer),
	// overflow (queue full) and error (bad frame). They are separate MIB words,
	// so a single "RX dropped" line would hide which one fired.
	var rcDrop = Number(g.rx_rc_drop) || 0, overDrop = Number(g.rx_over_drop) || 0;
	var errDrop = Number(g.rx_error_drop) || 0;
	var port = gdmPort(topo, g.reg);

	/* A GDM card carries the same link state as the port card above it: without
	 * the pill, a port whose PHY is down was indistinguishable from an idle one
	 * that is simply carrying no traffic - the counters are zero in both cases.
	 * The port name moves out of the tag (the pill needs it) and into the card
	 * body, where it reads as the port this MAC serves. */
	var up = port ? port.carrier === 1 : false;
	var drops = txDrop + rxDrop + rcDrop + overDrop + errDrop;
	/* GDM1 fronts the internal switch and its topology label lists every LAN
	 * behind it ("LAN · 10G LAN2, 1G LAN3, 1G LAN4"), which does not fit beside
	 * a row label in a quarter-width card. The MAC's identity is enough here;
	 * the individual LANs have their own cards in the ports section. */
	var pname = !port ? _('No port')
		: isSwitchCpuPort(port) ? _('Internal Switch') : humanPortName(port, topo);
	var body = [
		aui.row(_('Port'), pname),
		aui.row(_('TX packets'), aui.fmtK(tx)),
		aui.row(_('RX packets'), aui.fmtK(rx))
	];
	if (drops > 0) body.push(aui.row(_('Dropped'), aui.fmtK(drops), 'ai-err'));
	return aui.card({
		name: 'GDM' + g.reg,
		tag: port ? aui.pill(up ? _('Link up') : _('Link down'), up ? 'ok' : '') : null,
		accent: drops > 0 ? 'var(--ds-warn)'
			: (tx > 0 || rx > 0) ? 'var(--ai-npu)' : 'var(--ds-border-strong)',
		body: body
	});
}

/* Share of the CDM RX split over the last render interval. Kept per engine
 * outside the render so it survives re-renders, and null on the first sample
 * (or after a counter reset), where the cumulative value is the only answer. */
var cdmPrevSample = {};
function cdmDeltaShare(c) {
	var reg = String(c.reg);
	var cpu = Number(c.rx_cpu) || 0, hwf = Number(c.rx_hwf) || 0;
	var prev = cdmPrevSample[reg];
	cdmPrevSample[reg] = { cpu: cpu, hwf: hwf };
	if (!prev) return null;
	var dc = cpu - prev.cpu, dh = hwf - prev.hwf;
	// The registers only grow; a decrease means a reset or a different boot,
	// so that interval carries no share.
	if (dc < 0 || dh < 0 || dc + dh <= 0) return null;
	return dh / (dc + dh) * 100;
}

/* A drop-counter row. Only the error colour depends on the value, so the row
 * itself can stay in place: keeping it lets both CDM cards show the same set of
 * counters in the same order. */
function dropRow(label, value) {
	var v = Number(value) || 0;
	return aui.row(label, aui.fmtK(v), v > 0 ? 'ai-err' : '');
}

function renderCdmCard(c, split) {
	c = c || {};
	var cpu = Number(c.rx_cpu) || 0, hwf = Number(c.rx_hwf) || 0;
	var total = cpu + hwf;
	var cumPct = total > 0 ? hwf / total * 100 : 0;
	var deltaPct = cdmDeltaShare(c);
	var pct = deltaPct === null ? cumPct : deltaPct;
	var perCpu = [c.rx_cpu0, c.rx_cpu1, c.rx_cpu2, c.rx_cpu3].map(function(v) { return Number(v) || 0; });
	var body = [
		// HWF is the hardware-forwarding channel of this CDM, so the bar is the
		// share of frames this engine received that bypassed the CPU - not the
		// system-wide offload ratio and not the PPE binding rate.
		// Registers are since-boot accumulators: the cumulative ratio is
		// dominated by everything that happened since power-on and barely moves
		// between two polls, so the bar uses the interval and the
		// "Since boot" line keeps the cumulative value visible.
		aui.bar({
			pct: pct,
			accent: cdmOffloadAccent(pct, total),
			title: _('HW forwarding share'),
			right: total > 0 ? aui.fmtPct(pct, 1) : '—'
		}),
		aui.row(_('CPU path'), aui.fmtK(cpu)),
		aui.row(_('HW forwarded'), aui.fmtK(hwf)),
		// Register +0x00 of this CDM is TX_OK_CNT (vendor CDMA1_TX_OK_CNT): the
		// frames the engine handed towards the switch. Measured deltas track the
		// egress of its own netdevs (CDM1 vs lan1 tx, CDM2 vs pon0 tx), so this
		// line belongs to the transmit stream and must never be summed with the
		// RX split above.
		aui.row(_('Transmitted'), aui.fmtK(c.tx)),
		aui.row(_('Since boot'), total > 0 ? aui.fmtPct(cumPct, 1) : '—'),
		// Everything below is rendered unconditionally, zeros included. CDM1 and
		// CDM2 are the two CPU ports of the same IP block and the two receive
		// channels are mutually exclusive in practice (one engine carries the
		// fast-path stream, the other the PPE-bound stream), so hiding the idle
		// channel's rows made the cards different heights and made a real 0 read
		// like a field that was never collected.
		aui.row(_('HW fast path'), aui.fmtK(c.rx_hwf_fast)),
		aui.row(_('Per-CPU RX'), perCpu.map(function(v) { return aui.fmtK(v); }).join(' · '))
	];
	/* The three drop channels keep their own row while any of them is non-zero,
	 * so a real drop still says which channel produced it. When all three are
	 * zero - the normal case, and the one both cards are almost always in -
	 * they collapse into a single "Dropped 0" line instead of three rows of
	 * zeros. Both cards stay the same height in that case, which is what the
	 * three-row version was protecting. */
	var dropTotal = (Number(c.rx_cpu_drop) || 0) + (Number(c.rx_hwf_drop) || 0) + (Number(c.rx_hwf_fast_drop) || 0);
	if (dropTotal > 0) {
		body.push(dropRow(_('CPU dropped'), c.rx_cpu_drop));
		body.push(dropRow(_('HW dropped'), c.rx_hwf_drop));
		body.push(dropRow(_('HW fast dropped'), c.rx_hwf_fast_drop));
	} else {
		body.push(aui.row(_('Dropped'), '0'));
	}
	// CDM1 is the CPU port of PPE engine 1 and CDM2 of engine 2, so each card
	// also carries the flow-table slice counted by that engine. The split comes
	// from the PPE probe (20 s cadence) and is undefined until it lands, and on
	// a single-PPE SoC there is no CDM2 slice at all.
	split = split || {};
	var eng = Number(c.reg) === 2 ? 'ppe2' : Number(c.reg) === 1 ? 'ppe1' : '';
	if (eng && typeof split[eng] !== 'undefined')
		body.push(aui.row(eng === 'ppe2' ? _('PPE2 table') : _('PPE1 table'),
			aui.fmtK(split[eng]) + ' · BND ' + aui.fmtK(split[eng + '_bound'] || 0)));
	// The engine identity is the port role, not the direction: the mainline
	// driver hands QDMA0 (CDM1) to the LAN netdevs and QDMA1 (CDM2) to the WAN
	// one, and appends the PPE id accordingly (airoha_dev_set_qdma()).
	var role = Number(c.reg) === 2 ? 'WAN' : Number(c.reg) === 1 ? 'LAN' : '';
	return aui.card({
		name: 'CDM' + c.reg,
		tag: role || 'CPU DMA',
		accent: 'var(--ai-npu)',
		body: body
	});
}

function renderPseBufferCard(pse) {
	pse = pse || {};
	var used = Number(pse.used) || 0, free = Number(pse.free) || 0;
	var total = used + free;
	var pct = total > 0 ? used / total * 100 : 0;
	/* FE+0x100 carries the hardware's own high-water mark of this pool
	 * (SHARE_USED_CNT_MAX). A burst is emptied again within milliseconds, so the
	 * instantaneous word a poll reads is back to zero by the time the card
	 * renders; the peak is the only honest answer to "how close has this pool
	 * come to running out". Undefined on a backend that predates the field. */
	var peak = (pse.peak === undefined || pse.peak === null) ? null : (Number(pse.peak) || 0);
	var peakPct = (peak !== null && total > 0) ? Math.min(100, peak / total * 100) : null;
	/* The bar takes --ds-ok, the same token the Crypto Engine card's "Activated"
	 * pill paints with, so the fill reads as one accent across the page. No live
	 * "used / total" readout either: the pool sits at zero almost every sample,
	 * so the head only names the resource and the row below carries the peak. */
	var barOpts = {
		pct: pct,
		accent: 'var(--ds-ok)',
		pill: true,
		title: _('HW Buffer')
	};
	if (peakPct !== null) barOpts.peak = peakPct;
	var body = [ aui.bar(barOpts) ];
	/* "Used 41 / Total 12.06 K · Share 0.3%" was three words too many for a card
	 * that now shares its row with the GDM MACs; the label already says Peak. */
	if (peakPct !== null)
		body.push(aui.row(_('Peak'),
			aui.fmtK(peak) + ' / ' + aui.fmtK(total) + ' · ' + aui.fmtPct(peakPct, 1)));
	return aui.card({
		name: _('PSE shared buffer'),
	/* Current usage is near zero almost all the time, so the card tag shows the
	 * peak share instead - the only number on this card that carries signal. */
		tag: peakPct !== null ? aui.fmtPct(peakPct, 1) : '',
		accent: 'var(--ai-npu)',
		body: body
	});
}

/* Map the backend's unavailability reason to a translatable sentence. */
function frameEngineReason(fe) {
	if (fe && fe.reason === 'devmem_unavailable')
		return _('Frame Engine counters need the devmem applet (CONFIG_BUSYBOX_CONFIG_DEVMEM) and /dev/mem; neither is available on this build.');
	return _('Frame Engine counters are unavailable on this build.');
}

/* The whole frame-engine block, rendered inside the NPU & Offload Engine
 * section. GDM cards are restricted to the ports this board exposes; the CDM
 * cards and the PSE buffer are board-independent. */
function renderFrameEngine(fe, topo, split) {
	fe = fe || {};
	var head = E('div', { 'class': 'ai-subhead', 'style': 'margin-top:0' }, _('Frame Engine'));
	if (fe.available === false) {
		return E('div', { 'style': 'margin-top:var(--ds-sp-4)' }, [
			head, aui.empty(frameEngineReason(fe))
		]);
	}
	// Keep only the GDM ports this board actually exposes. When the topology
	// is not known yet (first paint) the filter fails open rather than hiding
	// every card until the first poll lands.
	var knownPorts = !!(topo && Array.isArray(topo.ports) && topo.ports.length);
	var gdm = (Array.isArray(fe.gdm) ? fe.gdm : []).filter(function(g) {
		return g && (!knownPorts || gdmPort(topo, g.reg));
	});
	var cdm = Array.isArray(fe.cdm) ? fe.cdm : [];
	/* The PSE pool used to sit alone on a full-width card, which left a long
	 * empty bar across the page for a number that is 0 almost always. It shares
	 * the first row with the GDM MACs instead: same height as its neighbours,
	 * and the row reads as "the frame engine's resources and the ports they
	 * serve" - which is also why the separate "GDM Ports" subhead is gone. */
	var row = [ renderPseBufferCard(fe.pse) ].concat(gdm.map(function(g) {
		return renderGdmCard(g, topo);
	}));
	var blocks = [ head, E('div', { 'class': 'ai-grid ai-grid--4' }, row) ];
	if (cdm.length) {
		blocks.push(E('div', { 'class': 'ai-subhead' }, _('CDM Engines')));
		blocks.push(E('div', { 'class': 'ai-grid ai-grid--3' }, cdm.map(function(c) {
			return renderCdmCard(c, split);
		})));
	}
	return E('div', { 'style': 'margin-top:var(--ds-sp-4)' }, blocks);
}

/* NSS (EIP93) crypto engine. Kept out of the frame-engine block: it is a
 * separate IP block on the SoC and only the user-space half (/dev/crypto via
 * cryptodev + OpenSSL devcrypto) depends on packages rather than the kernel.
 * The card is returned unbundled so the caller can lay it out side by side
 * with the PPE Engines and NPU cards in one three-column grid. */
function renderCryptoStatus(cr) {
	if (!cr) {
		return aui.card({
			name: _('Crypto Engine'), tag: 'EIP93 · AES / DES / authenc',
			accent: 'var(--ds-border-strong)',
			body: [ aui.empty(_('No data')) ]
		});
	}

	var active = Number(cr.present) === 1;
	var algos = Number(cr.algos) || 0;
	/* /proc/crypto prints refcnt as the number of tfm users of an algorithm,
	 * but every registered algorithm holds a permanent baseline of 1: an idle
	 * engine still reads refcnt == algos (32/32 measured on 6.18, and the
	 * generic software blocks read the same 1), so the raw sum is a static
	 * mirror of the algorithm count and never moves with load. The backend
	 * publishes `sessions` = sum of max(0, refcnt - 1), the only part that can
	 * actually change; a backend predating the field falls back to the same
	 * subtraction here. */
	var sessions = (cr.sessions === undefined || cr.sessions === null)
		? Math.max(0, (Number(cr.refcnt) || 0) - algos)
		: (Number(cr.sessions) || 0);

	var engineRow;
	if (Number(cr.openssl) !== 1)
		engineRow = _('openssl-util not installed');
	else if (cr.engine === 1)
		engineRow = aui.pill(_('Available'), 'ok');
	else if (cr.engine === 0)
		engineRow = aui.pill(_('Unavailable'), 'warn');
	else
		engineRow = '—';

	var rows = [
		// Bound device leads the card: it names the hardware block first, the
		// run-state pill reads as its qualifier.
		aui.row(_('Bound device'), active && Number(cr.bound) === 1 ? '1fb70000.crypto' : _('Not bound')),
		aui.row(_('Status'), active ? aui.pill(_('Activated'), 'ok') : aui.pill(_('Driver unavailable'), 'warn')),
		aui.row('/dev/crypto', Number(cr.devcrypto) === 1 ? aui.pill(_('Available'), 'ok') : aui.pill(_('Unavailable'), 'warn')),
		aui.row(_('OpenSSL devcrypto'), engineRow),
		// Live tfm users above the registration baseline, kept directly above
		// the cumulative counter it qualifies.
		aui.row(_('Active sessions'), String(sessions)),
		// Since-boot completion interrupts: the sum of the leading per-CPU
		// columns only. The hwirq number on the same /proc/interrupts line is an
		// identifier, not a count, so it must stay out of the total.
		aui.row(_('Cumulative IRQs'), typeof cr.irqs === 'number' ? aui.fmtK(cr.irqs) : '—')
	];
	return aui.card({
		name: _('Crypto Engine'), tag: 'EIP93 · AES / DES / authenc',
		accent: active ? 'var(--ai-npu)' : 'var(--ds-border-strong)',
		body: rows
	});
}

/* ── NPU and PPE engine status ── */
/* Compact label for the NPU reserved-memory carveout: the single region on
 * every board seen so far is the firmware binary, so name it; a multi-region
 * DTS collapses to a count plus the total size. Sizes arrive as the strings
 * parsed out of dmesg ("10240 KiB"). */
function npuMemLabel(regions) {
	var list = Array.isArray(regions) ? regions : [];
	if (!list.length) return '—';
	if (list.length === 1 && list[0] && list[0].size)
		return (list[0].name ? list[0].name + ' · ' : '') + list[0].size;
	var total = 0;
	list.forEach(function(r) {
		var m = /^([\d.]+)\s*(KiB|MiB|GiB)/.exec((r && r.size) || '');
		if (!m) return;
		var v = parseFloat(m[1]);
		total += m[2] === 'KiB' ? v * 1024 : m[2] === 'MiB' ? v * 1048576 : v * 1073741824;
	});
	return total ? list.length + ' · ' + Math.round(total / 1048576) + ' MiB' : '—';
}

function renderEngineStatus(st, ppe) {
	st = st || {}; ppe = ppe || {};
	var npuActive = isEnabled(st.npu_loaded);
	var npuCard = aui.card({
		name: 'NPU', accent: npuActive ? 'var(--ai-npu)' : 'var(--ds-border-strong)',
		body: [
			// Run state as a pill in a Status row, the same way the Crypto Engine
			// card reports it, instead of a plain "ACTIVE" header tag.
			aui.row(_('Status'), npuActive ? aui.pill(_('Activated'), 'ok') : aui.pill(_('Driver unavailable'), 'warn')),
			// One fact per row, matching the single-line rows of PPE Engines.
			aui.row(_('Firmware'), st.npu_version || 'Unknown'),
			aui.row(_('Clock'), st.npu_clock ? Math.round(st.npu_clock / 1000000) + ' MHz' : 'N/A'),
			aui.row(_('Cores'), (st.npu_cores || 0) + ' ' + _('cores') + ' · PCIe RAM'),
			// Device node and the firmware carveout are the only two facts the
			// driver publishes that the rows above do not already carry.
			aui.row(_('Device'), st.npu_device || '—'),
			aui.row(_('Reserved Memory'), npuMemLabel(st.memory_regions))
		]
	});

	var unbCount = (Array.isArray(ppe.entries) ? ppe.entries : []).filter(function(e) {
		return e && e.state && e.state !== 'BND';
	}).length;
	// Per-engine split of the flow table. The backend buckets every scanned
	// record by index (0-8191 PPE1, 8192-16383 PPE2, >=16384 shared DRAM), so
	// these counts are not limited to the 1024-entry sample the table below
	// shows. ppe1 is absent on a backend that predates the split, and ppe2
	// stays 0 on the single-PPE AN7583 - both cases hide their row.
	var ppe1 = Number(ppe.ppe1) || 0, ppe2 = Number(ppe.ppe2) || 0;
	var dram = Number(ppe.dram) || 0;
	var ppeRows = [
		aui.row(_('Bound'), String(st.offload_bound || 0)),
		aui.row(_('Total'), String(st.offload_total || 0)),
		aui.row(_('Unbound'), String(unbCount))
	];
	if (typeof ppe.ppe1 !== 'undefined')
		ppeRows.push(aui.row(_('PPE1 table'), ppe1 + ' · BND ' + (Number(ppe.ppe1_bound) || 0)));
	if (ppe2 > 0)
		ppeRows.push(aui.row(_('PPE2 table'), ppe2 + ' · BND ' + (Number(ppe.ppe2_bound) || 0)));
	if (dram > 0)
		ppeRows.push(aui.row(_('Shared DRAM'), dram + ' · BND ' + (Number(ppe.dram_bound) || 0)));
	/* Entries whose L2 header is still all-zero. They are reported separately
	 * because a table filled with them cannot bind to the hardware path, so a
	 * high count alongside a low Bind rate is the actual explanation. The field
	 * is only emitted by a backend that can see individual records. */
	var zeroL2 = Number(ppe.zero_l2) || 0;
	if (typeof ppe.zero_l2 !== 'undefined' && zeroL2 > 0) {
		// Red only once these entries dominate the table: a few all-zero L2
		// headers are ordinary churn, but past half the table the entries that
		// could bind have been crowded out, which is the fault worth flagging.
		var tableTotal = Number(ppe.total) || Number(st.offload_total) || 0;
		var zeroL2Share = tableTotal > 0 ? zeroL2 / tableTotal : 0;
		ppeRows.push(aui.row(_('Zero-L2'),
			zeroL2 + ' · BND ' + (Number(ppe.zero_l2_bound) || 0),
			zeroL2Share >= 0.5 ? 'ai-err' : ''));
	}
	var ppeCard = aui.card({
		name: 'PPE Engines', tag: 'P4 + P8', accent: 'var(--ai-npu)',
		body: ppeRows
	});

	/* Both cards come back unbundled: the caller lines them up, together with
	 * the EIP93 crypto card, as three equal columns of one grid. */
	return [ ppeCard, npuCard ];
}

/* ── PPE flow table ── */
var PPE_SHOWN_MAX = 50;
var ppeStateFilter = '', ppeTypeFilter = '', ppePage = 0;
var ppeCurrentEntries = [], ppeCurrentMeta = {};

function filteredPpeEntries(entries) {
	return (entries || []).filter(function(e) {
		return e && (!ppeStateFilter || e.state === ppeStateFilter) &&
			(!ppeTypeFilter || String(e.type).split(' ')[0] === ppeTypeFilter);
	});
}

/* Header badge: how many entries the backend returned, the v4/v6 split, how
 * many are actually rendered, and how many were dropped by the client cap. */
function ppeCountText(entries) {
	entries = entries || [];
	if (ppeCurrentMeta.available === false) return _('PPE table unavailable');
	var total = ppeCurrentMeta.total === undefined ? entries.length : ppeCurrentMeta.total;
	var s = total + ' ' + _('flows') + ' · BND ' +
		(ppeCurrentMeta.bound || 0) + '/UNB ' + (ppeCurrentMeta.unbound || 0) +
		' · IPv4 ' + (ppeCurrentMeta.ipv4 || 0) + '/IPv6 ' + (ppeCurrentMeta.ipv6 || 0) +
		'/L2B ' + (ppeCurrentMeta.l2b || 0);
	if (ppeCurrentMeta.truncated) s += ' · ' + _('showing') + ' ' + entries.length + ' / ' + total;
	return s;
}

function ppeRows(entries) {
	entries = filteredPpeEntries(entries);
	if (!entries || !entries.length)
		return [ E('tr', {}, [ E('td', { 'colspan': '9' }, aui.empty(ppeCurrentMeta.available === false ? _('PPE table unavailable') : _('No matching flows'))) ]) ];
	return entries.slice(ppePage * PPE_SHOWN_MAX, (ppePage + 1) * PPE_SHOWN_MAX).map(function(e) {
		var eth = e.eth || '';
		if (eth === '00:00:00:00:00:00->00:00:00:00:00:00') eth = '-';
		var state = e.state === 'BND' ? aui.badge(e.state, 'bnd') : aui.badge(e.state, 'unb');
		/* data-state drives the row tint in the stylesheet. BND ("bound") is the
		 * state the reader actually wants to see - it means the hardware, not the
		 * CPU, is carrying that flow - and it was one small badge among nine
		 * columns before. */
		return E('tr', { 'data-state': e.state || '' }, [
			E('td', { 'class': 'ai-num', 'data-label': _('Index') }, e.index),
			E('td', { 'data-label': _('State') }, state),
			E('td', { 'data-label': _('Type') }, e.type + (e.proto ? ' ' + e.proto : '')),
			E('td', { 'data-label': 'VLAN' }, e.vlan || '-'),
			E('td', { 'data-label': _('Original Flow'), 'style': 'color:var(--ai-npu)' }, e.orig || '-'),
			E('td', { 'data-label': _('New Flow') }, e.new_flow || '-'),
			E('td', { 'data-label': _('Ethernet') }, eth),
			E('td', { 'data-label': _('Packets'), 'class': 'ai-num' }, e.packets === null || e.packets === undefined ? 'N/A' : String(e.packets)),
			E('td', { 'data-label': _('Bytes'), 'class': 'ai-num' }, e.bytes === null || e.bytes === undefined ? 'N/A' : String(e.bytes))
		]);
	});
}

function renderPpeTable(entries) {
	function selectFilter(label, values, change) {
		return E('select', { 'aria-label': label, 'change': function(event) {
			change(event.target.value);
			ppePage = 0;
			updatePpeTable(ppeCurrentEntries);
		} }, [E('option', { value: '' }, label)].concat(values.map(function(value) {
			return E('option', { value: value }, value);
		})));
	}
	var tools = E('div', { 'style': 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px' }, [
		selectFilter(_('All states'), ['BND', 'UNB', 'FIN'], function(value) { ppeStateFilter = value; }),
		selectFilter(_('All types'), ['IPv4', 'IPv6', 'L2B', 'DS-LITE', '6RD'], function(value) { ppeTypeFilter = value; }),
		E('button', { 'type': 'button', 'class': 'cbi-button', 'id': 'ppe-prev', 'title': _('Previous page'),
			'aria-label': _('Previous page'), 'style': 'width:32px;height:32px', 'click': function() {
				ppePage = Math.max(0, ppePage - 1); updatePpeTable(ppeCurrentEntries);
			} }, '\u2039'),
		E('span', { 'id': 'ppe-page', 'style': 'min-width:6em;text-align:center;font-variant-numeric:tabular-nums' }, '1 / 1'),
		E('button', { 'type': 'button', 'class': 'cbi-button', 'id': 'ppe-next', 'title': _('Next page'),
			'aria-label': _('Next page'), 'style': 'width:32px;height:32px', 'click': function() {
				ppePage++; updatePpeTable(ppeCurrentEntries);
			} }, '\u203a')
	]);
	// Accent stripe like every other single element on the page; PPE is the
	// NPU's own flow table, so it takes the same --ai-npu as the port table.
	return E('div', {}, [tools, E('div', {
		'class': 'ai-table-wrap ai-table-wrap--accent',
		'style': '--ai-accent:var(--ai-npu)'
	}, [
		E('table', { 'class': 'ai-table ai-table--mono ai-table--stack', 'id': 'ppe-entries-table' }, [
			E('thead', {}, [
				E('tr', {}, [
					E('th', { 'scope': 'col' }, _('Index')), E('th', { 'scope': 'col' }, _('State')),
					E('th', { 'scope': 'col' }, _('Type')), E('th', { 'scope': 'col' }, 'VLAN'),
					E('th', { 'scope': 'col' }, _('Original Flow')), E('th', { 'scope': 'col' }, _('New Flow')),
					E('th', { 'scope': 'col' }, _('Ethernet')), E('th', { 'scope': 'col' }, _('Packets')),
					E('th', { 'scope': 'col' }, _('Bytes'))
				])
			]),
			E('tbody', {}, ppeRows(entries))
		])
	])]);
}

function updatePpeTable(entries, metadata) {
	ppeCurrentEntries = entries || [];
	if (metadata) ppeCurrentMeta = metadata;
	var filtered = filteredPpeEntries(ppeCurrentEntries);
	var pages = Math.max(1, Math.ceil(filtered.length / PPE_SHOWN_MAX));
	ppePage = Math.max(0, Math.min(ppePage, pages - 1));
	var tbody = document.querySelector('#ppe-entries-table tbody');
	if (!tbody) return;
	tbody.innerHTML = '';
	ppeRows(entries).forEach(function(row) { tbody.appendChild(row); });
	var badge = document.getElementById('ppe-count');
	if (badge) badge.textContent = ppeCountText(entries);
	var page = document.getElementById('ppe-page');
	if (page) page.textContent = (ppePage + 1) + ' / ' + pages;
	var previous = document.getElementById('ppe-prev'), next = document.getElementById('ppe-next');
	if (previous) previous.disabled = ppePage === 0;
	if (next) next.disabled = ppePage + 1 >= pages;
}

/* ── Main view ── */
return view.extend({
	load: function() {
		// Progressive rendering: don't block on RPC calls, let the page render
		// immediately. Stylesheet goes in here (not in render) so it is already
		// applied when the view node is inserted — no width flash, matching the
		// fancontrol views' approach.
		aui.ensureCss();
		return Promise.resolve([]);
	},

	render: function(data) {
		data = data || [];
		aui.ensureCss();
		// The main live path uses named getDashboard fields and bypasses this
		// array. These defaults retain the legacy Promise.all slot order used by
		// the old-backend fallback below. load() currently returns an empty array,
		// but if it ever starts returning legacy data this index map must still
		// match that fallback: status, PPE, token, flow, AP mode, device mode,
		// topology, VLAN, WiFi and frame engine.
		var st = data[0] || {}, ppe = data[1] || {}, ti = data[2] || {};
		var flo = data[3] || { enabled: 0 };
		var apo = data[4] || { enabled: 0 };
		var dm = data[5] || {};
		var topo = data[6] || {};
		var vo = data[7] || { enabled: 0 };
		var fe = data[9] || {};
		var bridgeBlocked = isBridgeOffloadBlocked(dm);
		var entries = Array.isArray(ppe.entries) ? ppe.entries : [];
		var latestPpeEntries = entries;
		var ppeRequestSequence = 0;
		var latestPpeRequest = 0;
		// Last per-engine PPE slice seen in a real (non-deferred) PPE round. The
		// CDM cards and the PPE engine card show it, but the PPE probe is on a
		// 20 s cadence while the rest of the page re-renders every 10 s, so it has
		// to outlive a single reply. zero_l2 rides on the same parse, and on a
		// backend that predates the split it is the only one of the two present.
		var latestPpeSplit = (typeof ppe.ppe1 !== 'undefined' || typeof ppe.zero_l2 !== 'undefined') ? ppe : null;
		var updatedEl = null;
		function markUpdated() {
			if (updatedEl)
				updatedEl.textContent = _('Updated %s').format(new Date().toLocaleTimeString());
		}

		// The page auto-polls every 10 s; the only "refresh" affordance is the
		// system-level updated-time stamp on the right. Manual Refresh /
		// Pause-Resume buttons were removed — they conflicted with it.
		updatedEl = E('span', { 'class': 'ai-updated' }, '');

		// Width policy: the root carries no width rules of its own (fancontrol
		// style) — the layout inherits the theme's content width, so the
		// late-injected stylesheet never changes geometry (no width flash).
		var view = E('div', { 'class': 'cbi-map airoha-page' }, [
			E('h2', {}, _('Airoha SoC Status')),

			/* The freshness stamp. It was already built and updated on every
			 * poll but never inserted, so a 10 s-polling page gave the reader no
			 * way to tell a live reading from a frozen one. It rides in the
			 * toolbar row under the title, right-aligned, where a dashboard
			 * usually puts it. */
			E('div', {
				'class': 'ai-toolbar',
				'style': 'margin:0 0 var(--ds-sp-3)'
			}, [
				E('span', { 'class': 'ai-spacer' }),
				updatedEl
			]),

			// Processor first: it is the section that changes every poll, and the
			// ports below it are a wiring map that only changes when a cable does.
			// The body is built by renderCpuSection(), which is capability-driven:
			// a board without cpufreq telemetry simply gets fewer cards and the
			// auto-fit grid reflows, instead of showing a disabled control block
			// with a "not supported" line under it.
			aui.section({
				title: _('Processor'),
				body: renderCpuSection(st)
			}),

			aui.section({
				title: _('Ethernet Ports'),
				body: E('div', { 'id': 'ethernet-ports' }, renderEthernetPorts(topo))
			}),

			// NPU and hardware offload controls/status.
			aui.section({
				title: _('NPU & Offload Engine'),
				body: E('div', {}, [
					renderSummary(st, ti),
					E('div', { 'id': 'offload-controls', 'style': 'margin-top:var(--ds-sp-3)' },
						renderOffloadControls(topo, vo, flo, apo, bridgeBlocked)),
					/* PPE Engines, NPU and EIP93 crypto share one three-column
					 * grid. The two slots keep their own ids so the 10 s poll and
					 * the 60 s crypto fetch can refresh their cards without
					 * touching the neighbours; display:contents keeps the cards
					 * themselves as the grid items. */
					E('div', { 'class': 'ai-grid ai-grid--3', 'style': 'margin-top:var(--ds-sp-2)' }, [
						E('div', { 'id': 'engine-status', 'style': 'display:contents' }, renderEngineStatus(st, ppe)),
						E('div', { 'id': 'crypto-status', 'style': 'display:contents' }, renderCryptoStatus(null))
					]),
					E('div', { 'id': 'frame-engine' }, renderFrameEngine(fe, topo, ppe))
				])
			}),

			E('div', { 'id': 'wifi-detail' }),

			// PPE Flow Table
			aui.section({
				title: _('PPE Flow Offload Entries'),
				count: ppeCountText(entries), countId: 'ppe-count',
				body: renderPpeTable(entries)
			})
		]);

		// Data fetch + DOM update functions — called immediately and via poll.
		// Individual calls are retained only for compatibility with older backends.
		function _safeCall(promise, fallback) {
			return promise.catch(function() { return fallback; });
		}

		function applyData(st, ppe, ti, flo, apo, dm, topo, vo, wifi, fe, requestSequence, deferPpe) {
			aui.ensureCss();
			st = st || {};
			ppe = ppe || {};
			ti = ti || {};
			flo = flo || { enabled: 0 };
			apo = apo || { enabled: 0 };
			dm = dm || {};
			topo = topo || {};
			vo = vo || { enabled: 0 };
			wifi = wifi || { available: false, bands: [] };
			fe = fe || { available: false };
			if (typeof wifi.has_wifi !== 'boolean' && typeof ti.has_wifi === 'boolean')
				wifi.has_wifi = ti.has_wifi;
			var bridgeBlocked = isBridgeOffloadBlocked(dm);
			// deferred:true means "this round did not ask for PPE" (the flow
			// table is fetched on a slower cadence - see fetchDashboardData).
			// Leave both the table and latestPpeEntries alone: overwriting them
			// would flash an empty flow table on every round and defeat the point of
			// keeping the last real snapshot.
			if (deferPpe !== true && requestSequence > latestPpeRequest) {
				latestPpeRequest = requestSequence;
				latestPpeEntries = Array.isArray(ppe.entries) ? ppe.entries : [];
				if (typeof ppe.ppe1 !== 'undefined' || typeof ppe.zero_l2 !== 'undefined') latestPpeSplit = ppe;
				updatePpeTable(latestPpeEntries, ppe);
			}
			updateSummary(st, ti);

			// CPU. History first: it fills loadHistory, which the core-load card
			// and the curve both read, so both are refreshed from this round's
			// samples and not the previous round's.
			adoptHistory(st);
			/* The layout no longer depends on board capability, so every round
			 * only swaps the card bodies. That also keeps the chart - and a hover
			 * readout the user is holding open - stable across the 10 s poll. */
			if (document.getElementById('cpu-body')) {
				var ci = document.getElementById('cpu-info-content');
				if (ci) { ci.innerHTML = ''; ci.appendChild(renderCpuInfo(st)); }
				var cl = document.getElementById('cpu-load-content');
				if (cl) { cl.innerHTML = ''; cl.appendChild(renderCoreLoad(st)); }
				var lc = document.getElementById('cpu-load-history-chart');
				if (lc) {
					lc.innerHTML = '';
					lc.appendChild(renderLoadLegend());
					lc.appendChild(renderLoadChart(lc.parentNode ? lc.parentNode.clientWidth : 0));
				}
			}

			updateOffloadControl('vlan-offload-select', 'vlan-offload-badge', 'vlan-offload-row', vo.enabled, bridgeBlocked);
			updateOffloadControl('flow-offload-select', 'flow-offload-badge', 'flow-offload-row', flo.enabled, false);
			updateOffloadControl('apmode-offload-select', 'apmode-offload-badge', 'apmode-offload-row', apo.enabled, bridgeBlocked);

			var controls = document.getElementById('offload-controls');
			var controlBoard = String(topo.compatible || '') + ':' + (vo.supported !== false && apo.supported !== false);
			if (controls && topo.compatible && controls.getAttribute('data-board') !== controlBoard) {
				controls.replaceChildren(renderOffloadControls(topo, vo, flo, apo, bridgeBlocked));
				controls.setAttribute('data-board', controlBoard);
			}

			var engineEl = document.getElementById('engine-status');
			// renderEngineStatus returns the unbundled card pair — spread it.
			if (engineEl) engineEl.replaceChildren.apply(engineEl, renderEngineStatus(st, latestPpeSplit || ppe));
			var feEl = document.getElementById('frame-engine');
			if (feEl) feEl.replaceChildren(renderFrameEngine(fe, topo, latestPpeSplit));
			var epEl = document.getElementById('ethernet-ports');
			if (epEl) { epEl.innerHTML = ''; epEl.appendChild(renderEthernetPorts(topo)); }
			var wifiEl = document.getElementById('wifi-detail');
			if (wifiEl) {
				wifiEl.replaceChildren();
				var wifiDetails = renderWifiDetails(wifi, ppe, ti, st);
				if (wifiDetails) wifiEl.appendChild(wifiDetails);
			}

			markUpdated();
		}

		function fetchLegacyData() {
			return Promise.all([
				_safeCall(callNpuStatus(), {}),
				_safeCall(callPpeEntries(), { available: false, entries: [] }),
				_safeCall(callTokenInfo(), {}),
				_safeCall(callGetFlowOffload(), { enabled: 0 }),
				_safeCall(callGetApModeOffload(), { enabled: 0 }),
				_safeCall(callGetDeviceMode(), { bridge_offload_blocked: false }),
				_safeCall(callGetTopology(), {}),
				_safeCall(callGetVlanOffload(), { enabled: 0 }),
				_safeCall(callGetWifiStats(), { available: false, bands: [] }),
				_safeCall(callFrameEngine(), { available: false, reason: 'request_failed' })
			]).then(function(d) {
				return {
					st: d[0] || {}, ppe: d[1] || {}, ti: d[2] || {},
					flo: d[3] || {}, apo: d[4] || {}, dm: d[5] || {},
					topo: d[6] || {}, vo: d[7] || {}, wifi: d[8] || {}, fe: d[9] || {}
				};
			});
		}

		// PPE is by far the most expensive probe on the board (a 1024-entry
		// debugfs snapshot + awk, ~2 s on the PON ONU), so `ppe:0` tells the
		// backend to skip it entirely. The reply then carries deferred:true,
		// which applyData uses to keep the previous flow table on screen.
		function fetchDashboardData(includePpe) {
			var deferred = { available: false, entries: [], total: 0, deferred: true };
			return callDashboard(includePpe ? 1 : 0).then(function(dashboard) {
				// No getDashboard: an older backend. It always returns the whole
				// page - including PPE - in one go, so the caller's PPE cadence
				// cannot be honoured; fall back to the 10 individual calls and
				// let them behave exactly as they did before.
				if (!dashboard) return fetchLegacyData();
				var ppe = dashboard.ppe || {};
				return {
					st: dashboard.status || {},
					ppe: includePpe ? ppe : deferred,
					ti: dashboard.token || {},
					flo: dashboard.flow_offload || {},
					apo: dashboard.apmode_offload || {},
					dm: dashboard.device_mode || {},
					topo: dashboard.topology || {},
					vo: dashboard.vlan_offload || {},
					wifi: dashboard.wifi || {},
					fe: dashboard.frame_engine || {},
					deferPpe: !includePpe
				};
			}, function() {
				return fetchLegacyData();
			});
		}

		function runFetch(includePpe) {
			var requestSequence = ++ppeRequestSequence;
			return fetchDashboardData(includePpe).then(function(data) {
				applyData(data.st, data.ppe, data.ti, data.flo, data.apo, data.dm,
					data.topo, data.vo, data.wifi, data.fe, requestSequence, data.deferPpe);
			}).catch(function(err) {
				console.error('[airoha_npu] fetchData error:', err);
			});
		}

		// NSS Crypto is not part of the dashboard: its only expensive probe is
		// the OpenSSL engine test, ~0.46 s per call, and the engine list cannot
		// change before a reboot. Pulled on first paint and then once a minute -
		// the card is a capability report, not a counter, so a minute of latency
		// costs nothing and the call is 1/6 of the rounds instead of 1/4.
		function applyCrypto(cr) {
			var el = document.getElementById('crypto-status');
			if (el && cr) el.replaceChildren(renderCryptoStatus(cr));
		}

		function runCrypto() {
			return _safeCall(callCryptoInfo(), null).then(applyCrypto);
		}

		// Poll cadence. 10 s is the master interval: everything the page measures
		// is a trend, and one round costs ~1.8 s of CPU across the four cores, so
		// halving the rate halves that. The two probes that cannot afford the
		// same rate get their own counters, expressed in polls so the numbers
		// stay readable against POLL_SECS:
		//   * PPE (a 1024-entry debugfs snapshot + awk, the most expensive probe
		//     on the board) every 2nd poll = 20 s;
		//   * crypto every 6th poll = 60 s.
		var POLL_SECS = 10;
		var PPE_POLL_EVERY = 2;
		var CRYPTO_POLL_EVERY = 6;
		var pollCount = 0;

		function pollFetch() {
			pollCount++;
			if (pollCount % CRYPTO_POLL_EVERY === 0) runCrypto();
			return runFetch(pollCount % PPE_POLL_EVERY === 1);
		}

		// First paint is deliberately two requests, in order: the fast half
		// (ports, CPU, NPU, frame engine - well under a second) renders as soon
		// as it lands, then the flow table is fetched separately. Firing both at
		// once would just put the expensive call back on the critical path.
		runCrypto();
		runFetch(false).then(function() {
			return runFetch(true);
		});
		// Poll for periodic updates. POLL_SECS is mirrored by the backend's
		// history gate (HIST_GATE in luci.airoha_npu, 8 s): every round now
		// passes it, so the curves get one point per poll.
		poll.add(pollFetch, POLL_SECS);

		return view;
	},

	handleSaveApply: null, handleSave: null, handleReset: null
});
