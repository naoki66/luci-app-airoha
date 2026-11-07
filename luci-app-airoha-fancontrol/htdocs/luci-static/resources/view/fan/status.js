'use strict';
'require dom';
'require poll';
'require rpc';
'require view';
'require view.fan.theme as fanTheme';

var callFanStatus = rpc.declare({
	object: 'luci.fan',
	method: 'getStatus'
});

var HISTORY_WINDOW_MS = 2 * 60 * 1000;
var TIME_GRID_INTERVAL_MS = 10 * 1000;
var TIME_LABEL_INTERVAL_MS = 30 * 1000;
var VALUE_GRID_DIVISIONS = 4;
var HISTORY_STORAGE_KEY = 'airoha-fancontrol-history-v1';
var CHART_PAD = { left: 31, right: 6, top: 7, bottom: 16 };
var history = [];
var themeWatched = false;

/* Every readout on this page is keyed by a semantic level rather than a raw
 * hex colour. The level maps onto the shared ramp in theme.js, so the same
 * blue / green / amber / red means the same thing here and on the settings
 * page, and both light and dark palettes stay above 4.5:1 for text. */
var CHARTS = [
	{ id: 'fc-temp', key: 'temperature', level: 'hot',
		line: '--fan-hot', fill: '--fan-hot-soft',
		lineFallback: '#bc4c00', fillFallback: 'rgba(188,76,0,.14)',
		minMax: 40, step: 20, label: _('Board Temperature'), unit: 'C',
		format: function(value) { return value + '\u00b0'; },
		read: function(s) { return (s.temp_board || 0) + '\u00b0C'; } },
	{ id: 'fc-pwm', key: 'pwm', level: 'info',
		line: '--fan-info', fill: '--fan-info-soft',
		lineFallback: '#0969da', fillFallback: 'rgba(9,105,218,.14)',
		minMax: 100, step: 50, label: _('Fan PWM'), unit: ' / 255',
		format: function(value) { return String(value); },
		read: function(s) { return (s.fan_pwm || 0) + ' / 255'; } },
	{ id: 'fc-rpm', key: 'rpm', level: 'ok',
		line: '--fan-ok', fill: '--fan-ok-soft',
		lineFallback: '#1a7f37', fillFallback: 'rgba(26,127,55,.16)',
		minMax: 1000, step: 500, label: _('Fan Speed'), unit: ' RPM',
		format: function(value) { return String(value); },
		read: function(s) { return (s.fan_rpm || 0) + ' RPM'; } }
];

var SYSTEM_GAUGES = [
	{ id: 'temp-cpu', key: 'temp_cpu', label: _('CPU') },
	{ id: 'temp-board', key: 'temp_board', label: _('Board (Fan Curve)') },
	{ id: 'temp-phy1', key: 'temp_phy1', label: _('10G PHY') },
	{ id: 'temp-phy2', key: 'temp_phy2', label: _('Switch PHY') }
];

var WIFI_GAUGES = [
	{ id: 'temp-wifi24g', key: 'wifi_24g', label: _('2.4 GHz Radio') },
	{ id: 'temp-wifi5g', key: 'wifi_5g', label: _('5 GHz Radio') },
	{ id: 'temp-wifi6g', key: 'wifi_6g', label: _('6 GHz Radio') }
];

var ALL_GAUGES = SYSTEM_GAUGES.concat(WIFI_GAUGES);

var PRESET_INFO = {
	quiet: { value: _('Quiet'), sub: _('Low noise priority'), level: 'ok' },
	balanced: { value: _('Balanced'), sub: _('Noise and cooling balanced'), level: 'ok' },
	performance: { value: _('Performance'), sub: _('Cooling priority'), level: 'ok' },
	custom: { value: _('Custom'), sub: _('Custom temperature curve'), level: 'custom' }
};

