# PwnEscape: A Guest-to-Host Memory Leak via IPv4 Checksum Offload

> CVE-2026-99999 — a guest's own checksum-offload metadata, taken at face value by the host's network stack, lets it mutate an IPv4 header the host had already finished with and leak host memory back out through the packet

Disclosed
:   Initial bounded disclosure 2026-08-20; root cause and candidate patch reported privately to kernel security/netdev maintainers 2026-09-04; CVE published 2026-10-15 (oss-security forward of the PWNAI Research write-up)

Reported / found by
:   Paulos Yibelo (PWNAI Research / pwn.ai), during Vercel's "$1 Million Sandbox Challenge" (announced 2026-08-18) — the finding arrived on day three of the two-week program

CVSS
:   9.3 CRITICAL (NVD, `CVSS:3.1/AV:L/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H`) · CWE-20 (Improper Input Validation)

Fixed in
:   mainline 7.3 (commit `6785011f8b16`, authored and accepted into `net.git` 2026-10-07/08, merged via the `net-7.3-rc7` pull 2026-10-14); backported same-day to seven stable branches as separate commits

Exploit tool
:   not published — pwn.ai's write-up withholds the memory-allocation-control and host-write mechanics for an unpublished "Part 2"

Actively exploited
:   no confirmed cases; the published disclosure demonstrates a host-memory leak against Vercel's own production sandboxes, but the further host-write and root-execution chain was shown only on the researcher's own lab machines, not in production

*Part of [War Stories: Network Stack Bugs and CVEs](../war-stories.md).*

## What happened

A security researcher taking part in a public bug-bounty challenge found that a virtual machine's guest could hand the host's network stack a packet with self-contradictory metadata — correct enough to pass the checks the kernel already runs, but able to rewrite part of the packet's own header *after* those checks had already relied on it being well-formed.

The rewrite could turn a 20-byte IPv4 header into one the kernel believed was 60 bytes long. The 32 bytes of "header" that didn't actually exist got filled in from whatever host memory happened to sit next to the packet — which then went out over the network, to the guest that asked for it.

The bug itself isn't inside KVM, Firecracker, or any hypervisor's own code. It's in ordinary IPv4 packet handling that every Linux host runs regardless of virtualization; what makes it a guest-to-host issue is where that packet metadata comes from.

A VM's network traffic doesn't travel over a real wire — the guest's virtual NIC (`virtio-net`) hands its packets to the host through a `tun`/`tap` device, prefixed with a small `virtio_net_hdr` struct that *the guest itself fills in*, including the checksum-offload fields this bug depends on:

```
┌──────────────────────┐          ┌───────────────────────────────────┐
│ Guest VM             │          │ Host kernel                       │
│                      │          │                                   │
│ app sends a packet   │  virtio  │ tun/tap receives it,              │
│ virtio-net driver    │  ring ▶  │ reads the guest-supplied          │
│ attaches a           │          │ virtio_net_hdr (csum_start,       │
│ virtio_net_hdr it    │          │ csum_offset, ...) and later       │
│ fills in itself      │          │ completes the checksum using      │
│                      │          │ those guest-chosen values         │
└──────────────────────┘          └───────────────────────────────────┘
```

Nothing about this path is unusual or misconfigured — it's exactly how virtio-net is supposed to work, letting a guest offload checksum work the way real NIC hardware would. The bug is that once that metadata reaches ordinary IPv4 code deep in the host, nothing re-checks it against what a hostile sender might supply.

## How the code was vulnerable

Linux lets a sender defer a packet's checksum to be filled in later, rather than computing it up front — `CHECKSUM_PARTIAL`. The sender (or, for virtual networking, the guest) supplies two offsets: `csum_start`, where the checksum calculation should begin, and `csum_offset`, where the finished 2-byte result should be written, relative to `csum_start`.

`skb_checksum_help()` is what actually does this later, and — checked against `net/core/dev.c` at the pre-fix `v7.3-rc6`-era tag — its own bounds checking only looks at whether the write stays inside the packet's linear data, never at whether `csum_start` is far enough *into* the packet to land after the IPv4 header it's about to still be read as:

