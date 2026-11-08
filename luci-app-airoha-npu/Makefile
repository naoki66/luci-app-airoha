# This is free software, licensed under the Apache License, Version 2.0 .

include $(TOPDIR)/rules.mk

LUCI_NAME:=luci-app-airoha-npu
PKG_VERSION:=2.0.0
PKG_RELEASE:=9
PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=XR1710G Maintainer
TITLE:=LuCI Airoha XR1710G / XG2010G Status

LUCI_TITLE:=LuCI Airoha XR1710G / XG2010G Status
LUCI_DESCRIPTION:=Unified Airoha XR1710G and XG2010G SoC/NPU status app with CPU, \
	frame-engine, PPE hardware-offload, Ethernet topology and board-aware WiFi monitoring. \
	The WiFi section is shown on XR1710G and omitted on radio-less XG2010G systems.

# The Frame Engine block (GDM/CDM/PSE counters) reads the AN7581 register window
# straight out of physical memory, so the image needs *both* halves of the
# devmem path or that whole block degrades at runtime to "devmem applet ...
# unavailable":
#
#   CONFIG_KERNEL_DEVMEM      the kernel side; without it /dev/mem does not
#                             exist at all, and `dd if=/dev/mem` is not a
#                             fallback - the memory char device rejects those
#                             reads with EFAULT, only mmap (what devmem uses)
#                             reaches the registers.
#   BUSYBOX_*_DEVMEM          the applet side; without it `command -v devmem`
#                             fails in the rpcd backend.
#
# busybox builds its applet list from CONFIG_BUSYBOX_CONFIG_* when
# CONFIG_BUSYBOX_CUSTOM=y and from CONFIG_BUSYBOX_DEFAULT_* otherwise (see
# BUSYBOX_SYM in package/utils/busybox/Makefile), and the CONFIG_ family is not
# settable while BUSYBOX_CUSTOM=n. Both are declared so that whichever family
# the target reads is already y; deciding between them here would need
# $(CONFIG_BUSYBOX_CUSTOM) at Makefile-parse time, which is unavailable: the
# package scan (include/scan.mk) only regenerates tmp/.packageinfo when the
# Makefile set changes, never when .config does, so a conditional DEPENDS would
# be silently stale. Declaring a superset cannot break either mode - the
# unused family's value is simply never read.
#
# XR1710G already gets all three from its config seed, and XG2010G gets the
# applet from busybox's per-device CONFIG_DEVMEM override; declaring them here
# is what protects any other target this app is built into.
LUCI_DEPENDS:=+luci-base +kmod-br-netfilter \
	+@KERNEL_DEVMEM \
	+@BUSYBOX_DEFAULT_DEVMEM \
	+@BUSYBOX_CONFIG_DEVMEM

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

# The exec bit is load-bearing: a 0664 init script fails at boot with rc 126 and
# the rpcd backend never gets re-registered. Some build hosts check out with
# core.filemode=false, which drops the bit recorded in git, so repair it on the
# staged tree and verify the staged files instead of trusting the checkout.
# The rc.d link must be baked into the image too: postinst exits early during
# image builds (IPKG_INSTROOT is set), so `enable` alone cannot enable the
# service on a freshly flashed device.
define Build/Prepare/luci-app-airoha-npu
	chmod 0755 $(PKG_BUILD_DIR)/root/etc/init.d/airoha-npu $(PKG_BUILD_DIR)/root/etc/init.d/npu-jitter $(PKG_BUILD_DIR)/root/usr/libexec/npu-jitter-daemon $(PKG_BUILD_DIR)/root/usr/libexec/rpcd/luci.airoha_npu
	[ -x $(PKG_BUILD_DIR)/root/etc/init.d/airoha-npu ] || { echo "luci-app-airoha-npu: staged init script is not executable" >&2; exit 1; }
	[ -x $(PKG_BUILD_DIR)/root/etc/init.d/npu-jitter ] || { echo "luci-app-airoha-npu: staged jitter init script is not executable" >&2; exit 1; }
	[ -x $(PKG_BUILD_DIR)/root/usr/libexec/npu-jitter-daemon ] || { echo "luci-app-airoha-npu: staged jitter daemon is not executable" >&2; exit 1; }
	[ -x $(PKG_BUILD_DIR)/root/usr/libexec/rpcd/luci.airoha_npu ] || { echo "luci-app-airoha-npu: staged rpcd backend is not executable" >&2; exit 1; }
	$(INSTALL_DIR) $(PKG_BUILD_DIR)/root/etc/rc.d
	ln -sf ../init.d/airoha-npu $(PKG_BUILD_DIR)/root/etc/rc.d/S89airoha-npu
endef

define Package/$(LUCI_NAME)/conffiles
/etc/config/npu-monitor
endef

define Package/$(LUCI_NAME)/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0

# Reload rpcd to register the luci.airoha_npu backend
/etc/init.d/rpcd reload 2>/dev/null

# Bridge acceleration is opt-in through the NPU tab. Remove defaults from
# earlier builds so only firewall hardware flow offload is enabled by default.
rm -f /etc/sysctl.d/10-bridge-offload.conf /etc/sysctl.d/99-bridge-offload.conf

# Enable and start the npu-jitter service
/etc/init.d/npu-jitter enable 2>/dev/null
/etc/init.d/npu-jitter start 2>/dev/null

# Self-heal: an image built from a checkout that lost the exec bit ships
# /etc/init.d/airoha-npu as 0664, and rc.common then fails with rc 126 without
# logging anything. Re-assert both the bit and the rc.d link here.
sed -i 's/\r$$//' /etc/init.d/airoha-npu 2>/dev/null
chmod 0755 /etc/init.d/airoha-npu 2>/dev/null
chmod 0755 /etc/init.d/npu-jitter 2>/dev/null
chmod 0755 /usr/libexec/rpcd/luci.airoha_npu 2>/dev/null

# Enable the boot-time CPU settings apply script (runs at next reboot)
/etc/init.d/airoha-npu enable 2>/dev/null
[ -e /etc/rc.d/S89airoha-npu ] || ln -sf ../init.d/airoha-npu /etc/rc.d/S89airoha-npu 2>/dev/null

# Clear LuCI cache so the new menu entries are picked up
rm -f /tmp/luci-indexcache.*
rm -rf /tmp/luci-modulecache/

exit 0
endef

define Package/$(LUCI_NAME)/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0

# Stop and disable the npu-jitter service
/etc/init.d/npu-jitter stop 2>/dev/null
/etc/init.d/npu-jitter disable 2>/dev/null

# Stop and disable the boot-time CPU settings apply script
/etc/init.d/airoha-npu stop 2>/dev/null
/etc/init.d/airoha-npu disable 2>/dev/null

# Reload rpcd to unregister the backends
/etc/init.d/rpcd reload 2>/dev/null

exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
#
# feeds/luci/luci.mk (included above) already runs
#   $(foreach pkg,$(LUCI_BUILD_PACKAGES),$(eval $(call BuildPackage,$(pkg))))
# for this app and the luci-i18n-airoha-npu-<lang> translation packages, so no
# explicit BuildPackage eval must be added here (that would define the package
# twice). The literal string above is nevertheless REQUIRED: include/scan.mk
# discovers package Makefiles with
#   find ... -name Makefile | xargs grep -aHE 'call (Build/DefaultTargets|BuildPackage|KernelPackage)'
# so a Makefile without it is never scanned, never lands in tmp/.packageinfo
# and the package silently disappears from every generated image.
