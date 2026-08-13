# vDSO and Virtual System Calls

> Kernel-accelerated clock reads and other fast-path syscalls without ring transitions

## The problem: syscall overhead for time

`clock_gettime(CLOCK_MONOTONIC, &ts)` is one of the most frequently called functions in a typical server
process. High-frequency timers, latency histograms, and O(1) scheduling decisions all call it in tight
loops. Each real `syscall` instruction costs roughly 100–200 ns on a modern x86-64 CPU due to the ring
transition, KPTI CR3 switch, and pipeline flush — plus any microarchitectural Spectre mitigations.

For a process calling `clock_gettime()` a million times per second, that overhead alone consumes 100–200 ms
of CPU time per second purely on privilege transitions. The kernel solves this with the **vDSO**.

## What the vDSO is

The vDSO (virtual Dynamic Shared Object) is a small ELF shared library that the kernel builds into the kernel
image and maps into every process's address space at `execve()` time. It is visible in `/proc/self/maps`:

```bash
cat /proc/self/maps | grep vdso
# 7ffee3a2d000-7ffee3a2f000 r-xp 00000000 00:00 0  [vdso]
```

The address is randomized by ASLR on every process start. The vDSO exports a small set of functions
(visible via `nm` or `objdump`) that implement time-critical syscalls entirely in userspace:

```bash
nm /proc/self/maps   # doesn't work directly; extract the vDSO first:
vdso=$(cat /proc/self/maps | awk '/\[vdso\]/{print $1}' | head -1)
# On a running system, glibc links the vDSO automatically via the AT_SYSINFO_EHDR
# auxiliary vector entry set by the kernel at exec time.
objdump -T /lib/x86_64-linux-gnu/vdso.so.1 2>/dev/null
# __vdso_clock_gettime
# __vdso_gettimeofday
# __vdso_clock_getres
# __vdso_getcpu
# __vdso_time
```

glibc resolves these symbols at startup from the `AT_SYSINFO_EHDR` auxiliary vector entry and uses them
in place of the real syscall wrappers.

## The vvar page: shared kernel data

Adjacent to the vDSO mapping is the **vvar** page — a read-only page mapped into every process that the
kernel updates with current timekeeping state:

```bash
cat /proc/self/maps | grep vvar
# 7ffee3a2b000-7ffee3a2d000 r--p 00000000 00:00 0  [vvar]
```

The vvar page is mapped read-only in userspace but read-write in the kernel. The vDSO code reads from
`[vvar]`; the kernel timer interrupt writes to it. No ring transition is needed because reading a
mapped page is a plain memory access.

## struct vdso_data

The core data structure in the vvar page is `struct vdso_data`, defined in `include/vdso/datapage.h`:

```c
/* include/vdso/datapage.h */
struct vdso_data {
    u32             seq;            /* seqlock sequence counter */
    s32             clock_mode;     /* VDSO_CLOCKMODE_TSC, _PVCLOCK, _HVCLOCK, _NONE */
    u64             cycle_last;     /* TSC value at last update */
    u64             mask;           /* TSC mask (for 32-bit counters) */
    u32             mult;           /* TSC-to-ns multiplier */
    u32             shift;          /* right-shift for mult */
    union {
        struct vdso_timestamp   basetime[VDSO_BASES]; /* per-clock base */
        struct timens_offset    offset[VDSO_BASES];   /* time namespace offsets */
    };
    s32             tz_minuteswest; /* timezone */
    s32             tz_dsttime;
    u32             hrtimer_res;    /* hrtimer resolution in ns */
    u32             __unused;
    struct arch_vdso_data arch_data; /* architecture-specific */
};

struct vdso_timestamp {
    u64     sec;    /* base seconds */
    u64     nsec;   /* base nanoseconds (scaled) */
};
```

`VDSO_BASES` is the number of supported clock IDs. Each entry in `basetime[]` holds the time value at the
moment of the last kernel update.

## The seqlock pattern

Because the kernel updates `vdso_data` from timer interrupt context (and possibly from multiple CPUs), the
vDSO must handle concurrent reads. It uses a **seqlock** — a lockless read-side protocol:

In current kernels (after the vdso_clock refactoring), the seqlock helpers take `const struct vdso_clock *`
rather than `const struct vdso_data *`. The vDSO code accesses clock data via a `vdso_clock` sub-struct:

