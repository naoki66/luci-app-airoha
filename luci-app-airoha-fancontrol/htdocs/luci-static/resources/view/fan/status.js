'use strict';
'require uci';
'require poll';
'require rpc';
'require view';
'require view.fan.theme as fanTheme';

/*
 * Fan control - single merged page (status + settings).
 *
 * The page used to be two tabs: "Status" (read-only dashboard) and
 * "Settings" (mode / preset / curve editor). Users had to jump between them
 * to answer "is the fan behaving, and what is driving it?", so both views
 * now live on one page in monitoring-first order:
 *
 *   1. header        - title, live freshness and context chips
 *   2. Temperatures  - board sensor (drives the curve) on a full-width row,
 *                      the remaining sensors in two groups below
 *   3. Real-time trends - the 2-minute history charts
 *   4. Control panel - auto/manual segmented control sharing one row with
 *                      the four status summary cards, and (in automatic
 *                      mode) the preset tiles + curve editor underneath
 *   5. Fixed speed   - the manual-mode alternative to the curve editor
 *
 * Saving is explicit and uses the theme's own footer: the view implements
 * handleSave / handleSaveApply / handleReset, so Argon (or any theme) renders
 * its usual "Save & Apply / Save / Reset" bar - the page must not draw a
 * second one. luci.fan.applySettings writes uci once; "Save" stops there,
 * "Save & Apply" also reloads the fan service.
 */

var callGetStatus = rpc.declare({ object: 'luci.fan', method: 'getStatus' });
var callGetAllCurves = rpc.declare({ object: 'luci.fan', method: 'getAllCurves' });
var callApplySettings = rpc.declare({
	object: 'luci.fan',
	method: 'applySettings',
	params: [ 'mode', 'manual_pwm', 'preset', 'points', 'apply' ]
});

/* Legacy single-purpose methods. Kept as a fallback so a front-end-only
 * update still saves against an older rpcd (one commit per call, but rare). */
var callSetCustomCurve = rpc.declare({ object: 'luci.fan', method: 'setCustomCurve', params: [ 'points' ] });
var callSetPreset = rpc.declare({ object: 'luci.fan', method: 'setPreset', params: [ 'preset' ] });
var callSetMode = rpc.declare({ object: 'luci.fan', method: 'setMode', params: [ 'mode' ] });
var callSetManualPwm = rpc.declare({ object: 'luci.fan', method: 'setManualPwm', params: [ 'pwm' ] });

/* -------------------------------------------------------------- status side */

var HISTORY_WINDOW_MS = 2 * 60 * 1000;
var TIME_GRID_INTERVAL_MS = 10 * 1000;
var TIME_LABEL_INTERVAL_MS = 30 * 1000;
var VALUE_GRID_DIVISIONS = 4;
var HISTORY_STORAGE_KEY = 'airoha-fancontrol-history-v1';
var CHART_PAD = { left: 31, right: 6, top: 7, bottom: 16 };
var history = [];
var themeWatched = false;

/* One data hue for all three trends. They used to borrow the semantic ramp
 * (amber / blue / green), which made a temperature reading look like a health
 * warning and turned the panel into a traffic-light plot. Card titles already
 * tell the series apart, so colour can stay quiet and consistent. */
var CHARTS = [
	{ id: 'fc-temp', key: 'temperature', level: 'series',
		line: '--fan-series', fill: '--fan-series-soft', fade: '--fan-series-fade',
		lineFallback: '#0f766e', fillFallback: 'rgba(15,118,110,.18)', fadeFallback: 'rgba(15,118,110,0)',
		minMax: 40, step: 20, label: _('Board Temperature'), unit: 'C',
		format: function(value) { return value + '\u00b0'; },
		read: function(s) { return (s.temp_board || 0) + '\u00b0C'; } },
	{ id: 'fc-pwm', key: 'pwm', level: 'series',
		line: '--fan-series', fill: '--fan-series-soft', fade: '--fan-series-fade',
		lineFallback: '#0f766e', fillFallback: 'rgba(15,118,110,.18)', fadeFallback: 'rgba(15,118,110,0)',
		minMax: 100, step: 50, label: _('Fan PWM'), unit: ' / 255',
		format: function(value) { return String(value); },
		read: function(s) { return (s.fan_pwm || 0) + ' / 255'; } },
	{ id: 'fc-rpm', key: 'rpm', level: 'series',
		line: '--fan-series', fill: '--fan-series-soft', fade: '--fan-series-fade',
		lineFallback: '#0f766e', fillFallback: 'rgba(15,118,110,.18)', fadeFallback: 'rgba(15,118,110,0)',
		minMax: 1000, step: 500, label: _('Fan Speed'), unit: ' RPM',
		format: function(value) { return String(value); },
		read: function(s) { return (s.fan_rpm || 0) + ' RPM'; } }
];

/* The board sensor drives the fan curve, so it is the reading the page
 * exists for: it gets its own full-width row above the other six. */
var BOARD_GAUGE = { id: 'temp-board', key: 'temp_board', label: _('Board (Fan Curve)') };

var SYSTEM_GAUGES = [
	{ id: 'temp-cpu', key: 'temp_cpu', label: _('CPU') },
	{ id: 'temp-phy1', key: 'temp_phy1', label: _('10G PHY') },
	{ id: 'temp-phy2', key: 'temp_phy2', label: _('Switch PHY') }
];

var WIFI_GAUGES = [
	{ id: 'temp-wifi24g', key: 'wifi_24g', label: _('2.4 GHz Radio') },
	{ id: 'temp-wifi5g', key: 'wifi_5g', label: _('5 GHz Radio') },
	{ id: 'temp-wifi6g', key: 'wifi_6g', label: _('6 GHz Radio') }
];

var ALL_GAUGES = [ BOARD_GAUGE ].concat(SYSTEM_GAUGES, WIFI_GAUGES);

var PRESET_INFO = {
	quiet: { value: _('Quiet'), sub: _('Low noise priority'), level: 'ok' },
	balanced: { value: _('Balanced'), sub: _('Noise and cooling balanced'), level: 'ok' },
	performance: { value: _('Performance'), sub: _('Cooling priority'), level: 'ok' },
	custom: { value: _('Custom'), sub: _('Custom temperature curve'), level: 'custom' }
};

/* ------------------------------------------------------------- settings side */

/* 20 °C, not 0: the board idles around 37 °C and no usable curve point lives
 * below 20, so the first fifth of the plot used to be dead space. The domain
 * is shared by the axis, the drag maths and the input bounds. */
var TEMP_MIN = 20, TEMP_MAX = 100, PWM_MIN = 0, PWM_MAX = 255;
var PRESETS = [ 'quiet', 'balanced', 'performance', 'custom' ];

var PRESET_META = {
	quiet: { label: _('Quiet'), hint: _('Runs warmer, stays quiet') },
	balanced: { label: _('Balanced'), hint: _('Noise and cooling in balance') },
	performance: { label: _('Performance'), hint: _('Cooler, louder under load') },
	custom: { label: _('Custom'), hint: _('Drag the points yourself') }
};

/* uci defaults, used when getAllCurves is unavailable. */
var FALLBACK_CURVES = {
	quiet: [ [ 45, 54 ], [ 55, 69 ], [ 65, 95 ], [ 75, 199 ], [ 85, 255 ] ],
	balanced: [ [ 40, 54 ], [ 50, 69 ], [ 60, 95 ], [ 70, 199 ], [ 80, 255 ] ],
	performance: [ [ 35, 69 ], [ 45, 95 ], [ 55, 150 ], [ 65, 199 ], [ 75, 255 ] ],
	custom: [ [ 40, 54 ], [ 50, 69 ], [ 60, 95 ], [ 70, 199 ], [ 80, 255 ] ]
};

var DEFAULT_POINTS = FALLBACK_CURVES.custom.map(function(p) {
	return { temp: p[0], pwm: p[1] };
});

var ICON_PATHS = {
	auto: '<path d="M3 17c3.4 0 5-11 9-11s5.6 7 9 7"/><circle cx="3" cy="17" r="1.5"/><circle cx="12" cy="6" r="1.5"/><circle cx="21" cy="13" r="1.5"/>',
	manual: '<path d="M4 12h16"/><circle cx="15" cy="12" r="3.6"/><path d="M4 6h6M4 18h6"/>',
	check: '<path d="M20 6L9 17l-5-5"/>'
};

var state = {
	loaded: false,
	dirty: false,
	saving: false,
	mode: 'auto',
	manualPwm: 127,
	preset: 'balanced',
	curves: {},
	custom: [],
	saved: null,
	live: { temp: 0, pwm: 0, rpm: 0 },
	geom: null,
	drag: -1,
	hover: -1,
	selected: -1
};

var ui = null;
var pollReady = false;
var themeReady = false;

/* ------------------------------------------------------------------- utils */

function clamp(value, min, max) {
	return value < min ? min : (value > max ? max : value);
}

function copyPoints(points) {
	return points.map(function(p) { return { temp: p.temp, pwm: p.pwm }; });
}

