# The kobject Path Race That Needed a Retry, Not a Lock

> CVE-2023-45863 — `kobject_get_path()` computed a sysfs path's length in one pass and filled the buffer in a second, unsynchronized pass, and a network-interface rename landing between the two passes could grow a name enough to overflow the undersized buffer straight into a heap slab

Disclosed
:   October 14, 2023 (CVE-2023-45863 published on NVD; the bug was found, reported, and fixed months earlier, in December 2022–January 2023 — see below)

Reported by
:   Wang Hai, Huawei (KASAN-based reproduction)

CVSS
:   6.4 MEDIUM (CVSS 3.1, `AV:L/AC:H/PR:H/UI:N/S:U/C:H/I:H/A:H`)

Bug present since
:   at least Linux 2.6.12-rc2 (April 2005, the earliest point in the kernel's git-tracked history) — `kobject_get_path()`'s two-pass length/fill design already existed at the very start of git history

Fixed in
:   commit `3bb2a01caa81`, merged January 11, 2023 — backported to stable as Linux 6.2.3 (March 10, 2023); first reached mainline in Linux 6.3 (April 23, 2023)

Exploit tool
:   no public proof-of-concept found

Actively exploited
:   no confirmed cases (not on CISA KEV)

*Part of [War Stories: Device Drivers](../war-stories.md).*

## Before state

Every uevent the kernel sends to userspace — `add`, `remove`, `change`, `move` — carries a `DEVPATH` field: the device's location in the sysfs tree, such as `/devices/pci0000:00/.../net/eth0`. `udevd`/`systemd-udevd` uses that string, joined with `/sys`, to know exactly which sysfs node an event refers to, so it can read further attributes, apply naming and permission rules, and create the matching `/dev` node. `kobject_get_path()` builds that string by walking a kobject's `parent` chain up to the root, in two separate passes: `get_kobj_path_length()` walks the chain once, summing `strlen(kobject_name(parent)) + 1` for every ancestor to compute the exact buffer size needed; `kobject_get_path()` then allocates a buffer of exactly that size and calls `fill_kobj_path()`, which walks the *same* chain a second time, writing each ancestor's name into the buffer right-to-left. Nothing holds a lock across the two passes — the code trusts that the chain, and every name in it, is unchanged between them.

## The trigger

`ixgbe_probe()`, loading a network driver, registers a child kobject (the NIC's MII bus) via `device_add()`, which needs to build that child's sysfs path for its own `add` uevent. On CPU 0, `get_kobj_path_length()` walks up through the child's parent — the netdev's own kobject, e.g. named `eth0` — and computes a length based on that name. Concurrently, on CPU 1, `systemd-udevd` — reacting to the `add` uevent already sent moments earlier for the netdev itself — issues a rename, for instance applying a persistent-interface-naming rule that changes `eth0` to something longer like `enp3s0f0`. `kobject_rename()` swaps `kobj->name` to point at the new, longer string. Its own doc comment places the burden of synchronization entirely on the caller: "It is the responsibility of the caller to provide mutual exclusion between two different calls of `kobject_rename` on the same kobject." For a network interface, that mutual exclusion comes from the RTNL lock its caller (`dev_change_name()`) already holds — serializing renames against each other, but doing nothing to serialize a rename against an unrelated reader like `get_kobj_path_length()`/`fill_kobj_path()`, which never take RTNL or any other lock at all. If the rename lands between the two passes, `fill_kobj_path()`'s second walk sees the *new*, longer name for that ancestor while working with the length computed from the *old*, shorter one. The commit fixing this diagrams the interleaving directly:

```
cpu0                                         cpu1
ixgbe_probe
 register_netdev(netdev)
  netdev_register_kobject
   device_add
    kobject_uevent // Sending ADD events
                                             systemd-udevd // rename netdev
                                              dev_change_name
                                               device_rename
                                                kobject_rename
 ixgbe_mii_bus_init                             |
  mdiobus_register                              |
   __mdiobus_register                           |
    device_register                             |
     device_add                                 |
      kobject_uevent                            |
       kobject_get_path                         |
        len = get_kobj_path_length // old name  |
        path = kzalloc(len, gfp_mask);          |
                                                kobj->name = name;
                                                /* name length becomes
                                                 * longer
                                                 */
        fill_kobj_path /* kobj path length is
                        * longer than path,
                        * resulting in out of
                        * bounds when filling path
                        */
```

`fill_kobj_path()` had no bound of its own — it trusted the `length` argument it was handed, and blindly subtracted `strlen()` of whatever name each ancestor's `kobject_name()` currently returned, walking off the front of the undersized buffer and `memcpy`-ing past its start.

## Observed behavior

This is a heap buffer overflow with both the write offset and content driven by the renamed interface's new name — a write, not merely a read, past the front of a slab allocation. Wang Hai's KASAN report, from a stress-test loop of `rmmod ixgbe; sleep 0.5; modprobe ixgbe; sleep 0.5`, caught it directly:

```
BUG: KASAN: slab-out-of-bounds in fill_kobj_path+0x50/0xc0
Write of size 7 at addr ff1100090573d1fd by task kworker/28:1/673

 Workqueue: events work_for_cpu_fn
 Call Trace:
 <TASK>
 dump_stack_lvl+0x34/0x48
 print_address_description.constprop.0+0x86/0x1e7
 print_report+0x36/0x4f
 kasan_report+0xad/0x130
 kasan_check_range+0x35/0x1c0
 memcpy+0x39/0x60
 fill_kobj_path+0x50/0xc0
 kobject_get_path+0x5a/0xc0
 kobject_uevent_env+0x140/0x460
 device_add+0x5c7/0x910
 __mdiobus_register+0x14e/0x490
 ixgbe_probe.cold+0x441/0x574 [ixgbe]
 local_pci_probe+0x78/0xc0
 work_for_cpu_fn+0x26/0x40
 process_one_work+0x3b6/0x6a0
 worker_thread+0x368/0x520
 kthread+0x165/0x1a0
 ret_from_fork+0x1f/0x30
```

## Why it happened

`get_kobj_path_length()` and `fill_kobj_path()` were written under an implicit assumption: that a kobject's ancestor chain, and every ancestor's name, would hold still between a length computation and the fill that follows it. That assumption is reasonable for the common case — most kobjects aren't renamed — but nothing in the code enforced it, and a network interface rename triggered by udev's own reaction to the *first* uevent this same probe sequence sent is exactly the kind of concurrent event the two-pass design had no way to account for. The bug required both sides of the race to hold real, but not exotic, privilege: triggering the probe/reload path used in the reproducer needs `CAP_SYS_MODULE` (module load/unload), and issuing an interface rename via rtnetlink or the legacy `SIOCSIFNAME` ioctl needs `CAP_NET_ADMIN` — capabilities `systemd-udevd`, running as root, already holds as a matter of course. When Wang Hai pinged for a merge decision, Greg Kroah-Hartman's reply weighed exactly this: "It's in my 'to review' queue that I am working on. As this is not anything that a normal user can trigger, it's not that high of a priority, right?" — an explicit acknowledgment that the bug's root-only trigger surface shaped how urgently it was treated, not whether it was real.

## Resolution

`3bb2a01caa81` ("kobject: Fix slab-out-of-bounds in fill_kobj_path()", Wang Hai) doesn't add a lock across the two passes — it makes `fill_kobj_path()` bounds-check itself and retry from scratch if the chain moved under it:

```diff
-static void fill_kobj_path(const struct kobject *kobj, char *path, int length)
+static int fill_kobj_path(const struct kobject *kobj, char *path, int length)
 {
 	const struct kobject *parent;
 	--length;
 	for (parent = kobj; parent; parent = parent->parent) {
 		int cur = strlen(kobject_name(parent));
 		length -= cur;
+		if (length <= 0)
+			return -EINVAL;
 		memcpy(path + length, kobject_name(parent), cur);
 		*(path + --length) = '/';
 	}
 	...
+	return 0;
 }

 char *kobject_get_path(const struct kobject *kobj, gfp_t gfp_mask)
 {
+retry:
 	len = get_kobj_path_length(kobj);
 	...
 	path = kzalloc(len, gfp_mask);
 	...
-	fill_kobj_path(kobj, path, len);
+	if (fill_kobj_path(kobj, path, len)) {
+		kfree(path);
+		goto retry;
+	}
 	return path;
 }
```

Every write in `fill_kobj_path()` is now preceded by a check that `length` hasn't gone non-positive; the moment it would, the function bails out with `-EINVAL` instead of writing out of bounds, and `kobject_get_path()` treats that as a signal that the buffer it allocated is stale, frees it, and restarts the whole length-then-fill computation from `retry:`. There is still no lock — a sufficiently persistent stream of renames could in principle retry repeatedly — and a reviewer, Michal Swiatkowski, asked exactly that: "I wonder if there is no case we end up with infinite loop (fill_kobj_path always returning error). Do You know?" Wang Hai's answer: "It should only be possible to have an infinite loop if name or parent keeps changing. The probability of this is extremely low. If necessary, change it to only retry 3 times?" The retry cap was never added to the merged fix — `kobject_get_path()` retries unconditionally on every detected mismatch.

## What it taught us

**A two-pass "measure, then fill" pattern needs either a lock across both passes or a way for the fill pass to detect that the measurement is stale — it cannot simply trust the measurement stayed valid.** Locking wasn't the fix chosen here; a self-checking fill pass that fails cleanly and lets the caller retry achieved the same safety without introducing a new lock into a function already reachable from many contexts.

**A bug's real-world urgency and its correctness are separate questions, and maintainers are explicit about weighing the first without denying the second.** Nothing about `dev->driver`-adjacent bugs being root-only made this one less of a genuine out-of-bounds heap write — it affected how quickly it got reviewed, not whether it needed fixing.

!!! warning "Pattern to watch for"
    Any function that computes a buffer size in one pass and fills that buffer in a separate pass over the same mutable data is only as safe as the assumption that nothing changes in between. If the data can change concurrently and taking a lock across both passes isn't practical, the fill pass needs to detect a stale measurement and fail safely — not trust the number it was handed.

## See also

- [Linux Device Model](../device-model.md) — `struct kobject`, sysfs, and the uevent mechanism this bug lives in
- [The uevent_show() Fix That Deadlocked Driver Detach](uevent-show-deadlock.md) — a different driver-core race, in the same uevent-generation code path, whose deadlock traces back to a lock added to fix an earlier race and was ultimately resolved by removing that lock in favor of RCU
- [Netfilter x_tables Heap Overflow](../../net/war-stories/netfilter-xtables.md) — a comparable heap-overflow-via-unchecked-length bug in a different subsystem

## External references

- [git.kernel.org: 3bb2a01caa81](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=3bb2a01caa813d3a1845d378bbe4169ef280d394) — "kobject: Fix slab-out-of-bounds in fill_kobj_path()," the fix, with the full race diagram and KASAN report in its commit message
- [lore.kernel.org: v2 patch thread](https://lore.kernel.org/r/20221220012143.52141-1-wanghai38@huawei.com/) — Wang Hai's submission and the Michal Swiatkowski / Greg Kroah-Hartman discussion
- [NVD: CVE-2023-45863](https://nvd.nist.gov/vuln/detail/CVE-2023-45863) — CVE record, CVSS 3.1 6.4 MEDIUM, published October 14, 2023
- [Debian LTS advisory DLA-3710-1](https://lists.debian.org/debian-lts-announce/2024/01/msg00004.html) — independent description of the flaw
