# luci-app-clients

One LuCI application for everything the router knows about the stations on its
network: addresses, per-device WAN traffic, and the wireless association each
station had.

Menu entry: **Status → Net Clients** (`admin/status/clients`), sitting right
after Airoha Soc (`order` 16).

Two tabs:

| Tab | Answers |
|---|---|
| **Overview** | How much total traffic, plus a live trend chart |
| **Devices** | One row per client: addresses with their source, network, WAN rate, connections, last seen (the Signal column only appears on devices with radios) |

## Dependencies

Declared in the Makefile, so a normal install pulls them in:

| Package | Why |
|---|---|
| `ucode`, `ucode-mod-fs`, `ucode-mod-ubus` | `clients-probe` and `clients-snoop` |
| `rpcd-mod-iwinfo` | the `iwinfo` ubus object the probe calls for association data |

The vendor-icon bundle (`htdocs/.../resources/clients-oui/`, 501 KB, 67 files)
ships inside this package. It used to live in luci-app-onu and this page merely
borrowed it; that made the icons silently disappear when the other package was
not installed.

## Where the data comes from

The collectors run on a timer and write to `/tmp`. The pages read those files;
nothing here starts a measurement, and nothing polls a daemon over a socket.

| Source | Provides | Written by |
|---|---|---|
| `nf_conntrack` accounting | per-device rates, LAN/WAN split, connection count | `clients-probe` |
| ARP + IPv6 neighbour cache | who is reachable now, address family | `clients-probe` |
| `iwinfo` assoclist | SSID, band, signal, noise | `clients-probe` |
| bridge snooping | IPv4 assignment evidence, IPv6 addresses learned from neighbour discovery | `clients-snoop`, long-running |
| live snapshot | everything above, with the counters already turned into rates and running totals | `clients-probe collect`, every 10 s |
| fast ring | the four overview tile figures, on their own cheaper clock | `clients-probe loop`, every 1 s |
| archive | first / last seen, last known association and name | `clients-probe collect`, every 30 s |
| nftables bridge counter | traffic between two clients of the same subnet, which nothing else sees | `clients-probe intra-setup`, once at service start |

The sampling clock belongs to the collector, not to the browser: every pass
walks conntrack once and writes `/tmp/clients-snapshot.json`, with `rates`,
`totals` and the `rate_window` they were divided by, plus one aggregate `trend`
point (the summed LAN/WAN rates and the inner-LAN figure). The chart's *Type*
selector picks one of three - total, WAN, LAN - and the LAN series already has
the inner-LAN traffic folded into it. The
series holds 180 points - 30 minutes at the default cadence, enough for the
widest window the page offers - so the chart is already drawn from history when
the page opens instead of filling in from the moment someone looks. Opening the
page reads that file, so a second tab costs nothing and a viewer never waits for
a sample.
`clients-probe` with no argument still prints a live snapshot and exits, and the
page falls back to it - differencing the counters locally - when the file is
missing because the service is stopped.

### Why there is a second, smaller file

The snapshot answers "who is on my network", and answering that costs most of a
second a pass - conntrack, ARP, `iwinfo`, `nlbwmon` and `nft`. Measured on
target that is 0.47 s, so with the configured 10 s sleep it is rewritten every
10.8 s, and anything reading it inherits that as its refresh rate. The four
tiles at the top of the page do not need the roster, so a second writer keeps
`/tmp/clients-samples.json` moving once a second: one row per tick with the
four scope rates, the inner-LAN rate and the window they were divided by, plus
the counters the next tick differences against.

Two files, two writers. They are not merged into one because two processes
renaming over each other would lose a whole collection pass whenever they
collide, and a sidecar of a few kilobytes costs less than the lock that sharing
would need.

The page reads the ring on every poll and the snapshot on the slower one, then
lays the ring's points over the newest part of the snapshot's series - the
chart is one series, drawn from whichever source is fresher at that timestamp.