/* uci is user-editable and older configs may hold out-of-order points, which
 * the hardware would apply as a zig-zag. Repair the invariants once on load so
 * every later consumer (canvas, table, payload) sees the same valid curve.
 * Points may arrive as [temp, pwm] pairs (the FALLBACK_CURVES shape) or as
 * {temp, pwm} objects; a bare fallback used to degenerate into a ramp of
 * TEMP_MIN..TEMP_MIN+4 at PWM 0, which the fan would actually follow. */
function sanitize(raw) {
	var out = [];
	var lastTemp = -1, lastPwm = 0;
	var list = (raw && raw.length) ? raw.map(function(p) {
		return Array.isArray(p) ? { temp: p[0], pwm: p[1] } : p;
	}) : DEFAULT_POINTS;
	for (var i = 0; i < 5; i++) {
		var src = list[Math.min(i, list.length - 1)] || DEFAULT_POINTS[i];
		var temp = clamp(parseInt(src.temp, 10) || 0, TEMP_MIN, TEMP_MAX);
		var pwm = clamp(parseInt(src.pwm, 10) || 0, PWM_MIN, PWM_MAX);
		if (temp <= lastTemp) temp = Math.min(TEMP_MAX, lastTemp + 1);
		if (pwm < lastPwm) pwm = lastPwm;
		out.push({ temp: temp, pwm: pwm });
		lastTemp = temp;
		lastPwm = pwm;
	}
	return out;
}

function pwmAt(points, temp) {
	if (!points || !points.length) return 0;
	if (temp <= points[0].temp) return points[0].pwm;
	for (var i = 1; i < points.length; i++) {
		if (temp <= points[i].temp) {
			var a = points[i - 1], b = points[i];
			var span = b.temp - a.temp;
			if (span <= 0) return b.pwm;
			return Math.round(a.pwm + (b.pwm - a.pwm) * (temp - a.temp) / span);
		}
	}
	return points[points.length - 1].pwm;
}

function pct(pwm) {
	return Math.round(pwm * 100 / PWM_MAX);
}

function activePoints() {
	if (state.preset === 'custom') return state.custom;
	return sanitize(state.curves[state.preset] || FALLBACK_CURVES[state.preset] || FALLBACK_CURVES.balanced);
}

function iconEl(cls, name) {
	var el = document.createElement('span');
	el.className = cls;
	el.setAttribute('aria-hidden', 'true');
	el.innerHTML = '<svg viewBox="0 0 24 24" focusable="false">' + (ICON_PATHS[name] || '') + '</svg>';
	return el;
}