```c
/* include/vdso/helpers.h */
static __always_inline u32 vdso_read_begin(const struct vdso_clock *vc)
{
    return seqcount_latch_read_begin(&vc->seq);
}

static __always_inline bool vdso_read_retry(const struct vdso_clock *vc, u32 start)
{
    return seqcount_latch_read_retry(&vc->seq, start);
}

/* In the vDSO clocktime function: */
const struct vdso_data *vd = __arch_get_vdso_data();
const struct vdso_clock *vc = &vd->clock_data[clock_mode];
```

A typical clock read loop then looks like:

```c
/* arch/x86/entry/vdso/vclock_gettime.c */
static __always_inline int do_hres(const struct vdso_data *vd, clockid_t clk,
                                    struct __kernel_timespec *ts)
{
    const struct vdso_clock *vc = &vd->clock_data[clk];
    const struct vdso_timestamp *vdso_ts = &vc->basetime[clk];
    u64 cycles, last, sec, ns;
    u32 seq;

    do {
        seq = vdso_read_begin(vc);   /* read seq; if odd, writer in progress — spin */

        /* Read clock mode; if not TSC, fall back to real syscall */
        if (unlikely(vc->clock_mode == VDSO_CLOCKMODE_NONE))
            return clock_gettime_fallback(clk, ts);

        cycles = __arch_get_hw_counter(vc->clock_mode, vd);
        last   = vc->cycle_last;
        ns     = vdso_ts->nsec;
        sec    = vdso_ts->sec;

        /* Convert TSC delta to nanoseconds */
        ns += vdso_calc_delta(cycles, last, vc->mask, vc->mult);
        ns >>= vc->shift;

    } while (unlikely(vdso_read_retry(vc, seq)));  /* retry if seq changed */

    ts->tv_sec  = sec + __iter_div_u64_rem(ns, NSEC_PER_SEC, &ns);
    ts->tv_nsec = ns;
    return 0;
}
```

`vdso_read_begin()` reads the sequence counter and spins while it is odd (a writer holds the lock).
`vdso_read_retry()` reads the counter again and returns true if it has changed, meaning a kernel update
happened mid-read and the values are inconsistent. The loop retries until a clean read completes — in
practice, zero or one retries.

## TSC to wall-clock conversion

The nanosecond conversion uses a multiply-and-shift formula that avoids division:

```
ns = ((cycles - cycle_last) * mult) >> shift
```

- `mult` and `shift` are precomputed by `clocksource_cyc2ns()` in the kernel so that the multiply fits in
  a 64-bit integer without overflow.
- `cycle_last` is the TSC value at the last kernel update.
- Adding `ns` to `basetime[clk].nsec` gives the current nanosecond offset within the second.

The kernel updates `cycle_last`, `mult`, `shift`, and `basetime` on every NTP adjustment and on every
timer interrupt (via `update_vsyscall()` in `kernel/time/vsyscall.c`), holding the seqlock write side
during the update.

## Which clocks are vDSO-accelerated

| Clock ID | vDSO-accelerated | Notes |
|----------|-----------------|-------|
| `CLOCK_REALTIME` | Yes | Wall time; updated on NTP adjustments |
| `CLOCK_MONOTONIC` | Yes | Never steps backward |
| `CLOCK_BOOTTIME` | Yes | Includes suspend time |
| `CLOCK_REALTIME_COARSE` | Yes | Low-resolution; reads `basetime` directly, no TSC math |
| `CLOCK_MONOTONIC_COARSE` | Yes | Same, monotonic variant |
| `CLOCK_TAI` | Yes | International Atomic Time (REALTIME + leap-second offset) |
| `CLOCK_PROCESS_CPUTIME_ID` | No | Requires per-task accounting in the kernel |
| `CLOCK_THREAD_CPUTIME_ID` | No | Same |

Coarse clocks skip the TSC read entirely; they return the pre-computed `basetime` directly (resolution is
one jiffy, ~1–4 ms). This makes them even cheaper than the TSC-based clocks.

## VDSO_CLOCKMODE_NONE: fallback to real syscall

If the TSC is not reliable — for example, after live VM migration (the TSC may jump), during CPU hotplug,
or when the kernel detects TSC instability — the kernel sets `clock_mode` to `VDSO_CLOCKMODE_NONE`. The
vDSO detects this and calls `clock_gettime_fallback()`, which executes the real `syscall` instruction:

