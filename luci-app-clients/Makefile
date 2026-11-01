# SPDX-License-Identifier: Apache-2.0

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI Net Clients - addresses and traffic
# ucode backs /usr/libexec/clients-probe, the data source of the page.
# rpcd-mod-iwinfo provides the iwinfo ubus object the probe calls for the
# association list.
#
# tcpdump is deliberately NOT a dependency: /usr/libexec/clients-snoop uses it
# to listen to the bridge for DHCPACKs and IPv6 neighbour discovery, which is
# what gives an AP (no local leases, no IPv6 of its own) assignment evidence
# and client IPv6 addresses. Without tcpdump the snoop daemon exits quietly
# and the page falls back to what ARP sees.
#
# nlbwmon is deliberately NOT a dependency: the page no longer shows the
# month column it used to feed, and the live WAN figures come from conntrack
# accounting alone.
LUCI_DEPENDS:=+luci-base +ucode +ucode-mod-fs +ucode-mod-ubus +rpcd-mod-iwinfo
# Deliberately NOT a dependency: luci-app-bandix. Its per-device counters are
# exact, but they only exist with the flow offload turned off, and on a PON
# gateway that costs more throughput than the measurement is worth. Everything
# this page shows is derived from conntrack accounting, which the driver keeps
# updating for PPE-offloaded flows.
#
# Deliberately NOT a dependency, for the same reason: nlbwmon. Its per-period
# counters were removed from the page, and nothing else reads them.
LUCI_DESCRIPTION:=One place for every LAN client: addresses with their source \
	and the WAN traffic each device moved.
PKG_VERSION:=0.1.0
PKG_RELEASE:=3

PKG_LICENSE:=Apache-2.0

# root/usr/libexec/clients-* and root/etc/init.d/clients must keep their
# executable bit (0755 in git). luci.mk copies root/ with $(CP), which preserves
# the mode, so the bit recorded in git is what ends up on the target. A
# non-executable probe leaves the page permanently empty.
#
# The files the page reads through fs.read - /tmp/clients-history.json,
# /tmp/clients-snapshot.json and /tmp/clients-samples.json - are granted in
# acl.d by path. Changing clients.global.history_path to somewhere else needs
# that ACL updated too.

# This package no longer configures dnsmasq. It used to enable log-queries and
# point log-facility at /tmp/dnsmasq.log so the DNS tab could parse the query
# log; with OpenWrt's stock /etc/dnsmasq.conf also carrying a log-facility
# line, that produced "illegal repeated keyword" at startup on dnsmasq 2.93+
# and took DNS, and with it DHCP, down for the whole LAN. The DNS tab is gone,
# so postinst now removes those two UCI options instead of setting them, and
# restores the stock log-facility line if an earlier version of this package
# commented it out. Both steps are no-ops on a box that never ran the old
# version.

define Package/luci-app-clients/postinst
[ -n "$${IPKG_INSTROOT}" ] || { \
	uci -q delete dhcp.@dnsmasq[0].logqueries; \
	uci -q delete dhcp.@dnsmasq[0].logfacility; \
	uci -q commit dhcp; \
	uci -q delete clients.dns; \
	uci -q commit clients; \
	[ -e /etc/dnsmasq.conf ] && sed -i -e 's|^#log-facility=/dev/null|log-facility=/dev/null|' /etc/dnsmasq.conf; \
	/etc/init.d/dnsmasq restart 2>/dev/null; \
	rm -f /tmp/dnsmasq.log /tmp/clients-dns.json /tmp/clients-dns.json.new; \
	rm -f /tmp/luci-indexcache.*; \
	rm -rf /tmp/luci-modulecache/; \
	/etc/init.d/rpcd reload 2>/dev/null; \
	/etc/init.d/clients enable 2>/dev/null; \
	/etc/init.d/clients restart 2>/dev/null; \
	exit 0; \
}
endef

define Package/luci-app-clients/prerm
[ -n "$${IPKG_INSTROOT}" ] || { \
	/etc/init.d/clients stop 2>/dev/null; \
	/etc/init.d/clients disable 2>/dev/null; \
	uci -q delete dhcp.@dnsmasq[0].logqueries; \
	uci -q delete dhcp.@dnsmasq[0].logfacility; \
	uci -q commit dhcp; \
	rm -f /tmp/dnsmasq.log; \
	[ -e /etc/dnsmasq.conf ] && sed -i -e 's|^#log-facility=/dev/null|log-facility=/dev/null|' /etc/dnsmasq.conf; \
	/etc/init.d/dnsmasq restart 2>/dev/null; \
	rm -f /tmp/clients-history.json /tmp/clients-snapshot.json /tmp/clients-samples.json; \
	rm -f /tmp/clients-snoop.json /tmp/clients-ptr.json; \
	rm -f /tmp/clients-dns.json /tmp/clients-dns.json.new; \
	rm -f /tmp/luci-indexcache.*; \
	rm -rf /tmp/luci-modulecache/; \
	exit 0; \
}
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage: feed scanner marker; luci.mk generates the package rules.
