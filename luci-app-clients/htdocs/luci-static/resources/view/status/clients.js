// SPDX-License-Identifier: Apache-2.0

'use strict';
'require dom';
'require poll';
'require ui';
'require view';
'require view.status.clients.common as common';
'require view.status.clients.overview as overviewView';
'require view.status.clients.devices as devicesView';

/*
 * Net Clients - one page, two tabs.
 *
 * The page itself owns nothing but the tab frame: the data, the polling and
 * the per-tab state stay inside the two sub-views, which are required as
 * LuCI modules and mounted into their panes on first activation. A tab that
 * is not on screen gets `hidden = true` on its instance, and every sub-view
 * checks that flag at the top of its poll callback - so exactly one tab is
 * sampling at any time, no matter how many of them were opened.
 *
 * Mounting is lazy: switching to a tab that has never been shown loads and
 * renders it on the spot, which keeps the first paint of the page down to the
 * work the default tab actually needs.
 *
 * The sub-views are plain L.Class modules, NOT view.extend() classes. LuCI's
 * L.require() instantiates whatever it loads, and instantiating a View runs
 * its load()/render() cycle against #view - the sub-views would each replace
 * the tab frame as soon as this file is required, which read as "the header
 * flashes and the tabs are gone". Only this file is a real view.
 */

var TABS = [
	{ name: 'overview', label: _('Overview'), view: overviewView, title: _('Net Clients') + ' - ' + _('Overview') },
	{ name: 'devices',  label: _('LAN clients'), view: devicesView,  title: _('Net Clients') + ' - ' + _('LAN clients') }
];

function tabDef(name) {
	for (var i = 0; i < TABS.length; i++)
		if (TABS[i].name == name)
			return TABS[i];

	return TABS[0];
}

return view.extend({
	active: 'overview',
	instances: {},
	nodes: {},
	loaded: {},

	/* One instance per sub-view, created on first touch. Tabs other than the
	 * active one start hidden so their poll callbacks stand down until they
	 * are actually looked at. */
	instance: function(name) {
		if (!this.instances[name]) {
			var inst = Object.create(tabDef(name).view);

			inst.hidden = (name != this.active);
			this.instances[name] = inst;
		}

		return this.instances[name];
	},

	/* Load (first time) and render a tab into its pane. A stale mount - the
	 * user having switched away while the load was in flight - is discarded
	 * rather than written into the wrong pane. A failed mount is reported in
	 * the pane itself: one broken tab must not take the page down with it. */
	mount: function(name) {
		var self = this;
		var inst = this.instance(name);
		var pane = this.nodes[name];

		return Promise.resolve(inst.load ? inst.load() : null).then(function() {
			if (self.active != name)
				return;

			dom.content(pane, inst.render());
			self.loaded[name] = true;
		}).catch(function(error) {
			console.error('[clients] mount failed:', name, error);

			if (self.active == name)
				dom.content(pane, E('div', { 'class': 'alert-message error' }, [
					E('h4', {}, _('Loading failed')),
					E('pre', {}, String((error && (error.message || error)) || error))
				]));
		});
	},

	handleTab: function(name, ev) {
		if (ev && ev.preventDefault)
			ev.preventDefault();

		if (this.active == name)
			return;

		/* Stand the previous tab's poll down, wake the new one up. The new
		 * tab's instance may not exist yet - lazy mounting means it is created
		 * on demand right here, which is what the mount below then finds. */
		this.instances[this.active].hidden = true;
		this.active = name;
		this.instance(name).hidden = false;

		this.refreshTabs();
		this.setTitle(name);

		for (var key in this.nodes)
			this.nodes[key].style.display = (key == name) ? '' : 'none';

		if (!this.loaded[name])
			this.mount(name);
	},

	setTitle: function(name) {
		this.title.textContent = tabDef(name).title;
	},

	refreshTabs: function() {
		var items = this.tabbar.querySelectorAll('li');

		for (var i = 0; i < items.length; i++) {
			var name = items[i].getAttribute('data-tab');

			items[i].className = (name == this.active) ? 'cbi-tab' : 'cbi-tab-disabled';
		}
	},

	render: function() {
		var self = this;

		common.ensureStylesheet();

		this.title = E('h2', {}, tabDef(this.active).title);

		this.tabbar = E('ul', { 'class': 'cbi-tabmenu' }, TABS.map(function(tab) {
			return E('li', {
				'class': (tab.name == self.active) ? 'cbi-tab' : 'cbi-tab-disabled',
				'data-tab': tab.name,
				'role': 'tab'
			}, [
				E('a', {
					'href': '#',
					'click': ui.createHandlerFn(self, 'handleTab', tab.name)
				}, tab.label)
			]);
		}));

		/* Panes in TABS order; only the active one is mounted right away. */
		this.nodes = {};
		var panes = TABS.map(function(tab) {
			var pane = E('div', {
				'class': 'clients-tabpane',
				'data-tab': tab.name,
				'style': (tab.name == self.active) ? '' : 'display:none'
			});

			self.nodes[tab.name] = pane;

			return pane;
		});

		this.mount(this.active);

		return E('div', { 'class': 'cbi-map' }, [
			this.title,
			this.tabbar,
			E('div', { 'class': 'clients-tabwrap' }, panes)
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
