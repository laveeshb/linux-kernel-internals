# printk: Kernel Logging Internals

> The kernel's logging system: log buffer, rate limiting, dev_printk, and dmesg

## The printk API

```c
/* Basic usage: */
printk(KERN_INFO "my_driver: initialized, irq=%d\n", irq);

/* Convenience macros (preferred): */
pr_emerg("...");    /* KERN_EMERG   = "<0>" */
pr_alert("...");    /* KERN_ALERT   = "<1>" */
pr_crit("...");     /* KERN_CRIT    = "<2>" */
pr_err("...");      /* KERN_ERR     = "<3>" */
pr_warn("...");     /* KERN_WARNING = "<4>" */
pr_notice("...");   /* KERN_NOTICE  = "<5>" */
pr_info("...");     /* KERN_INFO    = "<6>" */
pr_debug("...");    /* KERN_DEBUG   = "<7>" (only if DEBUG defined) */

/* Device-aware wrappers (include dev name/address in output): */
dev_err(&pdev->dev, "failed to map IO: %d\n", ret);
dev_info(&client->dev, "probe OK, addr=0x%02x\n", client->addr);
dev_warn(&pdev->dev, "timeout, retrying\n");
dev_dbg(&pdev->dev, "IRQ status: 0x%08x\n", status);
```

## Log levels and console

```c
/*
 * Messages are printed to the console (serial, VT) if their log level
 * is below the current console_loglevel:
 */
cat /proc/sys/kernel/printk
# 4  4  1  7
# current  default  min  boot-time-default

/* Levels:
   0 EMERG   — system unusable
   1 ALERT   — action must be taken immediately
   2 CRIT    — critical conditions
   3 ERR     — error conditions
   4 WARNING — warning conditions (many distros set console_loglevel to 4; the
                upstream Kconfig default, CONFIG_CONSOLE_LOGLEVEL_DEFAULT, is 7)
   5 NOTICE  — normal but significant
   6 INFO    — informational
   7 DEBUG   — debug messages (never shown at default level)
*/

/* Temporarily show all messages including DEBUG: */
echo 8 > /proc/sys/kernel/printk
```

## Circular log buffer

```c
/* kernel/printk/printk.c */
/*
 * The ring buffer stores records with metadata.
 * Size controlled by: CONFIG_LOG_BUF_SHIFT (default 17 = 128KB)
 * Boot parameter: log_buf_len=4M
 */

struct printk_info {
    u64     seq;         /* sequence number */
    u64     ts_nsec;     /* timestamp in nanoseconds */
    u16     text_len;    /* length of message text */
    u8      facility;    /* syslog facility */
    u8      flags:5;     /* internal record flags */
    u8      level:3;     /* syslog level, 0-7 */
    u32     caller_id;   /* cpu/task ID */
};

/*
 * Ring buffer is a lock-free multi-producer multi-consumer design.
 * Readers (dmesg, /dev/kmsg) never block the writer (printk).
 * Old messages are overwritten when buffer fills.
 */
```

## printk flow

```c
/* kernel/printk/printk.c — simplified; the real function also handles
 * panic-CPU message suppression and the scheduler-context (LOGLEVEL_SCHED)
 * case before reaching this core sequence */
asmlinkage int vprintk_emit(int facility, int level,
                             const struct dev_printk_info *dev_info,
                             const char *fmt, va_list args)
{
    /* 1. Format the message and store it in the ring buffer
     *    (vscnprintf + prb_reserve/memcpy/prb_commit happen inside) */
    int printed_len = vprintk_store(facility, level, dev_info, fmt, args);

    /* 2. Decide how/whether to flush to the console right now.
     *    The real decision is driven by struct console_flush_type,
     *    covering the legacy console-lock path, the newer "nbcon"
     *    (non-blocking console) path, and offloading to a kthread or
     *    irq_work when direct printing isn't safe here. */

    /* 3. If nothing is flushing directly, wake up console writers
     *    (klogd, /dev/kmsg readers) so they pick the message up */
    wake_up_klogd();

    return printed_len;
}
```

## Reading kernel logs

```bash
# dmesg: reads /dev/kmsg
dmesg
dmesg -T      # human-readable timestamps
dmesg -l err  # only errors and above
dmesg -w      # follow (like tail -f)
dmesg --clear # clear the ring buffer

# /dev/kmsg: raw structured access
cat /dev/kmsg
# 6,1234,123456789,-;e1000: eth0: Intel(R) PRO/1000 Network Connection
# Format: level,seq,timestamp(us),flags;message

# journalctl reads from journal which captures kernel messages:
journalctl -k              # kernel messages since last boot
journalctl -k -b-1         # previous boot kernel messages
journalctl -k -p err       # kernel errors
```

## Rate limiting

```c
/* Avoid log flooding: */
printk_ratelimited(KERN_WARNING "my_driver: spurious interrupt\n");
/* Allows one message per 5 seconds, prints suppressed count */

pr_warn_ratelimited("Too many requests, dropping\n");
dev_warn_ratelimited(&dev, "error %d, continuing\n", ret);

/* Controlled by: */
/* /proc/sys/kernel/printk_ratelimit        (default 5 seconds) */
/* /proc/sys/kernel/printk_ratelimit_burst  (default 10 messages) */

/* Custom rate limit: */
static DEFINE_RATELIMIT_STATE(my_rs, 10 * HZ, 5);
if (__ratelimit(&my_rs))
    pr_warn("...");
```

