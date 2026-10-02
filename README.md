# luci-app-airoha

Standalone LuCI feed for Airoha/Gemtek firmware builds.

## Packages

- `luci-app-airoha`: Airoha NPU and PPE status, controls, and diagnostics.
- `luci-app-airoha-factory`: factory identity and calibration helpers.
- `luci-app-airoha-recovery`: U-Boot HTTP recovery controls.
- `luci-app-netmode`: network mode and backhaul status controls.
- `luci-app-mesh-conf`: mesh and wired backhaul configuration.

## OpenWrt / ImmortalWrt feed

Add this feed to `feeds.conf.default`:

```text
src-git airoha https://github.com/naoki66/luci-app-airoha.git
```

Then install the packages with:

```sh
./scripts/feeds update airoha
./scripts/feeds install -a -p airoha
```

The package names and configuration symbols are unchanged so existing device
profiles can continue selecting them after the feed is installed.

## Scope

This repository contains only the five LuCI packages above. Device trees,
target support, board defaults, firmware images, and private reverse-engineering
material remain in the corresponding firmware repositories.
