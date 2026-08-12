# AF_PACKET TPACKET_V3 Privilege Escalation

> CVE-2017-7308 — a single `(int)` cast around an unsigned subtraction defeated a ring-buffer bounds check, found by syzkaller and turned into local root by Project Zero

**Disclosed:** March 29, 2017 &nbsp;·&nbsp; **Reported by:** Andrey Konovalov, Google Project Zero (via syzkaller + KASAN) &nbsp;·&nbsp; **CVSS:** 7.8 HIGH &nbsp;·&nbsp; **Fixed in:** mainline March 2017, backported to 4.10.x and earlier stable branches &nbsp;·&nbsp; **Exploit tool:** yes (2 Exploit-DB entries, incl. a [Metasploit module](https://www.exploit-db.com/exploits/44654)) &nbsp;·&nbsp; **Actively exploited:** no confirmed cases (not on CISA KEV)

*Part of [War Stories: Network Stack Bugs and CVEs](../war-stories.md).*

## Before state

`AF_PACKET` sockets (used by `tcpdump`, Wireshark, and any raw-capture tool) can be configured with a memory-mapped ring buffer via `PACKET_RX_RING`/`PACKET_TX_RING`, avoiding a copy per captured packet. `packet_set_ring()` in `net/packet/af_packet.c` validates the requested ring geometry — block size, number of blocks, frame size — before allocating and mapping the ring. For the `TPACKET_V3` ring format, each block reserves space for a small private header (`tp_sizeof_priv`) in addition to packet frames, computed via the `BLK_PLUS_PRIV()` macro.

The sanity check guarding this computation looked like:

```c
if (po->tp_version >= TPACKET_V3 &&
    (int)(req->tp_block_size - BLK_PLUS_PRIV(req_u->req3.tp_sizeof_priv)) <= 0)
        goto out;
```

## The trigger

Both `tp_block_size` and the result of `BLK_PLUS_PRIV()` are unsigned. Casting their subtraction to `(int)` before comparing to zero is unsafe: [Project Zero's Andrey Konovalov](https://projectzero.google/2017/05/exploiting-linux-kernel-via-packet.html), using syzkaller (a coverage-guided syscall fuzzer) together with KASAN, found that by supplying a `tp_sizeof_priv` value with its high bit set, the unsigned subtraction wraps to a large value that, when reinterpreted as a signed `int`, appears positive — silently passing a check that was supposed to reject an oversized private-header request.

This let `blk_sizeof_priv` end up set to an attacker-chosen value, corrupting the block layout computed in `init_prb_bdqc()` and `prb_open_block()` and, downstream of that, the `max_frame_len` calculation used in `__packet_lookup_frame_in_block()` — leaving the kernel's view of the ring's frame layout disagreeing with the actual size of the mapped blocks.

## Observed behavior

The mismatch between the computed frame layout and the real block boundaries let a caller drive a **heap out-of-bounds write** when the kernel populated ring-buffer frames — a local integer-signedness bug that Project Zero's [writeup](https://projectzero.google/2017/05/exploiting-linux-kernel-via-packet.html), "Exploiting the Linux kernel via packet sockets," turned into a working local root exploit.

Creating an `AF_PACKET` socket at all requires `CAP_NET_RAW` — ordinarily a meaningful barrier, but, as the writeup notes, one "which can be acquired by an unprivileged user inside a user namespaces" on any system where `CONFIG_USER_NS=y` and unprivileged user namespace creation is allowed, a common default on Ubuntu at the time (the writeup explicitly notes Android disallows untrusted code from creating `AF_PACKET` sockets at all).

Beyond Project Zero's own writeup, the bug was independently weaponized twice more: two separate proof-of-concept exploits were catalogued on [Exploit-DB](https://www.exploit-db.com/exploits/44654) — one of them a [Metasploit module](https://www.exploit-db.com/exploits/44654) (`exploit/linux/local/af_packet_packet_set_ring_priv_esc`), turning a research bug into a one-command local-root tool available to anyone running the framework. There's no public evidence of it being caught in active exploitation against real targets (it isn't on CISA's KEV catalog), but "no confirmed attack" and "no practical way to attack" are different claims — this one had the latter closed within months of disclosure.

## Why it happened

A single unsigned-to-signed cast, applied to a subtraction of two attacker-influenced unsigned values, was enough to defeat a bounds check. The check's author reasoned about the comparison as if it were happening in a signed domain where "negative or zero" cleanly meant "too small," without accounting for how a large unsigned wraparound would be reinterpreted once cast to `int`.

## Resolution

[`2b6867c2ce76`](https://github.com/torvalds/linux/commit/2b6867c2ce76c596676bec7d2d525af525fdc6e2) ("net/packet: fix overflow in check for priv area size"), authored by Andrey Konovalov, drops the signed cast and instead casts `tp_sizeof_priv` to `u64` before the comparison — comparing both sides in a wide-enough, correctly-signed domain that wraparound can no longer occur:

```c
if (po->tp_version >= TPACKET_V3 &&
    req->tp_block_size <=
          BLK_PLUS_PRIV((u64)req_u->req3.tp_sizeof_priv))
        goto out;
```

The fix landed in mainline in March 2017 and was backported to stable kernels; distributions shipped it in their 4.10.x and earlier stable branches shortly after.

Konovalov [originally posted this fix](https://lore.kernel.org/netdev/cover.1490709552.git.andreyknvl@google.com/) as part of a five-patch series addressing multiple overflow and signedness issues across the AF_PACKET ring-buffer code. Willem de Bruijn, reviewing on netdev, pushed back on the scope: "These are a lot of changes to backport to stable kernels. Can we separate the minimal patch set needed to address known overflow to send to net... and follow up with the larger cleanup to net-next." Konovalov agreed and split two of the five patches — the `tp_frame_size` checks and a reordering cleanup — out into a separate net-next series, [reposting the trimmed three-patch v2](https://lore.kernel.org/netdev/cover.1490796500.git.andreyknvl@google.com/) the next day as the minimal `net` submission that actually needed to reach stable. David Miller applied it within 24 hours.

## What it taught us

**Signed/unsigned casts around a subtraction are a recurring bug class.** "Cast the difference of two unsigned values to `int` and check the sign" is a pattern that looks correct and reads naturally, but only actually works if the difference can never wrap — a property that has to be proven, not assumed, whenever either operand is attacker-influenced.

**A capability check is only as strong as its reachability.** `CAP_NET_RAW` was a real, meaningful gate in a world without unprivileged user namespaces; once unprivileged namespace creation became common, the same capability check stopped meaning "trusted caller."

**Ring-buffer geometry bugs are size-mismatch bugs by nature.** Any code that separately validates a size and later relies on that size to compute offsets is vulnerable to exactly this class of bug if the validation and the later use don't agree bit-for-bit on the arithmetic domain (signed vs. unsigned, width).

!!! warning "Pattern to watch for"
    Grep for `(int)` casts wrapping subtraction of two `unsigned`/`size_t`/`u32`/`u64` values anywhere a bounds check follows — this exact shape (`(int)(a - b) <= 0`) is what caused CVE-2017-7308 and recurs across the kernel. Also worth checking: `sysctl kernel.unprivileged_userns_clone` (or your distro's equivalent) — if unprivileged namespace creation is enabled, treat every `CAP_NET_RAW`/`CAP_NET_ADMIN`-gated local bug as remotely reachable from container workloads.

## See also

- [AF_PACKET Raw Sockets](../packet-socket.md) — the ring-buffer mechanics behind this bug
- [Network Namespaces](../net-namespaces.md) — how unprivileged user+network namespaces expose `CAP_NET_RAW`-gated code paths
- [Netfilter x_tables Heap Overflow](netfilter-xtables.md) — another capability-gated local bug turned container-escape primitive
- [UDP UFO Path-Switch Corruption](udp-ufo.md) — another syzkaller-found bug in the same era

## External references

- [NVD: CVE-2017-7308](https://nvd.nist.gov/vuln/detail/CVE-2017-7308) — AF_PACKET TPACKET_V3 CVE record
- [GitHub mirror: 2b6867c2ce76](https://github.com/torvalds/linux/commit/2b6867c2ce76c596676bec7d2d525af525fdc6e2) — "net/packet: fix overflow in check for priv area size"
- [lore.kernel.org: net/packet: fix multiple overflow issues in ring buffers (v1)](https://lore.kernel.org/netdev/cover.1490709552.git.andreyknvl@google.com/) — the cover-letter thread showing Willem de Bruijn's request to split the minimal overflow fix from the broader ring-buffer cleanup
- [lore.kernel.org: v2, the trimmed three-patch series](https://lore.kernel.org/netdev/cover.1490796500.git.andreyknvl@google.com/) — the resubmission David Miller actually merged
- [Project Zero: Exploiting the Linux kernel via packet sockets](https://projectzero.google/2017/05/exploiting-linux-kernel-via-packet.html) — Andrey Konovalov's writeup of CVE-2017-7308
- [Exploit-DB 41994](https://www.exploit-db.com/exploits/41994) and [44654](https://www.exploit-db.com/exploits/44654) — two independently catalogued local-root exploits; 44654 is a Metasploit module
