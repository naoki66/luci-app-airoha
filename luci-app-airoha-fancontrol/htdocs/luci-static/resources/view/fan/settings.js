'use strict';
'require view';
'require form';
'require uci';
'require rpc';
'require view.fan.theme as fanTheme';

var callGetAllCurves = rpc.declare({
	object: 'luci.fan',
	method: 'getAllCurves'
});

/* One ramp for the whole app. The canvas used to draw its legend with four
 * Bootstrap hex values (#28a745 / #007bff / #dc3545 / #6f42c1) that had no
 * relationship to the page palette; the legend is HTML now and both it and the
 * strokes read the very same tokens as the status page. */
var PRESET_KEYS = [ 'quiet', 'balanced', 'performance', 'custom' ];
var CURVE_TOKENS = {
	quiet: '--fan-ok', balanced: '--fan-info', performance: '--fan-error',
	custom: '--fan-custom', preview: '--fan-preview'
};
var CURVE_FALLBACK = {
	quiet: '#1a7f37', balanced: '#0969da', performance: '#cf222e',
	custom: '#6f42c1', preview: '#bc4c00'
};
var PRESET_LABELS = {
	quiet: _('Quiet'), balanced: _('Balanced'), performance: _('Performance'),
	custom: _('Custom'), preview: _('Preview')
};

/* The theme listener must call the current view's redraw, not accumulate one
 * closure per render (LuCI keeps both views in the same document). */
var settingsRedraw = null;
var settingsThemeWatched = false;

