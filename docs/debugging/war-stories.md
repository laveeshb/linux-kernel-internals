# Debugging War Stories

> Real bugs caught by KASAN, lockdep, syzkaller, and other tools

These are technically grounded accounts of the kinds of bugs that kernel debugging tools catch in real life. Each story illustrates a class of bug, the tool that surfaced it, how to read the output, and the fix.

---

## 1. KASAN finds a use-after-free in a network driver RX path

**Tool:** KASAN (generic, `CONFIG_KASAN_GENERIC`)
**Bug class:** Use-after-free
**Subsystem:** Networking (`sk_buff`, NAPI RX handler)

### What happened

A network driver's RX completion handler was processing received frames in a loop. Inside the loop, the driver called `dev_kfree_skb()` to release the `sk_buff` after passing it up the stack via `netif_receive_skb()`. But the loop then accessed `skb->len` in its accounting code — after the skb had been freed.

The access was in a fast path that the developer had been optimizing. An earlier refactor moved the accounting code below the `dev_kfree_skb()` call without noticing that `skb` was now a dangling pointer.

### The KASAN report

```
==================================================================
BUG: KASAN: use-after-free in netif_receive_skb_internal+0x234/0x580
Read of size 4 at addr ffff8881043a1068 by task ksoftirqd/0/12

CPU: 0 PID: 12 Comm: ksoftirqd/0 Not tainted 6.7.0 #1
Call Trace:
 kasan_report+0xbd/0x100
 kasan_check_range+0x115/0x1a0
 netif_receive_skb_internal+0x234/0x580    ← access site
 mydrv_rx_completion+0x1a8/0x3f0 [mydrv]   ← our driver

Allocated by task 0:
 __kasan_kmalloc+0x81/0xa0
 kmem_cache_alloc+0x68/0x2e0
 __alloc_skb+0x44/0x200                    ← allocated here
 mydrv_rx_alloc+0x20/0x60 [mydrv]

Freed by task 12:
 __kasan_slab_free+0x120/0x160
 kmem_cache_free+0x68/0x2e0
 kfree_skb_reason+0x58/0xa0
 dev_kfree_skb+0x18/0x20
 mydrv_rx_completion+0x198/0x3f0 [mydrv]  ← freed HERE (before the access above)
==================================================================
```

Reading the report:
- The **Read of size 4** is accessing `skb->len` (a `__u32` at offset `0x68` in `struct sk_buff`)
- The free stack shows `mydrv_rx_completion+0x198`; the access stack shows `mydrv_rx_completion+0x1a8` — the access is 16 bytes later in the same function, confirming a use-after-free in the same call frame

### The fix

```c
/* Before (buggy): */
void mydrv_rx_completion(struct mydrv *priv, struct rx_desc *desc)
{
    struct sk_buff *skb = desc->skb;

    skb_put(skb, desc->len);
    netif_receive_skb(skb);
    dev_kfree_skb(skb);          /* skb freed here */

    priv->stats.rx_bytes += skb->len;   /* BUG: skb dangling pointer */
}

/* After (fixed): save len before freeing */
void mydrv_rx_completion(struct mydrv *priv, struct rx_desc *desc)
{
    struct sk_buff *skb = desc->skb;
    unsigned int len = desc->len;   /* save before free */

    skb_put(skb, len);
    netif_receive_skb(skb);
    dev_kfree_skb(skb);

    priv->stats.rx_bytes += len;    /* use saved copy */
}
```

**Lesson:** KASAN reports the exact allocation and free stacks alongside the access stack, making the source of a UAF immediately obvious even in optimized code.

---

## 2. lockdep catches an ABBA deadlock before production

**Tool:** lockdep (`CONFIG_PROVE_LOCKING`)
**Bug class:** Circular lock dependency (potential deadlock)
**Subsystem:** Filesystem (ext4-style inode stats)

### What happened

A developer added a per-superblock `stats_lock` spinlock to protect aggregate I/O statistics. They introduced two code paths that acquired the new lock:

- **Path A** (`ext4_write_end`): acquired `inode->i_rwsem` (write), then `sb->stats_lock`
- **Path B** (`stats_flush_worker`): a kworker that acquired `sb->stats_lock`, then iterated dirty inodes and called `inode_lock()` (which takes `inode->i_rwsem` write)

This is a classic ABBA pattern:
```
Path A: inode→i_rwsem → sb→stats_lock
Path B: sb→stats_lock → inode→i_rwsem
```

### The lockdep splat

