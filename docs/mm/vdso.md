# vDSO: Virtual Dynamic Shared Object

> Syscalls without entering the kernel: gettimeofday at userspace speed

## The problem

Every system call requires a mode switch: user → kernel → user. For `gettimeofday()`, this means:
- Save registers, change privilege level (CPL 0)
- Look up time in the kernel
- Restore registers, return to userspace

For high-frequency time queries (trading systems, profilers, game loops), this round-trip costs ~100-300ns. The vDSO eliminates it.

## What is the vDSO?

The vDSO (virtual dynamic shared object) is a small shared library that the kernel **maps into every process address space** automatically. It contains a few time-related functions implemented as pure userspace code that read from a kernel-maintained shared memory region — no syscall needed.

```bash
# See vDSO mapping in every process
cat /proc/self/maps | grep vdso
# 7fff12345000-7fff12346000 r-xp  [vdso]

# Extract and disassemble the vDSO
objcopy --dump-section .text=/tmp/vdso.so [vdso] /dev/null 2>/dev/null
# Or:
dd if=/proc/self/mem bs=4096 count=1 skip=$((0x7fff12345000/4096)) > /tmp/vdso.so
```

## Functions in the vDSO

```c
/* The vDSO exports these symbols (x86-64): */
__vdso_clock_gettime()    /* clock_gettime(CLOCK_REALTIME, ...)  — fast */
__vdso_clock_getres()     /* clock_getres()                      — fast */
__vdso_gettimeofday()     /* gettimeofday()                      — fast */
__vdso_time()             /* time()                              — fast */
__vdso_getcpu()           /* getcpu() — current CPU/NUMA node   — fast */

/* These call the vDSO instead of the kernel: */
/* glibc wraps all of these to use vDSO automatically */
```

## The vdso_data shared page

The kernel maintains a **vvar** (vDSO variable) page that is:
- Mapped read-only into every process
- Written by the kernel (holding current time)
- Read by the vDSO functions (no syscall)

```c
/* arch/x86/include/asm/vvar.h */
/* arch/x86/entry/vdso/vma.c */
struct vdso_data {
    u32 seq;              /* seqlock sequence counter */

    s32 clock_mode;       /* VDSO_CLOCKMODE_* */
    u64 cycle_last;       /* TSC value at last update */
    u64 mask;             /* TSC bitmask */
    u32 mult;             /* TSC → ns multiplier */
    u32 shift;            /* TSC → ns shift */

    /* Per-clockid data: */
    struct {
        u64 nsec;         /* sub-second nanoseconds */
        u64 sec;          /* seconds since epoch */
        u64 snsec;        /* CLOCK_MONOTONIC offsets */
    } basetime[VDSO_BASES];

    s32 tz_minuteswest;   /* timezone */
    s32 tz_dsttime;
    u32 hrtimer_res;
    u32 __unused;
};

/* Two copies for NMI safety: */
extern struct vdso_data _vdso_data[CS_BASES];  /* in vmlinux */
/* Mapped to [vvar] page in each process */
```

## The seqlock pattern

The kernel updates `vdso_data` while user code reads it concurrently. A **seqlock** ensures consistent reads:

```c
/* Kernel (timekeeping.c): write side */
void update_vsyscall(struct timekeeper *tk)
{
    struct vdso_data *vdata = __arch_get_k_vdso_data();

    /* Increment seq to odd: mark as "being updated" */
    vdso_write_begin(vdata);

    /* Update all fields */
    vdata->cycle_last = tk->tkr_mono.cycle_last;
    vdata->mult       = tk->tkr_mono.mult;
    vdata->shift      = tk->tkr_mono.shift;
    /* ... */

    /* Increment seq to even: "update complete" */
    vdso_write_end(vdata);
}
```

```c
/* vDSO userspace: read side (in [vdso] mapping) */
notrace static __always_inline int
do_hres(const struct vdso_data *vd, clockid_t clk, struct __kernel_timespec *ts)
{
    const struct vdso_timestamp *vdso_ts = &vd->basetime[clk];
    u64 cycles, ns;
    u32 seq;

    do {
        /* Read seq: must be even (not being updated) */
        seq = vdso_read_begin(vd);
        if (unlikely(vd->clock_mode == VDSO_CLOCKMODE_NONE))
            return -1;  /* fallback to syscall */

        /* Read TSC */
        cycles = __arch_get_hw_counter(vd->clock_mode, vd);

        /* Compute nanoseconds: (cycles - cycle_last) * mult >> shift */
        ns = vdso_ts->nsec;
        ns += (cycles - vd->cycle_last) * vd->mult;
        ns >>= vd->shift;

        ts->tv_sec  = vdso_ts->sec;
        ts->tv_nsec = ns;

    } while (unlikely(vdso_read_retry(vd, seq)));
    /* Retry if seq changed mid-read (kernel was updating) */

    return 0;
}
```