function attr(value) {
	return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function drawCurveCanvas(canvasId, curves, activePreset, customPreview, highlight) {
	var canvas = document.getElementById(canvasId);
	if (!canvas) return;
	var ctx = canvas.getContext('2d');
	var dpr = Math.min(window.devicePixelRatio || 1, 2);
	var cssW = canvas.clientWidth || 500;
	var cssH = canvas.clientHeight || 300;
	canvas.width = Math.round(cssW * dpr);
	canvas.height = Math.round(cssH * dpr);
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

	var width = cssW;
	var height = cssH;
	/* The old fixed 40px padding swallowed most of a phone-sized canvas. */
	var padX = width < 420 ? 28 : 40;
	var padY = width < 420 ? 26 : 36;
	var plotW = Math.max(width - 2 * padX, 1);
	var plotH = Math.max(height - 2 * padY, 1);

	var background = fanTheme.color('--fan-canvas', '#fbfcfd', canvas);
	var grid = fanTheme.color('--fan-grid', 'rgba(80,90,100,.18)', canvas);
	var axis = fanTheme.color('--fan-axis', '#555', canvas);
	var muted = fanTheme.color('--fan-muted', '#5c6773', canvas);
	var text = fanTheme.color('--fan-text', '#1f2328', canvas);
	var colors = {};
	PRESET_KEYS.forEach(function(key) {
		colors[key] = fanTheme.color(CURVE_TOKENS[key], CURVE_FALLBACK[key], canvas);
	});
	var previewColor = fanTheme.color(CURVE_TOKENS.preview, CURVE_FALLBACK.preview, canvas);

	ctx.fillStyle = background;
	ctx.fillRect(0, 0, width, height);

	ctx.strokeStyle = grid;
	ctx.lineWidth = 1;
	for (var t = 0; t <= 100; t += 10) {
		var x = padX + (t / 100) * plotW;
		ctx.beginPath(); ctx.moveTo(x, padY); ctx.lineTo(x, padY + plotH); ctx.stroke();
	}
	for (var p = 0; p <= 255; p += 51) {
		var y = padY + plotH - (p / 255) * plotH;
		ctx.beginPath(); ctx.moveTo(padX, y); ctx.lineTo(padX + plotW, y); ctx.stroke();
	}

	ctx.strokeStyle = axis;
	ctx.lineWidth = 1.5;
	ctx.beginPath();
	ctx.moveTo(padX, padY);
	ctx.lineTo(padX, padY + plotH);
	ctx.lineTo(padX + plotW, padY + plotH);
	ctx.stroke();

	ctx.fillStyle = text;
	ctx.font = '11px system-ui, sans-serif';
	ctx.textAlign = 'center';
	ctx.fillText(_('Temperature (°C)'), width / 2, height - 4);
	ctx.save();
	ctx.translate(11, height / 2);
	ctx.rotate(-Math.PI / 2);
	ctx.fillText(_('PWM (0-255)'), 0, 0);
	ctx.restore();

	ctx.fillStyle = muted;
	ctx.font = '9px system-ui, sans-serif';
	ctx.textAlign = 'center';
	for (var tx = 0; tx <= 100; tx += 20)
		ctx.fillText(tx, padX + (tx / 100) * plotW, padY + plotH + 13);
	ctx.textAlign = 'right';
	for (var py = 0; py <= 255; py += 51)
		ctx.fillText(py, padX - 4, padY + plotH - (py / 255) * plotH + 4);

	function drawLine(points, color, alpha, lineW, dots) {
		if (!points || !points.length) return;
		ctx.strokeStyle = color;
		ctx.fillStyle = color;
		ctx.lineWidth = lineW || 1.5;
		ctx.globalAlpha = alpha != null ? alpha : 0.4;
		ctx.beginPath();
		points.forEach(function(pt, idx) {
			var px = padX + (pt.temp / 100) * plotW;
			var y = padY + plotH - (pt.pwm / 255) * plotH;
			idx === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
		});
		ctx.stroke();
		if (dots) {
			points.forEach(function(pt, idx) {
				var px = padX + (pt.temp / 100) * plotW;
				var y = padY + plotH - (pt.pwm / 255) * plotH;
				ctx.beginPath();
				ctx.arc(px, y, highlight === idx + 1 ? 6 : 4, 0, 2 * Math.PI);
				ctx.fill();
			});
		}
		ctx.globalAlpha = 1;
	}

	PRESET_KEYS.forEach(function(key) {
		var isActive = key === activePreset && !customPreview;
		drawLine(curves[key], colors[key], isActive ? 1 : 0.3, isActive ? 2.5 : 1, isActive);
	});
	if (customPreview)
		drawLine(customPreview, previewColor, 1, 2.5, true);
}

function readCustomPoints() {
	var points = [];
	for (var i = 1; i <= 5; i++) {
		var tEl = document.querySelector('[data-name="point' + i + '_temp"] input');
		var pEl = document.querySelector('[data-name="point' + i + '_pwm"] input');
		var temp = tEl ? parseInt(tEl.value, 10) : 0;
		var pwm = pEl ? parseInt(pEl.value, 10) : 0;
		if (isNaN(temp)) temp = 0;
		if (isNaN(pwm)) pwm = 0;
		points.push({ temp: Math.min(100, Math.max(0, temp)), pwm: Math.min(255, Math.max(0, pwm)) });
	}
	return points;
}

/* LuCI validates each field against range(0,100)/range(0,255) but knows
 * nothing about the relationship between the five points. A decreasing curve
 * was accepted and then drawn as a zig-zag; say so before it can be saved. */
function validatePoints() {
	var error = document.getElementById('fan-curve-error');
	if (!error) return;
	var points = readCustomPoints();
	var messages = [];
	for (var i = 1; i < points.length; i++) {
		if (points[i].temp <= points[i - 1].temp) {
			messages.push(_('Temperature points must increase.'));
			break;
		}
	}
	for (var j = 1; j < points.length; j++) {
		if (points[j].pwm < points[j - 1].pwm) {
			messages.push(_('PWM points must not decrease.'));
			break;
		}
	}
	error.textContent = messages.join(' ');
	error.classList.toggle('is-visible', messages.length > 0);
}

function legendMarkup() {
	var html = '<div class="fan-curve-wrap"><div class="fan-curve-legend" id="fan-curve-legend">';
	PRESET_KEYS.concat([ 'preview' ]).forEach(function(key) {
		var hidden = key === 'preview' ? ' style="display:none"' : '';
		html += '<span class="fan-curve-legend-item" data-preset="' + key + '"' + hidden +
			'><i class="fan-curve-swatch"></i>' + attr(PRESET_LABELS[key]) + '</span>';
	});
	html += '</div><canvas id="curve-canvas" class="fan-curve-canvas" role="img" aria-label="' +
		attr(_('Curve Preview')) + '"></canvas>' +
		'<div class="fan-curve-error" id="fan-curve-error"></div></div>';
	return html;
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('fan'),
			callGetAllCurves()
		]);
	},

	render: function(data) {
		var curves = data[1] || {};
		var m, s, o;
		fanTheme.apply();

		/* The header below renders the same title block as the status view;
		 * leaving a description on the Map would show it twice. */
		m = new form.Map('fan', null, null);

		s = m.section(form.NamedSection, 'settings', 'fancontrol', _('Control Mode'));
		s.anonymous = true;

		o = s.option(form.ListValue, 'mode', _('Mode'));
		o.value('auto', _('Automatic (Follow Curve)'));
		o.value('manual', _('Manual (Fixed Speed)'));
		o.default = 'auto';

		o = s.option(form.Value, 'manual_pwm', _('Manual Fan Speed (PWM)'),
			_('Set a fixed PWM value (0-255). 0 = Off, 255 = Full Speed'));
		o.datatype = 'range(0,255)';
		o.default = '127';
		o.depends('mode', 'manual');
		o.rmempty = false;

		o = s.option(form.ListValue, 'curve_preset', _('Fan Curve Preset'));
		o.value('quiet', _('Quiet - Lower speeds, higher temps'));
		o.value('balanced', _('Balanced - Good mix of noise and cooling'));
		o.value('performance', _('Performance - Higher speeds, lower temps'));
		o.value('custom', _('Custom - Define your own curve'));
		o.default = 'balanced';
		o.depends('mode', 'auto');

		o = s.option(form.DummyValue, '_curve_graph', _('Curve Preview'));
		o.depends('mode', 'auto');
		o.rawhtml = true;
		o.cfgvalue = legendMarkup;

		s = m.section(form.NamedSection, 'custom', 'curve', _('Custom Curve Editor'),
			_('Define temperature thresholds and corresponding fan speeds.'));
		s.anonymous = true;
		s.addremove = false;

		var defaults = {
			point1_temp: 40, point1_pwm: 54,
			point2_temp: 50, point2_pwm: 69,
			point3_temp: 60, point3_pwm: 95,
			point4_temp: 70, point4_pwm: 199,
			point5_temp: 80, point5_pwm: 255
		};

		for (var i = 1; i <= 5; i++) {
			o = s.option(form.Value, 'point' + i + '_temp',
				_('Point %d Temperature (°C)').format(i));
			o.datatype = 'range(0,100)';
			o.default = String(defaults['point' + i + '_temp']);
			o.rmempty = false;

			o = s.option(form.Value, 'point' + i + '_pwm',
				_('Point %d PWM (0-255)').format(i));
			o.datatype = 'range(0,255)';
			o.default = String(defaults['point' + i + '_pwm']);
			o.rmempty = false;
		}

		return m.render().then(function(node) {
			node.classList.add('fan-app', 'fan-settings');
			var header = E('div', { 'class': 'fan-app-header' }, [
				E('div', {}, [
					E('h2', {}, _('Fan Control')),
					E('div', { 'class': 'fan-app-subtitle' },
						_('Configure fan control mode and speed curves.'))
				])
			]);
			var firstChild = node.children ? node.children[0] : null;
			if (firstChild) node.insertBefore(header, firstChild);
			else node.appendChild(header);
			var sections = node.querySelectorAll('.cbi-section');
			if (sections[0]) sections[0].classList.add('fan-control-section');
			if (sections[1]) sections[1].classList.add('fan-curve-section');

			if (sections[1]) {
				var head = E('div', { 'class': 'fan-curve-point-head' }, [
					E('span', {}, _('Temperature (°C)')),
					E('span', {}, _('PWM (0-255)'))
				]);
				var descr = sections[1].querySelector('.cbi-section-descr');
				if (descr && descr.nextSibling)
					sections[1].insertBefore(head, descr.nextSibling);
				else
					sections[1].appendChild(head);
			}

			requestAnimationFrame(function() {
				fanTheme.apply();
				var presetSelect = node.querySelector('[data-name="curve_preset"] select');
				var modeSelect = node.querySelector('[data-name="mode"] select');
				var point1Marker = node.querySelector('[data-name="point1_temp"]');
				var activePoint = 0;

				function getCurrentPreset() {
					return presetSelect ? presetSelect.value : uci.get('fan', 'settings', 'curve_preset') || 'balanced';
				}

				function getCurrentMode() {
					return modeSelect ? modeSelect.value : uci.get('fan', 'settings', 'mode') || 'auto';
				}

				function toggleCustomSection() {
					var visible = getCurrentMode() === 'auto' && getCurrentPreset() === 'custom';
					if (point1Marker) {
						var section = point1Marker.closest('.cbi-section');
						/* A class keeps the reveal animation and stops this
						 * from fighting LuCI's depends(), which already owns
						 * the manual_pwm row. */
						if (section) section.classList.toggle('is-hidden', !visible);
					}
				}

				function updateLegend(preset, hasPreview) {
					var items = node.querySelectorAll('.fan-curve-legend-item');
					for (var i = 0; i < items.length; i++) {
						var key = items[i].getAttribute('data-preset');
						if (key === 'preview') {
							items[i].style.display = hasPreview ? '' : 'none';
							items[i].classList.toggle('is-active', !!hasPreview);
						} else {
							items[i].classList.toggle('is-active', key === preset);
						}
					}
				}

				function redrawCanvas() {
					var preset = getCurrentPreset();
					var hasPreview = preset === 'custom';
					drawCurveCanvas('curve-canvas', curves, preset,
						hasPreview ? readCustomPoints() : null, activePoint);
					updateLegend(preset, hasPreview);
					validatePoints();
				}

				settingsRedraw = redrawCanvas;
				if (!settingsThemeWatched) {
					settingsThemeWatched = true;
					fanTheme.onThemeChange(function() {
						if (settingsRedraw) settingsRedraw();
					});
				}

				for (var i = 1; i <= 5; i++) {
					var marker = node.querySelector('[data-name="point' + i + '_temp"]');
					if (marker) marker.setAttribute('data-point', String(i));

					[ '_temp', '_pwm' ].forEach(function(suffix) {
						var el = node.querySelector('[data-name="point' + i + suffix + '"] input');
						if (!el) return;
						el.addEventListener('input', redrawCanvas);

						/* Focusing a field highlights its dot on the preview,
						 * so ten numeric inputs read as five curve points. */
						(function(pointNo) {
							function setFocus(on) {
								activePoint = on ? pointNo : 0;
								var card = el.closest('.cbi-value');
								if (card) card.classList.toggle('is-focused', on);
								redrawCanvas();
							}
							el.addEventListener('focus', function() { setFocus(true); });
							el.addEventListener('blur', function() { setFocus(false); });
						})(i);
					});
				}

				redrawCanvas();
				toggleCustomSection();

				if (presetSelect) {
					presetSelect.addEventListener('change', function() {
						toggleCustomSection();
						setTimeout(redrawCanvas, 50);
					});
				}

				if (modeSelect) {
					modeSelect.addEventListener('change', function() {
						toggleCustomSection();
						setTimeout(redrawCanvas, 50);
					});
				}

				/* The backing store used to be sized only on draw, so a window
				 * resize or a LuCI panel collapse left it stretched and blurry.
				 * Changing canvas.width/height does not change its CSS box, so
				 * the observer cannot feed back into itself. */
				var canvasEl = document.getElementById('curve-canvas');
				if (canvasEl && window.ResizeObserver) {
					new window.ResizeObserver(function() { redrawCanvas(); }).observe(canvasEl);
				} else if (canvasEl) {
					window.addEventListener('resize', redrawCanvas);
				}
			});
			return node;
		});
	}
});
