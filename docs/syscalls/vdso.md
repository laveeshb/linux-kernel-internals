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

## struct vdso_time_data and struct vdso_clock

There is no single combined `struct vdso_data` in current kernels. The vvar page is `struct vdso_time_data`,
and the per-clocksource seqlock state it holds an array of is `struct vdso_clock` — both defined in
`include/vdso/datapage.h`:

```c
/* include/vdso/datapage.h */
struct vdso_clock {
    u32             seq;            /* seqlock sequence counter */
    s32             clock_mode;     /* VDSO_CLOCKMODE_TSC, _PVCLOCK, _HVCLOCK, _NONE */
    u64             cycle_last;     /* TSC value at last update */
#ifdef CONFIG_GENERIC_VDSO_OVERFLOW_PROTECT
    u64             max_cycles;     /* largest safe delta before the multiply could overflow */
#endif
    u64             mask;           /* TSC mask (for 32-bit counters) */
    u32             mult;           /* TSC-to-ns multiplier */
    u32             shift;          /* right-shift for mult */
    union {
        struct vdso_timestamp   basetime[VDSO_BASES]; /* per-clock base */
        struct timens_offset    offset[VDSO_BASES];   /* time namespace offsets */
    };
};

struct vdso_time_data {
    struct arch_vdso_time_data  arch_data;               /* architecture-specific */
    struct vdso_clock           clock_data[CS_BASES];     /* one per clocksource */
    struct vdso_clock           aux_clock_data[MAX_AUX_CLOCKS]; /* auxiliary clocksources */
    s32                         tz_minuteswest; /* timezone */
    s32                         tz_dsttime;
    u32                         hrtimer_res;    /* hrtimer resolution in ns */
    u32                         __unused;
};

struct vdso_timestamp {
    u64     sec;    /* base seconds */
    u64     nsec;   /* base nanoseconds (scaled) */
};
```

`VDSO_BASES` is the number of supported clock IDs; each `vdso_clock`'s `basetime[]` holds one entry per
clock ID. `CS_BASES` is the number of clocksource "bases" the top-level page tracks (hi-res and its coarse
counterpart) — `clock_data[CS_BASES]` is what used to be a single embedded seqlock inside one big struct,
before the vdso_clock/vdso_time_data split separated "per-clocksource state that gets its own seqlock" from
"page-wide data updated once."

## The seqlock pattern

Because the kernel updates the vvar page from timer interrupt context (and possibly from multiple CPUs),
the vDSO must handle concurrent reads. It uses a **seqlock** — a lockless read-side protocol — scoped to
each `vdso_clock`, not a raw `seqcount_t`/`seqcount_latch_t`. `include/vdso/helpers.h` implements the
retry loop by hand with `READ_ONCE()`/`cpu_relax()`/`smp_rmb()`, rather than calling out to the generic
seqcount-latch helpers:

```c
/* include/vdso/helpers.h */
static __always_inline u32 vdso_read_begin(const struct vdso_clock *vc)
{
    u32 seq;

    while (unlikely((seq = READ_ONCE(vc->seq)) & 1))
        cpu_relax();   /* odd sequence number: a writer is mid-update, spin */

    smp_rmb();
    return seq;
}

static __always_inline u32 vdso_read_retry(const struct vdso_clock *vc, u32 start)
{
    u32 seq;

    smp_rmb();
    seq = READ_ONCE(vc->seq);
    return unlikely(seq != start);
}
```

A typical clock read then looks like this — `do_hres()` (`lib/vdso/gettimeofday.c`) drives the seqlock
loop, and delegates the actual TSC-to-nanoseconds math to `vdso_get_timestamp()` in the same file:

```c
/* lib/vdso/gettimeofday.c */
bool do_hres(const struct vdso_time_data *vd, const struct vdso_clock *vc,
             clockid_t clk, struct __kernel_timespec *ts)
{
    u64 sec, ns;
    u32 seq;

    do {
        seq = vdso_read_begin(vc);
        if (!vdso_get_timestamp(vd, vc, clk, &sec, &ns))
            return false;   /* clock_mode == VDSO_CLOCKMODE_NONE: caller falls back to a real syscall */
    } while (vdso_read_retry(vc, seq));

    vdso_set_timespec(ts, sec, ns);
    return true;
}

static __always_inline bool
vdso_get_timestamp(const struct vdso_time_data *vd, const struct vdso_clock *vc,
                    unsigned int clkidx, u64 *sec, u64 *ns)
{
    const struct vdso_timestamp *vdso_ts = &vc->basetime[clkidx];
    u64 cycles;

    if (unlikely(!vdso_clocksource_ok(vc)))
        return false;

    cycles = __arch_get_hw_counter(vc->clock_mode, vd);
    if (unlikely(!vdso_cycles_ok(cycles)))
        return false;

    *ns  = vdso_calc_ns(vc, cycles, vdso_ts->nsec);  /* TSC delta → ns, multiply-and-shift */
    *sec = vdso_ts->sec;
    return true;
}
```

(The real `do_hres()` also has a time-namespace branch, checked via `vdso_read_begin_timens()` before the
loop above, that this sketch leaves out.) `vdso_read_begin()` reads the sequence counter and spins while it
is odd (a writer holds the lock). `vdso_read_retry()` reads the counter again and returns true if it has
changed, meaning a kernel update happened mid-read and the values are inconsistent. The loop retries until
a clean read completes — in practice, zero or one retries.

## TSC to wall-clock conversion