```
======================================================
WARNING: possible circular locking dependency detected
------------------------------------------------------
kworker/u4:1/234 is trying to acquire lock:
ffff888100cd1a80 (&inode->i_rwsem){++++}-{3:3}, at: inode_lock+0x1d/0x30

but task is already holding:
ffffffff82a45678 (&sb->stats_lock){....}-{2:2}, at: stats_flush_worker+0x44/0x120

which lock already depends on the new lock.

the existing dependency chain (in reverse order) is:
-> #1 (&sb->stats_lock){....}:
       _raw_spin_lock+0x52/0x70
       ext4_write_end+0x2c0/0x5a0    ← Path A: holds i_rwsem, acquires stats_lock

-> #0 (&inode->i_rwsem){++++}:
       down_write+0x52/0x120
       inode_lock+0x1d/0x30
       stats_flush_worker+0x78/0x120  ← Path B: holds stats_lock, acquires i_rwsem

 *** DEADLOCK ***
======================================================
```

Lockdep fired on the **first execution** of `stats_flush_worker`, before any production system ran the code. No actual deadlock had occurred — both paths could have been running on different CPUs in a busy filesystem.

### The fix

The developer reversed the acquisition order in `stats_flush_worker`: collect the dirty-inode list under `stats_lock` into a local array, drop `stats_lock`, then acquire each inode lock individually.

```c
/* Before (buggy): */
void stats_flush_worker(struct work_struct *work)
{
    struct super_block *sb = container_of(work, ...);

    spin_lock(&sb->stats_lock);           /* acquire stats_lock first */
    list_for_each_entry(inode, &sb->s_inodes, i_sb_list) {
        inode_lock(inode);                /* then i_rwsem — ABBA! */
        flush_inode_stats(inode, sb);
        inode_unlock(inode);
    }
    spin_unlock(&sb->stats_lock);
}

/* After (fixed): snapshot under lock, then iterate without stats_lock */
void stats_flush_worker(struct work_struct *work)
{
    struct super_block *sb = container_of(work, ...);
    u64 total_bytes = 0;

    spin_lock(&sb->stats_lock);
    total_bytes = sb->pending_bytes;
    sb->pending_bytes = 0;
    spin_unlock(&sb->stats_lock);       /* drop stats_lock before inode locks */

    /* Now safe to acquire inode locks without holding stats_lock */
    update_sb_stats(sb, total_bytes);
}
```

**Lesson:** lockdep finds impossible-to-reproduce deadlocks deterministically. A real deadlock would require two CPUs to interleave at exactly the wrong moment — which might happen only once a week on a loaded system. lockdep found it in the first test run.

---

## 3. syzkaller finds a NULL deref via crafted io_uring SQE

**Tool:** syzkaller + syzbot
**Bug class:** NULL pointer dereference (missing bounds check)
**Subsystem:** io_uring (`io_write`, fixed-file table)

### What happened

A new io_uring feature landed in `linux-next`. Within 2 hours, syzbot reported a NULL pointer dereference in `io_write()`, triggered by an `IORING_OP_WRITE` SQE with `IOSQE_FIXED_FILE` set but with `ctx->file_table.files` being NULL (no fixed files registered).

The kernel was reading `ctx->file_table.files[req->fixed_file]` without checking whether `ctx->file_table.files` was initialized. The reproducer was a 20-line C program.

### The syzbot report

```
BUG: kernel NULL pointer dereference, address: 0000000000000000
#PF: supervisor read access in kernel mode
#PF: error_code(0x0000) - not-present page
RIP: 0010:io_file_get_fixed+0x2c/0x90

Call Trace:
 io_write+0xa4/0x5a0
 io_issue_sqe+0x3a0/0x8c0
 io_submit_sqes+0x1f0/0x4d0
 __sys_io_uring_enter+0x2c0/0x560
 __x64_sys_io_uring_enter+0x1c/0x30
 do_syscall_64+0x5b/0x1d0

Reproduced with:
 r0 = io_uring_setup(0x8, &(0x7f0000000000)={0x1f4})  /* setup with no fixed files */
 io_uring_enter(r0, 0x1, 0x0, 0x0,
   {op=IORING_OP_WRITE, flags=IOSQE_FIXED_FILE, fd=0x0,
    buf=0x7f00, len=0x10, off=0x0})
```

### The root cause

```c
/* Before (buggy) — io_uring/io_uring.c: */
static struct file *io_file_get_fixed(struct io_ring_ctx *ctx,
                                      struct io_kiocb *req,
                                      unsigned int issue_flags)
{
    unsigned int fd = req->fixed_file;   /* fixed-file index from the SQE */

    /* Missing: check if file_table is initialized */
    if (fd >= ctx->file_table.nr)    /* nr is 0 → returns NULL next line */
        return NULL;

    return io_fixed_file_slot(&ctx->file_table, fd)->file_ptr & ~3;
    /* file_table.files is NULL → deref of NULL + offset */
}
```

