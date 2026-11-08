include $(TOPDIR)/rules.mk

LUCI_NAME:=luci-app-netmode
PKG_VERSION:=0.1.0
PKG_RELEASE:=1

PKG_MAINTAINER:=XR1710G Maintainer
PKG_LICENSE:=GPL-2.0-or-later

LUCI_TITLE:=LuCI Network Mode (AP / DHCP / PPPoE)
LUCI_DESCRIPTION:=One-click switching between AP mode, DHCP router mode and PPPoE router mode, with automatic config backup and restore.
LUCI_DEPENDS:=+luci-base +rpcd +jsonfilter +ppp-mod-pppoe
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

define Package/$(LUCI_NAME)/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
chmod 755 /usr/libexec/rpcd/luci.netmode 2>/dev/null
/etc/init.d/rpcd restart 2>/dev/null
rm -f /tmp/luci-indexcache.*
rm -rf /tmp/luci-modulecache/
exit 0
endef

define Package/$(LUCI_NAME)/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
/etc/init.d/rpcd restart 2>/dev/null
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