`vdso_get_timestamp()` calls `vdso_calc_ns()` to do the nanosecond conversion — a multiply-and-shift
formula that avoids division:

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
vDSO detects this and calls `clock_gettime_fallback()`, which is arch-specific — on x86-64 it lives in
`arch/x86/include/asm/vdso/gettimeofday.h`, not the shared `lib/vdso/gettimeofday.c`, because the vDSO runs
without a libc and can't call libc's `syscall()`: it issues the real syscall instruction directly through
the `VDSO_SYSCALL2()` macro instead:

```c
/* arch/x86/include/asm/vdso/gettimeofday.h */
static __always_inline
long clock_gettime_fallback(clockid_t _clkid, struct __kernel_timespec *_ts)
{
    return VDSO_SYSCALL2(clock_gettime, 64, _clkid, _ts);
}
```

This fallback is transparent to the caller — the function signature and return value are identical.
`VDSO_CLOCKMODE_NONE` can also be triggered manually by writing to
`/sys/devices/system/clocksource/clocksource0/current_clocksource` to switch away from the TSC.

## getcpu() in the vDSO

`getcpu(cpu, node, NULL)` returns the current CPU and NUMA node without a syscall. On x86-64,
`__vdso_getcpu()` delegates to `vdso_read_cpunode()` (`arch/x86/include/asm/segment.h`), which defaults to
the `LSL` instruction — reading a CPU/node-encoding descriptor limit out of a per-CPU GDT entry — and uses
`RDPID` instead when the CPU supports it, via `alternative_io`. `RDTSCP` is not used for this at all; LSL
was chosen specifically because it's faster than RDTSCP and works on every CPU. The per-CPU setup function
`setup_getcpu()` (`arch/x86/kernel/cpu/common.c`) both programs that GDT entry *and* writes `MSR_TSC_AUX`
(RDPID reads this MSR directly) when the CPU has `RDTSCP` or `RDPID`. No GS-relative memory access is
involved — GS is a kernel-mode register and userspace cannot access the kernel's GS base.

```c
/* arch/x86/entry/vdso/common/vgetcpu.c */
notrace long __vdso_getcpu(unsigned *cpu, unsigned *node, void *unused)
{
    vdso_read_cpunode(cpu, node);
    return 0;
}

/* arch/x86/include/asm/segment.h */
static inline void vdso_read_cpunode(unsigned *cpu, unsigned *node)
{
    unsigned long p;

    /* LSL is faster than RDTSCP and works on all CPUs; use RDPID instead if available */
    alternative_io("lsl %[seg],%k[p]", "rdpid %[p]", X86_FEATURE_RDPID,
                    [p] "=r" (p), [seg] "r" (__CPUNODE_SEG));

    if (cpu)
        *cpu = p & VDSO_CPUNODE_MASK;   /* 0xfff */
    if (node)
        *node = p >> VDSO_CPUNODE_BITS; /* 12 */
}
```

## Debugging vDSO issues

**strace always shows clock_gettime as a real syscall**: strace injects ptrace, which sets
`SYSCALL_WORK_SYSCALL_TRACE` on the tracee. This causes the kernel to intercept the `syscall` instruction path, but
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
# but kernel debuggers can inspect the vdso_time_data struct:
# (crash or gdb with vmlinux)
# p *((struct vdso_time_data *)vdso_data_ptr)
```

## vsyscall: legacy fixed-address interface (x86-64 only)

Before the vDSO, x86-64 had the **vsyscall** page: code mapped at the fixed address `0xffffffffff600000`
that implemented `gettimeofday`, `time`, and `getcpu`. Because the address was fixed, it was trivially
exploitable for return-oriented programming (ROP) gadgets.

There are three modes, controlled by the `vsyscall=` boot parameter — there is no `native` mode any more.
The kernel's own default, `CONFIG_LEGACY_VSYSCALL_XONLY`, is `vsyscall=xonly`: the page traps and emulates
execution but denies reads, closing off the use of the vsyscall page's fixed address as a data-read gadget.
`vsyscall=emulate` (execution trapped and emulated, reads also allowed) still exists but is deprecated and
selectable only from the command line, not as a build-time default. `vsyscall=none` removes the mapping
entirely — old binaries that need it get `SIGSEGV`.

```bash
# Check vsyscall mode (shows in /proc/self/maps whenever the mapping exists at all)
cat /proc/self/maps | grep vsyscall
# ffffffffff600000-ffffffffff601000 --xp 00000000 00:00 0  [vsyscall]
```

Only very old binaries (pre-2012 glibc, or statically linked against ancient libc) use the vsyscall page.
All modern software uses the vDSO exclusively.

## arm64 vDSO

arm64 has its own vDSO at `arch/arm64/kernel/vdso/`. The mechanism is identical — a vvar page with the same
`struct vdso_time_data`/`struct vdso_clock` layout, a seqlock, and the same TSC-equivalent using the ARM
generic timer (`CNTVCT_EL0` counter register). The key difference:

- There is no vsyscall legacy on arm64.
- The fallback uses the `svc #0` instruction (arm64 system call) rather than `syscall`.
- arm64 supports `VDSO_CLOCKMODE_ARCHTIMER` using the always-on virtual counter.

The shared vDSO library code in `lib/vdso/gettimeofday.c` is compiled for both x86-64 and arm64; only the
hardware counter read (`__arch_get_hw_counter`) is architecture-specific.

## Further reading

### Kernel source

- [include/vdso/datapage.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/vdso/datapage.h) — `struct vdso_clock` and `struct vdso_time_data`: the current vvar layout, replacing an older single combined `struct vdso_data`
- [include/vdso/helpers.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/vdso/helpers.h) — `vdso_read_begin()` / `vdso_read_retry()`: the seqlock read-side helpers
- [lib/vdso/gettimeofday.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/lib/vdso/gettimeofday.c) — `do_hres()` and `vdso_get_timestamp()`: the shared seqlock-guarded, TSC-to-timespec read path used by all architectures
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