function clockText(ts) {
	var d = new Date(ts);
	function pad(v) { return v < 10 ? '0' + v : String(v); }
	return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/* A monitoring page has to say how fresh its numbers are. A failed RPC used to
 * leave the last values on screen with no indication that they had gone stale. */
function markLive(ok, ts, root) {
	var dot = document.getElementById('fan-live-dot');
	var text = document.getElementById('fan-live-text');
	var stamp = document.getElementById('fan-last-update');
	if (dot) dot.setAttribute('data-state', ok ? 'live' : 'stale');
	if (text) text.textContent = ok ? _('Live') : _('Connection lost');
	if (stamp) stamp.textContent = ok
		? _('Last update %s').format(clockText(ts))
		: _('Showing the last known values');
	if (root) root.classList.toggle('is-stale', !ok);
}

function healthInfo(status) {
	if (!status) return { level: 'none', text: _('No data') };
	var maxTemp = 0;
	ALL_GAUGES.forEach(function(gauge) {
		maxTemp = Math.max(maxTemp, Number(status[gauge.key]) || 0);
	});
	if ((Number(status.fan_rpm) || 0) === 0 && (Number(status.fan_pwm) || 0) > 0)
		return { level: 'error', text: _('Fan stopped') };
	if (maxTemp > fanTheme.THRESHOLDS[2])
		return { level: 'error', text: _('Overheating') };
	if (maxTemp > fanTheme.THRESHOLDS[1])
		return { level: 'hot', text: _('Hot') };
	return { level: 'ok', text: _('Normal') };
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

function renderSummary(status) {
	return E('div', { 'class': 'fan-summary-grid' }, summaryData(status).map(function(card) {
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
	}));
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

function tickElements() {
	return fanTheme.tempTicks().map(function(threshold) {
		return E('div', { 'class': 'fan-temp-tick', 'style': 'left:' + threshold + '%' });
	});
}

function scaleElements() {
	var nodes = [ E('span', {}, '0') ];
	fanTheme.tempTicks().forEach(function(threshold) {
		nodes.push(E('span', { 'style': 'left:' + threshold + '%' }, String(threshold)));
	});
	nodes.push(E('span', {}, '100\u00b0C'));
	return nodes;
}

function createTempGauge(gauge, temp) {
	var level = fanTheme.tempLevel(temp);
	var trackChildren = [
		E('div', { 'class': 'fan-temp-fill', 'data-role': 'fill',
			'style': 'width:' + fanTheme.tempPercent(temp) + '%' })
	].concat(tickElements());

	return E('div', { 'id': gauge.id, 'class': 'fan-temp-card', 'data-level': level.key }, [
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

function appendHistory(status) {
	var now = Date.now();
	history.push({ time: now, temperature: status.temp_board || 0,
		pwm: status.fan_pwm || 0, rpm: status.fan_rpm || 0 });
	while (history.length && history[0].time < now - HISTORY_WINDOW_MS) history.shift();
	persistHistory();
}

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
	ctx.fillStyle = fillColor;
	ctx.fill();
	ctx.beginPath();
	for (var j = 0; j < hist.length; j++) {
		var linePoint = point(hist[j]);
		j === 0 ? ctx.moveTo(linePoint.x, linePoint.y) : ctx.lineTo(linePoint.x, linePoint.y);
	}
	ctx.strokeStyle = lineColor;
	ctx.lineWidth = 1.7;
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
		ctx.arc(hp.x, hp.y, 3.5, 0, 2 * Math.PI);
		ctx.fill();
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

return view.extend({
	load: function() {
		return Promise.resolve([]);
	},

	render: function() {
		fanTheme.apply();
		if (!themeWatched) {
			themeWatched = true;
			fanTheme.onThemeChange(function() { drawAllCharts(); });
		}
		restoreHistory();

		var viewEl = E('div', { 'class': 'cbi-map fan-app fan-dashboard' }, [
			E('div', { 'class': 'fan-app-header' }, [
				E('div', {}, [
					E('h2', {}, _('Fan Status')),
					E('div', { 'class': 'fan-app-subtitle' },
						_('View real-time fan speed and system temperatures.'))
				]),
				E('div', { 'class': 'fan-app-meta' }, [
					E('span', { 'class': 'fan-live' }, [
						E('span', { 'class': 'fan-live-dot', 'id': 'fan-live-dot', 'data-state': 'pending' }),
						E('span', { 'id': 'fan-live-text' }, _('Collecting data…'))
					]),
					E('span', { 'id': 'fan-last-update' }, '')
				])
			]),
			renderSummary(null),
			E('div', { 'class': 'fan-panel' }, [
				E('div', { 'class': 'fan-panel-head' }, [
					E('div', { 'class': 'fan-panel-title' }, _('Real-time Trends')),
					E('div', { 'class': 'fan-panel-hint' }, _('Last 2 minutes'))
				]),
				E('div', { 'class': 'fan-chart-grid' }, CHARTS.map(function(chart) {
					return chartCard(chart, null);
				}))
			]),
			E('div', { 'class': 'fan-panel' }, [
				E('div', { 'class': 'fan-panel-head' }, [
					E('div', { 'class': 'fan-panel-title' }, _('Temperatures')),
					E('div', { 'class': 'fan-panel-hint' }, '0\u2013100\u00b0C')
				]),
				E('div', { 'class': 'fan-temp-grid' }, [
					temperatureGroup(_('System'), SYSTEM_GAUGES, null),
					temperatureGroup(_('WiFi'), WIFI_GAUGES, null)
				])
			])
		]);

		var fetchData = L.bind(function() {
			return callFanStatus().then(L.bind(function(current) {
				current = current || {};
				fanTheme.apply();
				updateSummary(current);
				ALL_GAUGES.forEach(function(gauge) {
					updateGauge(gauge, current[gauge.key] || 0);
				});
				updateChartValues(current);
				appendHistory(current);
				drawAllCharts();
				markLive(true, Date.now(), viewEl);
			}, this)).catch(L.bind(function() {
				markLive(false, 0, viewEl);
			}, this));
		}, this);

		requestAnimationFrame(function() {
			drawAllCharts();
			CHARTS.forEach(bindChartTooltip);
			fetchData();
		});
		poll.add(fetchData, 3);
		return viewEl;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