```c
offset = skb_checksum_start_offset(skb);
ret = -EINVAL;
if (unlikely(offset >= skb_headlen(skb))) {
    /* ...bails out... */
}
csum = skb_checksum(skb, offset, skb->len - offset, 0);

offset += skb->csum_offset;
if (unlikely(offset + sizeof(__sum16) > skb_headlen(skb))) {
    /* ...bails out... */
}
ret = skb_ensure_writable(skb, offset + sizeof(__sum16));
if (ret)
    goto out;

*(__sum16 *)(skb->data + offset) = csum_fold(csum) ?: CSUM_MANGLED_0;
```

Both checks only bound the write from *above* (it can't run past the end of the linear data) — neither one stops `csum_start` from pointing *inside* the IPv4 header itself, well before where a real transport-layer checksum would ever start.

If an attacker picks `csum_offset` so the 2-byte write lands on the header's first byte — where IP packs the 4-bit version and 4-bit IHL (header-length) fields together — the computed checksum's low nibble becomes the new IHL, attacker-chosen, up to its maximum value of 15 (a claimed 60-byte header instead of the real 20).

The second half of the bug is pure ordering. `ip_do_fragment()` — checked against `net/ipv4/ip_output.c` at the same tag — calls `skb_checksum_help()` *before* it reads the header it's about to fragment:

```c
/* for offloaded checksums cleanup checksum before fragmentation */
if (skb->ip_summed == CHECKSUM_PARTIAL) {
    err = skb_checksum_help(skb);   /* pre-fix: no validation of csum_start here */
    if (err)
        goto fail;
}

/* Point into the IP datagram header. */
iph = ip_hdr(skb);
...
hlen = iph->ihl * 4;
```

By the time `hlen` is computed, the checksum write has already run — so if it corrupted `iph->ihl`, `ip_do_fragment()` trusts the corrupted value for how much "header" to copy into the first fragment.

Per the disclosure, the packet's real linear data ran out at 28 bytes; told the header was 60, the fragmenting code copied 32 bytes past the end of what the packet actually contained — and whatever host memory happened to sit there went out as spurious IP options in the emitted packet.

The packet before the attacker's write — 28 real bytes, a normal 20-byte header plus 8 bytes of payload:

```
┌───────────────────────────┬──────────┐
│     IP header (IHL=5)     │ payload  │
│         20 bytes          │ 8 bytes  │
└───────────────────────────┴──────────┘
0                           20         28
```

`skb_checksum_help()` writes its 2-byte checksum at byte 0 — landing on the IHL field itself — and `ip_do_fragment()` reads the result back as the new header length. Nothing else in the packet changed; only that one field did:

```
┌───────────────────────────┬──────────┬───────────────────────┐
│    IP header (IHL=15!)    │ payload  │ 32B: NOT this packet  │
│         20 bytes          │ 8 bytes  │ adjacent host memory  │
└───────────────────────────┴──────────┴───────────────────────┘
0                           20         28                      60
```

`ip_do_fragment()` treats the whole 0–60 range as "header" and copies all of it into the fragment. Bytes 0–27 are real; bytes 28–59 are just whatever happened to be sitting in host memory next to the packet — and they go out over the network as if they were IP header options.

`skb_checksum_help()` isn't only reachable from `ip_do_fragment()` — the same missing check applied to four other call sites the fix touches: netfilter's `CHECKSUM` target, `nfnetlink_queue`, bridge connection tracking, and IPsec output. Any of them completing a checksum on attacker-steered metadata hits the same gap; `ip_do_fragment()` is simply the one the published disclosure walks through in detail.

The two kernel features that hand a guest this kind of control over `csum_start`/`csum_offset` in the first place substantially predate the bug: `tun`'s `IFF_VNET_HDR` support, letting a `tun`/`tap` device accept a `virtio_net_hdr` prefix carrying GSO and checksum metadata, landed in 2008 (commit [`f43798c2`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=f43798c27684764ad7bc3d16a59ff01bf2a8e21e), "tun: Allow GSO using virtio_net_hdr"); `af_packet`'s equivalent `PACKET_VNET_HDR` socket option followed in 2010 (commit [`bfd5f4a3`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=bfd5f4a3d6058fb059f194ac4350db080899896f), "packet: Add GSO/csum offload support.").

Neither commit is at fault — `virtio_net_hdr` is the normal, documented way a guest's virtio-net device hands checksum-offload metadata to the host, exactly as a real NIC's hardware offload would; the gap is in how the host's general-purpose checksum completion trusted that metadata once it arrived, nearly two decades of kernel history later.

## The leak

Paulos Yibelo's write-up (pwn.ai) frames the bug as a logical out-of-bounds read, triggered without any race or timing dependency — a single crafted packet, with checksum metadata chosen to overwrite the IHL field, is enough on its own.

The disclosure reports 32 bytes of host memory leaked per occurrence, continuously, for as long as the guest keeps sending — and demonstrates this against Vercel's actual production sandbox fleet, not only a lab setup.

The write-up explicitly does not publish what comes after the leak. It describes achieving "selected 64-byte host-kernel writes" and running a host-root helper across four cold boots — but only on the researcher's own disposable KVM/Firecracker machines, configured to match Vercel's setup, never against production.

The allocator-control technique that turns a repeatable 32-byte leak into a controlled write, and the mechanics of the write and execution steps themselves, are deliberately withheld for a follow-up ("Part 2") that hadn't been published as of this page's sources. Treat the leak itself as demonstrated and the host-write/code-execution chain as reported, not independently verified here.

Yibelo's own post is careful to separate two different claims that press coverage tended to blur: *escaping a sandbox's network isolation* (what the disclosed leak does) and *escaping a VM to the underlying host* (what the lab-only write/execution chain claims to do).

The bug itself lives in ordinary host IPv4 code — not inside KVM, Firecracker, or any other hypervisor's own implementation — a point Edera's Alex Zenla made to CSO Online in the same terms: *"When a guest breaks out, it isn't escaping into some neatly contained hypervisor."* "KVM escape" and "VM escape," as used in coverage of this bug, name the trust boundary the researchers crossed in their own lab, not the component that actually contained the flaw.

## What this means for you

The published disclosure is specifically about one scenario: code running inside a VM attacking the machine hosting it. But the kernel's actual fix doesn't patch "the VM path" — it patches the shared, generic code those VM packets happen to flow through, and that same code has another, ordinary way in that has nothing to do with virtualization. The two meet at the same vulnerable function:

```
┌──────────────────────────┐      ┌──────────────────────────┐
│ Scenario A               │      │ Scenario B               │
│                          │      │                          │
│ Code inside a VM         │      │ An unprivileged          │
│ guest (e.g. a cloud      │      │ process on the SAME      │
│ tenant's workload)       │      │ machine, in its own      │
│                          │      │ user+network             │
│ via virtio-net/tun       │      │ namespace                │
└──────────────────────────┘      └──────────────────────────┘
             │                                │               
             └───────────────┬────────────────┘               
                             ▼                                
┌────────────────────────────────────────────────────────────┐
│    Host kernel's generic IPv4 checksum-completion code     │
│       (ip_do_fragment, netfilter CHECKSUM, nfqueue,        │
│            bridge conntrack, xfrm/IPsec output)            │
└────────────────────────────────────────────────────────────┘
                             │                                
                             ▼                                
             leaks or corrupts host-kernel memory
```

"Leaks host-kernel memory" is itself doing a lot of work in that sentence, and most of the public coverage stops right there, at the packet-mechanics level, without saying what that actually gets anyone. Two separate things are at stake, and they fail differently:

**The confidentiality side** is a numbers game, not a precision tool. Those 32 bytes aren't *anything in particular* — they're whatever the kernel happened to have sitting in memory near the packet at that moment, which could be nothing useful, or could be a fragment of another connection's buffered data, a piece of something the kernel was caching, or (on a shared host) a scrap belonging to a completely different customer's traffic.

One leak tells an attacker almost nothing. But the bug is repeatable for as long as the sender keeps sending — Vercel's own description is that this "can happen continuously" — so the real exposure isn't one 32-byte peek, it's an attacker who can request that peek as many times as they want and sift through everything that comes back.

That's the same shape of risk [Heartbleed](https://en.wikipedia.org/wiki/Heartbleed) made famous: no single request leaks a password, but an attacker who can ask millions of times eventually finds something worth having.

**The availability side is blunter and needs no sifting at all.** Vercel's own account of the lab-only crash finding says two crafted packets took down the host — and a host, in a virtualized or sandboxed setup, isn't one customer's machine, it's the physical machine underneath *everyone's* machine on it.

Crashing it doesn't just end the attacker's own session; Vercel's description is that it "shut down every sandbox running on it." That's the part of the official severity score (`A:H`, availability: high, in the CVSS vector cited earlier) that a reader skimming "leaks host memory" would miss entirely: this isn't only a quiet information leak, it's also a way to take an entire shared machine offline, for every tenant on it, with two packets.

The unpublished "Part 2" — host-kernel writes and root execution, demonstrated only in the researchers' own lab — would be the serious escalation past both of those: not reading scraps of memory or crashing the box, but running arbitrary code with the host's own privileges, at which point every other VM or sandbox sharing that machine is exposed to whatever the attacker chooses to do next, not just inconvenienced by an outage.

That step is reported, not demonstrated publicly, and this page treats it that way rather than as an established fact — but it's the reason this got a 9.3 CRITICAL score rather than a quiet, routine hardening patch.

Scenario B is *not* a second vulnerability. It's the same bug, closed by the same commit, the same day — the fix touches five call sites, and only one of them (`ip_do_fragment`, reached via `tun`) is specific to the VM story that made headlines.

`af_packet`'s own `PACKET_VNET_HDR` option (added in 2010, the same mechanism, modeled directly on `tun`'s) lets any process with `CAP_NET_RAW` hand the kernel the same kind of attacker-controlled metadata, with no VM involved at all — confirmed in the actual `net/packet/af_packet.c` source. And `CAP_NET_RAW` is checked against the network namespace's *own* user namespace (`ns_capable(net->user_ns, CAP_NET_RAW)`, also checked directly in source) — a capability any unprivileged process can get for itself, on a system where unprivileged user namespaces are allowed, by creating one.