### The fix

```c
/* After (fixed): */
static struct file *io_file_get_fixed(struct io_ring_ctx *ctx,
                                      struct io_kiocb *req,
                                      unsigned int issue_flags)
{
    unsigned int fd = req->fixed_file;   /* fixed-file index from the SQE */

    if (unlikely(!ctx->file_table.files))   /* guard: no fixed files registered */
        return NULL;
    if (unlikely(fd >= ctx->file_table.nr))
        return NULL;

    return io_fixed_file_slot(&ctx->file_table, fd)->file_ptr & ~3;
}
```

Alternatively, the check can return `-EBADF` early from `io_write()`:
```c
if (req->flags & REQ_F_FIXED_FILE) {
    if (unlikely(!ctx->file_table.files))
        return -EBADF;
}
```

**Lesson:** syzkaller systematically exercises every combination of flags and registers that a human tester would never try. The crafted SQE exploited a subtle initialization race — the feature worked fine with registered fixed files, but not with zero files registered. The syzbot C reproducer was sent to the mailing list with the bug report and the patch landed within 24 hours.

---

## 4. KFENCE catches an off-by-one in `kstrdup`

**Tool:** KFENCE (`CONFIG_KFENCE`)
**Bug class:** Heap out-of-bounds write (off-by-one)
**Subsystem:** String helpers / driver core

### What happened

A production server running a recent kernel started showing KFENCE reports in its kernel logs. The system had `CONFIG_KFENCE=y` with the default 100ms sample interval. The report appeared in the first hour of uptime.

### The KFENCE report

```
==================================================================
BUG: KFENCE: out-of-bounds write in kstrdup+0x48/0x70

Out-of-bounds write at 0xffff888080a3c007 (1B left of kfence-#17):
 kstrdup+0x48/0x70           ← writes byte 8 of a 7-byte allocation
 some_helper+0x24/0x60 [mydriver]
 driver_probe_device+0x1a8/0x3c0
 bus_probe_device+0x88/0xe0

kfence-#17 [0xffff888080a3c000-0xffff888080a3c006, size=7, cache=kmalloc-8]
allocated by task 1:
 kfence_alloc+0x7c/0xb0
 __kmalloc+0x3e/0x80
 kstrdup+0x20/0x70
 some_helper+0x10/0x60 [mydriver]

CPU: 1 PID: 1 Comm: swapper/0 Not tainted 6.8.0 #1
==================================================================
```

### Root cause

The helper in `mydriver` called `kstrdup()` indirectly through an upstream utility function. That utility function had a bug: it allocated `strlen(s)` bytes instead of `strlen(s) + 1`, omitting space for the NUL terminator. The `kstrdup` implementation then wrote the NUL at byte index `len`, which is one past the end of the allocation.

```c
/* Buggy upstream helper: */
char *make_name(const char *prefix, const char *suffix)
{
    size_t len = strlen(prefix) + strlen(suffix);
    char *buf = kmalloc(len, GFP_KERNEL);   /* BUG: no +1 for NUL */
    if (!buf)
        return NULL;
    sprintf(buf, "%s%s", prefix, suffix);   /* writes NUL at buf[len] */
    return buf;
}
```

The bug had existed for several kernel releases, but no KASAN-enabled kernel had ever exercised this exact code path: `make_name()` was reached only from a driver probe path tied to hardware that wasn't present in the KASAN-enabled CI fleet or on developers' local test rigs. This was a coverage gap, not a KASAN detection-granularity gap — generic KASAN's shadow byte encodes the exact accessible-byte count within each 8-byte granule (see [KASAN and KFENCE](kasan-kfence.md) for the shadow-byte table), so a NUL write to byte 8 of a 7-byte `kmalloc-8` object would have been flagged immediately had it run under KASAN. The bug survived because KASAN's ~2–3× CPU overhead means it typically runs only in development and CI, on whatever hardware and code paths engineers happen to exercise there — not because an off-by-one at this exact boundary is somehow invisible to it.

KFENCE, by contrast, samples allocations in production at near-zero overhead, so it eventually caught this allocation once it landed in a KFENCE slot, right-aligned in a 4 KB data page. The guard page immediately followed byte 7. The NUL write to byte 8 hit the guard page and faulted.

### The fix

```c
/* Fixed: */
char *make_name(const char *prefix, const char *suffix)
{
    size_t len = strlen(prefix) + strlen(suffix) + 1;   /* +1 for NUL */
    char *buf = kmalloc(len, GFP_KERNEL);
    if (!buf)
        return NULL;
    sprintf(buf, "%s%s", prefix, suffix);
    return buf;
}
```

