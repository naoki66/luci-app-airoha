include $(TOPDIR)/rules.mk

LUCI_NAME:=luci-app-airoha-factory
PKG_VERSION:=1.0.0
PKG_RELEASE:=3

PKG_MAINTAINER:=XR1710G Maintainer
PKG_LICENSE:=GPL-2.0-or-later
TITLE:=LuCI Airoha XR1710G Factory Partition Editor

LUCI_TITLE:=LuCI Airoha XR1710G Factory Partition Editor
LUCI_DESCRIPTION:=Reads and modifies XR1710G factory provisioning data \
	(MAC addresses, serial number, Wi-Fi defaults, admin credentials). The \
	legacy layout uses the writable vendor MTD block at 0x400000; the \
	2010-style OpenWrt U-Boot layout rewrites the DSD backup inside the UBI \
	"factory" volume and keeps the U-Boot environment in sync.
LUCI_DEPENDS:=+luci-base +uboot-envtools +ubi-utils

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

# Ensure the rpcd backend is executable even if a packaging path lost the
# +x bit; rpcd silently skips non-executable scripts in /usr/libexec/rpcd.
chmod 755 /usr/libexec/rpcd/luci.airoha_factory 2>/dev/null

# Older releases owned the shared /etc/fw_env.config and put the vendor mtd0
# entry in front of the two UBI entries appended by uboot-envtools.  fw_env
# only honours the first two entries of a config file, so that MTD+UBI mix
# made every bare fw_printenv/fw_setenv call fail with "Incompatible flash
# types!".  Drop the vendor entry from the shared file when it also carries
# UBI entries so uboot-envtools keeps full control again.  If the file only
# holds the vendor entry (uboot-envtools not installed/never run) it is left
# alone, because a single MTD entry is still a perfectly valid config.
if [ -f /etc/fw_env.config ] && grep -qE '^[[:space:]]*/dev/ubi[0-9]+_[0-9]+[[:space:]]' /etc/fw_env.config && grep -qE '^[[:space:]]*/dev/mtd[0-9]+[[:space:]]+0x200000[[:space:]]' /etc/fw_env.config; then
	grep -vE '^[[:space:]]*/dev/mtd[0-9]+[[:space:]]+0x200000[[:space:]]' /etc/fw_env.config > /etc/fw_env.config.tmp 2>/dev/null
	mv /etc/fw_env.config.tmp /etc/fw_env.config 2>/dev/null
	rm -f /etc/fw_env.config.tmp
fi

# rpcd only rescan the backend directory on a full (re)start, so restart it
# to register the new luci.airoha_factory backend.
/etc/init.d/rpcd restart 2>/dev/null

# Clear LuCI cache so the new menu entries are picked up
rm -f /tmp/luci-indexcache.*
rm -rf /tmp/luci-modulecache/

exit 0
endef

define Package/$(LUCI_NAME)/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0

# Restart rpcd to unregister the luci.airoha_factory backend
/etc/init.d/rpcd restart 2>/dev/null

exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
