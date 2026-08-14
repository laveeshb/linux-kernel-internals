# KCSAN: Kernel Concurrency Sanitizer

> Data race detection using watchpoints and the Linux Kernel Memory Model

## What is a data race?

A **data race** occurs when two threads access the same memory location concurrently, at least one access is a write, and there's no synchronization between them:

```c
/* Thread 1: */         /* Thread 2: */
x++;                    y = x;     /* data race! */
/* Reads x, increments, writes x — 3 non-atomic operations */
/* Thread 2 may see a partial state */
```

Data races are undefined behavior in C11 and cause subtle bugs — compilers can miscompile racing code in unexpected ways, and hardware CPUs may reorder or coalesce the accesses.

## How KCSAN works

KCSAN uses **software watchpoints** to detect racing accesses:

```
Thread 1 write to &x:
  1. KCSAN randomly decides to set a watchpoint on &x
  2. Records &x in a per-CPU software watchpoint slot (no hardware debug registers)
  3. Delays briefly (~microseconds) to give another thread time to access &x

Thread 2 read from &x (during the delay):
  4. Watchpoint fires: both threads' call stacks recorded
  5. KCSAN reports the data race
```

This is a probabilistic approach — not all races are detected, but it finds real races in practice without false positives (compared to shadow memory approaches).

## Configuration

```bash
# Kconfig options:
CONFIG_KCSAN=y
CONFIG_KCSAN_REPORT_ONCE_IN_MS=3000     # rate-limit reports
CONFIG_KCSAN_DELAY_RANDOMIZE=y          # randomize watchpoint delay
CONFIG_KCSAN_NUM_WATCHPOINTS=64         # software watchpoint slots (shared across CPUs)
CONFIG_KCSAN_INTERRUPT_WATCHER=y        # also watch interrupt context
CONFIG_KCSAN_REPORT_RACE_UNKNOWN_ORIGIN=y  # report even without second stack

# Build: set CONFIG_KCSAN=y in .config, then build normally
```

## Reading KCSAN reports

```
==================================================================
BUG: KCSAN: data-race in my_function+0x1234/0x5678 [my_module]
            my_other_function+0xabcd/0xef01 [my_module]

read to 0xffffffff12345678 of 4 bytes by task 1234 on cpu 0:
 my_function+0x1234/0x5678
 some_caller+0x0abc/0x0def
 kernel_thread+0x0001/0x0012

write to 0xffffffff12345678 of 4 bytes by task 5678 on cpu 1:
 my_other_function+0xabcd/0xef01
 another_caller+0x0123/0x0456
 kernel_thread+0x0001/0x0012

value changed: 0x00000000 -> 0x00000001
Reported by Kernel Concurrency Sanitizer on:
CPU: 1 PID: 5678 Comm: worker Tainted: G    B W
==================================================================
```

Key fields:
- **read/write**: which operation triggered the watchpoint
- **address**: the racing memory location
- **value changed**: shows the write that caused the race
- **two call stacks**: one for each racing access

## Annotation: intentional benign races

Some kernel code intentionally reads a variable without synchronization as a hint/optimization. These must be annotated to silence KCSAN:

```c
/* READ_ONCE / WRITE_ONCE: communicate to compiler AND KCSAN */
/* that this access is intentionally unsynchronized */
int val = READ_ONCE(shared_var);   /* don't optimize away the read */
WRITE_ONCE(shared_var, new_val);   /* don't optimize away the write */

/* For intentional data races (lossy counters, heuristics): */
/* data_race() marks an access as intentionally racy: */
int approximate_count = data_race(shared_counter);

/* KCSAN_NO_SANITIZE_CURRENT: suppress for entire function */
void __no_kcsan my_racy_function(void)
{
    /* KCSAN won't instrument this function */
}
```

## Atomic operations and KCSAN

Atomic operations are not races:

```c
/* These are fine (atomic, not a race): */
atomic_inc(&counter);              /* atomic read-modify-write */
atomic_cmpxchg(&ptr, old, new);    /* compare-and-swap */

/* smp_load_acquire / smp_store_release: acquire/release barriers */
/* Also recognized by KCSAN as synchronized access: */
old = smp_load_acquire(&ptr);
smp_store_release(&ptr, new);
```

## Linux Kernel Memory Model (LKMM)

KCSAN is designed to enforce the **Linux Kernel Memory Model**, which defines the formal semantics of concurrent kernel code:

