# The uevent_show() Fix That Deadlocked Driver Detach

> CVE-2024-44952 (rejected) — a 2024 fix for a real `dev->driver` NULL-pointer race added `device_lock()` to a sysfs read path, recreating a deadlock that lockdep couldn't see because `device_lock()` deliberately opts out of its cycle detector, and only a subsystem with its own local lockdep key for the device mutex ever caught it

Disclosed
:   September 4, 2024 (CVE-2024-44952 published by the "Linux" CNA; later rejected — see below)

Reported by
:   syzbot (fuzzer-found); root-caused by Tetsuo Handa

CVSS
:   5.5 MEDIUM (CVSS 3.1, `AV:L/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:H` — an NVD-computed score, briefly visible before rejection; not present in the current NVD record)

Bug present since
:   commit `c0a40097f0bc`, May–June 2024, first shipped in Linux 6.10

Fixed in
:   commit `15fffc6a5624`, July 2024, first shipped in Linux 6.11

CVE status
:   Rejected by the assigning "Linux" CNA on November 9, 2024 — the rejection record gives only boilerplate ("withdrawn by its CVE Numbering Authority"), no bug-specific rationale

Exploit tool
:   none; the impact is a kernel deadlock (denial of service), not memory corruption or code execution

Actively exploited
:   no confirmed cases (not on CISA KEV)

*Part of [War Stories: Device Drivers](../war-stories.md).*

## Before state

`device_lock()` — a wrapper around `dev->mutex` — protects a device's core state, including the `dev->driver` pointer that records which driver (if any) currently owns the device. It's acquired in many different orderings across the driver core, sysfs, and individual bus/subsystem code, and by the kernel's own admission it is not amenable to lockdep's ordinary cycle detection: `dev->mutex` is initialized with `lockdep_set_novalidate_class()`, which tells lockdep to skip its usual acquisition-order bookkeeping for this lock entirely. Most `device_lock()`-related lock-ordering problems are therefore invisible to lockdep by design — unless a subsystem allocates its own explicit local lockdep key for a specific device's mutex, opting that one device class back into validation. CXL's ACPI driver code does exactly that for the platform device it binds to (`device_lock_set_class(&pdev->dev, &cxl_root_key)` in `drivers/cxl/acpi.c`), which is the only reason the deadlock in this story ever produced a lockdep splat instead of an unexplained hang.

`uevent_show()` is the sysfs read handler backing a device's `uevent` attribute; it calls into `dev_uevent()`, which builds the same key=value environment (`DEVPATH=`, `DEVTYPE=`, and so on) sent to userspace over the kernel's uevent netlink socket, including `DRIVER=%s` sourced from `dev->driver->name` when a driver is bound. `dev->driver` itself is written in two places that matter here: `really_probe()` sets it when a probe succeeds and clears it back to `NULL` via `device_unbind_cleanup()` when a probe fails, and `device_release_driver_internal()` clears it on ordinary driver detach — both under `device_lock()`.

## The trigger

Reading `dev->driver` without holding `device_lock()` was a real, live bug: `dev_uevent()` checked `if (dev->driver)` and then dereferenced `dev->driver->name` with no synchronization, so a concurrent failed-probe cleanup on another CPU could clear `dev->driver` to `NULL` between the check and the dereference. `c0a40097f0bc` ("drivers: core: synchronize really_probe() and dev_uevent()", Dirk Behme, May 2024) fixed this the direct way: wrap the call into `dev_uevent()` from `uevent_show()` with `device_lock()`/`device_unlock()`, matching the lock `really_probe()` already held around its own writes. The commit message notes this exact class of race had been reported once before, in 2015, and never fixed then. It also references an open syzbot report for a related-looking NULL dereference on the *initialization* side (`dev->driver = drv`, which only ever transitions `NULL` → non-`NULL`) and says that report "can be considered to be false-positives" but should be incidentally fixed by the same change.

What the commit message does not mention, and apparently nobody checking it caught, is that `device_lock()` was already being taken in `uevent_show()`'s call stack from the *other* direction: driver removal. `device_release_driver_internal()` — called via `driver_detach()` when a module is unloaded — holds `device_lock()` across a call to `device_del()`, which in turn calls `kernfs_remove_by_name_ns()` to delete the device's sysfs entries, including its own `uevent` attribute file. Deleting a kernfs node has to wait for any in-flight read of that node to finish; an in-flight read of the `uevent` attribute is exactly `uevent_show()` — now itself waiting to acquire the very `device_lock()` that driver detach is holding while it waits for that read to complete.