That's not new or specific to this bug either; it's the same mechanism behind the older CVE-2017-1000111, and the exact "capabilities routinely granted to unprivileged processes inside user namespaces" theme this page's own index already calls out across other incidents in this collection. Nobody in the public write-ups tested or claimed Scenario B specifically — it's this page's own reading of what the fix's scope implies, not a second finding, and it's already fixed, not a live gap.

What it does change is who should care, and why:

**If Linux is just your development machine, with no VMs involved.** Scenario B is the relevant one, and it needs a process already running on your machine as some user — nothing here is reachable by a remote attacker with no foothold at all, a malicious website, or an email attachment on its own (NVD scores this `AV:L`, local, not `AV:N`).

What it does mean: if you ever run code you don't fully trust locally — an untrusted package's install script, a downloaded binary, a CI job building someone else's PR — that code gets one more way to read fragments of kernel memory it has no business seeing, on top of whatever else an unprivileged process could already attempt.

The fix is the same as for any kernel bug: keep your distro's kernel updated. Mainline picked it up October 14, 2026; it's backported to the 5.10, 5.15, 6.1, 6.6, 6.12, 6.18, and 7.2 stable series, so an ordinary kernel update once your distro ships one covers it.

**If you host Linux VMs yourself — a PC, a Mac, a home server.** This is where it matters whether the thing directly underneath your VM is a Linux kernel.