**The tick reads four numbers out of sysfs and nothing else.** It was once a
shorter version of the snapshot - conntrack, the ARP table, nlbwmon - which
measured 0.34 s, and later 0.44 s. That is not a second's worth of work. What
the tiles need is aggregate bytes per direction, and the interface counters
answer exactly that in about 8 ms: `port_counters()` walks two sysfs
directories, reads the members of the LAN bridge plus the uplink, and the four
figures are one subtraction later. Per-client attribution still needs conntrack
and nlbwmon, and that stays on the 10 s pass that draws the roster.

Two details make the one second affordable:

- **The loop owns the interpreter.** Starting `clients-probe tick` from a shell
  costs 40 ms before any work happens - the interpreter reads and compiles this
  file every time - which alone is four percent of a core at 1 Hz. `clients-probe
  loop` parses once and ticks from inside a loop, shortening each sleep by
  however long the pass took so the cadence does not drift. Measured on target
  across 30 s: 25 jiffies, **0.83%**.
- **Nothing on this path forks.** The port scan used to be a `for d in
  /sys/class/net/*` shell loop that also ran `basename` twice per member, 25 ms
  of process spawning; it is now `fs.opendir` and a handful of small reads. No
  `nlbwmon`, no `nft`, no conntrack in the tick at all.

Two details worth knowing before reading the numbers:

- **The window is a moving average, not the last tick.** These counters are
  reconciled in bursts, so a single one-second baseline lands in a gap as often
  as not - measured on target, an idle-looking network accumulated 80 KB one
  second and nothing the next two. Dividing that by one second gives 80 KB/s, 0,
  0: a comb, not a measurement. The tick therefore sums the last `SAMPLE_SPAN`
  (3) seconds of deltas and divides once, which hides the batch boundaries
  without inventing traffic - every byte in the sum came out of a counter. Three
  seconds is short on purpose: the window is also the lag the tile shows.
- **The ring carries no per-device series.** It is four aggregate figures and
  the chart draws exactly those: there is no device selector, because a chart
  of one station is what the devices tab is for and the two would answer the
  same question at two different clocks.
- **Per-station speeds ride the same file.** The ring also carries a
  `macrates` table - MAC to `[up, down]` - refreshed every `MAC_RATE_EVERY` (5)
  seconds, which is as often as its source changes. It comes from `nlbwmon`:
  the hardware offload freezes conntrack's counters per flow, and nlbwmon reads
  the accounting the driver writes back. Measured over a minute, nlbwmon
  reconciles in batches every four to five seconds, so sampling it at 1 Hz
  would report four zeros and a spike. The devices tab takes the larger of
  that figure and the collector's, so a half-elapsed batch cannot dip a busy
  station to zero.

### What the LAN figure counts

The three tiles on the overview page are LAN, WAN and Total, where Total is the
sum of the other two. Both halves come from the **interface counters**, on a
router as much as on an AP:

- **WAN** is the uplink device: `wan` when it is a bridge member, `pppoe-wan`
  (or `wan`) when it is routed.
- **LAN** is the sum of the LAN bridge's other members, minus what crossed the
  uplink - the bytes that went out of the LAN ports but did not leave through
  the WAN.

Those counters are what survives the hardware offload. On this fleet,
`nf_conntrack`'s byte accounting is **frozen** for offloaded flows: measured on
target, the WAN interface moved 2.82 MB in 43 s while every conntrack counter
added up to exactly zero. Conntrack is still what attributes bytes to a client -
it is the only source that knows which address sent them - but it cannot be the
figure the tiles are drawn from.

The same counters also fix a figure that used to read zero. Two clients on the
**same** subnet are forwarded by the bridge at layer 2, so no conntrack entry is
ever created; a routed box that drew LAN from conntrack had nothing to report for
the commonest traffic on the network. The port counters see those frames, so LAN
is now a real number on both roles, and an em dash only appears when the box
genuinely has no LAN bridge to measure.

Per-client figures on the devices page are a different matter: they still come
from conntrack, corrected by `nlbwmon` where the offload has zeroed it. A
client's own rate is therefore coarser than the tile above it, and on an AP it
can stay near zero while the tile shows the port figure - the frames were
counted at the port, not against any flow.

