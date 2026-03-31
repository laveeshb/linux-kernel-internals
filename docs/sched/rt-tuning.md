# Real-Time Linux Tuning Guide

> Achieving deterministic low-latency with PREEMPT_RT: CPU isolation, memory locking, and IRQ management

## What "real-time" means on Linux

A real-time system guarantees a **worst-case response time** — not just average latency. Linux with PREEMPT_RT can achieve:
- `cyclictest` worst-case latency: **10-100µs** (vs 1-100ms without RT)
- Suitable for: audio processing, industrial control, motor drives, trading systems

The key components:
1. `PREEMPT_RT` kernel (sleeping spinlocks, threaded IRQs)
2. CPU isolation (no kernel threads, no interrupts)
3. Memory locking (no page faults)
4. High-priority SCHED_FIFO tasks
5. Disabled CPU frequency scaling

## Step 1: Install PREEMPT_RT kernel

```bash
# Check if current kernel has RT:
uname -v | grep -i preempt
# #1 SMP PREEMPT_RT ... → RT kernel
# #1 SMP PREEMPT ...    → non-RT full preemption

# Debian/Ubuntu: install RT kernel
apt-get install linux-image-rt-amd64
# or build from source with CONFIG_PREEMPT_RT=y

# Verify RT features:
zcat /proc/config.gz | grep -E "PREEMPT_RT|PREEMPT_LAZY"
# CONFIG_PREEMPT_RT=y

# Check for RT patches not in mainline:
# For older kernels: https://wiki.linuxfoundation.org/realtime/start
```

## Step 2: CPU isolation with boot parameters

```bash
# /etc/default/grub:
GRUB_CMDLINE_LINUX="isolcpus=2,3 nohz_full=2,3 rcu_nocbs=2,3 irqaffinity=0,1"
# Update grub:
update-grub && reboot

# After reboot:
# - CPUs 2,3: isolated from load balancer, tickless
# - CPUs 0,1: handle all interrupts, kernel threads
# - irqaffinity=0,1: IRQs only on CPUs 0,1

# Verify isolation:
cat /sys/devices/system/cpu/isolated    # 2,3
cat /sys/devices/system/cpu/nohz_full   # 2,3
```

## Step 3: Move kernel threads off RT CPUs

```bash
# Move all movable kernel threads to CPUs 0,1:
for pid in $(ps -eo pid,comm | grep -E "^\s*[0-9]+ \[" | awk '{print $1}'); do
    taskset -p 3 $pid 2>/dev/null  # mask=0x3 = CPUs 0,1
done

# Or use tuna (recommended):
tuna --cpus=2,3 --isolate   # moves all non-isolated tasks away

# Verify: no kernel threads on CPUs 2,3
ps -eo pid,psr,comm | awk '$2==2 || $2==3' | grep "\["
# (should be empty or only [irq/...] which will be moved next)
```

## Step 4: IRQ affinity

```bash
# Move all interrupts to CPUs 0,1:
for irq_dir in /proc/irq/*/; do
    irq=$(basename $irq_dir)
    [ "$irq" = "0" ] && continue  # keep timer on CPU 0
    cat $irq_dir/smp_affinity_list 2>/dev/null | grep -q "[23]" && \
        echo "0,1" > $irq_dir/smp_affinity_list 2>/dev/null
done

# Stop irqbalance from undoing this:
systemctl stop irqbalance
systemctl disable irqbalance

# Verify:
cat /proc/interrupts | awk 'NR>1{print $1, $NF}' | head -20
```

## Step 5: Memory locking (prevent page faults)

Page faults are unpredictable. Real-time applications must lock all memory:

```c
#include <sys/mman.h>
#include <sched.h>

/* Lock all current and future pages */
mlockall(MCL_CURRENT | MCL_FUTURE);
/* MCL_CURRENT: lock existing mappings */
/* MCL_FUTURE: lock all future mmap/malloc */

/* Pre-fault the stack */
#define STACK_SIZE (8 * 1024 * 1024)  /* 8MB */
char stack_prefault[STACK_SIZE];
memset(stack_prefault, 0, sizeof(stack_prefault));

/* Pre-fault heap (malloc will use pages already touched) */
void *heap = malloc(HEAP_SIZE);
memset(heap, 0, HEAP_SIZE);

/* Now: no page faults during RT operation */
```

```bash
# System-wide: allow unlimited locked memory for RT tasks
# /etc/security/limits.conf:
echo "@realtime - memlock unlimited" >> /etc/security/limits.conf
# Or just for root (already unlimited usually)
```

## Step 6: SCHED_FIFO task priority

```c
#include <sched.h>

/* Set SCHED_FIFO priority 80 (out of 1-99) */
struct sched_param param = { .sched_priority = 80 };
sched_setscheduler(0, SCHED_FIFO, &param);
/* SCHED_FIFO: runs until it blocks or yields; preempts SCHED_OTHER */
/* SCHED_RR: like FIFO but with a time quantum (round-robin within priority) */

/* Pin to isolated CPU 2 */
cpu_set_t cpuset;
CPU_ZERO(&cpuset);
CPU_SET(2, &cpuset);
sched_setaffinity(0, sizeof(cpuset), &cpuset);

/* Main RT loop */
while (1) {
    clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &next_activation, NULL);

    /* Do real-time work here */
    do_work();

    /* Calculate next activation */
    next_activation.tv_nsec += PERIOD_NS;
    if (next_activation.tv_nsec >= 1000000000LL) {
        next_activation.tv_nsec -= 1000000000LL;
        next_activation.tv_sec++;
    }
}
```