Run KVM, QEMU, VirtualBox, or libvirt on a Linux machine, and that host kernel is exactly what this bug describes — any VM guest you run, including a prebuilt image you downloaded rather than built yourself (a CTF challenge VM, a vendor appliance, a "run this suspicious file in a sandboxed VM" workflow), gets Scenario A against your own host if your kernel predates the fix.

If your host OS is macOS or Windows, that specific host-side code isn't in Darwin or NT's kernel at all, so this bug doesn't describe your host directly — though whatever Linux kernel is running one layer in (inside a VM, inside WSL2, inside whatever VM a container tool manages for you) is still an ordinary Linux kernel subject to Scenario B on its own terms, and still worth keeping patched. The practical check is simple: whatever is the *nearest* Linux kernel underneath whatever you're running, is it updated past October 2026?

**If you run production services on Linux VMs in the cloud.** Two different cases, depending on who operates the hypervisor underneath you.

If you're a customer of a fully-managed service — serverless compute, managed VMs, a platform like Vercel's Sandbox — the provider owns the host kernel, not you. Vercel has already stated its managed sandbox fleet is patched, and the same logic holds generally: a fully-managed provider patches its own hosts, so there's nothing for you to do beyond normal patching inside your own VM.

If instead *you* operate your own KVM or Firecracker infrastructure — your own multi-tenant platform, your own sandboxing product, self-managed virtualization on rented bare metal — you're the host operator, in exactly the same position as the "host Linux VMs yourself" case above, just at larger scale: patch the hosts, not just the guests, since updating a guest's kernel does nothing for a host that's still vulnerable underneath it.

## How it was found