function clockText(ts) {
	var d = new Date(ts);
	function pad(v) { return v < 10 ? '0' + v : String(v); }
	return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/* A monitoring page has to say how fresh its numbers are. A failed RPC used to
 * leave the last values on screen with no indication that they had gone stale. */
function markLive(ok, ts) {
	if (!ui) return;
	var dot = ui.liveDot;
	var text = ui.liveText;
	var stamp = ui.lastUpdate;
	if (dot) dot.setAttribute('data-state', ok ? 'live' : 'stale');
	if (text) text.textContent = ok ? _('Live') : _('Connection lost');
	if (stamp) stamp.textContent = ok
		? _('Last update %s').format(clockText(ts))
		: _('Showing the last known values');
	if (ui.root) ui.root.classList.toggle('is-stale', !ok);
}

function healthInfo(status) {
	if (!status) return { level: 'none', text: _('No data') };
	var maxTemp = 0;
	ALL_GAUGES.forEach(function(gauge) {
		maxTemp = Math.max(maxTemp, Number(status[gauge.key]) || 0);
	});
	if ((Number(status.fan_rpm) || 0) === 0 && (Number(status.fan_pwm) || 0) > 0)
		return { level: 'error', text: _('Fan stopped') };
	/* Reuse the very same table as the per-sensor labels. The old badge had
	 * its own >55 = Hot rule, so a 63 C PHY was "Hot" here and "偏高" below. */
	var level = fanTheme.tempLevel(maxTemp);
	return { level: level.key, text: level.label };
}

function modeInfo(uciMode) {
	return uciMode === 'manual'
		? { value: _('Manual'), sub: _('Fixed PWM output'), level: 'warn' }
		: { value: _('Automatic'), sub: _('Following fan curve'), level: 'info' };
}

function presetInfo(uciMode, preset) {
	if (uciMode === 'manual')
		return { value: _('Manual'), sub: _('Curve is paused'), level: 'none' };
	return PRESET_INFO[preset] || PRESET_INFO.balanced;
}

/* `status === null` is the first frame, before the first RPC returns. Showing
 * zeroes there used to look like a stopped fan for a moment; use a dash. */
function summaryData(status) {
	var s = status || {};
	var ready = !!status;
	var mode = modeInfo(s.uci_mode);
	var preset = presetInfo(s.uci_mode, s.uci_preset);
	var health = healthInfo(status);
	var dash = '\u2014';
	return [
		{ id: 'fan-summary-rpm', icon: 'fan', level: 'info', title: _('Fan Speed'),
			badge: health.text, badgeLevel: health.level,
			value: ready ? String(s.fan_rpm || 0) : dash, unit: ready ? 'RPM' : '',
			sub: ready ? (s.fan_percentage || 0) + '% ' + _('PWM output') : dash },
		{ id: 'fan-summary-pwm', icon: 'pwm', level: 'ok', title: _('Fan PWM'),
			value: ready ? (s.fan_pwm || 0) + ' / 255' : dash, unit: '',
			sub: ready ? (s.fan_percentage || 0) + '%' : dash },
		{ id: 'fan-summary-mode', icon: 'mode', level: mode.level, title: _('Control Mode'),
			value: ready ? mode.value : dash, unit: '', sub: ready ? mode.sub : dash },
		{ id: 'fan-summary-preset', icon: 'curve', level: preset.level, title: _('Fan Curve Preset'),
			value: ready ? preset.value : dash, unit: '', sub: ready ? preset.sub : dash }
	];
}

function summaryCard(card) {
	return E('div', { 'id': card.id, 'class': 'fan-summary-card', 'data-level': card.level }, [
		E('div', { 'class': 'fan-card-top' }, [
			fanTheme.icon(card.icon),
			E('div', { 'class': 'fan-card-title' }, card.title),
			card.badge ? E('span', { 'class': 'fan-badge', 'data-role': 'badge',
				'data-level': card.badgeLevel }, card.badge) : ''
		]),
		E('div', { 'class': 'fan-card-value' }, [
			E('span', { 'data-role': 'value' }, card.value),
			E('span', { 'class': 'fan-card-unit', 'data-role': 'unit' }, card.unit)
		]),
		E('div', { 'class': 'fan-card-sub', 'data-role': 'sub' }, card.sub)
	]);
}

function setRole(el, role, text) {
	var node = el && el.querySelector('[data-role="' + role + '"]');
	if (node) node.textContent = text;
}

function updateSummary(status) {
	summaryData(status).forEach(function(card) {
		var el = document.getElementById(card.id);
		if (!el) return;
		el.setAttribute('data-level', card.level);
		setRole(el, 'value', card.value);
		setRole(el, 'unit', card.unit);
		setRole(el, 'sub', card.sub);
		var badge = el.querySelector('[data-role="badge"]');
		if (badge) {
			badge.textContent = card.badge || '';
			badge.setAttribute('data-level', card.badgeLevel || 'none');
		}
	});
}

function scaleElements() {
	var nodes = [ E('span', {}, '0') ];
	var levels = [ 'warn', 'hot', 'error' ];
	fanTheme.tempTicks().forEach(function(threshold, idx) {
		nodes.push(E('span', { 'style': 'left:' + threshold + '%',
			'data-level': levels[idx] || 'hot' }, String(threshold)));
	});
	nodes.push(E('span', {}, '100\u00b0C'));
	return nodes;
}

/* Define the bands once in the panel header rather than repeating a level
 * word on each of the seven temperature cards. */
function tempLegend() {
	var bands = [
		{ level: 'ok', text: _('Normal') + ' \u226445\u00b0' },
		{ level: 'warn', text: _('Warm') + ' 45\u201360\u00b0' },
		{ level: 'hot', text: _('Hot') + ' 60\u201375\u00b0' },
		{ level: 'error', text: _('Overheated') + ' >75\u00b0' }
	];
	return E('div', { 'class': 'fan-temp-legend' }, bands.map(function(band) {
		return E('span', { 'class': 'fan-temp-legend-item', 'data-level': band.level }, [
			E('i', { 'class': 'fan-temp-legend-dot' }), band.text
		]);
	}));
}

function createTempGauge(gauge, temp, hero) {
	var level = fanTheme.tempLevel(temp);
	/* One continuous fill. Threshold positions are marked by the hairlines
	 * below the scale, never by lines drawn across the bar. */
	var trackChildren = [
		E('div', { 'class': 'fan-temp-fill', 'data-role': 'fill',
			'style': 'width:' + fanTheme.tempPercent(temp) + '%' })
	];

	return E('div', { 'id': gauge.id,
		'class': hero ? 'fan-temp-card fan-temp-card--hero' : 'fan-temp-card',
		'data-level': level.key }, [
		E('div', { 'class': 'fan-temp-row' }, [
			E('span', { 'class': 'fan-temp-label' }, gauge.label),
			E('span', { 'class': 'fan-temp-reading' }, [
				E('span', { 'class': 'fan-temp-level', 'data-role': 'level' }, level.label),
				E('span', { 'class': 'fan-temp-value', 'data-role': 'value' },
					temp > 0 ? temp + '\u00b0C' : '\u2014')
			])
		]),
		E('div', { 'class': 'fan-temp-track', 'role': 'progressbar',
			'aria-label': gauge.label, 'aria-valuemin': '0', 'aria-valuemax': '100',
			'aria-valuenow': String(temp) }, trackChildren),
		E('div', { 'class': 'fan-temp-scale' }, scaleElements())
	]);
}

function updateGauge(gauge, temp) {
	var card = document.getElementById(gauge.id);
	if (!card) return;
	var level = fanTheme.tempLevel(temp);
	card.setAttribute('data-level', level.key);
	setRole(card, 'level', level.label);
	setRole(card, 'value', temp > 0 ? temp + '\u00b0C' : '\u2014');

	var fill = card.querySelector('[data-role="fill"]');
	if (fill) fill.style.width = fanTheme.tempPercent(temp) + '%';

	var track = card.querySelector('.fan-temp-track');
	if (track) track.setAttribute('aria-valuenow', String(temp));
}

function temperatureGroup(title, gauges, status) {
	return E('div', { 'class': 'fan-temp-group' }, [
		E('div', { 'class': 'fan-temp-group-title' }, title),
		E('div', { 'class': 'fan-temp-list' }, gauges.map(function(gauge) {
			return createTempGauge(gauge, status ? (status[gauge.key] || 0) : 0);
		}))
	]);
}

/* Full-width lead gauge for the board sensor. */
function boardGauge(status) {
	return E('div', { 'class': 'fan-temp-hero' }, [
		createTempGauge(BOARD_GAUGE, status ? (status.temp_board || 0) : 0, true)
	]);
}

function restoreHistory() {
	try {
		var saved = JSON.parse(window.localStorage.getItem(HISTORY_STORAGE_KEY) || '[]');
		var cutoff = Date.now() - HISTORY_WINDOW_MS;
		if (!Array.isArray(saved)) return;
		history = saved.filter(function(sample) {
			return sample && typeof sample.time === 'number' && sample.time >= cutoff &&
				typeof sample.temperature === 'number' && typeof sample.pwm === 'number' && typeof sample.rpm === 'number';
		});
	} catch (e) {
		history = [];
	}
}

function persistHistory() {
	try {
		window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
	} catch (e) {
		/* Local storage is optional; keep the live chart working when it is unavailable. */
	}
}

function appendHistory(status) {
	var now = Date.now();
	history.push({ time: now, temperature: status.temp_board || 0,
		pwm: status.fan_pwm || 0, rpm: status.fan_rpm || 0 });
	while (history.length && history[0].time < now - HISTORY_WINDOW_MS) history.shift();
	persistHistory();
}

/* -------------------------------------------------------- trend charting */

function chartScale(hist, key, minMax, step) {
	var maximum = minMax;
	for (var i = 0; i < hist.length; i++)
		if (hist[i][key] != null) maximum = Math.max(maximum, hist[i][key]);
	return Math.ceil(maximum / step) * step;
}

function drawChart(canvas, hist, chart, hoverSample) {
	if (!canvas || !hist.length) return;
	var style = getComputedStyle(canvas);
	var width = Math.max(canvas.clientWidth, 1);
	var height = Math.max(canvas.clientHeight, 1);
	var dpr = Math.min(window.devicePixelRatio || 1, 2);
	var ctx = canvas.getContext('2d');
	var pad = CHART_PAD;
	var plotW = Math.max(width - pad.left - pad.right, 1);
	var plotH = Math.max(height - pad.top - pad.bottom, 1);
	var plotB = pad.top + plotH;
	var now = hist[hist.length - 1].time;
	var start = now - HISTORY_WINDOW_MS;
	var maximum = chartScale(hist, chart.key, chart.minMax, chart.step);
	var labelColor = style.color || fanTheme.color('--fan-muted', '#5c6773', canvas);
	var gridColor = fanTheme.color('--fan-grid', 'rgba(80,90,100,.18)', canvas);
	var lineColor = fanTheme.color(chart.line, chart.lineFallback, canvas);
	var fillColor = fanTheme.color(chart.fill, chart.fillFallback, canvas);
	var fadeColor = fanTheme.color(chart.fade, chart.fadeFallback, canvas);
	var surfaceColor = fanTheme.color('--fan-surface', '#fff', canvas);

	canvas.width = Math.round(width * dpr);
	canvas.height = Math.round(height * dpr);
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, width, height);
	ctx.strokeStyle = gridColor;
	ctx.lineWidth = 1;
	ctx.beginPath();
	for (var e = 0; e <= HISTORY_WINDOW_MS; e += TIME_GRID_INTERVAL_MS) {
		var gx = pad.left + plotW * e / HISTORY_WINDOW_MS;
		ctx.moveTo(gx, pad.top);
		ctx.lineTo(gx, plotB);
	}
	for (var d = 0; d <= VALUE_GRID_DIVISIONS; d++) {
		var gy = pad.top + plotH * d / VALUE_GRID_DIVISIONS;
		ctx.moveTo(pad.left, gy);
		ctx.lineTo(pad.left + plotW, gy);
	}
	ctx.stroke();

	ctx.fillStyle = labelColor;
	ctx.font = '10px system-ui, sans-serif';
	ctx.textAlign = 'right';
	ctx.textBaseline = 'top';
	ctx.fillText(chart.format(maximum), pad.left - 4, pad.top - 1);
	ctx.textBaseline = 'middle';
	ctx.fillText(chart.format(maximum / 2), pad.left - 4, pad.top + plotH / 2);
	ctx.textBaseline = 'bottom';
	ctx.fillText(chart.format(0), pad.left - 4, plotB + 1);
	for (var t = 0; t <= HISTORY_WINDOW_MS; t += TIME_LABEL_INTERVAL_MS) {
		var lx = pad.left + plotW * t / HISTORY_WINDOW_MS;
		var remaining = (HISTORY_WINDOW_MS - t) / 1000;
		ctx.textAlign = t === 0 ? 'left' : t === HISTORY_WINDOW_MS ? 'right' : 'center';
		ctx.fillText(remaining ? '-' + remaining + 's' : '0', lx, height);
	}

	function point(sample) {
		return { x: pad.left + (sample.time - start) / HISTORY_WINDOW_MS * plotW,
			y: plotB - (sample[chart.key] || 0) / maximum * plotH };
	}
	ctx.beginPath();
	ctx.moveTo(point(hist[0]).x, plotB);
	for (var i = 0; i < hist.length; i++) {
		var fillPoint = point(hist[i]);
		ctx.lineTo(fillPoint.x, fillPoint.y);
	}
	ctx.lineTo(point(hist[hist.length - 1]).x, plotB);
	ctx.closePath();
	var gradient = ctx.createLinearGradient(0, pad.top, 0, plotB);
	gradient.addColorStop(0, fillColor);
	gradient.addColorStop(1, fadeColor);
	ctx.fillStyle = gradient;
	ctx.fill();
	ctx.beginPath();
	for (var j = 0; j < hist.length; j++) {
		var linePoint = point(hist[j]);
		j === 0 ? ctx.moveTo(linePoint.x, linePoint.y) : ctx.lineTo(linePoint.x, linePoint.y);
	}
	ctx.strokeStyle = lineColor;
	ctx.lineWidth = 2.5;
	ctx.lineJoin = 'round';
	ctx.lineCap = 'round';
	ctx.stroke();

	if (hoverSample) {
		var hp = point(hoverSample);
		ctx.save();
		ctx.strokeStyle = lineColor;
		ctx.globalAlpha = 0.6;
		ctx.lineWidth = 1;
		ctx.setLineDash([ 3, 3 ]);
		ctx.beginPath();
		ctx.moveTo(hp.x, pad.top);
		ctx.lineTo(hp.x, plotB);
		ctx.stroke();
		ctx.setLineDash([]);
		ctx.globalAlpha = 1;
		ctx.fillStyle = lineColor;
		ctx.beginPath();
		ctx.arc(hp.x, hp.y, 4.5, 0, 2 * Math.PI);
		ctx.fill();
		ctx.lineWidth = 2;
		ctx.strokeStyle = surfaceColor;
		ctx.stroke();
		ctx.restore();
	}
}

function chartCard(chart, status) {
	return E('div', { 'class': 'fan-chart-card', 'data-level': chart.level }, [
		E('div', { 'class': 'fan-card-title' }, chart.label),
		E('div', { 'id': chart.id + '-val', 'class': 'fan-chart-value' },
			status ? chart.read(status) : '\u2014'),
		E('div', { 'class': 'fan-chart-frame' }, [
			E('canvas', { 'id': chart.id, 'class': 'fan-chart-canvas',
				'role': 'img', 'aria-label': chart.label }),
			E('div', { 'id': chart.id + '-empty', 'class': 'fan-chart-empty' },
				_('Collecting data…')),
			E('div', { 'id': chart.id + '-tip', 'class': 'fan-chart-tip' })
		]),
		E('div', { 'class': 'fan-chart-legend' }, [
			E('span', { 'class': 'fan-chart-swatch' }),
			E('span', {}, _('Last 2 minutes'))
		])
	]);
}