```bash
# Set process priority from shell:
chrt -f 80 ./my_rt_program    # SCHED_FIFO prio 80
chrt -r 80 ./my_rt_program    # SCHED_RR prio 80
chrt -d --sched-deadline 1000000 --sched-period 10000000 --sched-runtime 500000 ./my_rt_prog

# Check:
chrt -p <pid>
# scheduling policy: SCHED_FIFO
# scheduling priority: 80
```

## Step 7: Disable CPU frequency scaling

CPU frequency changes add latency:

```bash
# Set performance governor on all CPUs:
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo performance > $cpu 2>/dev/null
done

# Disable turbo boost (can cause frequency spikes):
echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo
# or:
echo 0 > /sys/devices/system/cpu/cpufreq/boost

# Verify:
cat /sys/devices/system/cpu/cpu2/cpufreq/scaling_governor
# performance
cat /proc/cpuinfo | grep MHz | head -4
# All CPUs at max fixed frequency
```

## Measuring latency with cyclictest

`cyclictest` is the standard tool for measuring scheduling latency:

```bash
# Install:
apt install rt-tests

# Basic test: measure wakeup latency on isolated CPU 2
cyclictest --cpu=2 --priority=80 --policy=fifo \
           --interval=1000 --duration=60 \
           --mlockall --threads=1 \
           --histogram=200 --histfile=/tmp/hist.dat

# Output:
# T: 0 ( 1234) P:80 I:1000 C:  60000 Min:      8 Act:     12 Avg:     11 Max:      87
#                                                      ↑           ↑           ↑
#                                                   min µs      avg µs      max µs

# With RT kernel + isolation: Max should be < 100µs
# Without: Max can be > 1ms

# Stress test: run with load to find worst case
cyclictest --cpu=2 -p80 -i1000 -d60 -m -q &
# Simultaneously generate load:
hackbench -l 100000 &
stress-ng --cpu 6 --io 4 --vm 2 --vm-bytes 256M &
```

### Generating latency histogram

```bash
# Run with histogram output
cyclictest -p80 -m -n -i200 -l1000000 --histogram=200 > /tmp/histogram.dat

# Plot with gnuplot:
cat << 'EOF' > plot.gp
set terminal png
set output "latency_histogram.png"
set xlabel "Latency (µs)"
set ylabel "Frequency"
plot '/tmp/histogram.dat' using 1:2 with histeps
EOF
gnuplot plot.gp
```

## Diagnosing latency spikes

```bash
# Trace long preemption-disabled periods (> threshold µs):
echo preemptirqsoff > /sys/kernel/debug/tracing/current_tracer
echo 50 > /sys/kernel/debug/tracing/tracing_thresh  # 50µs threshold
cat /sys/kernel/debug/tracing/trace | head -30

# Trace scheduling latency with bpftrace:
bpftrace -e '
tracepoint:sched:sched_wakeup
/args->pid == target_pid/
{ @wakeup_ts = nsecs; }

tracepoint:sched:sched_switch
/args->next_pid == target_pid && @wakeup_ts/
{
    @lat_us = hist((nsecs - @wakeup_ts) / 1000);
    delete(@wakeup_ts);
}'

# hwlatdetect: detect hardware-caused latencies (SMI, BIOS)
hwlatdetect --duration=60 --threshold=50
# Detects System Management Interrupts (SMIs) that stall the CPU
```

## SMI: the worst enemy of real-time

**System Management Interrupts (SMIs)** are generated by the BIOS/UEFI and run in System Management Mode (SMM) — completely invisible to the OS and cannot be disabled by the kernel:

```bash
# Detect SMI activity:
hwlatdetect --duration=60 --threshold=100
# DETECTED: 3 latency spikes above threshold
# Spike: duration=150µs
# This is likely an SMI!

# Workaround: disable SMIs in BIOS/UEFI settings
# (vendor-specific, often under "System Management Mode" or "Intel TXT")

# Intel: can use MSR to monitor SMI count:
rdmsr -a 0x34  # MSR_SMI_COUNT (per-CPU SMI counter)
```

## Full RT configuration checklist

```bash
# Check all RT prerequisites:
cat << 'EOF' > check_rt.sh
#!/bin/bash
echo "=== Kernel PREEMPT_RT ==="
uname -v | grep -qi preempt_rt && echo "OK: PREEMPT_RT active" || echo "FAIL: Not PREEMPT_RT"

echo "=== CPU Isolation ==="
[ -s /sys/devices/system/cpu/isolated ] && \
    echo "OK: isolated=$(cat /sys/devices/system/cpu/isolated)" || \
    echo "WARN: No CPU isolation"

echo "=== Frequency Scaling ==="
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null | \
    grep -q performance && echo "OK: performance governor" || \
    echo "WARN: Not performance governor"

echo "=== IRQBalance ==="
systemctl is-active irqbalance 2>/dev/null | \
    grep -q inactive && echo "OK: irqbalance stopped" || \
    echo "WARN: irqbalance running"

echo "=== Turbo/Boost ==="
[ "$(cat /sys/devices/system/cpu/intel_pstate/no_turbo 2>/dev/null)" = "1" ] && \
    echo "OK: turbo disabled" || echo "WARN: turbo may be enabled"
EOF
bash check_rt.sh
```

## Further reading

- [Preemption Model](preemption.md) — PREEMPT_RT internals
- [IRQ Affinity and CPU Isolation](../interrupts/irq-affinity.md) — IRQ management
- [CPU Affinity](cpu-affinity.md) — SCHED_FIFO and task pinning
- [SCHED_DEADLINE](deadline.md) — EDF scheduling for hard real-time
- [RT Scheduler](rt-scheduler.md) — SCHED_FIFO/SCHED_RR internals
- [The Scheduling Tick](sched-tick.md) — NOHZ_FULL for tickless CPUs
- `rtl/cyclictest` — latency measurement tool