## Observed behavior

The result is a classic AB-BA deadlock between a device's `device_lock()` and kernfs's internal per-node `kn->active` reference count, caught via a CXL hardware reproducer and a lockdep splat (`Tainted: G OE N`, kernel `6.10.0-rc7+`):

```
======================================================
WARNING: possible circular locking dependency detected
6.10.0-rc7+ #275 Tainted: G           OE    N
------------------------------------------------------
modprobe/2374 is trying to acquire lock:
ffff8c2270070de0 (kn->active#6){++++}-{0:0}, at: __kernfs_remove+0xde/0x220

but task is already holding lock:
ffff8c22016e88f8 (&cxl_root_key){+.+.}-{3:3}, at: device_release_driver_internal+0x39/0x210

which lock already depends on the new lock.

the existing dependency chain (in reverse order) is:

-> #1 (&cxl_root_key){+.+.}-{3:3}:
       __mutex_lock+0x99/0xc30
       uevent_show+0xac/0x130
       dev_attr_show+0x18/0x40
       sysfs_kf_seq_show+0xac/0xf0
       seq_read_iter+0x110/0x450
       vfs_read+0x25b/0x340
       ksys_read+0x67/0xf0
       do_syscall_64+0x75/0x190
       entry_SYSCALL_64_after_hwframe+0x76/0x7e

-> #0 (kn->active#6){++++}-{0:0}:
       __lock_acquire+0x121a/0x1fa0
       lock_acquire+0xd6/0x2e0
       kernfs_drain+0x1e9/0x200
       __kernfs_remove+0xde/0x220
       kernfs_remove_by_name_ns+0x5e/0xa0
       device_del+0x168/0x410
       device_unregister+0x13/0x60
       devres_release_all+0xb8/0x110
       device_unbind_cleanup+0xe/0x70
       device_release_driver_internal+0x1c7/0x210
       driver_detach+0x47/0x90
       bus_remove_driver+0x6c/0xf0
       cxl_acpi_exit+0xc/0x11 [cxl_acpi]
       __do_sys_delete_module.isra.0+0x181/0x260
       do_syscall_64+0x75/0x190
       entry_SYSCALL_64_after_hwframe+0x76/0x7e
```

`cxl_root_key` is a local lockdep key CXL assigns to its root device's mutex specifically so lockdep can reason about it — an opt-in that most of the driver core doesn't take, because `dev->mutex` carries `lockdep_set_novalidate_class()` precisely on account of how inconsistently `device_lock()` is ordered against other locks across the tree. Without that local key, this exact deadlock shape would have been just as real on any other device class, silently absent from lockdep's dependency graph, and reproducible only as an unexplained hang under `rmmod`.

## Why it happened

Two independently reasonable fixes collided. `really_probe()` already held `device_lock()` when it wrote `dev->driver`; adding `device_lock()` to the one unsynchronized reader was the natural, narrowly-scoped fix for a real NULL-pointer race, and it's the kind of change a reviewer checking "does this fix the race being described" would approve without needing to re-derive every other caller already holding that lock elsewhere in the call stack. `device_release_driver_internal()`'s use of `device_lock()` across `device_del()` long predates this change and is unrelated in purpose — driver detach needs the lock to keep the device's driver-binding state consistent while it tears the device down. Neither commit's author was wrong about their own fix in isolation; the deadlock lives entirely in the interaction between the two, mediated by kernfs's own internal wait-for-readers logic during node removal — a dependency `device_lock()`'s novalidate status meant nobody could rely on lockdep to surface automatically.

## Resolution

`15fffc6a5624` ("driver core: Fix uevent_show() vs driver detach race", Dan Williams, July 2024) removes `device_lock()`/`device_unlock()` from `uevent_show()` entirely and replaces the locked read with an RCU-protected one. `dev_uevent()` now reads the driver pointer under `rcu_read_lock()` with `READ_ONCE()`:

```c
 static int dev_uevent(const struct kobject *kobj, struct kobj_uevent_env *env)
 {
 	const struct device *dev = kobj_to_dev(kobj);
+	struct device_driver *driver;
 	int retval = 0;
 	...
-	if (dev->driver)
-		add_uevent_var(env, "DRIVER=%s", dev->driver->name);
+	/* Synchronize with module_remove_driver() */
+	rcu_read_lock();
+	driver = READ_ONCE(dev->driver);
+	if (driver)
+		add_uevent_var(env, "DRIVER=%s", driver->name);
+	rcu_read_unlock();
```