The retry loop is the key: if the kernel updated `vdso_data` during our read (seq changed), we retry. Typically 0 retries.

## AT_SYSINFO_EHDR: finding the vDSO

The kernel passes the vDSO address via the ELF auxiliary vector:

```c
/* Auxiliary vector entry at program startup */
AT_SYSINFO_EHDR = 33   /* address of the vDSO ELF header */

/* glibc reads this during startup: */
void __dl_discover_osversion(void)
{
    ElfW(Phdr) *phdr = (void *)getauxval(AT_SYSINFO_EHDR);
    /* dlopen-like loading of the vDSO */
}
```

```c
/* Read auxiliary vector from /proc/self/auxv: */
#include <sys/auxv.h>
unsigned long vdso_addr = getauxval(AT_SYSINFO_EHDR);
printf("vDSO at %#lx\n", vdso_addr);

/* Or parse /proc/self/auxv manually: */
#include <elf.h>
Elf64_auxv_t auxv;
int fd = open("/proc/self/auxv", O_RDONLY);
while (read(fd, &auxv, sizeof(auxv)) == sizeof(auxv)) {
    if (auxv.a_type == AT_SYSINFO_EHDR) {
        printf("vDSO ELF header at %#lx\n", auxv.a_un.a_val);
        break;
    }
}
```

## vDSO fallback to syscall

If the vDSO can't provide the answer (e.g., clock is not TSC-based, or it's a non-monotonic clock), it falls back to a real syscall:

```c
/* arch/x86/entry/vdso/vclock_gettime.c */
notrace int __vdso_clock_gettime(clockid_t clock, struct __kernel_timespec *ts)
{
    const struct vdso_data *vd = __arch_get_vdso_data();

    switch (clock) {
    case CLOCK_REALTIME:
    case CLOCK_MONOTONIC:
    case CLOCK_BOOTTIME:
    case CLOCK_TAI:
        /* Fast path via TSC */
        if (likely(do_hres(vd + clock, clock, ts) == 0))
            return 0;
        break;

    case CLOCK_REALTIME_COARSE:
    case CLOCK_MONOTONIC_COARSE:
        /* Coarse: just read from vdso_data without TSC */
        do_coarse(vd + clock, clock, ts);
        return 0;

    default:
        break;
    }

    /* Fallback: real syscall */
    return clock_gettime_fallback(clock, ts);
}
```

## Performance comparison

```c
/* Benchmark: syscall vs vDSO vs rdtsc */

/* syscall gettimeofday: ~150-300ns */
struct timeval tv;
gettimeofday(&tv, NULL);  /* uses vDSO automatically with glibc */

/* Direct vDSO call (same as gettimeofday with glibc): ~5-15ns */

/* Raw RDTSC (fastest, but no unit): ~2-5ns */
uint64_t t = __rdtsc();
```

```bash
# Measure gettimeofday latency
perf stat -e syscalls:sys_enter_gettimeofday -- \
    python3 -c "import time; [time.time() for _ in range(1000000)]"
# syscalls:sys_enter_gettimeofday: 0  (zero syscalls — all vDSO!)

# Force syscall path (bypass vDSO):
LD_PRELOAD=/lib/x86_64-linux-gnu/libpthread.so.0  # doesn't work anymore
# Use seccomp to intercept, or strace:
strace -c -e gettimeofday myprogram  # will show 0 if vDSO is working
```

## vDSO on other architectures

The vDSO is architecture-specific:

| Architecture | vDSO functions |
|-------------|---------------|
| x86-64 | clock_gettime, gettimeofday, time, getcpu |
| ARM64 | clock_gettime, gettimeofday, clock_getres |
| RISC-V | clock_gettime, gettimeofday |
| Power | clock_gettime, gettimeofday, getcpu |
| s390 | clock_gettime, gettimeofday |

```bash
# ARM64 vDSO functions
nm /proc/self/mem 2>/dev/null | grep vdso || \
    objdump -d /proc/self/mem 2>/dev/null | head
# Or:
cat /proc/self/maps | grep vdso
# Extract and inspect:
dd if=/proc/self/mem of=/tmp/vdso.so bs=4096 count=1 \
   skip=$(($(cat /proc/self/maps | grep vdso | cut -d- -f1 | head -1 | xargs printf '%d')/4096)) 2>/dev/null
nm /tmp/vdso.so
```

## Further reading

- [Timekeeping and Clocksources](../time/timekeeping.md) — how the kernel maintains time
- [Process Address Space](mmap.md) — vDSO VMA in process maps
- [What happens during exec()](exec.md) — AT_SYSINFO_EHDR in the auxiliary vector
- [Syscall Entry Path](../syscalls/syscall-entry.md) — when vDSO falls back to syscall
- `arch/x86/entry/vdso/` — x86-64 vDSO implementation
- `include/vdso/datapage.h` — struct vdso_data