### Counting the traffic conntrack cannot see

Switched frames are invisible to layer 3. The tiles get them from the port
counters above; this counter exists as the fallback for a box where those are
not available, and as the one figure that says how much of the LAN traffic never
left the switch: a rule in the `bridge` family, installed once when the service
starts.

```
table bridge clients_intra {
	chain forward {
		type filter hook forward priority filter; policy accept;
		meta ibrname "br-lan" meta obrname "br-lan" counter comment "intra-lan"
	}
}
```

A frame is counted when it entered **and** left through the LAN bridge, which is
exactly "switched between two of its ports". What that leaves out is what should
be left out:

- frames the router itself sends or receives - they go through the input and
  output hooks, never forward, so client-to-router traffic is not in the figure;
- on an AP, anything that crossed the uplink. There `wan` is a member of the LAN
  bridge, so a bridged WAN frame also enters and leaves through it; the rule
  gains `iifname != "wan" oifname != "wan"` in that case and only client-to-client
  frames remain.

The counter has **no direction**: both ends of the exchange are clients, so
upload and download have no meaning. It is therefore folded into the LAN figure
rather than shown beside it - a frame lands under both arrows, which is what the
hardware port counters behind an AP's LAN tile have always done: a switched frame
is rx on one port and tx on another. Nothing is listed separately, and `Total`
picks it up through the same sum.

On an AP the counter is read for diagnostics only: the port counters behind the
LAN tile already contain those frames, and adding it again would count them
twice. `clients-probe status` prints what the collector last saw, and
`clients-probe intra` reads the counter directly.

Installed by `clients-probe intra-setup` at start-up, rebuilt on every service
reload and on a firewall reload, and removed by `stop`. A manual `nft flush
ruleset` therefore takes the figure away until the next `service clients
restart`; until then the page leaves the row and the chart type out rather than
showing a flat zero. `clients-probe status` prints the last figure the collector
saw, and `clients-probe intra` reads the counter directly.

The archive merge rides on the same pass but on a slower clock
(`clients.global.interval`), and the stamp that decides it lives in the live
file, so the loop needs no other state.

## Bridging device (AP mode)

When this box only bridges - an AP without its own DHCP server - two of the
page's sources go dark: there are no local leases to colour an IPv4 address
with, and the kernel never resolves a client's global IPv6 address (the box
itself has none, so `ip -6 neigh` only lists the upstream routers). Verified
on a real AP: the IPv6 column stays empty for every client.

`clients-snoop` listens instead. It runs `tcpdump` on the LAN bridge with a
kernel BPF filter that only lifts DHCPv4 and ICMPv6 neighbour-discovery
packets out of the traffic stream, and reduces them to mac → address facts:

- a **DHCPACK** names the client hardware address and the address assigned,
  which colours the IPv4 address as DHCP-assigned even though the server is
  elsewhere;
- a **neighbour advertisement** announces one of the sender's own addresses,
  and a **duplicate-address detection probe** (a solicitation from `::`)
  does the same for the sender - either yields the IPv6 addresses the page
  could not learn otherwise.

Facts land in `/tmp/clients-snoop.json`; `clients-probe` folds them into its
snapshot and marks observations from the last two minutes as live traffic.
The daemon is optional: without `tcpdump` it stays off and the page falls
back to what ARP sees. On a router that owns its DHCP server it adds nothing
the lease file does not already say, so `clients.config.snoop.enabled`
switches it off.

## Why not bandix

`luci-app-bandix` measures traffic in eBPF at the TC hook, which is more precise
than reading conntrack. It also requires the flow offload to be turned off,
because offloaded flows never reach the TC hook. On a PON gateway that trades
hardware line-rate forwarding for a nicer number on a status page, which is a
bad trade. Everything this package shows is derived from conntrack accounting,
and the driver keeps those counters updated for PPE-offloaded flows - verified
on target before this design was chosen.