and `uevent_show()` drops the `device_lock()`/`device_unlock()` pair around the call entirely. The write side gets a matching `synchronize_rcu()` in `module_remove_driver()`, which runs during driver/module teardown, ensuring any in-flight RCU-protected reader of `dev->driver` has finished before the driver object itself can go away:

```c
 void module_remove_driver(const struct device_driver *drv)
 {
 	if (!drv)
 		return;
 
+	/* Synchronize with dev_uevent() */
+	synchronize_rcu();
+
 	sysfs_remove_link(&drv->p->kobj, "module");
```

This preserves the original fix's goal — no reader can observe a torn or freed `dev->driver` — without ever taking `device_lock()` from the sysfs read path, so the AB-BA ordering against driver detach's kernfs removal simply no longer exists. The commit's own rationale is pragmatic about the cost: driver objects are long-lived and unregistered rarely, so paying `synchronize_rcu()`'s latency once per module removal is an acceptable trade for making an infrequent, narrow race safe without a lock.

## What it taught us

**A lock that's exempted from lockdep validation doesn't stop being capable of deadlocking — it stops being able to tell you about it.** `device_lock()`'s `lockdep_set_novalidate_class()` exists because the lock is used too inconsistently across the driver core for generic cycle detection to avoid false positives, but that tradeoff means a real new deadlock introduced anywhere in that inconsistent usage is invisible by default. This one only surfaced because CXL's driver code had independently opted its own device class back into validation with a local lockdep key — most of the driver core carries no such key, and the same defect shape elsewhere would present only as an unexplained hang.

**Fixing a race by adding a lock is only safe if you know everything else that already holds that lock in the surrounding call graph.** The 2024 NULL-pointer fix was correct about the race it targeted and wrong about being lock-free-safe to apply, because `device_lock()` was already load-bearing on a completely different call path — driver detach — that the fix's author had no obvious reason to go looking for.

!!! warning "Pattern to watch for"
    Before adding a lock acquisition to fix a data race, check not just what already holds that lock on the path you're fixing, but what *else*, elsewhere in the codebase, holds it across a call into code your new acquisition might now be reached from — especially for a lock like `device_lock()` that's deliberately exempted from automated cycle detection. A local lockdep key scoped to just your own subsystem is one way to get real signal on a lock the driver core itself can't validate for you.

## See also

- [Linux Device Model](../device-model.md) — `struct device`, `device_lock()`, and the driver core's probe/detach machinery this bug lives in
- [The kobject Path Race That Needed a Retry, Not a Lock](kobject-path-race.md) — a different driver-core race, also in a sysfs-adjacent path, fixed without adding a new lock
- [The Deadlock Detector That Scheduled While Atomic](../../locking/war-stories/rtmutex-deadlock-detector-atomic-sleep.md) — a different subsystem's lock-discipline bug, and the mirror opposite of this one in visibility: that bug triggered a loud "scheduling while atomic" splat on any production kernel, where this one stayed invisible without a subsystem-local lockdep key

## External references

- [git.kernel.org: c0a40097f0bc](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=c0a40097f0bc81deafc15f9195d1fb54595cd6d0) — "drivers: core: synchronize really_probe() and dev_uevent()," the fix that introduced the deadlock while fixing a real NULL-pointer race
- [git.kernel.org: 15fffc6a5624](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=15fffc6a5624b13b428bb1c6e9088e32a55eb82c) — "driver core: Fix uevent_show() vs driver detach race," the RCU-based fix, with the full lockdep splat in its commit message
- [NVD: CVE-2024-44952](https://nvd.nist.gov/vuln/detail/CVE-2024-44952) — current record, showing rejected status
- [Wayback Machine: NVD CVE-2024-44952, October 22, 2024](https://web.archive.org/web/20241022050517/https://nvd.nist.gov/vuln/detail/CVE-2024-44952) — archived snapshot showing the CVSS 3.1 5.5 MEDIUM score before rejection
- [Kernel documentation: driver model overview](https://docs.kernel.org/driver-api/driver-model/overview.html) — `struct device` and `device_lock()`'s role in the driver core