Or, more idiomatically using `kasprintf()`:

```c
char *make_name(const char *prefix, const char *suffix)
{
    return kasprintf(GFP_KERNEL, "%s%s", prefix, suffix);
}
```

**Lesson:** KASAN and KFENCE are both precise detectors, but neither can catch a bug on a code path it never executes. KASAN's overhead confines it to development and CI, which only cover the hardware and workloads engineers test there; KFENCE's near-zero overhead lets it sample production traffic continuously. Running KFENCE in production caught a bug that had slipped past code review and every KASAN-enabled test run simply because none of them had ever reached this code path.

---

## 5. kdump saves the day after silent memory corruption

**Tool:** kdump + `crash` + KASAN (follow-up)
**Bug class:** Use-after-free corrupting `kmem_cache` freelist
**Subsystem:** Block layer (`bio` objects), device lifecycle

### What happened

A storage server experienced periodic silent hangs — the system would stop responding and reboot (via hardware watchdog) with no oops, no panic, and no messages in the kernel log. The crashes happened every few days under heavy I/O load.

After enabling kdump (`CONFIG_KEXEC=y`, `crashkernel=256M` on the boot command line), the team captured a vmcore on the next crash.

### crash analysis

```bash
crash vmlinux /var/crash/vmcore

crash> kmem -s bio
CACHE         OBJSIZE  ALLOCATED     TOTAL  SLABS  SLAB SIZE  NAME
ffff888200041800     256       1234      1280      5     8192  bio

crash> kmem -S bio
...
FREE / [ALLOCATED]
 ffff888100ab1200  (0)   ← free object
[ffff888100ab1300] (1)   ← allocated object (normal)
 ffff888100ab1400  (0)   ← free object — but look at its freelist pointer:

crash> rd ffff888100ab1400 4
ffff888100ab1400:  deadbeef41414141 0000000000000000   ←  corrupted freelist pointer!
```

The `kmem_cache` freelist for `bio` objects had been corrupted. A freed `bio` had been overwritten: its first 8 bytes (which `SLUB` uses as the freelist pointer) now contained `0xdeadbeef41414141` — clearly written by kernel code, not a valid kernel pointer.

This corrupted freelist pointer would eventually cause `kmem_cache_alloc()` to return a bogus pointer — at which point the kernel would write into an arbitrary kernel address, leading to the silent hang.

### Tracking down the writer

The `crash` session showed the corrupted bio was last seen allocated by a specific block driver from the `bio` backtrace stored in `SLUB` debug metadata (visible because `CONFIG_SLUB_DEBUG=y` was enabled).

With that information, the team enabled `CONFIG_KASAN=y` on a test system with the same driver and workload.

### The KASAN report

Within minutes of starting the test I/O workload:

```
==================================================================
BUG: KASAN: use-after-free in blk_complete_request+0x8c/0x120
Write of size 8 at addr ffff888100ab1400 by task blkd/56

Freed by task 56:
 __kasan_slab_free+0x120/0x160
 bio_put+0x44/0x80
 bio_endio+0x9c/0x100        ← bio freed here via bio_endio

Allocated by task 56:
 __kasan_kmalloc+0x81/0xa0
 bio_alloc_bioset+0x68/0x1a0
 myblk_submit_io+0x34/0x80 [myblk]
==================================================================
```

### Root cause

The driver was accessing `bio->bi_iter` after calling `bio_endio()`. `bio_endio()` calls the bio's completion callback which may call `bio_put()` — dropping the last reference and freeing the bio back to the slab. If the driver's reference count was wrong, `bio_endio()` would free the bio and the driver would then write into freed memory.

The actual bug: the driver called `bio_endio()` without first calling `get_device()` on the target device. Under memory pressure, the device's `release()` callback ran and freed a shared structure that included the bio pool. When `bio_endio()` subsequently ran, it released the bio into an already-destroyed pool, corrupting the freelist.

### The fix

```c
/* Before (buggy): driver submits I/O without holding device reference */
static int myblk_submit_io(struct myblk_dev *dev, struct bio *bio)
{
    bio->bi_end_io = myblk_end_io;
    bio->bi_private = dev;
    submit_bio(bio);
    return 0;
}

/* After (fixed): hold device reference for the lifetime of each I/O */
static int myblk_submit_io(struct myblk_dev *dev, struct bio *bio)
{
    if (!get_device(&dev->dev))   /* bump reference before submitting */
        return -ENODEV;

    bio->bi_end_io = myblk_end_io;
    bio->bi_private = dev;
    submit_bio(bio);
    return 0;
}

static void myblk_end_io(struct bio *bio)
{
    struct myblk_dev *dev = bio->bi_private;

    /* ... process completion ... */
    bio_put(bio);
    put_device(&dev->dev);        /* drop reference after I/O completes */
}
```