function drawAllCharts() {
	CHARTS.forEach(function(chart) {
		var canvas = document.getElementById(chart.id);
		var empty = document.getElementById(chart.id + '-empty');
		if (empty) empty.classList.toggle('is-visible', !history.length);
		if (!history.length) return;
		drawChart(canvas, history, chart);
	});
}

function bindChartTooltip(chart) {
	var canvas = document.getElementById(chart.id);
	var tip = document.getElementById(chart.id + '-tip');
	if (!canvas || !tip) return;

	function clear() {
		tip.classList.remove('is-visible');
		drawChart(canvas, history, chart);
	}

	canvas.addEventListener('mousemove', function(ev) {
		if (!history.length) return;
		var rect = canvas.getBoundingClientRect();
		var x = ev.clientX - rect.left;
		var plotW = Math.max(rect.width - CHART_PAD.left - CHART_PAD.right, 1);
		var ratio = (x - CHART_PAD.left) / plotW;
		if (ratio < 0 || ratio > 1) { clear(); return; }

		var now = history[history.length - 1].time;
		var target = now - HISTORY_WINDOW_MS + ratio * HISTORY_WINDOW_MS;
		var best = null, bestDist = Infinity;
		for (var i = 0; i < history.length; i++) {
			var dist = Math.abs(history[i].time - target);
			if (dist < bestDist) { bestDist = dist; best = history[i]; }
		}
		if (!best) { clear(); return; }

		tip.textContent = clockText(best.time) + '  ' +
			chart.format(best[chart.key]) + (chart.unit || '');
		tip.classList.add('is-visible');
		var tipWidth = tip.offsetWidth || 96;
		tip.style.left = Math.max(2, Math.min(x + 10, rect.width - tipWidth - 4)) + 'px';
		drawChart(canvas, history, chart, best);
	});

	canvas.addEventListener('mouseleave', clear);
}

function updateChartValues(status) {
	CHARTS.forEach(function(chart) {
		var el = document.getElementById(chart.id + '-val');
		if (el) el.textContent = status ? chart.read(status) : '\u2014';
	});
}

/* ------------------------------------------------------------- curve editor */

function geometry(width, height) {
	var compact = width < 460;
	var pad = {
		left: compact ? 48 : 56,
		right: compact ? 12 : 16,
		top: 20,
		bottom: compact ? 26 : 30
	};
	return {
		width: width,
		height: height,
		pad: pad,
		plotW: Math.max(width - pad.left - pad.right, 1),
		plotH: Math.max(height - pad.top - pad.bottom, 1)
	};
}

function toX(g, temp) {
	return g.pad.left + (clamp(temp, TEMP_MIN, TEMP_MAX) - TEMP_MIN) /
		(TEMP_MAX - TEMP_MIN) * g.plotW;
}

function toY(g, pwm) {
	return g.pad.top + g.plotH - pwm / PWM_MAX * g.plotH;
}

function colorsFor(el) {
	return {
		grid: fanTheme.color('--fan-grid', 'rgba(80,90,100,.18)', el),
		axis: fanTheme.color('--fan-axis', '#555', el),
		muted: fanTheme.color('--fan-muted', '#5c6773', el),
		surface: fanTheme.color('--fan-surface', '#fff', el),
		series: fanTheme.color('--fan-series', '#0f766e', el),
		idle: fanTheme.color('--fan-series-idle', '#94a3b8', el),
		soft: fanTheme.color('--fan-series-soft', 'rgba(15,118,110,.18)', el),
		fade: fanTheme.color('--fan-series-fade', 'rgba(15,118,110,0)', el),
		live: fanTheme.color('--fan-info', '#0969da', el)
	};
}

function roundRect(ctx, x, y, w, h, r) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.lineTo(x + w - r, y);
	ctx.quadraticCurveTo(x + w, y, x + w, y + r);
	ctx.lineTo(x + w, y + h - r);
	ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
	ctx.lineTo(x + r, y + h);
	ctx.quadraticCurveTo(x, y + h, x, y + h - r);
	ctx.lineTo(x, y + r);
	ctx.quadraticCurveTo(x, y, x + r, y);
	ctx.closePath();
}

function drawCurve() {
	var canvas = ui && ui.canvas;
	if (!canvas) return;
	var width = canvas.clientWidth || 0;
	var height = canvas.clientHeight || 0;
	if (!width || !height) return;

	var dpr = Math.min(window.devicePixelRatio || 1, 2);
	canvas.width = Math.round(width * dpr);
	canvas.height = Math.round(height * dpr);

	var ctx = canvas.getContext('2d');
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, width, height);

	var g = geometry(width, height);
	state.geom = g;
	var c = colorsFor(canvas);
	var points = activePoints();

	ctx.lineWidth = 1;
	ctx.strokeStyle = c.grid;
	ctx.beginPath();
	for (var tv = TEMP_MIN; tv <= TEMP_MAX; tv += 20) {
		var gx = toX(g, tv);
		ctx.moveTo(gx, g.pad.top);
		ctx.lineTo(gx, g.pad.top + g.plotH);
	}
	for (var pv = 0; pv <= 100; pv += 20) {
		var gy = toY(g, pv / 100 * PWM_MAX);
		ctx.moveTo(g.pad.left, gy);
		ctx.lineTo(g.pad.left + g.plotW, gy);
	}
	ctx.stroke();

	/* Spines stay lighter than the data; the plot is a background, the curve
	 * is the content. */
	ctx.strokeStyle = c.axis;
	ctx.globalAlpha = 0.45;
	ctx.beginPath();
	ctx.moveTo(g.pad.left, g.pad.top);
	ctx.lineTo(g.pad.left, g.pad.top + g.plotH);
	ctx.lineTo(g.pad.left + g.plotW, g.pad.top + g.plotH);
	ctx.stroke();
	ctx.globalAlpha = 1;

	ctx.font = '10px system-ui, sans-serif';
	ctx.fillStyle = c.muted;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'top';
	for (var tx = TEMP_MIN; tx <= TEMP_MAX; tx += 20)
		ctx.fillText(tx, toX(g, tx), g.pad.top + g.plotH + 8);

	ctx.textAlign = 'right';
	ctx.textBaseline = 'middle';
	for (var py = 0; py <= 100; py += 20)
		ctx.fillText(py, g.pad.left - 7, toY(g, py / 100 * PWM_MAX));

	/* The ratio is meaningless on its own: 100% is the fan at full duty, 0%
	 * is it stopped. Naming both ends answers "what does the top mean" without
	 * inventing an RPM scale (rpm is not linear in duty on this fan). */
	ctx.font = '9px system-ui, sans-serif';
	ctx.textAlign = 'left';
	ctx.fillText(_('Max'), 2, toY(g, PWM_MAX) + 1);
	ctx.fillText(_('Min'), 2, toY(g, 0) - 1);

	ctx.font = '10px system-ui, sans-serif';
	ctx.fillStyle = c.muted;
	ctx.textAlign = 'left';
	ctx.textBaseline = 'top';
	ctx.fillText(_('Fan speed %'), 2, 3);
	ctx.textAlign = 'right';
	ctx.fillText(_('Temperature °C'), g.pad.left + g.plotW, 3);

	/* Flat lead-in / lead-out show what the controller does outside the five
	 * programmed points (below point 1 it holds pwm1, above point 5 it holds
	 * the last value) without inventing a slope. */
	var coords = points.map(function(p) {
		return { x: toX(g, p.temp), y: toY(g, p.pwm) };
	});
	var path = [ { x: g.pad.left, y: coords[0].y } ].concat(coords)
		.concat([ { x: g.pad.left + g.plotW, y: coords[coords.length - 1].y } ]);
	var baseline = g.pad.top + g.plotH;

	var gradient = ctx.createLinearGradient(0, g.pad.top, 0, baseline);
	gradient.addColorStop(0, c.soft);
	gradient.addColorStop(1, c.fade);
	ctx.beginPath();
	ctx.moveTo(path[0].x, baseline);
	path.forEach(function(p) { ctx.lineTo(p.x, p.y); });
	ctx.lineTo(path[path.length - 1].x, baseline);
	ctx.closePath();
	ctx.fillStyle = gradient;
	ctx.fill();

	ctx.strokeStyle = c.series;
	ctx.lineWidth = 3;
	ctx.lineJoin = 'round';
	ctx.lineCap = 'round';
	ctx.beginPath();
	path.forEach(function(p, i) { i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
	ctx.stroke();

	drawLiveMarker(ctx, g, c, points, width);

	var focusIdx = state.drag >= 0 ? state.drag : state.hover;
	coords.forEach(function(p, i) {
		var isFocus = i === focusIdx || (state.selected === i && canvas === document.activeElement);
		if (isFocus) {
			ctx.beginPath();
			ctx.arc(p.x, p.y, 15, 0, 2 * Math.PI);
			ctx.fillStyle = c.soft;
			ctx.fill();
		}
		ctx.beginPath();
		ctx.arc(p.x, p.y, isFocus ? 8.5 : 7, 0, 2 * Math.PI);
		ctx.fillStyle = c.series;
		ctx.fill();
		ctx.lineWidth = 2.5;
		ctx.strokeStyle = c.surface;
		ctx.stroke();
	});

	/* "Now 62 °C -> about 45%" is derived from the curve, so it has to follow
	 * the shape while a handle is being dragged, not on the next poll. */
	syncEditorLive();
}

/* The curve is abstract until a "you are here" marker ties it to the board
 * temperature. It is drawn in the info hue, never the series hue, because it
 * is a reading rather than part of the curve. */
function drawLiveMarker(ctx, g, c, points, width) {
	var temp = state.live.temp;
	if (!(temp > 0)) return;
	var x = toX(g, clamp(temp, 0, TEMP_MAX));
	var y = toY(g, pwmAt(points, temp));

	ctx.save();
	ctx.strokeStyle = c.live;
	ctx.globalAlpha = 0.5;
	ctx.lineWidth = 1;
	ctx.setLineDash([ 3, 3 ]);
	ctx.beginPath();
	ctx.moveTo(x, g.pad.top);
	ctx.lineTo(x, g.pad.top + g.plotH);
	ctx.stroke();
	ctx.setLineDash([]);

	ctx.globalAlpha = 1;
	ctx.beginPath();
	ctx.arc(x, y, 4.5, 0, 2 * Math.PI);
	ctx.fillStyle = c.live;
	ctx.fill();
	ctx.lineWidth = 2;
	ctx.strokeStyle = c.surface;
	ctx.stroke();

	var label = Math.round(temp) + ' \u00b0C';
	ctx.font = '10px system-ui, sans-serif';
	var textW = ctx.measureText(label).width;
	var boxW = textW + 12;
	var boxX = clamp(x - boxW / 2, 2, width - boxW - 2);
	roundRect(ctx, boxX, g.pad.top + 2, boxW, 17, 4);
	ctx.fillStyle = c.live;
	ctx.fill();
	ctx.fillStyle = c.surface;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(label, boxX + boxW / 2, g.pad.top + 10.5);
	ctx.restore();
}

function drawSpark(canvas, points, active) {
	if (!canvas) return;
	var width = canvas.clientWidth || 0;
	var height = canvas.clientHeight || 0;
	if (!width || !height) return;

	var dpr = Math.min(window.devicePixelRatio || 1, 2);
	canvas.width = Math.round(width * dpr);
	canvas.height = Math.round(height * dpr);

	var ctx = canvas.getContext('2d');
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, width, height);

	var c = colorsFor(canvas);
	var last = null;
	ctx.beginPath();
	points.forEach(function(p, i) {
		var x = 2 + (clamp(p.temp, TEMP_MIN, TEMP_MAX) - TEMP_MIN) /
			(TEMP_MAX - TEMP_MIN) * (width - 4);
		var y = height - 4 - p.pwm / PWM_MAX * (height - 8);
		i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
		last = { x: x, y: y };
	});
	ctx.strokeStyle = active ? c.series : c.idle;
	ctx.lineWidth = active ? 2 : 1.6;
	ctx.lineJoin = 'round';
	ctx.lineCap = 'round';
	ctx.stroke();

	if (last) {
		ctx.beginPath();
		ctx.arc(last.x, last.y, active ? 2.6 : 2, 0, 2 * Math.PI);
		ctx.fillStyle = active ? c.series : c.idle;
		ctx.fill();
	}
}