Yibelo's write-up credits the discovery to a research campaign — the "Omega-Pwn" harness paired with an AI model ("GPT-5.6 Sol") for source-level analysis, under human direction — reaching the underlying primitive in about three days.

The write-up doesn't claim the AI found or exploited the bug unassisted; as with this collection's other AI-assisted finds, the human researcher directed the search and did the verification.

The reported timeline, from the write-up and its oss-security forward:

2026-08-18
:   Vercel announces the $1M Sandbox Challenge

2026-08-20
:   Initial bounded host-memory-leak report submitted

2026-09-04
:   Root cause and candidate patch reported privately to kernel security/netdev maintainers

2026-09-07
:   Michael S. Tsirkin reproduces the issue, acknowledges the patch

2026-09-19 to 2026-09-22
:   Patch posted and revised on netdev in the open

2026-10-07 to 2026-10-08
:   Revised patch accepted into `net.git`

2026-10-13 to 2026-10-14
:   Stable backports and CVE coordination; merged to mainline

2026-10-15
:   CVE-2026-99999 published; disclosure forwarded to oss-security

The fix's own `Closes:` tag points to a [netdev posting](https://lore.kernel.org/netdev/20260922030310.8684-2-habte.yibelo@gmail.com/) from Yibelo dated September 22 — consistent with the write-up's account of the patch moving from a private report in early September to ordinary public review on netdev by late September, a routine path once a fix is just a hardening patch under normal review rather than something needing a continued embargo.

## The impact

What's demonstrated, and where: a continuous 32-byte host-memory leak into attacker-visible network traffic, shown against Vercel's production sandbox fleet.

What's *reported but not independently verifiable from public sources*: a chain from that leak to controlled host-kernel writes and root code execution, demonstrated by the researchers only on their own disposable lab machines built to match Vercel's configuration — across four cold boots, with the technique that makes it reliable (allocator control) explicitly withheld.

Vercel's own account of the finding states that no reports showed anyone accessing customer data, and distinguishes the memory-leak finding (shown in production) from the crash and code-execution findings (shown only on the researchers' own matching hardware).

Because the vulnerable code is generic IPv4 handling, not anything KVM- or Firecracker-specific, the exposure isn't limited to Vercel.

Industry guidance converged on the same split described above: self-managed KVM hosts using `virtio-net`/TAP networking needed a kernel update, while fully-managed, provider-operated VM and serverless platforms generally didn't need customer action, since the provider patches the host kernel directly. Several enterprise container platforms built on KVM were also listed among affected components by their vendors.

## How it was fixed

The fix, commit [`6785011f8b16`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=6785011f8b16abf40b1e9d8b2e332232b3e68822) ("ipv4: validate checksum_start before completing checksum," Michael S. Tsirkin, Red Hat), adds a new helper to `include/net/ip.h`:

```c
static inline int ip_check_csum_start(const struct sk_buff *skb)
{
    if (unlikely(skb->csum_start < skb->network_header + ip_hdrlen(skb)))
        return -EINVAL;
    return 0;
}
```

— and calls it immediately before `skb_checksum_help()` at every IPv4 site the fix touches: `ip_do_fragment()`, bridge netfilter's connection-tracking fragmentation path, `nfnetlink_queue`'s checksum-help path, the `CHECKSUM` netfilter target, and IPsec's `xfrm_output()`.

Each site now refuses to complete the checksum at all if `csum_start` doesn't point at or after the end of the IPv4 header — closing off the specific corruption this disclosure used, without changing how legitimate deferred checksums behave.

The commit message is explicit that this is a defense-in-depth patch, not a full redesign of how the kernel trusts checksum-offload metadata from an untrusted source: *"We really shouldn't allow such packets in, but as a defence in depth measure, let's also check before we complete the checksum. A more complete validation at input is forthcoming, but needs more work."*

Reviewed by Willem de Bruijn (Google); authored and accepted into `net.git` October 7–8, 2026; merged to mainline October 14 via the `net-7.3-rc7` pull.

The same day it landed upstream, it was backported as seven separate stable commits; public reporting lists the covered branches as 5.10, 5.15, 6.1, 6.6, 6.12, 6.18, and 7.2, though this page hasn't independently confirmed which of the seven published stable-tree commit hashes maps to which branch.

## What it taught us