```c
/* lib/vdso/gettimeofday.c */
static __always_inline long clock_gettime_fallback(clockid_t clk,
                                                    struct __kernel_timespec *ts)
{
    return syscall(__NR_clock_gettime, clk, ts);
}
```

This fallback is transparent to the caller — the function signature and return value are identical.
`VDSO_CLOCKMODE_NONE` can also be triggered manually by writing to
`/sys/devices/system/clocksource/clocksource0/current_clocksource` to switch away from the TSC.

## getcpu() in the vDSO

`getcpu(cpu, node, NULL)` returns the current CPU and NUMA node without a syscall. On x86-64, `__vdso_getcpu()`
uses either `RDPID` (if available, reads `MSR_TSC_AUX` directly) or `RDTSCP` (reads the TSC and stores
the CPU+NUMA node in ECX via `MSR_TSC_AUX`). The kernel sets `MSR_TSC_AUX` per-CPU via
`set_cpu_rdtscp_id()` during CPU bringup. No GS-relative memory access is involved — GS is a kernel-mode
register and userspace cannot access the kernel's GS base.

```c
/* arch/x86/entry/vdso/vgetcpu.c */
static __always_inline int __vdso_getcpu(unsigned *cpu, unsigned *node,
                                          struct getcpu_cache *unused)
{
    unsigned int p;

    /* RDPID: reads MSR_TSC_AUX into p (cpu | (node << 12)) */
    /* Falls back to RDTSCP if RDPID unavailable */
    p = __rdpid();    /* or RDTSCP ecx */

    if (cpu)
        *cpu = p & 0xfff;
    if (node)
        *node = p >> 12;
    return 0;
}
```

## Debugging vDSO issues

**strace always shows clock_gettime as a real syscall**: strace injects ptrace, which sets
`TIF_SYSCALL_TRACE` on the tracee. This causes the kernel to intercept the `syscall` instruction path, but
the vDSO *bypasses* `syscall` entirely — the vDSO function runs in userspace without ever entering the
kernel. strace therefore never sees vDSO-accelerated calls unless the vDSO falls back.

When the vDSO *does* fall back (e.g., `VDSO_CLOCKMODE_NONE`), strace will show the syscall normally.

**Disabling the vDSO for testing**:

```bash
# Boot parameter: disable vDSO entirely
# (add to kernel command line)
vdso=0

# Or at runtime for a single process via LD_PRELOAD:
# Override __vdso_clock_gettime with a version that calls the real syscall
```

**Verifying vDSO is active**:

```c
/* The AT_SYSINFO_EHDR auxiliary vector points to the vDSO ELF header.
   If it is absent, the vDSO was not mapped. */
#include <sys/auxv.h>
unsigned long vdso_addr = getauxval(AT_SYSINFO_EHDR);
printf("vDSO ELF at: 0x%lx\n", vdso_addr);
```

**Inspecting the vvar data**:

```bash
# The vvar page is not directly readable from userspace tools,
# but kernel debuggers can inspect the vdso_data struct:
# (crash or gdb with vmlinux)
# p *((struct vdso_data *)vdso_data_ptr)
```

## vsyscall: legacy fixed-address interface (x86-64 only)

Before the vDSO, x86-64 had the **vsyscall** page: code mapped at the fixed address `0xffffffffff600000`
that implemented `gettimeofday`, `time`, and `getcpu`. Because the address was fixed, it was trivially
exploitable for return-oriented programming (ROP) gadgets.

Modern kernels default to `vsyscall=emulate`: the page is not executable, but page faults at those addresses
are caught and emulated by the kernel. `vsyscall=none` returns `SIGSEGV`. `vsyscall=native` maps the page
executable (insecure, not recommended).

```bash
# Check vsyscall mode (shows in /proc/self/maps on kernels with vsyscall=emulate)
cat /proc/self/maps | grep vsyscall
# ffffffffff600000-ffffffffff601000 --xp 00000000 00:00 0  [vsyscall]
```

Only very old binaries (pre-2012 glibc, or statically linked against ancient libc) use the vsyscall page.
All modern software uses the vDSO exclusively.

## arm64 vDSO

