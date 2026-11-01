// SPDX-License-Identifier: Apache-2.0

'use strict';
'require baseclass';
'require fs';
'require network';
'require rpc';
'require uci';

/*
 * Shared core of the Clients pages.
 *
 * Both views - overview and devices - read the same files and merge the same
 * sources, so the merge lives here once:
 *
 *   snapshot    /tmp/clients-snapshot.json     (init)    addresses, rates, wifi
 *   archive     /tmp/clients-history.json      (init)    first / last seen
 *
 * The snapshot carries what the probe knows - ARP and the IPv6 neighbour cache
 * (who is reachable now), nf_conntrack byte counters and iwinfo assoclists
 * (which AP, SSID, signal) - with the cumulative counters already
 * differentiated into rates and running totals by the collector that wrote it,
 * plus one trend point per pass so the chart has history before anyone looks at
 * it. That is the point of the file: the sampling clock belongs to the
 * background loop, so opening this page reads one document instead of starting
 * a measurement, and a second viewer costs nothing at all.
 *
 * When the file is missing - the service is stopped, or an older probe is
 * installed - the page falls back to asking the probe directly and doing the
 * differencing itself, which is what it used to do on every single poll.
 *
 * Nothing here is aware of a specific page. Each view builds a store, polls it,
 * and renders whatever it needs from the same merged rows.
 */

var PROBE = '/usr/libexec/clients-probe';
var SNAPSHOT_PATH = '/tmp/clients-snapshot.json';
var SAMPLES_PATH = '/tmp/clients-samples.json';
var HISTORY_PATH = '/tmp/clients-history.json';
var STYLESHEET = 'view/status/clients/clients.css';

/* How often the page reads the snapshot, not how often it is taken. Five
 * seconds keeps the counters moving while someone watches; the collector's own
 * cadence decides how much of that is new. */
var SAMPLE_INTERVAL = 5;
var LEASE_INTERVAL = 30;
var HISTORY_INTERVAL = 30;

/* How often the fast ring is read. The sampler behind it ticks once a second,
 * so this is the shortest interval that still shows every sample; the snapshot
 * is still read on SAMPLE_INTERVAL, it just no longer paces the tiles. */
var TICK_INTERVAL = 1;

/* Fallback path only: a gap this long means the tab was hidden or the timer was
 * throttled, and dividing the accumulated bytes by it would invent a spike, so
 * the baseline is refreshed instead. */
var RESYNC_GAP = 15000;

/* How much of the trend chart is kept in memory. One point per collector pass
 * at 300 points covers the "last 10 minutes" window the carrier pages offer
 * with room to spare. */
var TREND_POINTS = 300;

/* The six counters every traffic row carries, flat. The probe nests the LAN/WAN
 * split; the rate maths and the cache both want it flat, so it is flattened
 * once per row. */
var COUNTER_KEYS = [ 'up', 'down', 'lanUp', 'lanDown', 'wanUp', 'wanDown' ];

var callDHCPLeases = rpc.declare({
	object: 'luci-rpc',
	method: 'getDHCPLeases',
	expect: { '': {} }
});

/* ---------------- formatting ---------------- */

function sourceTitle(source) {
	switch (source) {
	case 'dhcpv6': return _('Assigned by %s').format('DHCPv6');
	case 'slaac': return _('Assigned by %s').format('SLAAC');
	case 'dynamic': return _('Assigned by %s').format('DHCP');
	case 'static': return _('Static lease: reserved in the DHCP configuration, so the address never changes');
	case 'manual': return _('Configured on the device itself, not handed out by DHCP');
	}

	return null;
}

function normalizeMAC(mac) {
	if (!mac || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac))
		return null;

	mac = mac.toUpperCase();

	/* All-zero and multicast addresses are never a client's own address. */
	if (mac == '00:00:00:00:00:00' || (parseInt(mac.substr(0, 2), 16) & 1))
		return null;

	return mac;
}

/* Both the unit and the decimals follow the magnitude: a fixed one-decimal
 * KiB/s reads "999.9 KiB/s", ten characters in a column that has room for
 * eight. Scaling at 1024 and dropping decimals as the number grows keeps every
 * reading inside its column without hiding anything. */
function autoUnit(bytes, suffix) {
	var value = Number(bytes) || 0;
	var units = (suffix == '/s') ? [ 'B/s', 'KiB/s', 'MiB/s', 'GiB/s' ]
		: [ 'B', 'KiB', 'MiB', 'GiB' ];
	var unit = 0;

	while (value >= 1024 && unit < units.length - 1) {
		value = value / 1024;
		unit++;
	}

	if (value == 0)
		return '0 ' + units[unit];

	var decimals = (unit == 0 || value >= 100) ? 0 : (value >= 10 ? 1 : 2);

	return value.toFixed(decimals) + ' ' + units[unit];
}

function formatRate(bytes) {
	return (bytes == null) ? '-' : autoUnit(bytes, '/s');
}

function formatSize(bytes) {
	return (bytes == null) ? '-' : autoUnit(bytes, '');
}

/* Link bandwidth is quoted in Mbps like every other uplink figure on a router;
 * per-host throughput stays in KiB/s, where the smaller unit carries meaning. */
function formatBandwidth(bytesPerSecond) {
	if (bytesPerSecond == null)
		return '-';

	return (bytesPerSecond * 8 / 1000000).toFixed(2) + ' Mbps';
}

function formatCount(value) {
	return (value == null) ? '-' : String(value);
}

/* "Last seen" is only useful as a distance from now - a wall-clock timestamp
 * makes the reader do the subtraction. The absolute time stays in the tooltip. */
function relativeTime(epoch) {
	if (!epoch || epoch <= 0)
		return null;

	var seconds = Math.max(0, Math.round(Date.now() / 1000) - epoch);

	if (seconds < 60)
		return _('just now');

	if (seconds < 3600)
		return _('%d min ago').format(Math.floor(seconds / 60));

	if (seconds < 86400)
		return _('%d h ago').format(Math.floor(seconds / 3600));

	return _('%d d ago').format(Math.floor(seconds / 86400));
}

function absoluteTime(epoch) {
	if (!epoch || epoch <= 0)
		return '-';

	return new Date(epoch * 1000).toLocaleString();
}