function drawAllSparks() {
	if (!ui) return;
	PRESETS.forEach(function(key) {
		var canvas = ui.sparks[key];
		if (!canvas) return;
		var points = key === 'custom' ? state.custom : sanitize(state.curves[key] || FALLBACK_CURVES[key]);
		drawSpark(canvas, points, state.preset === key);
	});
}

function drawAll() {
	drawCurve();
	drawAllSparks();
}

/* ------------------------------------------------------------ interaction */

function hitTest(ev) {
	var canvas = ui && ui.canvas;
	if (!canvas || !state.geom) return -1;
	var rect = canvas.getBoundingClientRect();
	var x = ev.clientX - rect.left;
	var y = ev.clientY - rect.top;
	var radius = ev.pointerType === 'touch' ? 26 : 17;
	var best = -1, bestDist = radius * radius;
	activePoints().forEach(function(p, i) {
		var dx = x - toX(state.geom, p.temp);
		var dy = y - toY(state.geom, p.pwm);
		var d = dx * dx + dy * dy;
		if (d <= bestDist) { bestDist = d; best = i; }
	});
	return best;
}

function canvasOffset(ev) {
	var rect = ui.canvas.getBoundingClientRect();
	return { x: ev.clientX - rect.left, y: ev.clientY - rect.top, rect: rect };
}

/* Dragging is only meaningful on the custom curve, but forcing the user to
 * pick "Custom" first is a dead end: the handle is right there. Touching a
 * handle on a preset copies that preset into the custom slot and continues,
 * which is what "start from Balanced and tweak it" means in practice. */
function convertToCustom() {
	if (state.preset === 'custom') return false;
	state.custom = copyPoints(activePoints());
	state.preset = 'custom';
	return true;
}

function applyPoint(index, temp, pwm) {
	var points = state.custom;
	var point = points[index];
	if (!point) return false;

	var minT = index > 0 ? points[index - 1].temp + 1 : TEMP_MIN;
	var maxT = index < points.length - 1 ? points[index + 1].temp - 1 : TEMP_MAX;
	var minP = index > 0 ? points[index - 1].pwm : PWM_MIN;
	var maxP = index < points.length - 1 ? points[index + 1].pwm : PWM_MAX;

	var nextTemp = (minT > maxT) ? point.temp : clamp(Math.round(temp), minT, maxT);
	var nextPwm = clamp(Math.round(pwm), Math.min(minP, maxP), Math.max(minP, maxP));

	if (nextTemp === point.temp && nextPwm === point.pwm) return false;
	point.temp = nextTemp;
	point.pwm = nextPwm;
	return true;
}

function dragTo(ev) {
	if (state.drag < 0 || !state.geom) return;
	var pos = canvasOffset(ev);
	var g = state.geom;
	var temp = TEMP_MIN + (pos.x - g.pad.left) / g.plotW * (TEMP_MAX - TEMP_MIN);
	var pwm = (g.pad.top + g.plotH - pos.y) / g.plotH * PWM_MAX;

	if (applyPoint(state.drag, temp, pwm)) {
		markDirty();
		syncPoints();
		drawAll();
	}
	positionTip();
}

function positionTip() {
	if (!ui || !ui.tip || state.drag < 0 || !state.geom) return;
	var point = state.custom[state.drag];
	var g = state.geom;
	var x = toX(g, point.temp);
	var y = toY(g, point.pwm);
	ui.tip.textContent = point.temp + ' \u00b0C \u00b7 ' + pct(point.pwm) + '%';
	ui.tip.style.left = clamp(x, 44, (ui.canvas.clientWidth || 0) - 44) + 'px';
	ui.tip.style.top = clamp(y, 22, (ui.canvas.clientHeight || 0) - 8) + 'px';
	ui.tip.classList.add('is-visible');
}

function beginDrag(index, ev) {
	convertToCustom();
	state.drag = index;
	state.selected = index;
	state.hover = index;
	syncPresets();
	/* The hint and the reset link are preset-dependent; refresh them now so
	 * the "switched to a custom curve" explanation appears with the drag. */
	syncEditorState();
	ui.editor.classList.add('is-dragging');
	ui.canvas.classList.add('is-editable');
	try { ui.canvas.setPointerCapture(ev.pointerId); } catch (e) {}
	ui.canvas.focus();
	dragTo(ev);
}

function endDrag() {
	if (state.drag < 0) return;
	state.drag = -1;
	if (ui) {
		ui.editor.classList.remove('is-dragging');
		if (ui.tip) ui.tip.classList.remove('is-visible');
	}
	drawAll();
}