arm64 has its own vDSO at `arch/arm64/kernel/vdso/`. The mechanism is identical — a vvar page with
`struct vdso_data`, a seqlock, and the same TSC-equivalent using the ARM generic timer (`CNTVCT_EL0`
counter register). The key difference:

- There is no vsyscall legacy on arm64.
- The fallback uses the `svc #0` instruction (arm64 system call) rather than `syscall`.
- arm64 supports `VDSO_CLOCKMODE_ARCHTIMER` using the always-on virtual counter.

The shared vDSO library code in `lib/vdso/gettimeofday.c` is compiled for both x86-64 and arm64; only the
hardware counter read (`__arch_get_hw_counter`) is architecture-specific.

## Further reading

### Kernel source

- [include/vdso/datapage.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/vdso/datapage.h) — `struct vdso_clock` and `struct vdso_time_data`: the current vvar layout. Note: current kernels no longer have a single combined `struct vdso_data` as shown earlier on this page — that layout was split into `vdso_clock` (per-clocksource seqlock state) and `vdso_time_data` (the top-level vvar struct) some time ago
- [include/vdso/helpers.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/vdso/helpers.h) — `vdso_read_begin()` / `vdso_read_retry()`: the seqlock read-side helpers
- [lib/vdso/gettimeofday.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/lib/vdso/gettimeofday.c) — `do_hres()`: the shared TSC-to-timespec read loop used by all architectures
- [arch/x86/entry/vdso/common/vclock_gettime.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/entry/vdso/common/vclock_gettime.c) — `__vdso_clock_gettime()` / `__vdso_gettimeofday()`: the x86-64 entry points
- [arch/x86/entry/vdso/common/vgetcpu.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/entry/vdso/common/vgetcpu.c) — `__vdso_getcpu()`
- [arch/x86/include/asm/vdso/gettimeofday.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/include/asm/vdso/gettimeofday.h) — `clock_gettime_fallback()` and `__arch_get_hw_counter()`: the real syscall fallback and the TSC read
- [arch/x86/include/asm/segment.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/include/asm/segment.h) — `vdso_read_cpunode()`: the actual LSL/RDPID CPU+node lookup used by `__vdso_getcpu()`
- [kernel/time/vsyscall.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/time/vsyscall.c) — `update_vsyscall()`: the kernel-side vvar update on every timer tick
- [arch/arm64/kernel/vdso](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/arm64/kernel/vdso) — arm64 vDSO implementation

### Man pages

- [`vdso(7)`](https://man7.org/linux/man-pages/man7/vdso.7.html) — overview of the vDSO mechanism and `AT_SYSINFO_EHDR` discovery
- [`clock_gettime(2)`](https://man7.org/linux/man-pages/man2/clock_gettime.2.html) — the syscall the vDSO accelerates
- [`gettimeofday(2)`](https://man7.org/linux/man-pages/man2/gettimeofday.2.html) — the syscall the vDSO accelerates
- [`getcpu(2)`](https://man7.org/linux/man-pages/man2/getcpu.2.html) — NOTES section documents the vDSO-backed fast path
- [`getauxval(3)`](https://man7.org/linux/man-pages/man3/getauxval.3.html) — `AT_SYSINFO_EHDR`, used to locate the vDSO at process start

### Related pages

- [Syscall Entry Path](syscall-entry.md) — KPTI and the cost of ring transitions
- [vDSO: Virtual Dynamic Shared Object](../mm/vdso.md) — companion mm-side page on vDSO mapping and per-architecture function tables
- [Timekeeping and Clocksources](../time/timekeeping.md) — TSC, clocksource, and NTP background behind the vvar update
- [Time Namespaces](../time/time-namespaces.md) — the `timens_offset` mechanism referenced in the vvar layout

### LWN articles

- [On vsyscalls and the vDSO](https://lwn.net/Articles/446528/) — the security case for retiring the fixed-address vsyscall page in favor of the vDSO
- [Implementing virtual system calls](https://lwn.net/Articles/615809/) — how `__vdso_gettimeofday()` and `__vdso_clock_gettime()` work, and how to add new vDSO functions

### External

- [Kernel boot parameters: `vdso=` and `vsyscall=`](https://docs.kernel.org/admin-guide/kernel-parameters.html) — official documentation for the `vdso=0` and `vsyscall={emulate,xonly,none}` boot options