function clockTime(epoch) {
	if (!epoch || epoch <= 0)
		return '-';

	var d = new Date(epoch * 1000);

	function pad(n) { return (n < 10) ? '0' + n : String(n); }

	return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' '
		+ pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/* ---------------- addresses ---------------- */

function ipv4Value(address) {
	var parts = String(address || '').split('.');
	var value = 0, part;

	if (parts.length != 4)
		return null;

	for (var i = 0; i < 4; i++) {
		part = parseInt(parts[i], 10);

		if (isNaN(part) || part < 0 || part > 255)
			return null;

		value = value * 256 + part;
	}

	return value;
}

/* IPv6 addresses only sort correctly once the shorthand is expanded: comparing
 * "…:4d" with "…:1ee0:…" as text puts 1ee0 after 4d. Eight zero-padded hextets
 * compare lexicographically and numerically at once. */
function ipv6Value(address) {
	var text = String(address || '').toLowerCase();
	var halves = text.split('::');
	var head, tail, filled, groups = [];

	if (!text || halves.length > 2)
		return null;

	head = (halves[0] == '') ? [] : halves[0].split(':');
	tail = (halves.length == 2 && halves[1] != '') ? halves[1].split(':') : [];
	filled = 8 - head.length - tail.length;

	if (filled < 0 || (halves.length == 1 && head.length != 8))
		return null;

	function pad(group) {
		while (group.length < 4)
			group = '0' + group;

		return group;
	}

	head.forEach(function(group) { groups.push(pad(group)); });

	for (var i = 0; i < filled; i++)
		groups.push('0000');

	tail.forEach(function(group) { groups.push(pad(group)); });

	return groups.join(':');
}

/* An IPv6 address is 39 characters and decides whether the counters stay
 * reachable. Breaking at the colon keeps it readable, and <wbr> adds the
 * opportunity without putting a character into the text, so a copied address
 * stays a valid address. */
function ipv6Nodes(address) {
	var parts = String(address).split(':');
	var nodes = [];

	parts.forEach(function(part, index) {
		nodes.push(part, (index < parts.length - 1) ? ':' : null,
			(index < parts.length - 1) ? E('wbr') : null);
	});

	return nodes;
}

/* Which network an address belongs to, decided from the subnets the probe
 * reported. This is the fallback for a row whose interface is unknown: a host
 * known only from the archive, or one the neighbour cache has already forgotten
 * but conntrack still holds a flow for. Without it those rows lose their VLAN
 * the moment ARP ages them out, which looks like the device moved networks. */
function subnetContains(cidr, address) {
	var parts = String(cidr || '').split('/');
	var mask = parseInt(parts[1], 10);

	if (!parts[0] || isNaN(mask))
		return false;

	if (String(address).indexOf(':') >= 0) {
		var base6 = ipv6Value(parts[0]);
		var addr6 = ipv6Value(address);

		if (!base6 || !addr6 || mask < 0 || mask > 128)
			return false;

		var bits = Math.floor(mask / 4);

		return base6.replace(/:/g, '').slice(0, bits) == addr6.replace(/:/g, '').slice(0, bits);
	}

	var base4 = ipv4Value(parts[0]);
	var addr4 = ipv4Value(address);

	if (base4 == null || addr4 == null || mask < 0 || mask > 32)
		return false;

	/* Math.pow, not a shift: 1 << 24 overflows a 32-bit signed shift into a
	 * negative size for a /8 and every comparison after it is nonsense. */
	var size = Math.pow(2, 32 - mask);

	return addr4 >= base4 && addr4 < base4 + size;
}

function networkOfAddress(addresses, networkList) {
	for (var i = 0; i < addresses.length; i++) {
		for (var j = 0; j < networkList.length; j++) {
			var network = networkList[j];
			var subnets = network.subnets || [];

			for (var k = 0; k < subnets.length; k++)
				if (subnetContains(subnets[k], addresses[i]))
					return network;
		}
	}

	return null;
}

/* A client accumulates addresses from three sources; keep each one once. */
function addAddress(list, address) {
	if (!address)
		return;

	var bare = String(address).replace(/\/\d+$/, '');

	for (var i = 0; i < list.length; i++)
		if (list[i] == bare)
			return;

	list.push(bare);
}

function reservedAddresses() {
	var map = Object.create(null);
	var sections = uci.sections('dhcp', 'host') || [];

	sections.forEach(function(section) {
		/* `ip` may be a list: dhcp-host accepts several addresses per host. */
		L.toArray(section.ip).forEach(function(address) {
			var bare = String(address || '').replace(/\/\d+$/, '');

			if (bare)
				map[bare] = true;
		});
	});

	return map;
}

function ensureStylesheet() {
	var href = L.resource(STYLESHEET);
	var links = document.querySelectorAll('link[rel="stylesheet"]');

	for (var i = 0; i < links.length; i++)
		if (links[i].getAttribute('href') == href)
			return;

	document.head.appendChild(E('link', {
		'rel': 'stylesheet',
		'type': 'text/css',
		'href': href
	}));
}

/* ---------------- merge ---------------- */

/*
 * Merge leases, neighbour entries, association records, counters and the
 * archive into one row per client. MAC is the identity; a client whose leases
 * never expose a MAC (some IPv6-only hosts, keyed by DUID) is keyed by its DUID
 * instead, so it still gets one row rather than one per lease, and is folded
 * back into its MAC row further down when the neighbour cache can tell which
 * MAC the address belongs to.
 *
 * IPv6 addresses carry their source. odhcpd's DHCPv6 leases are authoritative:
 * an address handed out with a lease is not SLAAC, whatever the neighbour cache
 * thinks. Everything else in the neighbour cache got there through router
 * advertisements, i.e. SLAAC. IPv4 has the same map, but only two of its three
 * cases are decidable here: "dynamic" is a lease, "manual" is an ARP entry that
 * no lease and no reservation covers. "static" is decided by the caller from
 * the reservation list, so a reserved host keeps its colour while offline.
 *
 * Traffic is summed in three buckets - total, LAN and WAN - as delivered by the
 * probe. The page never re-derives the split: the decision needs the subnet
 * list, and the probe already had it.
 */
function buildClients(state) {
	var clients = Object.create(null);
	var byAddress = Object.create(null);
	var hints = (state.hints && state.hints.hosts) ? state.hints.hosts : (state.hints || {});
	var networks = Object.create(null);
	var networkList = state.interfaces || [];

	networkList.forEach(function(entry) {
		if (entry.device)
			networks[entry.device] = entry;
	});

	function client(mac, key) {
		var id = String(key || mac || '').toLowerCase();

		if (!id)
			return null;

		if (!clients[id])
			clients[id] = {
				mac: mac || null,
				hostname: null,
				ipv4: [],
				ipv6: [],
				leases4: [],
				leases6: [],
				online: false,
				wireless: false,
				ssid: null,
				band: null,
				signal: null,
				noise: null,
				device: null,
				vlan: null,
				iface: null,
				rate: null,
				/* All six counters from the start: the merge below adds to
				 * them one by one, and a missing key would turn a page full of
				 * totals into NaN. */
				total: zeroCounters(),
				stored: null,
				conns: null,
				first: null,
				last: null,
				precision: null
			};

		if (mac && !clients[id].mac)
			clients[id].mac = mac;

		return clients[id];
	}

	function addLease(lease, family) {
		var mac = normalizeMAC(lease.macaddr);
		var key = mac;

		if (!key && lease.duid)
			key = 'duid:' + String(lease.duid).toLowerCase() + (lease.iaid ? '%' + lease.iaid : '');

		if (!key) {
			var address = (family == 4) ? lease.ipaddr : (L.toArray(lease.ip6addrs)[0] || lease.ip6addr);

			if (!address)
				return;

			key = 'addr:' + address;
		}

		var entry = client(mac, key);

		if (!entry)
			return;

		if (!entry.hostname && lease.hostname)
			entry.hostname = lease.hostname;

		if (family == 4) {
			addAddress(entry.ipv4, lease.ipaddr);
			entry.leases4.push(lease);
			state.ip4Source[String(lease.ipaddr).replace(/\/\d+$/, '')] = 'dynamic';
		}
		else {
			/* Field names differ between LuCI releases and between a lease taken
			 * from odhcpd and one reconstructed from state files: accept all
			 * three spellings rather than dropping the address on the floor. */
			var addresses = L.toArray(lease.ip6addrs);

			if (!addresses.length && lease.ip6addr)
				addresses = L.toArray(lease.ip6addr);

			if (!addresses.length && lease.ipaddr)
				addresses = L.toArray(lease.ipaddr);

			addresses.forEach(function(ip) {
				addAddress(entry.ipv6, ip);
				state.ip6Source[String(ip).replace(/\/\d+$/, '')] = 'dhcpv6';
			});
			entry.leases6.push(lease);
		}
	}

	state.leases4.forEach(function(lease) { addLease(lease, 4); });
	state.leases6.forEach(function(lease) { addLease(lease, 6); });

	/* A neighbour entry is the only proof that a host is reachable right now. */
	(state.arp || []).forEach(function(neighbour) {
		var mac = normalizeMAC(neighbour.mac);
		var entry = client(mac, mac || ('addr:' + neighbour.ip));

		if (!entry)
			return;

		addAddress(entry.ipv4, neighbour.ip);
		entry.online = true;

		if (neighbour.name && !entry.hostname)
			entry.hostname = neighbour.name;

		if (neighbour.device && !entry.device)
			entry.device = neighbour.device;
	});

	/* Names the LAN side already knows. They enrich a client that a lease, a
	 * neighbour row or a byte counter already placed on the LAN - they never
	 * create one, because the hint cache also reports WAN-side neighbours and
	 * the uplink gateway would otherwise be listed as a LAN host. Addresses are
	 * deliberately not taken from the hints: that cache outlives the host. */
	Object.keys(hints).forEach(function(mac) {
		var hint = hints[mac] || {};
		var normalised = normalizeMAC(mac);
		var entry = normalised ? clients[normalised.toLowerCase()] : null;

		if (!entry)
			return;

		if (hint.name && !entry.hostname)
			entry.hostname = hint.name;
	});

	/* IPv6: every neighbour-cache entry that resolved to a MAC belongs to that
	 * client, and any address odhcpd did not lease came from SLAAC. */
	(state.neigh6 || []).forEach(function(neighbour) {
		var mac = normalizeMAC(neighbour.mac);
		var entry = mac ? clients[mac.toLowerCase()] : null;
		var address = String(neighbour.ip).replace(/\/\d+$/, '');

		if (!entry)
			return;

		addAddress(entry.ipv6, address);
		entry.online = true;

		if (neighbour.device && !entry.device)
			entry.device = neighbour.device;

		if (!state.ip6Source[address])
			state.ip6Source[address] = 'slaac';
	});

	/* Wireless association. Information the ARP table can never carry: which
	 * radio, which SSID, how strong the link. A station without an address yet
	 * (DHCP in flight) still gets a row, which is why this can create a client. */
	Object.keys(state.wifi || {}).forEach(function(mac) {
		var assoc = state.wifi[mac] || {};
		var normalised = normalizeMAC(mac);
		var entry = normalised ? client(normalised, normalised) : null;

		if (!entry)
			return;

		entry.wireless = true;
		entry.online = true;
		entry.ssid = assoc.ssid || entry.ssid;

		if (assoc.band)
			entry.band = assoc.band;

		/* A reading of 0 dBm is "not reported", not "no signal". */
		if (assoc.signal)
			entry.signal = assoc.signal;

		if (assoc.noise)
			entry.noise = assoc.noise;
	});

	/*
	 * What the bridge heard. On an AP the DHCP server is somewhere else and
	 * the kernel never resolves a client's global IPv6 address, so the
	 * clients-snoop daemon listens to the bridge and records DHCPACK
	 * assignments and neighbour-discovery announcements. These observations
	 * only enrich rows another source already created - a passive packet
	 * proves an address, not a reachable host - except that a fresh one (the
	 * probe marks observations of the last two minutes) does prove the host
	 * is speaking right now.
	 */
	(state.snoop4 || []).forEach(function(host) {
		var mac = normalizeMAC(host.mac);
		var ip = String(host.ip || '').replace(/\/\d+$/, '');

		if (!mac || !ip || state.reserved4[ip])
			return;

		/* A DHCPACK for an address this box reserved statically does not
		 * change its colour; anything else the server handed out is dynamic,
		 * exactly as a local lease would be. */
		var entry = clients[mac.toLowerCase()];

		if (!entry)
			return;

		addAddress(entry.ipv4, ip);

		if (!state.ip4Source[ip])
			state.ip4Source[ip] = 'dynamic';
	});

	(state.snoop6 || []).forEach(function(host) {
		var mac = normalizeMAC(host.mac);
		var ip = String(host.ip || '').replace(/\/\d+$/, '');

		if (!mac || ip.indexOf(':') < 0)
			return;

		var entry = clients[mac.toLowerCase()];

		if (!entry)
			return;

		addAddress(entry.ipv6, ip);

		if (!state.ip6Source[ip])
			state.ip6Source[ip] = 'slaac';

		/* A neighbour announcement or duplicate-address probe from the last
		 * two minutes is live traffic: the host is on the air. */
		if (host.fresh)
			entry.online = true;
	});

	/* Names the probe heard on the wire itself: the DHCP Host-Name option
	 * clients-snoop captured on the bridge, folded into the snapshot's
	 * `names`. On a bridging device this is the only name source that
	 * exists - no local lease file, no hints with names - and it covers the
	 * clients an ARP row never will, because the AP does not talk to them.
	 * Placed after every row-creating source above so a wireless-only or
	 * snoop-fed row is already there to receive it; enrich-only, exactly
	 * like the hints earlier. */
	Object.keys(state.names || {}).forEach(function(mac) {
		var normalised = normalizeMAC(mac);
		var entry = normalised ? clients[normalised.toLowerCase()] : null;

		if (!entry)
			return;

		if (!entry.hostname)
			entry.hostname = state.names[mac];
	});


	/* Fold a DUID-keyed orphan into the MAC row that already owns its address. */
	var macOfAddress = Object.create(null);

	(state.arp || []).forEach(function(neighbour) {
		var mac = normalizeMAC(neighbour.mac);

		if (mac)
			macOfAddress[neighbour.ip] = mac;
	});
	(state.neigh6 || []).forEach(function(neighbour) {
		var mac = normalizeMAC(neighbour.mac);

		if (mac)
			macOfAddress[String(neighbour.ip).replace(/\/\d+$/, '')] = mac;
	});

	Object.keys(clients).forEach(function(id) {
		var orphan = clients[id];

		if (id.indexOf('duid:') != 0 && id.indexOf('addr:') != 0)
			return;

		var target = null;

		orphan.ipv4.concat(orphan.ipv6).forEach(function(ip) {
			var mac = macOfAddress[ip];

			if (mac && clients[mac.toLowerCase()] && clients[mac.toLowerCase()] !== orphan)
				target = clients[mac.toLowerCase()];
		});

		if (!target)
			return;

		if (!target.hostname && orphan.hostname)
			target.hostname = orphan.hostname;

		orphan.ipv4.forEach(function(ip) { addAddress(target.ipv4, ip); });
		orphan.ipv6.forEach(function(ip) { addAddress(target.ipv6, ip); });
		target.leases4 = target.leases4.concat(orphan.leases4);
		target.leases6 = target.leases6.concat(orphan.leases6);
		target.online = target.online || orphan.online;

		delete clients[id];
	});

	/* IPv4: an address with no lease behind it was set on the device by hand -
	 * but only once this box has shown that it hands addresses out at all.
	 * Snooped DHCPACKs count: on an AP they are the only evidence that some
	 * server - just not a local one - assigned addresses here. */
	var arpAddresses = Object.create(null);
	var dhcpKnown = state.leases4.length > 0 ||
		Object.keys(state.reserved4 || {}).length > 0 ||
		(state.snoop4 || []).length > 0;

	(state.arp || []).forEach(function(neighbour) {
		arpAddresses[neighbour.ip] = true;
	});

	Object.keys(clients).forEach(function(id) {
		clients[id].ipv4.forEach(function(ip) {
			if (!state.ip4Source[ip] && dhcpKnown && arpAddresses[ip])
				state.ip4Source[ip] = 'manual';
		});
	});

	Object.keys(clients).forEach(function(id) {
		var entry = clients[id];

		entry.ipv4.forEach(function(ip) { byAddress[ip] = entry; });
		entry.ipv6.forEach(function(ip) { byAddress[ip] = entry; });
	});

	/* Counters arrive per address; a client with several addresses sums them.
	 * The LAN/WAN split is taken from the counters verbatim. */
	Object.keys(state.traffic || {}).forEach(function(ip) {
		var counters = state.traffic[ip];
		var entry = byAddress[ip];

		if (!entry) {
			/* An address with traffic but neither lease nor neighbour row is
			 * still a host; without a row its bytes would vanish from the
			 * totals. */
			entry = client(null, 'addr:' + ip);

			if (!entry)
				return;

			addAddress(ip.indexOf(':') >= 0 ? entry.ipv6 : entry.ipv4, ip);
			byAddress[ip] = entry;
		}

		if (counters.device && !entry.device)
			entry.device = counters.device;

		entry.rate = entry.rate || { up: 0, down: 0, lanUp: 0, lanDown: 0, wanUp: 0, wanDown: 0 };
		entry.total = entry.total || { up: 0, down: 0, lanUp: 0, lanDown: 0, wanUp: 0, wanDown: 0 };

		var rate = state.rates[ip];

		if (rate) {
			entry.rate.up += rate.up;
			entry.rate.down += rate.down;
			entry.rate.lanUp += rate.lanUp;
			entry.rate.lanDown += rate.lanDown;
			entry.rate.wanUp += rate.wanUp;
			entry.rate.wanDown += rate.wanDown;
		}

		var total = state.totals[ip];

		if (total) {
			entry.total.up += total.up;
			entry.total.down += total.down;
			entry.total.lanUp += total.lanUp;
			entry.total.lanDown += total.lanDown;
			entry.total.wanUp += total.wanUp;
			entry.total.wanDown += total.wanDown;
		}

		if (counters.conns != null)
			entry.conns = (entry.conns || 0) + counters.conns;
	});

	/*
	 * The archive: first and last seen, and the association a station had when
	 * it was last here. Merged last so a live reading always wins over a stored
	 * one - the archive is what remains when nothing is live, not a second
	 * opinion about the present.
	 */
	var archive = state.archive || {};

	Object.keys(clients).forEach(function(id) {
		var entry = clients[id];
		var stored = entry.mac ? archive[entry.mac] : null;

		if (!stored)
			return;

		entry.first = entry.first || stored.first || null;
		entry.last = stored.last || null;

		if (!entry.ssid && stored.ssid) {
			entry.ssid = stored.ssid;
			entry.band = entry.band || stored.band || null;
			entry.wireless = true;
		}

		if (entry.signal == null && stored.signal)
			entry.signal = stored.signal;

		if (!entry.hostname && stored.name)
			entry.hostname = stored.name;
	});

	/*
	 * Then the rows only the archive remembers. A device that has gone to sleep
	 * keeps its place and its last-seen time instead of disappearing from the
	 * page the moment the neighbour cache forgets it.
	 */
	Object.keys(archive).forEach(function(mac) {
		if (clients[mac.toLowerCase()])
			return;

		var stored = archive[mac];
		var entry = client(mac, mac);

		if (!entry)
			return;

		entry.hostname = stored.name || null;
		entry.online = false;
		entry.historical = true;
		entry.first = stored.first || null;
		entry.last = stored.last || null;
		entry.device = stored.device || null;

		if (stored.ip4)
			addAddress(entry.ipv4, stored.ip4);
		if (stored.ip6)
			addAddress(entry.ipv6, stored.ip6);

		if (stored.ssid) {
			entry.ssid = stored.ssid;
			entry.band = stored.band || null;
			entry.wireless = true;
		}

		if (stored.signal)
			entry.signal = stored.signal;
	});

	/*
	 * Resolve the network each client sits on: the live ARP row said which
	 * device it arrived on; everything else is matched by subnet.
	 */
	Object.keys(clients).forEach(function(id) {
		var entry = clients[id];
		var network = entry.device ? networks[entry.device] : null;

		if (!network)
			network = networkOfAddress(entry.ipv4.concat(entry.ipv6), networkList);

		if (!network)
			return;

		entry.vlan = (network.vlan != null) ? network.vlan : entry.vlan;
		entry.iface = entry.iface || network.iface || null;
		entry.subnet = entry.subnet || (network.subnets || [])[0] || null;
	});

	/* How much to trust the numbers in the row. conntrack accounting sees the
	 * counters the driver syncs back, so it survives the offload; ARP alone
	 * means the host is listed with no traffic figure at all. */
	Object.keys(clients).forEach(function(id) {
		var entry = clients[id];

		entry.precision = (entry.rate || entry.total.up || entry.total.down) ? 'conntrack' : 'arp';
	});

	var list = Object.keys(clients).map(function(id) {
		clients[id].id = id;
		return clients[id];
	});

	/* Online first, then by traffic, so the busiest host is at the top without
	 * the order jumping between two otherwise idle polls. */
	list.sort(function(a, b) {
		if (a.online != b.online)
			return a.online ? -1 : 1;

		var at = a.total.up + a.total.down + (a.stored ? a.stored.up + a.stored.down : 0);
		var bt = b.total.up + b.total.down + (b.stored ? b.stored.up + b.stored.down : 0);

		if (at != bt)
			return bt - at;

		return L.naturalCompare(a.hostname || a.mac || a.id, b.hostname || b.mac || b.id);
	});

	return list;
}

function sortValue(entry, key) {
	switch (key) {
	case 'state':
		return entry.online ? 1 : 0;

	case 'hostname':
		return entry.hostname ? entry.hostname.toLowerCase() : null;

	case 'ipv4':
		return entry.ipv4.length ? ipv4Value(entry.ipv4[0]) : null;

	case 'ipv6':
		return entry.ipv6.length ? ipv6Value(entry.ipv6[0]) : null;

	case 'mac':
		return entry.mac || null;

	case 'network':
		if (entry.ssid)
			return entry.ssid.toLowerCase();
		return (entry.vlan != null) ? ('vlan' + String(entry.vlan).padStart(3, '0')) : null;

	case 'signal':
		return (entry.signal == null) ? null : entry.signal;

	case 'lan':
		return entry.rate ? (entry.rate.lanUp + entry.rate.lanDown) : null;

	case 'wan':
		return entry.rate ? (entry.rate.wanUp + entry.rate.wanDown) : null;

	case 'up':
		return entry.rate ? entry.rate.wanUp : null;

	case 'down':
		return entry.rate ? entry.rate.wanDown : null;

	case 'total':
		return entry.total ? (entry.total.wanUp + entry.total.wanDown) : null;

	case 'conns':
		return (entry.conns == null) ? null : entry.conns;

	case 'last':
		return entry.last || (entry.online ? Math.round(Date.now() / 1000) : null);
	}

	return null;
}

/* ---------------- store ---------------- */

/*
 * One sampler per page. It holds the baseline needed to differentiate the
 * cumulative counters, the archives, and the lease/hint data - everything the
 * three views ask for, fetched once per poll instead of once per view.
 */
/* ---------------- counters ---------------- */

/*
 * One point of the trend series as the collector stores it. The per-device
 * table is written as flat arrays - the MAC would otherwise be repeated for
 * every point it appears in - so it is widened back into the objects the chart
 * already reads.
 */
/*
 * One stored point, widened back into the shape the chart reads.
 *
 * `intra` - the frames two clients of the same subnet exchanged - belongs to
 * the LAN figure, so it is folded in here and not drawn separately. It has no
 * direction (both ends are clients, and the bridge counter sees each frame
 * once), so it lands under both arrows, which is what the hardware port
 * counters behind an AP have always done: a switched frame is rx on one port
 * and tx on another.
 *
 * `viaPorts` says the point already came from those port counters, where the
 * same frames are in the figures by construction - adding them again would
 * count them twice.
 */
/*
 * The chart places points by their timestamp, and it mixes two sources that
 * were written by different hands: the snapshot's trend is stamped in seconds,
 * the points this page builds itself are in milliseconds. Normalising here
 * keeps the axis monotonic and makes the window selector mean something -
 * comparing second-stamps against a millisecond cutoff used to keep every point
 * the file had, so all three windows drew the same thirty minutes.
 */
function toMs(value) {
	var t = Number(value) || 0;

	/* Anything before the year 5138 is seconds. */
	return (t > 0 && t < 1e11) ? t * 1000 : t;
}

function decodeTrendPoint(point, viaPorts) {
	var intra = (point.intra != null) ? (Number(point.intra) || 0) : 0;
	var extra = viaPorts ? 0 : intra;

	var decoded = {
		t: toMs(point.t),
		valid: point.valid !== false,
		lanUp: (point.lanUp || 0) + extra,
		lanDown: (point.lanDown || 0) + extra,
		wanUp: point.wanUp || 0,
		wanDown: point.wanDown || 0,
		/* Kept as measured, for the summary and for anything that wants the
		 * breakdown this merges away. */
		intra: (point.intra != null) ? intra : null,
		byMac: Object.create(null)
	};

	var macs = point.macs || {};

	Object.keys(macs).forEach(function(mac) {
		var v = macs[mac] || [];

		decoded.byMac[mac] = {
			up: v[0] || 0, down: v[1] || 0,
			lanUp: v[2] || 0, lanDown: v[3] || 0,
			wanUp: v[4] || 0, wanDown: v[5] || 0
		};
	});

	return decoded;
}

/*
 * One row of the fast ring, in the shape decodeTrendPoint() returns:
 *
 *   [ ts, wanUp, wanDown, lanUp, lanDown, intra, window ]
 *
 * `intra` is -1 where the box has no such counter, and `window` is zero on a
 * tick that had no baseline - such a point is marked invalid so the chart
 * breaks the line there instead of drawing a drop to zero. There is no
 * per-device split in a row: the ring carries the four tile figures only, so
 * the device selector keeps reading the snapshot's series.
 */
function decodeSampleRow(row, viaPorts) {
	if (!Array.isArray(row) || row.length < 7)
		return null;

	var intra = (Number(row[5]) >= 0) ? (Number(row[5]) || 0) : 0;
	var extra = viaPorts ? 0 : intra;

	return {
		t: toMs(row[0]),
		valid: (Number(row[6]) || 0) > 0,
		lanUp: (Number(row[3]) || 0) + extra,
		lanDown: (Number(row[4]) || 0) + extra,
		wanUp: Number(row[1]) || 0,
		wanDown: Number(row[2]) || 0,
		intra: (Number(row[5]) >= 0) ? intra : null,
		byMac: Object.create(null)
	};
}

function zeroCounters() {
	return { up: 0, down: 0, lanUp: 0, lanDown: 0, wanUp: 0, wanDown: 0 };
}

function flatCounters(entry) {
	return {
		up: (entry && entry.up) || 0,
		down: (entry && entry.down) || 0,
		lanUp: (entry && entry.lan && entry.lan.up) || 0,
		lanDown: (entry && entry.lan && entry.lan.down) || 0,
		wanUp: (entry && entry.wan && entry.wan.up) || 0,
		wanDown: (entry && entry.wan && entry.wan.down) || 0
	};
}

function diffCounters(current, previous) {
	var out = {};

	/* A flow can expire between two samples and take its bytes with it; a
	 * negative delta is clamped rather than reported as a jump backwards. */
	COUNTER_KEYS.forEach(function(key) {
		out[key] = Math.max(0, current[key] - (previous[key] || 0));
	});

	return out;
}

function createStore() {
	return {
		samples: null,
		rates: null,
		totals: null,
		portSamples: null,
		portRates: null,
		portTotals: null,
		archive: {},
		archiveUpdated: 0,
		trend: null,
		/* True while the trend series comes from the collector's file rather
		 * than from points this page built. */
		trendFromFile: false,
		/* The snapshot's own series, kept apart from `trend` so the fast ring
		 * can be laid over its newest part: the two overlap in time and each
		 * has to be able to replace the other without rebuilding from a merged
		 * array it cannot take apart again. */
		trendCoarse: null,
		/* The fast ring, decoded, and the timestamp of the newest row already
		 * applied. A ring is a state rather than a stream - reading it returns
		 * everything it holds - so this is not a cursor; it only stops the same
		 * sample from being applied twice. */
		ring: null,
		ringTs: 0,
		/* Per-station WAN rates, published by the sampler every few seconds:
		 * { ts, window, macs: { MAC: [up, down] } }. Null until the first ring
		 * that carries them. */
		macRates: null,
		/* False until a snapshot carried a real measurement window. The first
		 * rate of a session is unknown, not zero - marking the point lets the
		 * trend chart break the line there instead of drawing the fake rise
		 * from 0 that reads as a triangle. */
		baselineSeen: false,
		/* The timestamp of the snapshot currently applied, and the one the last
		 * trend point came from. A poll that lands between two collector
		 * passes must not apply or plot the same numbers again. */
		lastSnapshotTs: 0,
		lastSnapshotLoad: 0,
		lastTrendTs: 0,
		lastLeaseLoad: 0,
		lastHistoryLoad: 0,
		state: {
			interfaces: [],
			leases4: [],
			leases6: [],
			hints: null,
			arp: [],
			neigh6: [],
			wifi: {},
			traffic: {},
			stats: null,
			bridge: null,
			intra: null,
			snoop4: [],
			snoop6: [],
			names: {},
			reserved4: Object.create(null),
			ip6Source: Object.create(null),
			ip4Source: Object.create(null)
		},

		/* Read the snapshot the collector wrote. Its clock, not this page's: the
		 * file is refreshed whether or not anyone is looking, and it already
		 * carries the rates, so opening the page starts no measurement. */
		fetchSnapshot: function() {
			var self = this;

			self.lastSnapshotLoad = Date.now();

			return L.resolveDefault(fs.read(SNAPSHOT_PATH), '').then(function(text) {
				var data = null;

				try {
					data = text ? JSON.parse(text) : null;
				}
				catch (e) {
					data = null;
				}

				if (data && data.traffic)
					return self.applySnapshot(data);

				/* No cache: the sampler is stopped, or an older probe is
				 * installed. Take one live snapshot and differentiate here, so
				 * the page still shows traffic instead of nothing. */
				return fs.exec_direct(PROBE, []).then(function(output) {
					return self.applySnapshot(JSON.parse(output));
				});
			});
		},

		/*
		 * Read the fast ring. This is the cheap file - the only thing in it is
		 * the four tile figures per tick plus the bookkeeping the next tick
		 * differences against - so it is read on the short interval while the
		 * snapshot keeps its own, slower one. An older probe or a box where the
		 * tick loop is switched off leaves no file, and the tiles then fall
		 * back to the snapshot's rates with nothing else changed.
		 */
		fetchSamples: function() {
			var self = this;

			return L.resolveDefault(fs.read(SAMPLES_PATH), '').then(function(text) {
				var data = null;

				/* A ring that is present but unreadable looks exactly like a
				 * ring that was never written, and the page would quietly go
				 * back to the ten second clock. One line in the console, once,
				 * is what tells an ACL mistake apart from a disabled sampler. */
				if (!text && self.samplesWarned !== true) {
					self.samplesWarned = true;
					console.warn('clients: cannot read ' + SAMPLES_PATH +
						' - the tiles fall back to the snapshot clock');
				}

				try {
					data = text ? JSON.parse(text) : null;
				}
				catch (e) {
					data = null;
				}

				return self.applySamples(data);
			});
		},

		/*
		 * Apply one ring document.
		 *
		 * The rows are already rates, so nothing is differenced here - the tick
		 * did that against its own previous pass, which is the only place the
		 * raw counters exist. What this has to get right is which side the
		 * intra counter belonged to: the tick knows whether it measured a
		 * bridge, and on a bridge those frames are already inside the port
		 * counters.
		 */
		applySamples: function(data) {
			if (!data || !Array.isArray(data.samples) || !data.samples.length)
				return null;

			var newest = data.samples[data.samples.length - 1];
			var ts = Number(newest[0]) || 0;

			if (ts <= this.ringTs)
				return null;

			var viaPorts = (data.bridge === true);
			var ring = [];

			data.samples.forEach(function(row) {
				var point = decodeSampleRow(row, viaPorts);

				if (point != null)
					ring.push(point);
			});

			if (!ring.length)
				return null;

			this.ringTs = ts;
			this.ring = ring;
			/* Per-station speeds, refreshed on their own five second step by
			 * the same writer. Kept aside instead of inside the rows: the ring
			 * carries four aggregate figures, and a table per sample would
			 * multiply the file by the size of the roster. */
			this.macRates = (data.macrates && data.macrates.macs) ? data.macrates : null;
			this.rebuildTrend();

			return ring[ring.length - 1];
		},

		/*
		 * The chart reads one series, built from the two files on every change
		 * rather than appended to: the snapshot replaces its whole series each
		 * pass, so anything appended here would be wiped ten seconds later.
		 *
		 * The ring wins wherever it reaches - it is measured every couple of
		 * seconds against the snapshot's ten - and everything older comes from
		 * the snapshot, which is the only source that reaches back far enough
		 * for the 25 minute window.
		 */
		rebuildTrend: function() {
			var coarse = this.trendCoarse;

			/* Without a series from the collector the chart is built from
			 * points this page made, and there is nothing to merge into. */
			if (!coarse) {
				if (!this.trend)
					this.trend = [];

				return;
			}

			var ring = this.ring || [];

			if (!ring.length) {
				this.trend = coarse;
				return;
			}

			var cut = ring[0].t;

			this.trend = coarse.filter(function(point) {
				return point.t < cut;
			}).concat(ring);
		},

		/*
		 * The tile figures: the newest ring row that actually measured
		 * something. A tick with no baseline is skipped rather than treated as
		 * zero, so a restart does not make the tiles flash empty.
		 */
		liveScopes: function() {
			var ring = this.ring;

			if (!ring || !ring.length)
				return null;

			for (var i = ring.length - 1; i >= 0; i--)
				if (ring[i].valid)
					return ring[i];

			return null;
		},

		/*
		 * Apply one snapshot - from the cache or from a live call - to the
		 * store.
		 *
		 * The poll can outrun the collector, and a file that has not changed
		 * since the last poll must not be applied twice: the chart would get
		 * two points for one measurement.
		 */
		applySnapshot: function(data) {
			var self = this;
			var ts = Number(data.ts) || Math.round(Date.now() / 1000);

			if (self.lastSnapshotTs === ts)
				return data;

			self.lastSnapshotTs = ts;

			var bridge = data.bridge || null;

			if (data.rates != null) {
				/* The collector says how long the window was; zeroes without a
				 * window mean "no baseline yet", which is not the same as an
				 * idle network and must not become a chart point. */
				if (Number(data.rate_window) > 0)
					self.baselineSeen = true;

				self.rates = data.rates;
				self.totals = data.totals || {};

				/* The bridge port counters are differentiated the same way and
				 * live in the same file; on a bridging device they are the only
				 * rates that survive the offload. */
				self.portRates = (bridge && bridge.rates) || null;
				self.portTotals = (bridge && bridge.totals) || null;

				self.samples = null;
				self.portSamples = null;
			}
			else {
				self.differentiate(data, ts * 1000);
			}

			/* The chart's history, if the collector kept one. An empty series
			 * (first pass after the collector started) falls back to building
			 * points here, so the chart is never blank while data exists. */
			self.trendFromFile = Array.isArray(data.trend) && data.trend.length > 0;

			/* Client-to-client traffic: one rate, no direction, and absent
			 * from devices where the collector cannot count it. */
			self.state.intra = (data.intra && data.intra.ok === true) ? data.intra : null;

			if (self.trendFromFile) {
				/* A snapshot that names the device it subtracts (`bridge.wan`,
				 * a bridge member on an AP, pppoe-wan on a router) has already
				 * put intra into its LAN figure - the port counters it was
				 * differenced from contain those frames. Folding the separate
				 * intra rate in on top of that would count them twice. */
				var viaPorts = !!(bridge && (bridge.mode || bridge.wan));

				self.trendCoarse = data.trend.map(function(point) {
					return decodeTrendPoint(point, viaPorts);
				});

				/* The ring, if there is one, is laid over the newest part. */
				self.rebuildTrend();
			}

			self.state.interfaces = data.interfaces || [];
			self.state.arp = data.arp || [];
			self.state.neigh6 = data.neigh6 || [];
			self.state.wifi = data.wifi || {};
			self.state.wifiRadios = (data.wifi_radios != null) ? data.wifi_radios : null;
			self.state.traffic = data.traffic || {};
			self.state.stats = data.stats || null;
			self.state.bridge = bridge;
			self.state.snoop4 = Array.isArray(data.snoop4) ? data.snoop4 : [];
			self.state.snoop6 = Array.isArray(data.snoop6) ? data.snoop6 : [];
			self.state.names = (data.names && typeof data.names == 'object') ? data.names : {};

			return data;
		},

		/*
		 * Fallback path: turn the absolute counters into rates against the
		 * sample this page took last time. Kept because a page updated without
		 * the service restarted is a real state to be in, and showing no
		 * traffic at all is worse than computing it here.
		 */
		differentiate: function(data, now) {
			var self = this;
			var hadBaseline = (self.samples != null) || (self.portSamples != null);

			if (hadBaseline)
				self.baselineSeen = true;

			var samples = Object.create(null);
			var rates = Object.create(null);
			var totals = self.totals || Object.create(null);
			var traffic = data.traffic || {};

			Object.keys(traffic).forEach(function(ip) {
				var current = flatCounters(traffic[ip]);
				var previous = self.samples ? self.samples[ip] : null;
				var acc = totals[ip] || zeroCounters();

				if (previous && (now - previous.ts) > RESYNC_GAP)
					previous = null;

				if (previous) {
					var seconds = Math.max((now - previous.ts) / 1000, 0.5);
					var diff = diffCounters(current, previous);

					rates[ip] = zeroCounters();

					COUNTER_KEYS.forEach(function(key) {
						rates[ip][key] = diff[key] / seconds;
						acc[key] += diff[key];
					});
				}

				/* Addresses that disappear keep their accumulated total, so a
				 * host that drops off and comes back does not restart at zero. */
				current.ts = now;
				samples[ip] = current;
				totals[ip] = acc;
			});

			self.samples = samples;
			self.rates = rates;
			self.totals = totals;

			var bridge = data.bridge || {};
			var portSamples = Object.create(null);
			var portRates = Object.create(null);
			var portTotals = self.portTotals || Object.create(null);

			Object.keys(bridge.ports || {}).forEach(function(dev) {
				var current = { rx: bridge.ports[dev].rx || 0, tx: bridge.ports[dev].tx || 0 };
				var previous = self.portSamples ? self.portSamples[dev] : null;
				var acc = portTotals[dev] || { rx: 0, tx: 0 };
				var rate = { rx: 0, tx: 0 };

				if (previous && (now - previous.ts) > RESYNC_GAP)
					previous = null;

				if (previous) {
					var seconds = Math.max((now - previous.ts) / 1000, 0.5);
					var dRx = Math.max(0, current.rx - previous.rx);
					var dTx = Math.max(0, current.tx - previous.tx);

					rate = { rx: dRx / seconds, tx: dTx / seconds };
					acc = { rx: acc.rx + dRx, tx: acc.tx + dTx };
				}

				current.ts = now;
				portSamples[dev] = current;
				portRates[dev] = rate;
				portTotals[dev] = acc;
			});

			self.portSamples = portSamples;
			self.portRates = portRates;
			self.portTotals = portTotals;
		},

		/* On a bridge (AP) the hardware port counters are the only traffic
		 * source that survives the offload: WAN is whatever crossed the
		 * uplink, LAN is what moved between this device's own clients
		 * (local members minus what the uplink carried). Returns null when
		 * this box is not a bridge or no rate exists yet. */
		bridgeRates: function(useTotals) {
			var bridge = this.state.bridge;

			/* `wan` names the device the LAN figure is measured against - a
			 * bridge member called wan on an AP, pppoe-wan on a router. A
			 * router has no such member, so the old test for bridge mode left
			 * the tile on conntrack, which counts nothing for two clients
			 * behind the same switch. */
			var uplink = bridge ? (bridge.uplink || bridge.wan) : null;

			if (!bridge || uplink == null || !this.portRates)
				return null;

			var rates = Object.create(null);
			var local = { up: 0, down: 0 }, wan = { up: 0, down: 0 };

			Object.keys(useTotals ? (this.portTotals || {}) : this.portRates).forEach(function(dev) {
				var r = useTotals ? this.portTotals[dev] : this.portRates[dev];
				var bucket = (dev == uplink) ? wan : local;

				/* rx on a member is a client's upload, tx its download; the
				 * uplink's counters face the other way. */
				bucket.up += (dev == uplink) ? r.tx : r.rx;
				bucket.down += (dev == uplink) ? r.rx : r.tx;
			}, this);

			rates.lanUp = Math.max(0, local.up - wan.up);
			rates.lanDown = Math.max(0, local.down - wan.down);
			rates.wanUp = wan.up;
			rates.wanDown = wan.down;

			return rates;
		},

		fetchLeases: function() {
			var self = this;

			self.lastLeaseLoad = Date.now();

			return Promise.all([
				L.resolveDefault(callDHCPLeases(), {}),
				L.resolveDefault(network.getHostHints(), null),
				L.resolveDefault(uci.load('dhcp'), null)
			]).then(function(results) {
				var leases = results[0] || {};

				self.state.leases4 = Array.isArray(leases.dhcp_leases) ? leases.dhcp_leases : [];
				self.state.leases6 = Array.isArray(leases.dhcp6_leases) ? leases.dhcp6_leases : [];
				self.state.hints = results[1];

				/* Reading the sections needs a successful load; without the ACL
				 * grant the load rejects and the page falls back to lease-only
				 * colouring rather than failing. */
				try {
					self.state.reserved4 = reservedAddresses();
				}
				catch (e) {
					self.state.reserved4 = Object.create(null);
				}
			});
		},

		loadHistory: function() {
			var self = this;

			self.lastHistoryLoad = Date.now();

			return L.resolveDefault(fs.read(HISTORY_PATH), '').then(function(text) {
				var data = null;

				try {
					data = text ? JSON.parse(text) : null;
				}
				catch (e) {
					data = null;
				}

				self.archive = (data && data.clients) ? data.clients : {};
				self.archiveUpdated = (data && data.updated) || 0;
			});
		},

		/* The merged rows, ready to render. */
		clients: function() {
			var list = buildClients({
				leases4: this.state.leases4,
				leases6: this.state.leases6,
				hints: this.state.hints,
				interfaces: this.state.interfaces,
				arp: this.state.arp,
				neigh6: this.state.neigh6,
				wifi: this.state.wifi,
				reserved4: this.state.reserved4,
				ip6Source: this.state.ip6Source,
				ip4Source: this.state.ip4Source,
				traffic: this.state.traffic,
				rates: this.rates || {},
				totals: this.totals || {},
				archive: this.archive,
				snoop4: this.state.snoop4,
				snoop6: this.state.snoop6,
				names: this.state.names
			});

			/*
			 * The WAN column moves on the fast ring's five second step.
			 *
			 * The snapshot's per-client rates are differenced by the collector,
			 * which cannot run often enough to look live - a conntrack walk is
			 * half a second. nlbwmon answers the same question for every
			 * station in one 3 ms call, and it is the only source that sees
			 * offloaded flows at all, so the sampler republishes it and the
			 * table takes it. Only the rate: the bracketed totals stay with
			 * the collector, which owns the accumulation.
			 *
			 * The larger of the two is shown, not simply the newer one. Both
			 * are floors - nlbwmon reconciles in batches, and a sample that
			 * lands half way through one has seen only part of the traffic -
			 * so taking the fast figure unconditionally would dip a station to
			 * zero every few seconds for no reason the network can explain.
			 */
			var macs = this.macRates;

			if (macs && macs.macs && macs.window > 0) {
				list.forEach(function(entry) {
					var fast = entry.mac ? macs.macs[entry.mac.toUpperCase()] : null;

					if (!fast)
						return;

					if (!entry.rate) {
						entry.rate = {
							up: 0, down: 0, lanUp: 0, lanDown: 0,
							wanUp: 0, wanDown: 0
						};
					}

					entry.rate.wanUp = Math.max(entry.rate.wanUp || 0, fast[0] || 0);
					entry.rate.wanDown = Math.max(entry.rate.wanDown || 0, fast[1] || 0);
				});
			}

			return list;
		},

		/*
		 * One point of the trend chart: the summed rates of every client, split
		 * by scope. Kept in memory only - a chart of the last few minutes is not
		 * worth a file, and the archive already answers "how much in total".
		 *
		 * On a bridge the per-client rates are conntrack's and the offload
		 * freezes them at zero, so the point comes from the port counters
		 * instead; no per-device series exists at L2 and the selector shows
		 * an empty chart there.
		 */
		pushTrend: function(clients) {
			if (!this.trend)
				this.trend = [];

			/* The collector owns the series when the snapshot carries one;
			 * appending here would stack this page's points on top of the same
			 * measurements. */
			if (this.trendFromFile)
				return this.trend.length ? this.trend[this.trend.length - 1] : null;

			/* Two polls can land inside one collector pass. That is one
			 * measurement, so it is one point - the previous one is still the
			 * newest thing known. */
			if (this.lastTrendTs === this.lastSnapshotTs && this.trend.length)
				return this.trend[this.trend.length - 1];

			this.lastTrendTs = this.lastSnapshotTs;

			/* Stamped with the snapshot's own time, not the browser's: the
			 * point belongs to when it was measured, and a router whose clock
			 * differs from this machine's would otherwise scatter the axis. */
			var point = {
				t: this.lastSnapshotTs * 1000 || Date.now(),
				lanUp: 0, lanDown: 0, wanUp: 0, wanDown: 0
			};
			var l2 = this.bridgeRates(false);

			if (l2) {
				point.lanUp = l2.lanUp;
				point.lanDown = l2.lanDown;
				point.wanUp = l2.wanUp;
				point.wanDown = l2.wanDown;
				point.valid = (this.baselineSeen === true);
				point.byMac = Object.create(null);
				this.trend.push(point);

				if (this.trend.length > TREND_POINTS)
					this.trend = this.trend.slice(this.trend.length - TREND_POINTS);

				return point;
			}

			clients.forEach(function(entry) {
				if (!entry.rate)
					return;

				point.lanUp += entry.rate.lanUp || 0;
				point.lanDown += entry.rate.lanDown || 0;
				point.wanUp += entry.rate.wanUp || 0;
				point.wanDown += entry.rate.wanDown || 0;
			});

			/* A single client's series, for the device selector. */
			point.byMac = Object.create(null);

			clients.forEach(function(entry) {
				if (!entry.mac || !entry.rate)
					return;

				point.byMac[entry.mac] = {
					up: entry.rate.up,
					down: entry.rate.down,
					lanUp: entry.rate.lanUp,
					lanDown: entry.rate.lanDown,
					wanUp: entry.rate.wanUp,
					wanDown: entry.rate.wanDown
				};
			});

			point.valid = (this.baselineSeen === true);
			this.trend.push(point);

			if (this.trend.length > TREND_POINTS)
				this.trend = this.trend.slice(this.trend.length - TREND_POINTS);

			return point;
		}
	};
}

/* ---------------- icons ---------------- */

/*
 * The vendor-icon bundle used to live inside luci-app-onu and was borrowed from
 * there. It ships with this package now: the host table is the only consumer,
 * and a page that silently loses its icons because an unrelated package was not
 * installed is not really self-contained.
 *
 * Best-effort by design: a missing bundle leaves the hostname as plain text and
 * must not stop the poll.
 */
var ouiPromise = null;

function loadOUI() {
	if (ouiPromise)
		return ouiPromise;

	ouiPromise = new Promise(function(resolve) {
		var script = document.createElement('script');

		script.src = L.resource('clients-oui/oui.js');
		script.async = true;
		script.onload = function() { resolve(window.luciOUI || null); };
		script.onerror = function() { resolve(null); };

		document.head.appendChild(script);
	});

	return ouiPromise;
}

/*
 * LuCI's require() only accepts class factories, and - more importantly - it
 * returns `new _class()`, an instance, never the class itself (see luci.js:
 * `const instance = new _class(); ... return instance`). The first deployment
 * hung the API on the class as static members, which passed the isSubclass
 * check and then failed with "common.createStore is not a function", because
 * the instance inherits from the prototype, not from the class object.
 *
 * The members therefore live in the extend() properties, exactly the way
 * LuCI's own rpc.js exports declare(): the instance consumers receive carries
 * every helper as an inherited method.
 */
var Common = L.Class.extend({
	PROBE: PROBE,
	SNAPSHOT_PATH: SNAPSHOT_PATH,
	SAMPLES_PATH: SAMPLES_PATH,
	HISTORY_PATH: HISTORY_PATH,
	STYLESHEET: STYLESHEET,
	SAMPLE_INTERVAL: SAMPLE_INTERVAL,
	TICK_INTERVAL: TICK_INTERVAL,
	LEASE_INTERVAL: LEASE_INTERVAL,
	HISTORY_INTERVAL: HISTORY_INTERVAL,
	TREND_POINTS: TREND_POINTS,
	decodeTrendPoint: decodeTrendPoint,
	decodeSampleRow: decodeSampleRow,
	sourceTitle: sourceTitle,
	normalizeMAC: normalizeMAC,
	autoUnit: autoUnit,
	formatRate: formatRate,
	formatSize: formatSize,
	formatBandwidth: formatBandwidth,
	formatCount: formatCount,
	relativeTime: relativeTime,
	absoluteTime: absoluteTime,
	clockTime: clockTime,
	ipv4Value: ipv4Value,
	ipv6Value: ipv6Value,
	ipv6Nodes: ipv6Nodes,
	subnetContains: subnetContains,
	networkOfAddress: networkOfAddress,
	reservedAddresses: reservedAddresses,
	ensureStylesheet: ensureStylesheet,
	buildClients: buildClients,
	sortValue: sortValue,
	createStore: createStore,
	loadOUI: loadOUI
});

return Common;