A note on what exactly conflicts, since it is easy to conflate: **the conflict
is with the hardware offload (PPE), not with software flow offloading.**
Measured on a device with `flow_offloading=1` and `flow_offloading_hw=1` and the
nft flowtable `flags offload` in effect, conntrack still reported per-device WAN
bytes (3.23 MB up / 1.37 MB down for one client). What genuinely stops working
under hardware offload is anything that has to see the packet: eBPF on the TC
hook, `nft` limit/quota rules, and `tc` shaping. That is why this package does
not offer rate limiting or per-device quotas - they cannot be made reliable
without giving up the offload.

## Long-term counters (removed)

The page used to carry a "This month" column backed by `nlbwmon`. It was
removed together with the per-device LAN column: the live WAN figures answer
the question the table asks, and one fewer background counter is one fewer
thing to configure. `nlbwmon` is no longer a dependency; the `clients-probe
nlbw` query path is still present on the backend but nothing calls it.

## One limit worth knowing

**The running totals are floors, not lifetime totals.** conntrack counters
belong to a flow; when the flow is reaped, its bytes leave the table with it.
The rate is accurate, the accumulated figure is "what the collector has seen
since it started" - it survives a page reload, not a reboot.

## Configuration

`/etc/config/clients`:

| Option | Default | Meaning |
|---|---|---|
| `clients.global.enabled` | `1` | master switch for the host collector |
| `clients.global.interval` | `30` | seconds between host samples |
| `clients.global.retention` | `7` | days an offline client is kept |
| `clients.global.history_path` | `/tmp/clients-history.json` | archive location |
| `clients.global.live_interval` | `10` | seconds between live snapshot passes |
| `clients.global.snapshot_path` | `/tmp/clients-snapshot.json` | location the pages read |
| `clients.global.tick_interval` | `1` | seconds between tile measurements; `0` switches the fast ring off |
| `clients.global.samples_path` | `/tmp/clients-samples.json` | location of the fast ring |
| `clients.global.max_bytes` | `262144` | byte ceiling per cache file |
| `clients.snoop.enabled` | `1` | passive bridge listening on/off |

Every cache defaults to `/tmp` deliberately: a status page must not wear the
flash. Point them at persistent storage only if the history has to survive a
reboot - and update `acl.d/luci-app-clients.json` to match the new paths.

## Space used in /tmp

`/tmp` is RAM, so the five files this package keeps there are all capped:
`clients-history.json`, `clients-snapshot.json`, `clients-samples.json`,
`clients-snoop.json` and `clients-ptr.json`. A document that would exceed
`max_bytes` gives up rows before it is written - rates first, then the snooped
hints, then whole client rows, then the archive's oldest entries - so the worst
case is `max_bytes` per file instead of a function of how many addresses the
network handed out. The ceiling is **per file**, so the hard worst case is five
times `max_bytes` (1.25 MiB at the default) even though a real network never
gets close: measured on a `/24` under normal use the files total well under
100 KiB.

The fast ring is the smallest of them - 180 rows of eight numbers is about 8 KiB
with its bookkeeping, rewritten every two seconds.

The trend series is the largest single item in the snapshot - about 75 KiB with
eight devices and a full 180 points on a routed box, and about 14 KiB on a
bridge, where there is no per-device series. Under byte pressure it goes last:
first the per-device table is dropped, then the oldest points.

`clients-probe status` prints the size of each file and whether any of them is
over the ceiling, which is the cheapest way to check the cap from the outside.

## A note on dnsmasq (why this package stays out of it)

Earlier versions parsed dnsmasq's query log to build a DNS tab. That required
`log-queries=1` plus `log-facility=/tmp/dnsmasq.log` in UCI, and OpenWrt's stock
`/etc/dnsmasq.conf` ships its own `log-facility` line - two of them abort
dnsmasq startup with *illegal repeated keyword* on 2.93+, which takes DNS and
DHCP down for the whole LAN. The DNS tab and the collector are gone, and this
package no longer writes to dnsmasq's configuration at all: `postinst` removes
the two UCI options if an older version left them behind and restores the stock
`log-facility` line if it was commented out.

## Licence

Apache-2.0.