**Lesson:** Silent memory corruption is the hardest class of bug to debug because there is no oops at the point of corruption — the crash happens later, when the corrupted data is used. The workflow here is: (1) capture a vmcore with kdump to see the corrupted state, (2) use `crash` to identify what was overwritten and trace it to a subsystem, (3) enable KASAN on a test system to catch the actual write at the moment it happens. Neither tool alone would have been sufficient.

---

## Tool summary

| Story | Bug | Tool that found it | Time to find |
|---|---|---|---|
| Network driver UAF | `skb->len` after `dev_kfree_skb()` | KASAN | First test run |
| Filesystem ABBA deadlock | `stats_lock` → `i_rwsem` inversion | lockdep | First test run |
| io_uring NULL deref | Missing bounds check on fixed-file table | syzkaller | 2 hours after merge |
| `kstrdup` off-by-one | `strlen(s)` instead of `strlen(s)+1` | KFENCE (production) | 1 hour of uptime |
| `bio` freelist corruption | Missing `get_device()` | kdump → crash → KASAN | Days to capture; hours to diagnose |

---

## Further reading

- [KASAN and KFENCE](kasan-kfence.md) — memory error detector reference
- [lockdep in Practice](dynamic-debug-lockdep.md) — reading splats, annotating false positives
- [syzkaller](syzkaller.md) — setting up and using the kernel fuzzer
- [kdump and crash](kdump.md) — capturing and analyzing kernel crash dumps
- [Oops Analysis](oops-analysis.md) — decoding stack traces
- [KCSAN](kcsan.md) — data race detection

## External references

- [Kernel documentation: KASAN](https://docs.kernel.org/dev-tools/kasan.html) — shadow memory and use-after-free/out-of-bounds detection, the mechanism behind Case 1's report and Case 5's follow-up KASAN run
- [Kernel documentation: KFENCE](https://docs.kernel.org/dev-tools/kfence.html) — the sampling guard-page detector, its production-safe overhead, and left/right allocation alignment within a slot, behind Case 4
- [Kernel documentation: Lockdep Design](https://docs.kernel.org/locking/lockdep-design.html) — the dependency-cycle proof engine that produces the "possible circular locking dependency detected" splat in Case 2
- [Kernel documentation: kdump](https://docs.kernel.org/admin-guide/kdump/kdump.html) — kexec-based crash-kernel capture and the `crash` utility used to analyze the vmcore in Case 5
- [Kernel documentation: SLUB debugging](https://docs.kernel.org/admin-guide/mm/slab.html) — `CONFIG_SLUB_DEBUG`, redzoning, and object poisoning — the mechanism that let `crash` trace the corrupted `bio`'s allocation backtrace in Case 5
- [kernel/locking/lockdep.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/locking/lockdep.c) — `check_noncircular()` and `check_deadlock()`, the runtime cycle-detection code behind Case 2's splat
- [mm/kfence/core.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kfence/core.c) and [lib/Kconfig.kfence](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/lib/Kconfig.kfence) — the sampling-gate implementation and `CONFIG_KFENCE_SAMPLE_INTERVAL` (default 100, in milliseconds), confirming Case 4's "default 100ms sample interval" claim
- [mm/slub.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/slub.c) — `get_freepointer()`/`set_freepointer()`, the freelist-pointer mechanics behind the corrupted `bio` freelist in Case 5
- [mm/kasan/report.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/kasan/report.c) — `kasan_report()`, the reporting path behind Case 1 and Case 5's follow-up KASAN report
- [io_uring/io_uring.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/io_uring/io_uring.c) — `io_file_get_fixed()`, the real fixed-file resolution function Case 3's illustrative bug is modeled on (current source validates through `io_rsrc_node_lookup()` rather than the simplified direct index check shown here)

No specific commit hashes, CVE numbers, or kernel-version-tied feature claims appear in this page's prose — the five cases are composite scenarios illustrating real, recurring bug-and-tool patterns (following the same approach as `docs/kernel/war-stories.md`) rather than write-ups of a single named historical incident, so there is nothing of that kind to cite in place. The references above verify the underlying kernel mechanisms — KASAN/KFENCE detection internals, lockdep cycle detection, kdump/crash capture, SLUB debug metadata, and io_uring fixed-file resolution — against current mainline source and documentation.