## pr_fmt: module prefix

```c
/* At the top of the source file: */
#define pr_fmt(fmt) KBUILD_MODNAME ": " fmt

/* All subsequent pr_*() calls automatically include module name: */
pr_info("driver loaded\n");
/* Output: "my_module: driver loaded" */
```

## Dynamic debug

```bash
# dev_dbg() and pr_debug() are no-ops unless dynamically enabled:
# Enable all debug messages in a file:
echo "file drivers/net/e1000.c +p" > /sys/kernel/debug/dynamic_debug/control

# Enable all debug messages in a module:
echo "module e1000 +p" > /sys/kernel/debug/dynamic_debug/control

# Enable with flags (p=print, f=filename, l=line, m=module, t=thread):
echo "file net/ipv4/tcp.c +pflmt" > /sys/kernel/debug/dynamic_debug/control

# List all dynamic debug sites:
cat /sys/kernel/debug/dynamic_debug/control | grep "e1000"
# drivers/net/ethernet/intel/e1000e/netdev.c:2345 [e1000e]e1000_intr =p

# Boot parameter to enable at startup:
# dyndbg="module e1000 +p"
```

## pstore: persist messages across reboot

```bash
# If CONFIG_PSTORE enabled (EFI vars, RAM, MTD):
ls /sys/fs/pstore/      # crash logs from previous boot
cat /sys/fs/pstore/dmesg-ramoops-0

# ramoops: dedicated RAM region for persistent kernel logs
# EFI pstore: saves to UEFI non-volatile storage
# Useful for debugging early boot crashes or panic storms
```

## Observing printk

```bash
# Trace all printk calls:
bpftrace -e '
kprobe:vprintk_emit {
    printf("printk level=%d: %s\n", (int)arg1,
           str(*(char **)arg3));
}'

# Serial console speed bottleneck:
# High-volume logging can stall real-time tasks
# Solution: use async console (ASYNC_CONSOLE) or pstore
```

## Further reading

### Kernel source

- [kernel/printk/printk.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/printk/printk.c) — `vprintk_emit()`, `wake_up_klogd()`, `console_flush_all()`: the core implementation
- [kernel/printk/printk_ringbuffer.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/printk/printk_ringbuffer.h) — `struct printk_info`, `struct printk_ringbuffer`, `prb_reserve()`/`prb_commit()`: the lock-free ring buffer
- [include/linux/printk.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/printk.h) — the `pr_*()` convenience macros and `printk_ratelimited()`
- [include/linux/ratelimit_types.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/ratelimit_types.h) — `DEFINE_RATELIMIT_STATE()` and `__ratelimit()`: the rate-limiting primitives
- [include/linux/dev_printk.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/dev_printk.h) — `dev_err()`, `dev_info()`, `dev_warn()`, `dev_dbg()`: the device-aware wrappers

### Man pages

- [`dmesg(1)`](https://man7.org/linux/man-pages/man1/dmesg.1.html) — reading and filtering the kernel log, including `-T`, `-w`, `-l`, `--clear`
- [`syslog(2)`](https://man7.org/linux/man-pages/man2/syslog.2.html) — the syscall behind `dmesg`/`klogctl`, and the console-loglevel semantics exposed via `/proc/sys/kernel/printk`

### Related pages

- [Oops Analysis](../debugging/oops-analysis.md) — reading kernel crash output
- [kdump](../debugging/kdump.md) — kernel crash dumps
- [Dynamic Debug](../modules/dynamic-debug.md) — full treatment of `pr_debug()`/`dev_dbg()` and the `dynamic_debug/control` command language

### LWN articles

- [Reimplementing printk()](https://lwn.net/Articles/780556/) — John Ogness's lockless ring-buffer redesign that the current `printk_ringbuffer` implements
- [Why printk() is so complicated (and how to fix it)](https://lwn.net/Articles/800946/) — the tension between console output, log levels, and reliability that shapes the current design
- [Keeping printk() under control](https://lwn.net/Articles/66091/) — the original `printk_ratelimit()` mechanism

### External

- [Message logging with printk](https://docs.kernel.org/core-api/printk-basics.html) — the `pr_*()` macros, `KERN_*` log levels, and `pr_fmt()`
- [dynamic-debug-howto](https://docs.kernel.org/admin-guide/dynamic-debug-howto.html) — full command language and flag reference for `/sys/kernel/debug/dynamic_debug/control`
- [sysctl/kernel.rst: printk](https://docs.kernel.org/admin-guide/sysctl/kernel.html#printk) — the four `/proc/sys/kernel/printk` values, plus `printk_ratelimit` and `printk_ratelimit_burst` defaults
- [ramoops.rst](https://docs.kernel.org/admin-guide/ramoops.html) — the RAM-backed pstore/ramoops persistent logging mechanism