function bindCanvas() {
	var canvas = ui.canvas;

	canvas.addEventListener('pointerdown', function(ev) {
		var index = hitTest(ev);
		if (index < 0) return;
		ev.preventDefault();
		beginDrag(index, ev);
	});

	canvas.addEventListener('pointermove', function(ev) {
		if (state.drag >= 0) { dragTo(ev); return; }
		var index = hitTest(ev);
		if (index !== state.hover) {
			state.hover = index;
			canvas.classList.toggle('is-editable', index >= 0);
			drawCurve();
		}
	});

	[ 'pointerup', 'pointercancel' ].forEach(function(type) {
		canvas.addEventListener(type, endDrag);
	});

	canvas.addEventListener('pointerleave', function() {
		if (state.drag >= 0) return;
		state.hover = -1;
		canvas.classList.remove('is-editable');
		drawCurve();
	});

	/* Pointer dragging needs a keyboard twin. Focus lands on the canvas via
	 * Tab; arrows nudge the selected point (Shift = coarse). The precise
	 * inputs below remain the fully labelled alternative. */
	canvas.addEventListener('focus', function() {
		if (state.selected < 0) state.selected = 0;
		syncAnnounce();
		drawCurve();
	});
	canvas.addEventListener('blur', function() { drawCurve(); });
	canvas.addEventListener('keydown', function(ev) {
		var stepT = ev.shiftKey ? 5 : 1;
		var stepP = ev.shiftKey ? 25 : 5;
		/* Read from the displayed curve, not from state.custom: while a preset
		 * is active the custom slot may still hold an older, unrelated shape. */
		var visible = activePoints();
		var point = visible[state.selected >= 0 ? state.selected : 0];
		if (!point) return;
		var temp = point.temp, pwm = point.pwm;
		var handled = true;
		switch (ev.key) {
		case 'ArrowLeft': temp -= stepT; break;
		case 'ArrowRight': temp += stepT; break;
		case 'ArrowUp': pwm += stepP; break;
		case 'ArrowDown': pwm -= stepP; break;
		case 'Escape': state.selected = -1; handled = false; break;
		default: handled = false;
		}
		if (!handled) return;
		ev.preventDefault();
		if (state.selected < 0) state.selected = 0;
		/* Same rule as dragging: nudging a preset turns it into a custom
		 * curve instead of silently editing an invisible array. */
		if (convertToCustom()) syncPresets();
		applyPoint(state.selected, temp, pwm);
		markDirty();
		syncPoints();
		syncEditorState();
		drawAll();
		syncAnnounce();
	});
}

/* --------------------------------------------------------------- mutation */

function markDirty() {
	state.dirty = true;
	syncChips();
}

function chooseMode(mode) {
	if (state.mode === mode) return;
	state.mode = mode;
	markDirty();
	syncAll();
}

function choosePreset(preset) {
	if (state.preset === preset) return;
	state.preset = preset;
	markDirty();
	syncPresets();
	syncPoints();
	syncEditorState();
	drawAll();
}

function setManualPwm(pwm) {
	var value = clamp(Math.round(pwm), PWM_MIN, PWM_MAX);
	if (value === state.manualPwm) return;
	state.manualPwm = value;
	markDirty();
	syncManual();
}

function resetCurve() {
	state.custom = copyPoints(DEFAULT_POINTS);
	if (state.preset !== 'custom') state.preset = 'custom';
	markDirty();
	syncPresets();
	syncPoints();
	syncEditorState();
	drawAll();
}

function discardChanges() {
	if (!state.saved || !state.dirty) return;
	state.mode = state.saved.mode;
	state.preset = state.saved.preset;
	state.manualPwm = state.saved.manualPwm;
	state.custom = copyPoints(state.saved.custom);
	state.curves.custom = copyPoints(state.saved.custom);
	state.dirty = false;
	state.selected = -1;
	syncAll();
	showToast(_('Changes discarded'), 'info');
}

/* ------------------------------------------------------------------- sync */

function syncChips() {
	if (!ui) return;
	var manual = state.mode === 'manual';
	ui.modeChip.textContent = manual ? _('Fixed speed') : _('Automatic');
	ui.modeChip.setAttribute('data-level', manual ? 'warn' : 'info');

	if (manual) {
		ui.presetChip.textContent = _('Curve is paused');
		ui.presetChip.setAttribute('data-level', 'none');
	} else {
		var meta = PRESET_META[state.preset] || PRESET_META.balanced;
		ui.presetChip.textContent = meta.label;
		ui.presetChip.setAttribute('data-level', state.preset === 'custom' ? 'custom' : 'info');
	}

	var temp = state.live.temp;
	if (temp > 0) {
		ui.tempChip.textContent = _('Board %s').format(temp + ' \u00b0C');
		ui.tempChip.setAttribute('data-level', fanTheme.tempLevel(temp).key);
		ui.tempChip.hidden = false;
	} else {
		ui.tempChip.hidden = true;
	}

	ui.dirtyChip.hidden = !state.dirty;
}

function syncMode() {
	if (!ui) return;
	ui.modeCell.setAttribute('data-level', state.mode === 'manual' ? 'warn' : 'info');
	ui.segButtons.forEach(function(button) {
		var on = button.getAttribute('data-mode') === state.mode;
		button.classList.toggle('is-on', on);
		button.setAttribute('aria-pressed', on ? 'true' : 'false');
	});
	ui.manualPanel.hidden = state.mode !== 'manual';
	ui.curveBody.hidden = state.mode !== 'auto';
}

function syncManual() {
	if (!ui) return;
	var pwm = state.manualPwm;
	ui.manualValue.textContent = String(pct(pwm));
	ui.manualPwm.textContent = 'PWM ' + pwm;
	ui.slider.value = String(pwm);
	ui.slider.style.setProperty('--pct', (pwm / PWM_MAX * 100) + '%');
	ui.slider.setAttribute('aria-valuetext', pct(pwm) + '% (PWM ' + pwm + ')');

	ui.quick.forEach(function(button) {
		var target = parseInt(button.getAttribute('data-pwm'), 10);
		button.classList.toggle('is-on', Math.abs(target - pwm) <= 2);
	});

	var warn = pct(pwm) < 15;
	ui.manualNote.setAttribute('data-level', warn ? 'warn' : 'none');
	ui.manualNote.textContent = warn
		? _('Very low speed may not cool the board.')
		: _('The fan holds this speed regardless of temperature.');
}

function syncPresets() {
	if (!ui) return;
	ui.presetTiles.forEach(function(tile) {
		var on = tile.getAttribute('data-preset') === state.preset;
		tile.classList.toggle('is-on', on);
		if (tile.input) tile.input.checked = on;
		/* Only the custom entry owns the warm accent; every other selected
		 * tile uses the same data hue as the curve it draws. */
		tile.setAttribute('data-level',
			on ? (tile.getAttribute('data-preset') === 'custom' ? 'custom' : 'series') : 'none');
	});
}

function syncPoints() {
	if (!ui) return;
	var points = activePoints();
	ui.rows.forEach(function(row, i) {
		var point = points[i];
		if (!point) return;
		if (document.activeElement !== row.temp) row.temp.value = String(point.temp);
		if (document.activeElement !== row.pwm) row.pwm.value = String(point.pwm);
		row.pct.textContent = pct(point.pwm) + '%';
	});
}

function syncEditorState() {
	if (!ui) return;
	var custom = state.preset === 'custom';
	var label = PRESET_META[state.preset] ? PRESET_META[state.preset].label : PRESET_META.balanced.label;
	ui.curveHint.textContent = custom
		? _('Drag a point: sideways changes the temperature, up and down changes the speed.')
		: _('Dragging a point switches to a custom curve based on “%s”.').format(label);
	ui.resetBtn.hidden = !custom;
	ui.canvas.setAttribute('aria-label',
		_('Fan curve editor with 5 draggable points, current preset %s').format(label));
	ui.presetNote.textContent = custom
		? _('This curve is what the fan follows in automatic mode.')
		: _('Presets are fixed. Drag a point or pick Custom to make your own.');
	syncAnnounce();
}

function syncEditorLive() {
	if (!ui) return;
	var points = activePoints();
	var temp = state.live.temp;
	if (temp > 0) {
		ui.curveLive.textContent = _('Now %s → about %s').format(temp + ' \u00b0C', pct(pwmAt(points, temp)) + '%');
		ui.curveLive.hidden = false;
	} else {
		ui.curveLive.textContent = '';
		ui.curveLive.hidden = true;
	}
}

function syncAnnounce() {
	if (!ui || !ui.announce) return;
	var point = activePoints()[state.selected];
	ui.announce.textContent = point
		? _('Point %d: %s °C, %d%% speed').format(state.selected + 1, point.temp, pct(point.pwm))
		: '';
}

function syncAll() {
	if (!ui) return;
	syncMode();
	syncManual();
	syncPresets();
	syncPoints();
	syncEditorState();
	syncEditorLive();
	syncChips();
	drawAll();
}

/* ------------------------------------------------------------------- build */

function segButton(mode, title) {
	var button = E('button', {
		'type': 'button', 'class': 'fan-seg-btn', 'data-mode': mode
	}, title);
	button.addEventListener('click', function() { chooseMode(mode); });
	return button;
}

function presetTile(key) {
	var spark = E('canvas', { 'class': 'fan-preset-spark', 'aria-hidden': 'true' });
	/* A label, not a button: themes such as Argon pin every <button> to
	 * height:2.5rem, which clips the hint line under the sparkline. The hidden
	 * radio keeps the tile keyboard-navigable and gives it a checked state the
	 * browser maintains by itself (arrow keys move within the group). */
	var input = E('input', {
		'type': 'radio', 'class': 'fan-preset-input', 'name': 'fan-preset',
		'value': key, 'autocomplete': 'off'
	});
	var tile = E('label', { 'class': 'fan-preset', 'data-preset': key, 'data-level': 'none' }, [
		input,
		E('span', { 'class': 'fan-preset-name' }, PRESET_META[key].label),
		spark,
		E('span', { 'class': 'fan-preset-hint' }, PRESET_META[key].hint)
	]);
	/* click covers pointer/touch; change covers keyboard radio navigation
	 * (the native click a label forwards also lands here — choosePreset is
	 * idempotent for the already-active preset). */
	tile.addEventListener('click', function() { choosePreset(key); });
	input.addEventListener('change', function() { if (input.checked) choosePreset(key); });
	tile.spark = spark;
	tile.input = input;
	return tile;
}