**Checksum-offload metadata from a guest is attacker input, not trusted hardware state, and the code path treating it that way was nearly two decades old.** `virtio_net_hdr` exists to let a guest's paravirtualized NIC describe offload work the way real hardware would — but real hardware doesn't get to overwrite the header fields the kernel is about to make routing and fragmentation decisions on. The gap wasn't that `tun` or `af_packet` did anything wrong in 2008 or 2010; it's that the general-purpose checksum-completion code they both feed into never added the one check that matters once its input can come from something less trustworthy than the local machine.

**Validate position, not just extent.** `skb_checksum_help()`'s existing checks were about *not overrunning* the packet — a real and necessary check, just not the one this bug needed. Nothing stopped the write from landing too *early*, inside a region the caller still needed to trust. A bounds check that only looks at one end of a range can still leave the other end wide open.

**A fix can be explicit about not being finished.** The patch that shipped doesn't claim to solve attacker-controlled checksum offload in general — its own commit message says fuller input-side validation is still pending. Landing the narrow, well-understood defense-in-depth check now, while saying plainly what's still open, is a reasonable way to ship a partial fix under real time pressure.

**Public disclosure can be real and incomplete at the same time.** The published write-up demonstrates a genuine, reproducible host-memory leak against production infrastructure, and is equally explicit about which further claims — host writes, root execution — it is *not* backing with public evidence. Both halves matter: the demonstrated leak is a real bug with a real fix, and the undemonstrated escalation chain is not yet something anyone outside the research team can verify.

!!! warning "Pattern to watch for"
    Any deferred or offloaded operation that writes into a buffer based on an offset supplied by the sender — a checksum, a length field, an alignment pad — needs that offset validated against the structure it's about to be read back as, not just against the buffer's own bounds. This applies most sharply wherever the sender can be a guest, a container, or any other principal less trusted than the code doing the deferred work; a check that was safe when every caller was local kernel code doesn't stay safe once an external party controls the inputs.

## See also

- [sk_buff: The Kernel's Packet Representation](../sk-buff.md) — `csum_start`, `csum_offset`, and `CHECKSUM_PARTIAL` in context
- [Container Networking](../container-networking.md) — `tun`/`tap` devices and the virtualized-networking path this bug reaches through
- [The net/sched act_api Filter-Delete Race](act-api-uaf.md) — another bug in this collection whose discovery process involved AI-assisted analysis

## External references

- [git.kernel.org: 6785011f8b16](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=6785011f8b16abf40b1e9d8b2e332232b3e68822) — the fix, "ipv4: validate checksum_start before completing checksum"
- [git.kernel.org: f43798c27684](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=f43798c27684764ad7bc3d16a59ff01bf2a8e21e) — "tun: Allow GSO using virtio_net_hdr" (2008), one of two `Fixes:` targets
- [git.kernel.org: bfd5f4a3d605](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=bfd5f4a3d6058fb059f194ac4350db080899896f) — "packet: Add GSO/csum offload support." (2010), the other `Fixes:` target
- [lore.kernel.org: Yibelo's netdev posting](https://lore.kernel.org/netdev/20260922030310.8684-2-habte.yibelo@gmail.com/) — the `Closes:` link on the fix commit
- [NVD: CVE-2026-99999](https://nvd.nist.gov/vuln/detail/CVE-2026-99999) — CVSS 9.3 (`AV:L/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H`), CWE-20
- [pwn.ai: PwnEscape](https://pwn.ai/blog/pwnescape) — Paulos Yibelo's own write-up; withholds the host-write/execution chain for a planned Part 2
- [Vercel: Findings from the $1 Million Vercel Sandbox Challenge](https://vercel.com/blog/findings-from-the-1-million-dollar-vercel-sandbox-challenge) — Vercel's own account, including which parts were demonstrated in production versus researcher-owned hardware
- [oss-security: forward of the PWNAI Research write-up](http://www.openwall.com/lists/oss-security/2026/10/15/5) — Jan Schaumann's public disclosure forward
- [CSO Online: Linux kernel gets a fix for a flaw that enabled attackers to escape VMs](https://www.csoonline.com/article/4236460/linux-kernel-gets-a-fix-for-a-flaw-that-enabled-attackers-to-escape-vms.html) — Lucian Constantin's coverage
- [CSO Online: KVM escape exposes broader attack surface in Linux networking](https://www.csoonline.com/article/4237999/kvm-escape-exposes-broader-attack-surface-in-linux-networking.html) — follow-up coverage, including cloud-provider patching guidance and Alex Zenla's (Edera) comment on the VM-escape framing
