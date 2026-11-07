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

include $(TOPDIR)/feeds/luci/luci.mk

# Ship the two boot-time scripts with the exec bit *verified*.
#
# This feed is checked out with core.filemode=false on more than one build host,
# which drops the exec bit recorded in git: the file then lands in the tree as
# 0644/0664 and every path that copies it verbatim (image `files/` overlays,
# `cp` without -p, ...) propagates that. /etc/rc.d/S89airoha-npu was present
# and enabled while /etc/init.d/airoha-npu was 0664, so boot ran it as
# "Permission denied" (rc 126) and the rpcd backend it re-registers stayed
# missing until someone reloaded rpcd by hand.
#
# $(INSTALL_BIN) alone does not catch it: it chmods the *destination*, so a
# build that never goes through this recipe still ships a dead script. Fail
# loudly here instead of shipping a service that cannot start.
#
# $(1) source, $(2) destination
define Npu/install-exec
	$(INSTALL_DIR) $(dir $(2))
	[ -f $(1) ] || { echo "luci-app-airoha-npu: missing source $(1)" >&2; exit 1; }
	[ -x $(1) ] || { \
		echo "luci-app-airoha-npu: $(1) has no exec bit (mode $$(stat -c '%a' $(1) 2>/dev/null)); the build host lost it (core.filemode=false?) and the service cannot start" >&2; \
		exit 1; \
	}
	$(INSTALL_BIN) $(1) $(2)
	chmod 0755 $(2)
	[ -x $(2) ] || { \
		echo "luci-app-airoha-npu: $(2) shipped without the exec bit (mode $$(stat -c '%a' $(2) 2>/dev/null))" >&2; \
		exit 1; \
	}
endef

define Package/$(LUCI_NAME)/install
	# Install the unified SoC/NPU view.
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/airoha_npu
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/airoha_npu/status.js $(1)/www/luci-static/resources/view/airoha_npu/

	# Install the shared design system consumed by the status view.
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/airoha
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/airoha/ds-tokens.js $(1)/www/luci-static/resources/view/airoha/
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/airoha/ui.js $(1)/www/luci-static/resources/view/airoha/

	# Install UCI configuration
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_DATA) ./root/etc/config/npu-monitor $(1)/etc/config/

	# Install init.d scripts (executable, exec bit verified)
	$(call Npu/install-exec,./root/etc/init.d/npu-jitter,$(1)/etc/init.d/npu-jitter)

	# Install NPU jitter daemon (executable)
	$(INSTALL_DIR) $(1)/usr/libexec
	$(INSTALL_BIN) ./root/usr/libexec/npu-jitter-daemon $(1)/usr/libexec/
	$(INSTALL_DATA) ./root/usr/libexec/airoha-ppe.awk $(1)/usr/libexec/

	# Install RPC backend scripts (executable) together with the shared helpers,
	# so airoha-common.sh ships inside this package (no cross-package dependency).
	$(INSTALL_DIR) $(1)/usr/libexec/rpcd
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/luci.airoha_npu $(1)/usr/libexec/rpcd/
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/airoha-common.sh $(1)/usr/libexec/rpcd/

	# Install LuCI menu configuration.
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/luci-app-airoha-npu.json $(1)/usr/share/luci/menu.d/

	# Install RPC ACL configuration.
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-airoha-npu.json $(1)/usr/share/rpcd/acl.d/

	# Preserve runtime-created acceleration settings during sysupgrade.
	$(INSTALL_DIR) $(1)/lib/upgrade/keep.d
	$(INSTALL_DATA) ./root/lib/upgrade/keep.d/luci-app-airoha-npu $(1)/lib/upgrade/keep.d/

	# Install the init script that re-registers the rpcd backend at boot.
	# Bake the rc.d symlink so the service is enabled on a freshly flashed image too
	# (the postinst 'enable' only runs on a running device, not during image build).
	$(call Npu/install-exec,./root/etc/init.d/airoha-npu,$(1)/etc/init.d/airoha-npu)
	$(INSTALL_DIR) $(1)/etc/rc.d
	ln -sf ../init.d/airoha-npu $(1)/etc/rc.d/S89airoha-npu
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