function pointRow(index) {
	var temp = E('input', {
		'type': 'number', 'inputmode': 'numeric', 'min': String(TEMP_MIN), 'max': String(TEMP_MAX),
		'step': '1', 'aria-label': _('Point %d temperature in °C').format(index + 1)
	});
	var pwm = E('input', {
		'type': 'number', 'inputmode': 'numeric', 'min': String(PWM_MIN), 'max': String(PWM_MAX),
		'step': '1', 'aria-label': _('Point %d PWM value').format(index + 1)
	});
	var pctCell = E('span', { 'class': 'fan-point-pct' }, '');
	var row = E('div', { 'class': 'fan-point-row' }, [
		E('span', { 'class': 'fan-point-no' }, String(index + 1)),
		temp, pwm, pctCell
	]);

	function commit(which) {
		var value = parseInt(which === 'temp' ? temp.value : pwm.value, 10);
		if (isNaN(value)) {
			syncPoints();
			return;
		}
		/* Convert first, then re-read: on a preset the custom slot may hold a
		 * different shape, and the untouched axis must come from the curve
		 * that is actually on screen. */
		var converted = convertToCustom();
		var point = state.custom[index];
		if (!point) return;
		var changed = applyPoint(index,
			which === 'temp' ? value : point.temp,
			which === 'pwm' ? value : point.pwm);
		if (converted || changed) markDirty();
		syncPresets();
		syncEditorState();
		syncPoints();
		drawAll();
	}

	temp.addEventListener('input', function() { if (temp.value !== '') commit('temp'); });
	pwm.addEventListener('input', function() { if (pwm.value !== '') commit('pwm'); });
	temp.addEventListener('change', function() { commit('temp'); });
	pwm.addEventListener('change', function() { commit('pwm'); });
	[ temp, pwm ].forEach(function(input) {
		input.addEventListener('focus', function() {
			state.selected = index;
			row.classList.add('is-focus');
			drawCurve();
			syncAnnounce();
		});
		input.addEventListener('blur', function() {
			row.classList.remove('is-focus');
			syncPoints();
			drawCurve();
		});
	});

	return { node: row, temp: temp, pwm: pwm, pct: pctCell };
}

function buildUI() {
	var root = E('div', { 'class': 'cbi-map fan-app fan-dashboard fan-settings' });

	/* Header: the merged page has no tab strip to carry its name any more, so
	 * the title lives here, next to the freshness indicator and the context
	 * chips (mode / preset / board temperature / unsaved). */
	var liveDot = E('span', { 'class': 'fan-live-dot', 'id': 'fan-live-dot', 'data-state': 'pending' });
	var liveText = E('span', { 'id': 'fan-live-text' }, _('Collecting data…'));
	var lastUpdate = E('span', { 'id': 'fan-last-update' }, '');

	var modeChip = E('span', { 'class': 'fan-context-chip', 'id': 'fan-ctx-mode' }, '');
	var presetChip = E('span', { 'class': 'fan-context-chip', 'id': 'fan-ctx-preset' }, '');
	var tempChip = E('span', { 'class': 'fan-context-chip fan-chip-temp',
		'id': 'fan-ctx-temp', 'hidden': true }, '');
	var dirtyChip = E('span', { 'class': 'fan-context-chip fan-context-chip-dirty',
		'id': 'fan-ctx-dirty', 'hidden': true }, _('Unsaved'));

	root.appendChild(E('div', { 'class': 'fan-app-header fan-context-bar' }, [
		E('div', { 'class': 'fan-app-title' }, [
			fanTheme.icon('fan'),
			E('span', { 'class': 'fan-app-title-text' }, _('Fan Control')),
			E('span', { 'class': 'fan-live' }, [ liveDot, liveText ]),
			lastUpdate
		]),
		E('div', { 'class': 'fan-context-chips' }, [ modeChip, presetChip, tempChip, dirtyChip ])
	]));

	/* 1. Temperatures - the reading users open this page for, so it leads.
	 * The board sensor drives the fan curve and gets a full-width row; the
	 * other sensors follow in two groups. */
	root.appendChild(E('div', { 'class': 'fan-panel' }, [
		E('div', { 'class': 'fan-panel-head' }, [
			E('h2', { 'class': 'fan-panel-title' }, _('Temperatures')),
			tempLegend()
		]),
		boardGauge(null),
		E('div', { 'class': 'fan-temp-grid' }, [
			temperatureGroup(_('System'), SYSTEM_GAUGES, null),
			temperatureGroup(_('WiFi'), WIFI_GAUGES, null)
		])
	]));

	/* 2. Real-time trends, right under the temperatures they explain. */
	root.appendChild(E('div', { 'class': 'fan-panel' }, [
		E('div', { 'class': 'fan-panel-head' }, [
			E('h2', { 'class': 'fan-panel-title' }, _('Real-time Trends')),
			E('div', { 'class': 'fan-panel-hint' }, _('Last 2 minutes'))
		]),
		E('div', { 'class': 'fan-chart-grid' }, CHARTS.map(function(chart) {
			return chartCard(chart, null);
		}))
	]));

	/* 3. Control panel: the mode choice, the running-config summary cards and
	 * the curve editor live in ONE panel. In manual mode the curve body is
	 * swapped for the fixed-speed panel below. The segment shows the editable
	 * choice (with the dirty chip flagging unsaved changes), the cards show
	 * what the fan is doing right now. */
	var modeCell = E('div', { 'class': 'fan-mode-cell', 'data-level': 'info' }, [
		E('div', { 'class': 'fan-seg', 'role': 'group',
			'aria-label': _('Control mode') }, [
			segButton('auto', _('Automatic')),
			segButton('manual', _('Manual'))
		])
	]);

	/* Curve sub-block inside the merged panel; hidden in manual mode. */
	var presetTiles = PRESETS.map(presetTile);
	var sparks = {};
	presetTiles.forEach(function(tile) { sparks[tile.getAttribute('data-preset')] = tile.spark; });

	var curveLive = E('span', { 'class': 'fan-panel-hint fan-curve-live' }, '');
	var canvas = E('canvas', {
		'class': 'fan-editor-canvas',
		/* application, not img: the canvas is a keyboard-editable curve, and
		 * role=img would tell screen readers to skip its keys. */
		'role': 'application', 'tabindex': '0',
		'aria-label': _('Fan curve editor')
	});
	var tip = E('div', { 'class': 'fan-editor-tip', 'aria-hidden': 'true' });
	var editor = E('div', { 'class': 'fan-editor' }, [ canvas, tip ]);

	var resetBtn = E('button', { 'type': 'button', 'class': 'fan-link' }, _('Reset curve'));
	resetBtn.addEventListener('click', resetCurve);

	var rows = [];
	var pointsBody = E('div', { 'class': 'fan-points' }, [
		E('div', { 'class': 'fan-point-head' }, [
			E('span', {}, '#'),
			E('span', {}, _('Temperature °C')),
			E('span', {}, _('PWM')),
			E('span', {}, _('Output'))
		])
	]);
	for (var i = 0; i < 5; i++) {
		var row = pointRow(i);
		rows.push(row);
		pointsBody.appendChild(row.node);
	}

	var presetNote = E('p', { 'class': 'fan-note' }, '');
	var curveHint = E('div', { 'class': 'fan-panel-hint fan-curve-tip' }, '');

	var curveBody = E('div', { 'class': 'fan-curve-body' }, [
		E('div', { 'class': 'fan-control-subhead' }, [
			E('h3', { 'class': 'fan-subhead-title' }, _('Temperature curve')),
			curveLive
		]),
		E('div', { 'class': 'fan-preset-grid', 'role': 'group',
			'aria-label': _('Curve presets') }, presetTiles),
		presetNote,
		editor,
		E('div', { 'class': 'fan-editor-foot' }, [ curveHint, resetBtn ]),
		E('details', { 'class': 'fan-precise' }, [
			E('summary', {}, _('Precise values')),
			pointsBody
		])
	]);

	root.appendChild(E('div', { 'class': 'fan-panel fan-control-panel' }, [
		E('div', { 'class': 'fan-panel-head' }, [
			E('h2', { 'class': 'fan-panel-title' }, _('Control Mode')),
			E('span', { 'class': 'fan-panel-hint' }, _('One choice, applied to the whole fan'))
		]),
		E('div', { 'class': 'fan-overview-grid' },
			[ modeCell ].concat(summaryData(null).map(summaryCard))),
		curveBody
	]));

	/* 5. Manual speed - the manual-mode alternative to the curve body. */
	var manualValue = E('strong', {}, '50');
	var manualPwm = E('b', {}, 'PWM 128');
	var slider = E('input', {
		'type': 'range', 'class': 'fan-slider', 'min': String(PWM_MIN), 'max': String(PWM_MAX),
		'step': '1', 'aria-label': _('Fixed fan speed')
	});
	slider.addEventListener('input', function() { setManualPwm(parseInt(slider.value, 10)); });

	var quick = [ 25, 50, 75, 100 ].map(function(percent) {
		var pwm = Math.round(percent / 100 * PWM_MAX);
		var button = E('button', {
			'type': 'button', 'class': 'fan-chip', 'data-pwm': String(pwm)
		}, percent + '%');
		button.addEventListener('click', function() { setManualPwm(pwm); });
		return button;
	});

	var manualNote = E('p', { 'class': 'fan-note', 'data-level': 'none' }, '');

	var manualPanel = E('section', { 'class': 'fan-panel fan-manual-panel' }, [
		E('div', { 'class': 'fan-panel-head' }, [
			E('h2', { 'class': 'fan-panel-title' }, _('Fixed speed')),
			E('span', { 'class': 'fan-panel-hint' }, _('Slide to set one speed'))
		]),
		E('div', { 'class': 'fan-speed' }, [
			E('div', { 'class': 'fan-speed-value' }, [ manualValue, E('span', {}, '%') ]),
			E('div', { 'class': 'fan-speed-meta' }, [ manualPwm, E('span', {}, _('Fan output')) ])
		]),
		slider,
		E('div', { 'class': 'fan-speed-scale' }, [
			E('span', {}, '0'), E('span', {}, '25'), E('span', {}, '50'),
			E('span', {}, '75'), E('span', {}, '100')
		]),
		E('div', { 'class': 'fan-speed-quick' }, quick),
		manualNote
	]);
	root.appendChild(manualPanel);

	/* No save bar here on purpose: the theme renders Save & Apply / Save /
	 * Reset from the view's handleSave* callbacks (luci.js addFooter). */
	var announce = E('div', { 'class': 'fan-sr', 'aria-live': 'polite' }, '');
	root.appendChild(announce);
	var toast = E('div', { 'class': 'fan-toast', 'role': 'status', 'aria-live': 'polite' }, '');
	root.appendChild(toast);

	return {
		root: root,
		liveDot: liveDot,
		liveText: liveText,
		lastUpdate: lastUpdate,
		modeChip: modeChip,
		presetChip: presetChip,
		tempChip: tempChip,
		dirtyChip: dirtyChip,
		modeCell: modeCell,
		segButtons: Array.prototype.slice.call(modeCell.querySelectorAll('.fan-seg-btn')),
		manualPanel: manualPanel,
		manualValue: manualValue,
		manualPwm: manualPwm,
		manualNote: manualNote,
		slider: slider,
		quick: quick,
		curveBody: curveBody,
		curveLive: curveLive,
		curveHint: curveHint,
		presetNote: presetNote,
		presetTiles: presetTiles,
		sparks: sparks,
		editor: editor,
		canvas: canvas,
		tip: tip,
		resetBtn: resetBtn,
		rows: rows,
		announce: announce,
		toast: toast
	};
}

