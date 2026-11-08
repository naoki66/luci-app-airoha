include $(TOPDIR)/rules.mk

LUCI_NAME:=luci-app-mesh-conf
# 0.3.0 - adds the steering layer on top of 802.11k/v/r: the DAWN daemon makes
# the roaming decisions, this package generates its config (including the
# derived broadcast address and shared key), ships it to the peer and shows
# what the whole network sees.
PKG_VERSION:=0.3.0
PKG_RELEASE:=1

PKG_MAINTAINER:=XR1710G Maintainer
PKG_LICENSE:=GPL-2.0-or-later

LUCI_TITLE:=LuCI Mesh Configuration
LUCI_DESCRIPTION:=Join two XR1710G units: native 802.11s wireless mesh, or wired sync over the LAN (L2 neighbour discovery plus push/pull of /etc/config/wireless behind a shared key) with one-click 802.11k/v/r roaming, DAWN-driven client steering and a shared view of every AP and client in the network.
# wpad-mesh-* replaces wpad-basic: 802.11s needs a hostapd built with mesh
# support. socat carries the L2 discovery datagrams; uhttpd serves the sync
# endpoint and uclient-fetch is the http client used to push a config.
# dawn is the steering daemon: 802.11k/v only tells a client where it could
# go, DAWN is what decides that it should. It talks to the same hostapd whose
# ubus support the mesh wpad already brings, and needs umdns (its own dep).
LUCI_DEPENDS:=+luci-base +rpcd +jsonfilter +iw +uhttpd +uclient-fetch +socat +wpad-mesh-mbedtls +dawn
LUCI_PKGARCH:=all

# -- Packaging contract with feeds/luci/luci.mk --------------------------------
# luci.mk ends with
#   $(foreach pkg,$(LUCI_BUILD_PACKAGES),$(eval $(call BuildPackage,$(pkg))))
# and include/package-pack.mk expands `$(call Package/$(1)/install, ...)` while
# that eval happens; BuildPackVariable does the same for postinst/prerm/conffiles.
# A `define` written AFTER the include is therefore too late - the install rule
# has already captured luci.mk's default. That is why the old custom install
# (and any menu.d entries it installed) never reached the generated apk.
#
# This Makefile now keeps every define BEFORE the include, which is at the
# bottom of the file, and does NOT redefine Package/.../install. luci.mk's
# default install already ships everything under the source tree:
#   htdocs/*  -> $(1)/www/   (cp -pR, then JsMin / CssTidy)
#   root/*    -> $(1)/       (cp -pR, preserves the git exec bit)
# Anything the default cannot express is done in the official
# `Build/Prepare/$(LUCI_NAME)` hook on the staged copy of the tree.
# luci.mk guards its own postinst with `ifndef`, so defining it here wins.
# ------------------------------------------------------------------------------

# CRLF in a shebang ("/bin/sh\r") or in a view kills the rpcd plugin. This
# package has shipped a dead backend twice, so strip CR from the staged copy
# even though .gitattributes already pins LF. Repair and verify the exec bits
# the same way: procd silently skips a 0664 /usr/sbin/meshconf-beacon, which
# shows up only as "service not running" with an empty logread.
# The rc.d link is baked into the image because postinst is skipped during
# image builds (IPKG_INSTROOT is set).
define Build/Prepare/luci-app-mesh-conf
	$(FIND) $(PKG_BUILD_DIR)/root $(PKG_BUILD_DIR)/htdocs -type f | $(XARGS) perl -pi -e 's/\r//g'
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/libexec/rpcd/luci.meshconf $(PKG_BUILD_DIR)/root/usr/sbin/meshconf-beacon $(PKG_BUILD_DIR)/root/usr/share/meshconf/www/cgi/sync $(PKG_BUILD_DIR)/root/etc/init.d/meshconf
	[ -x $(PKG_BUILD_DIR)/root/usr/sbin/meshconf-beacon ] || { echo "luci-app-mesh-conf: staged beacon is not executable; procd cannot start it" >&2; exit 1; }
	$(INSTALL_DIR) $(PKG_BUILD_DIR)/root/etc/rc.d
	ln -sf ../init.d/meshconf $(PKG_BUILD_DIR)/root/etc/rc.d/S95meshconf
endef

# Only a default: an upgrade must not overwrite the sync key the operator
# already configured. Declaring the file as a conffile gives that guarantee
# through the package manager instead of the old `[ -f ... ] || install` probe.
define Package/luci-app-mesh-conf/conffiles
/etc/config/meshconf
endef

define Package/$(LUCI_NAME)/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0

# The previous release shipped a second init script whose only job was to
# repair this package's file modes. opkg leaves files it no longer owns in
# place, so a stale /etc/rc.d/S11meshconf-fix would keep pointing at it.
rm -f /etc/init.d/meshconf-fix /etc/rc.d/S??meshconf-fix

# Self-heal. rpcd enumerates /usr/libexec/rpcd at startup and drops any plugin
# it cannot exec -> a CRLF shebang ("/bin/sh\r") or a missing exec bit shows up
# as -32000 "Object not found" until it is fixed by hand.
sed -i 's/\r$$//' /usr/libexec/rpcd/luci.meshconf 2>/dev/null
chmod 0755 /usr/libexec/rpcd/luci.meshconf 2>/dev/null
chmod 0755 /usr/sbin/meshconf-beacon 2>/dev/null
chmod 0755 /usr/share/meshconf/www/cgi/sync 2>/dev/null
sed -i 's/\r$$//' /www/luci-static/resources/view/meshconf/meshconf.js 2>/dev/null
sed -i 's/\r$$//' /www/luci-static/resources/view/meshconf/steering.js 2>/dev/null
sed -i 's/\r$$//' /www/luci-static/resources/view/meshconf/ds-tokens.js 2>/dev/null

/etc/init.d/meshconf enable 2>/dev/null
/etc/init.d/meshconf restart 2>/dev/null

# rpcd must be restarted (not just signalled) to re-enumerate the plugins
/etc/init.d/rpcd restart 2>/dev/null

# give rpcd a few seconds to publish the object before giving up
i=0
while [ $$i -lt 5 ]; do
	ubus list luci.meshconf >/dev/null 2>&1 && break
	i=$$((i + 1))
	sleep 1
done

rm -f /tmp/luci-indexcache.*
rm -rf /tmp/luci-modulecache/
exit 0
endef

define Package/$(LUCI_NAME)/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
/etc/init.d/meshconf disable 2>/dev/null
/etc/init.d/meshconf stop 2>/dev/null
rm -f /etc/rc.d/S??meshconf
/etc/init.d/rpcd restart 2>/dev/null
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