```c
/* LKMM rules (simplified): */

/* 1. Plain accesses (x = y) are only allowed if no other CPU writes x
      concurrently without synchronization */

/* 2. ACQUIRE/RELEASE barriers provide ordering:
      lock()/unlock() pair gives:
        all accesses before lock() happen-before all accesses after unlock() */

/* 3. smp_mb() / smp_rmb() / smp_wmb() provide full barriers */

/* 4. READ_ONCE/WRITE_ONCE prevent compiler reordering */

/* Example correct code: */
static DEFINE_SPINLOCK(lock);
static int shared_var;

void writer(int val)
{
    spin_lock(&lock);
    WRITE_ONCE(shared_var, val);  /* also ok: just shared_var = val under lock */
    spin_unlock(&lock);
}

int reader(void)
{
    int val;
    spin_lock(&lock);
    val = READ_ONCE(shared_var);
    spin_unlock(&lock);
    return val;
}
```

## KCSAN vs other sanitizers

| | KCSAN | KASAN | ThreadSanitizer |
|---|-------|-------|-----------------|
| Detects | Data races | Memory errors (UAF, OOB) | Data races |
| Approach | Watchpoints (probabilistic) | Shadow memory (deterministic) | Shadow memory |
| Overhead | ~5% (watchpoints) | ~2x memory, 2x CPU | ~5-15x CPU |
| False positives | Very few | None | Some |
| Context | Kernel only | Kernel only | Userspace |

## syzkaller integration

syzkaller (kernel fuzzer) combined with KCSAN finds races in new syscall paths:

```bash
# KCSAN in syzkaller config (syzkaller/tools/syz-env):
"kernel_config": "CONFIG_KCSAN=y,CONFIG_KCSAN_INTERRUPT_WATCHER=y,..."

# syzkaller spawns multiple VMs executing syscalls in parallel
# KCSAN watchpoints detect races between concurrent syscall invocations
```

## Debugging a reported race

```bash
# 1. Capture the race:
dmesg | grep -A 30 "KCSAN"

# 2. Use addr2line to find source:
addr2line -e vmlinux -i 0xffffffff12345678
# → mm/slub.c:3456

# 3. Check git log for recent changes:
git log --oneline mm/slub.c | head -10

# 4. Reproduce deterministically (if possible):
# Set KCSAN_DELAY_RANDOMIZE=n and KCSAN_DELAY=100 to always delay
echo 100 > /sys/kernel/debug/kcsan/delay_task  # force 100µs delay

# 5. Fix options:
# a. Add proper locking
# b. Use atomic operations
# c. Annotate with data_race() if intentional and safe
# d. Use READ_ONCE/WRITE_ONCE for benign races

# 6. Verify fix:
# Run syzkaller or stress test with KCSAN enabled
# No new race reports for the same location
```

## Further reading

### Kernel source

- [kernel/kcsan/core.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/kcsan/core.c) — the watchpoint-based race detection engine
- [kernel/kcsan/report.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/kcsan/report.c) — report formatting: the two racing call stacks and the "value changed" line
- [kernel/kcsan/debugfs.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/kcsan/debugfs.c) — the `/sys/kernel/debug/kcsan` control file (on/off, blacklist/whitelist)
- [lib/Kconfig.kcsan](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/lib/Kconfig.kcsan) — Kconfig options and defaults (`KCSAN_NUM_WATCHPOINTS` defaults to 64, `KCSAN_REPORT_ONCE_IN_MS` defaults to 3000, `KCSAN_DELAY_RANDOMIZE` defaults to y)
- [include/linux/compiler.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/compiler.h) — `data_race()` macro definition
- [include/linux/compiler_types.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/compiler_types.h) — `__no_kcsan` function attribute definition
- [Documentation/dev-tools/kcsan.rst](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/dev-tools/kcsan.rst) — official KCSAN documentation
- [tools/memory-model/](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/tools/memory-model/) — Linux Kernel Memory Model (LKMM) formal specification

### Related pages

- [KASAN](../mm/kasan.md) — memory error detection (use-after-free, OOB)
- [KFENCE](../mm/kfence.md) — lightweight sampling memory error detector
- [Atomics and Memory Barriers](../locking/atomics.md) — correct concurrent access
- [RCU](../locking/rcu.md) — RCU is a race-free read-mostly pattern
- [Spinlock](../locking/spinlock.md) — spinlocks prevent races

### LWN articles

- [Finding race conditions with KCSAN](https://lwn.net/Articles/802128/) — Jonathan Corbet's introduction to KCSAN shortly after it was merged (October 2019)
- [Concurrency bugs should fear the big bad data-race detector](https://lwn.net/Articles/816850/) — a joint writeup by the KCSAN and Linux Kernel Memory Model developers on how the two projects fit together (April 2020)

### External

- [docs.kernel.org: Kernel Concurrency Sanitizer (KCSAN)](https://docs.kernel.org/dev-tools/kcsan.html) — rendered official documentation, including the debugfs interface and tuning parameters