/* ------------------------------------------------------------------ saving */

var toastTimer = null;

function showToast(text, kind) {
	if (!ui || !ui.toast) return;
	ui.toast.textContent = text;
	ui.toast.setAttribute('data-kind', kind || 'ok');
	ui.toast.classList.add('is-visible');
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = setTimeout(function() {
		if (ui && ui.toast) ui.toast.classList.remove('is-visible');
	}, 2600);
}

function finishSave(ok, message, applied) {
	state.saving = false;
	if (ok) {
		state.dirty = false;
		state.saved = {
			mode: state.mode,
			preset: state.preset,
			manualPwm: state.manualPwm,
			custom: copyPoints(state.custom)
		};
		state.curves.custom = copyPoints(state.custom);
		showToast(applied ? _('Applied') : _('Saved, not applied yet'), 'ok');
		fetchData();
	} else {
		showToast(_('Could not apply: %s').format(message || _('unknown error')), 'error');
	}
	syncChips();
}

/* Older rpcd builds have no applySettings. Fall back to the four single-field
 * methods, ordered so the last write wins on curve_preset (setCustomCurve
 * always flips it to "custom"). They always reload, so "Save" cannot honour
 * the not-applied case here - the toast says "applied" accordingly. */
function legacyApply() {
	return callSetCustomCurve(state.custom)
		.then(function() { return callSetPreset(state.preset); })
		.then(function() { return callSetMode(state.mode); })
		.then(function() { return callSetManualPwm(state.manualPwm); })
		.then(function() { finishSave(true, null, true); });
}

/* apply=false is the theme's plain "Save": config only, running fan untouched. */
function saveChanges(applied) {
	if (state.saving) return Promise.resolve();
	if (!state.dirty) return Promise.resolve();

	state.saving = true;
	syncChips();

	return callApplySettings(state.mode, state.manualPwm, state.preset, state.custom, applied ? 1 : 0)
		.then(function(res) {
			if (res && res.success === false) throw new Error(res.error || _('unknown error'));
			finishSave(true, null, applied);
		})
		.catch(function() {
			return legacyApply().catch(function(err) {
				finishSave(false, err && err.message);
			});
		});
}

/* ------------------------------------------------------------------- poll */

/* One poll feeds the whole page: summary cards, gauges, trend history and
 * the curve editor's live marker all read the same getStatus response. */
function fetchData() {
	if (!ui || !ui.root.isConnected || document.hidden) return Promise.resolve();
	return callGetStatus().then(function(current) {
		current = current || {};
		fanTheme.apply();
		state.live = {
			temp: parseInt(current.temp_board, 10) || 0,
			pwm: parseInt(current.fan_pwm, 10) || 0,
			rpm: parseInt(current.fan_rpm, 10) || 0
		};
		updateSummary(current);
		ALL_GAUGES.forEach(function(gauge) {
			updateGauge(gauge, current[gauge.key] || 0);
		});
		updateChartValues(current);
		appendHistory(current);
		drawAllCharts();
		syncChips();
		syncEditorLive();
		drawCurve();
		markLive(true, Date.now());
	}).catch(function() {
		/* Keep the last known readings on screen; markLive flags them stale. */
		markLive(false, 0);
	});
}

function ensurePoll() {
	if (pollReady) return;
	pollReady = true;
	poll.add(fetchData, 3);
}

/* ------------------------------------------------------------------- view */

return view.extend({
	load: function() {
		return Promise.all([ uci.load('fan'), callGetAllCurves() ]);
	},

	render: function(data) {
		fanTheme.apply();

		var curves = (data && data[1]) || {};
		var mode = uci.get('fan', 'settings', 'mode');
		var preset = uci.get('fan', 'settings', 'curve_preset');
		var manual = parseInt(uci.get('fan', 'settings', 'manual_pwm'), 10);

		state.mode = mode === 'manual' ? 'manual' : 'auto';
		state.preset = PRESETS.indexOf(preset) >= 0 ? preset : 'balanced';
		state.manualPwm = isNaN(manual) ? 127 : clamp(manual, PWM_MIN, PWM_MAX);
		state.curves = {
			quiet: sanitize(curves.quiet || FALLBACK_CURVES.quiet),
			balanced: sanitize(curves.balanced || FALLBACK_CURVES.balanced),
			performance: sanitize(curves.performance || FALLBACK_CURVES.performance),
			custom: sanitize(curves.custom || FALLBACK_CURVES.custom)
		};
		state.custom = copyPoints(state.curves.custom);
		state.saved = {
			mode: state.mode,
			preset: state.preset,
			manualPwm: state.manualPwm,
			custom: copyPoints(state.custom)
		};
		state.dirty = false;
		state.saving = false;
		state.drag = -1;
		state.hover = -1;
		state.selected = -1;

		ui = buildUI();
		bindCanvas();
		restoreHistory();

		if (!themeReady) {
			themeReady = true;
			fanTheme.onThemeChange(function() {
				drawAllCharts();
				if (ui) drawAll();
			});
		}
		themeWatched = true;

		requestAnimationFrame(function() {
			fanTheme.apply();
			syncAll();
			drawAllCharts();
			CHARTS.forEach(bindChartTooltip);
			ensurePoll();
			fetchData();

			if (window.ResizeObserver) {
				new window.ResizeObserver(function() {
					if (ui) { drawAll(); drawAllCharts(); }
				}).observe(ui.canvas);
			} else {
				window.addEventListener('resize', function() {
					if (ui) { drawAll(); drawAllCharts(); }
				});
			}
		});

		return ui.root;
	},

	/* luci.js renders the footer (Save & Apply / Save / Reset) from these
	 * callbacks, so the page must not draw its own action bar. */
	handleSave: function() {
		return saveChanges(false);
	},

	handleSaveApply: function() {
		return saveChanges(true);
	},

	handleReset: function() {
		discardChanges();
		return Promise.resolve();
	}
});
