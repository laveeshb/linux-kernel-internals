# Fault Injection for Memory Testing

> Deliberately failing kernel allocations to exercise error-handling paths

## What Is Fault Injection?

Fault injection is the practice of deliberately causing kernel operations to fail in order to test whether the error-handling paths in drivers and subsystems work correctly. The Linux kernel has a built-in fault injection framework that makes this systematic: you configure failure probability, scope, and targeting, and the kernel starts randomly failing specific operations.

The most common use is injection of memory allocation failures — making `kmalloc()`, `alloc_pages()`, and related calls return `NULL` or `-ENOMEM`. A well-written driver must handle these failures gracefully (free any partial allocations, return an error, not panic). A poorly written driver will oops, leak memory, or silently corrupt state. Fault injection reveals which category your code falls into.

!!! tip "Why this matters"
    Error paths are notoriously undertested. A driver may have a `goto err_free` path that has never executed in practice. Fault injection exercises those paths under controlled conditions, ideally in a VM, before a real allocation failure exposes them in production.

## The Fault Injection Framework

### Kernel Configuration

```
# Core fault injection infrastructure
CONFIG_FAULT_INJECTION=y
CONFIG_FAULT_INJECTION_DEBUG_FS=y     # debugfs interface (required for runtime control)
CONFIG_FAULT_INJECTION_STACKTRACE_FILTER=y  # filter by call site (requires CONFIG_STACKTRACE=y)

# Specific fault types
CONFIG_FAILSLAB=y          # Fail kmalloc / kmem_cache_alloc (slab allocations)
CONFIG_FAIL_PAGE_ALLOC=y   # Fail alloc_pages / get_free_pages (page allocator)
CONFIG_FAIL_FUTEX=y        # Fail futex operations (for futex error path testing)
CONFIG_FAIL_MAKE_REQUEST=y # Fail block I/O requests (bio layer)
CONFIG_FAIL_IO_TIMEOUT=y   # Inject I/O timeouts
CONFIG_FAIL_SUNRPC=y       # Fail SunRPC calls (NFS testing)
```

The framework's core lives in [`lib/fault-inject.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/lib/fault-inject.c). Individual subsystem hooks are in:

- [`mm/failslab.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/failslab.c) — slab allocation failures
- [`mm/fail_page_alloc.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/fail_page_alloc.c) — page allocator failures

### How the Framework Decides Whether to Fail

The framework evaluates a set of configurable attributes on each call to `should_fail()`:

```
should_fail() decision logic (lib/fault-inject.c):

  1. Is fault injection enabled? (probability > 0)
  2. Are we past the initial no-fail period? (interval counter)
  3. Does the random draw pass probability check?
  4. Is the call site in the stack trace filter? (if configured)
  5. Is this process/task marked make-it-fail? (if using per-task control)
  6. → YES to all: return true (fail this call)
```

Each of these is tunable via debugfs or per-task files.

## The debugfs Interface

When `CONFIG_FAULT_INJECTION_DEBUG_FS=y` is enabled, each fault type exposes a directory under `/sys/kernel/debug/`:

```
/sys/kernel/debug/
├── fail_page_alloc/
│   ├── probability        ← integer 0-100 (percent chance of failure per call)
│   ├── interval           ← fail at most 1 in N calls (0 = no limit)
│   ├── times              ← how many times to fail (-1 = unlimited)
│   ├── space              ← minimum free memory (KB) needed before injecting
│   ├── verbose            ← 0=quiet, 1=log failures, 2=log + stack trace
│   ├── task-filter        ← if 1: only fail tasks with make-it-fail=1
│   └── stacktrace-depth   ← how many stack frames to inspect for filtering
├── failslab/
│   ├── probability
│   ├── interval
│   ├── times
│   ├── space
│   ├── verbose
│   ├── cache-filter       ← if 1: use per-cache sysfs enable/disable
│   └── task-filter
└── fail_make_request/
    ├── probability
    ├── interval
    ├── times
    └── verbose
```

### Attribute Reference

| Attribute | Type | Meaning |
|-----------|------|---------|
| `probability` | 0–100 | Percentage chance each eligible call fails |
| `interval` | integer ≥ 0 | Skip the first N calls before starting to fail; 0 = no skip |
| `times` | integer | Number of times to inject failures; `-1` = unlimited |
| `space` | integer (KB) | Minimum free memory below which injection is skipped (avoids injecting during real OOM) |
| `verbose` | 0, 1, 2 | `0` = no output; `1` = log each failure; `2` = log + dump stack trace |
| `task-filter` | 0 or 1 | If `1`, only fail allocations made by tasks that have set `/proc/<pid>/make-it-fail` |

### Quick-Start: Fail All Page Allocations at 10%

```bash
# Mount debugfs if not already mounted
mount -t debugfs none /sys/kernel/debug

# Enable fail_page_alloc: 10% probability, unlimited times
echo 10  > /sys/kernel/debug/fail_page_alloc/probability
echo -1  > /sys/kernel/debug/fail_page_alloc/times
echo  0  > /sys/kernel/debug/fail_page_alloc/interval
echo  1  > /sys/kernel/debug/fail_page_alloc/verbose

# Confirm settings
cat /sys/kernel/debug/fail_page_alloc/probability
```

!!! warning
    Setting a high probability (>20%) system-wide without `task-filter` will cause rapid system instability. Use `task-filter=1` and `/proc/self/make-it-fail` for safe, targeted injection. Reserve global injection for dedicated test VMs.

## Targeting Specific Processes

The coarsest injection mode (no task filter) randomly fails allocations from any kernel context, which quickly destabilizes the system. For driver testing, you almost always want to restrict injection to a specific process.

### /proc/self/make-it-fail

Every task has a `make-it-fail` file in `/proc`:

```bash
# Enable injection for this shell and all processes it spawns
echo 1 > /proc/self/make-it-fail

# Run the driver load (only this process and its children are affected)
insmod my_driver.ko

# Disable injection for this shell
echo 0 > /proc/self/make-it-fail
```

For this to work, `task-filter` must also be set in the fault injector:

```bash
echo 1 > /sys/kernel/debug/failslab/task-filter
echo 1 > /proc/self/make-it-fail
```

The `make-it-fail` flag is inherited by child processes (fork/exec), so a test script that sets it before launching a target binary will inject failures into the entire subprocess tree.

### Targeting a Specific PID

```bash
# Target an already-running process
echo 1 > /proc/<pid>/make-it-fail
```

## Filtering by Call Site

With `CONFIG_FAULT_INJECTION_STACKTRACE_FILTER=y`, you can restrict injection to allocations that pass through a specific function in the call stack. This is powerful for testing one driver without destabilizing others.

The filter is configured via debugfs files under the fault injector directory:

```bash
# Enable stack trace filtering for failslab
# Inject only when 'my_driver_probe' appears in the call stack
echo 1 > /sys/kernel/debug/failslab/stacktrace-depth
# (stacktrace-depth controls how many frames to inspect)
```

The stack trace filter works by reading the call stack at the point `should_fail()` is called and checking whether any frame matches a configured pattern. See [`lib/fault-inject.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/lib/fault-inject.c) — specifically `fail_stacktrace()` — for the implementation.

In practice, the stack filter is most often used via the helper script provided in the kernel tree.

## Practical Example: Testing kmalloc Failures in a Driver

The following walkthrough tests how a hypothetical driver handles `kmalloc` returning `NULL` during probe.

### Setup

```bash
# Boot a test VM with:
# CONFIG_FAILSLAB=y
# CONFIG_FAULT_INJECTION_DEBUG_FS=y
# CONFIG_FAULT_INJECTION_STACKTRACE_FILTER=y

# Step 1: Enable failslab with task-filter (safe — only affects marked tasks)
echo  1 > /sys/kernel/debug/failslab/task-filter
echo 10 > /sys/kernel/debug/failslab/probability
echo -1 > /sys/kernel/debug/failslab/times
echo  2 > /sys/kernel/debug/failslab/verbose   # print stack on each failure

# Step 2: Mark this shell as a fault injection target
echo 1 > /proc/self/make-it-fail

# Step 3: Load the driver (kmalloc calls from this process will fail ~10% of the time)
insmod my_driver.ko

# Step 4: Watch the kernel log for failures and errors
dmesg -w
```

### What to Look For in dmesg

A correctly written driver will log an error and return `-ENOMEM`:

```
my_driver: probe of 0000:01:00.0 failed with error -12
```

A buggy driver may:

- Oops (NULL pointer dereference from using the returned pointer without checking)
- Hang (waiting for a resource that was never acquired)
- Succeed silently but leak memory (if the error path skips a `kfree`)

### Iterating

Increase probability gradually to exercise more paths:

```bash
# Start conservative
echo 5 > /sys/kernel/debug/failslab/probability

# After verifying no oopses, increase
echo 20 > /sys/kernel/debug/failslab/probability
echo 50 > /sys/kernel/debug/failslab/probability
```

Use `times` to limit total failures during a single test run:

```bash
# Fail exactly once, then stop
echo 1 > /sys/kernel/debug/failslab/times
```

This is useful for bisecting: find the exact allocation failure that causes a regression.

## Using the Kernel's Helper Script

The kernel ships a helper script that sets up fault injection for a specific command using the `FAIL_POINT` mechanism with stack trace filtering:

```bash
# From the kernel tree:
tools/testing/fault-injection/failcmd.sh

# Example: run modprobe with slab fault injection at 20% probability
tools/testing/fault-injection/failcmd.sh --probability=20 -- modprobe my_driver
```

This script sets up the debugfs parameters, marks the process with `make-it-fail`, runs the command, and cleans up. It is the recommended way to do targeted injection without manually managing the debugfs files. See [`tools/testing/fault-injection/`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/tools/testing/fault-injection) in the kernel source.

## fail_make_request: Block I/O Failure Injection

`CONFIG_FAIL_MAKE_REQUEST` injects failures at the block I/O layer (the `submit_bio()` path). This tests how filesystems and block drivers handle I/O errors, which is distinct from memory allocation failures.

```bash
# Enable block I/O failure injection
echo 10 > /sys/kernel/debug/fail_make_request/probability
echo -1 > /sys/kernel/debug/fail_make_request/times
echo  1 > /sys/kernel/debug/fail_make_request/verbose

# Restrict to a specific device (by major:minor)
echo <major>:<minor> > /sys/block/<device>/make-it-fail
# Example:
echo 1 > /sys/block/sdb/make-it-fail
```

The per-device `make-it-fail` file (in `/sys/block/<device>/`) restricts injection to a specific block device, which is much safer than injecting system-wide. This is the recommended approach for filesystem error path testing.

Typical use cases:

- Testing filesystem journal recovery when writes fail
- Verifying RAID rebuild logic when a device reports errors
- Testing that database write-ahead logs handle I/O failures without corruption

## Fault Injection with Syzkaller

[Syzkaller](https://github.com/google/syzkaller) is the kernel's primary coverage-guided fuzzer. It integrates with the fault injection framework to automatically exercise error paths that its syscall sequences trigger.

Syzkaller uses fault injection through two mechanisms:

**1. Automatic injection via procfs**

Syzkaller can set `/proc/<pid>/make-it-fail` on the processes it spawns, combined with `failslab` and `fail_page_alloc` configured globally. This causes the syscall sequences to encounter allocation failures at random points, exposing unhandled error paths.

**2. Targeted injection via `KCOV` + fault point tracing**

When syzkaller identifies a code path of interest via coverage (`CONFIG_KCOV=y`), it can target fault injection to specific call sites that appear in the coverage data, methodically failing each allocation in a code path to check every error branch.

To configure a syzkaller VM for fault injection:

```
# In syzkaller config (syzkaller.cfg):
{
  "enable_syscalls": ["..."],
  "fault_injection": true
}
```

This sets `failslab/task-filter=1` and enables the framework automatically.

For fuzzing memory management specifically, the combination of `CONFIG_KASAN=y` + `CONFIG_FAILSLAB=y` + `CONFIG_FAIL_PAGE_ALLOC=y` catches both bugs triggered by normal allocation patterns (KASAN) and bugs only reachable through error paths (fault injection).

See [KASAN](kasan.md) and [KFENCE](kfence.md) for the sanitizers that syzkaller typically pairs with fault injection.

## Stress Testing with Fault Injection

For regression testing and robustness validation (as opposed to one-off debugging), running fault injection alongside a stress workload is more effective than injecting in idle conditions.

### Combined Stress + Injection

```bash
# Terminal 1: Enable slab fault injection (task-filter off — affects all)
echo 5  > /sys/kernel/debug/failslab/probability
echo -1 > /sys/kernel/debug/failslab/times
echo  0 > /sys/kernel/debug/failslab/task-filter
echo  1 > /sys/kernel/debug/failslab/verbose

# Terminal 2: Concurrent memory stress
stress-ng --vm 4 --vm-bytes 75% --vm-keep --timeout 60s &

# Terminal 3: Driver load/unload cycle
for i in $(seq 1 50); do
  insmod my_driver.ko 2>/dev/null
  rmmod my_driver 2>/dev/null
done

# Terminal 4: Watch for oopses
dmesg -w | grep -E "BUG|Oops|WARN|NULL pointer|general protection"
```

### Targeted Slab Cache Injection

If a driver allocates from a specific named cache, restrict injection to avoid collateral damage:

```bash
# Enable cache-filter mode
echo 1 > /sys/kernel/debug/failslab/cache-filter

# Enable injection only for the target cache
# (requires the sysfs entry to exist, i.e., the cache is already active)
echo 1 > /sys/kernel/slab/my_driver_cache/failslab
```

## Kernel Documentation

The authoritative reference for the fault injection framework is:

- [`Documentation/fault-injection/fault-injection.rst`](https://docs.kernel.org/fault-injection/fault-injection.html) — covers all debugfs parameters, the `make-it-fail` interface, stack trace filtering, and the `failcmd.sh` helper

## Key Source Files

| File | Description |
|------|-------------|
| [`lib/fault-inject.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/lib/fault-inject.c) | Core framework: `should_fail()`, probability/interval/times logic, debugfs setup |
| [`mm/failslab.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/failslab.c) | `CONFIG_FAILSLAB`: hook into slab allocator |
| [`mm/fail_page_alloc.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/fail_page_alloc.c) | `CONFIG_FAIL_PAGE_ALLOC`: hook into page allocator |
| [`include/linux/fault-inject.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/fault-inject.h) | `fault_attr` struct and `should_fail()` declaration |
| [`tools/testing/fault-injection/failcmd.sh`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/tools/testing/fault-injection/failcmd.sh) | Helper script for per-command injection |

## Quick Reference

```bash
# Slab injection, task-filtered (safe)
echo 1  > /sys/kernel/debug/failslab/task-filter
echo 20 > /sys/kernel/debug/failslab/probability
echo -1 > /sys/kernel/debug/failslab/times
echo 1  > /proc/self/make-it-fail
<run test>
echo 0  > /proc/self/make-it-fail

# Page allocator injection, task-filtered
echo 1  > /sys/kernel/debug/fail_page_alloc/task-filter
echo 10 > /sys/kernel/debug/fail_page_alloc/probability
echo -1 > /sys/kernel/debug/fail_page_alloc/times
echo 1  > /proc/self/make-it-fail
<run test>
echo 0  > /proc/self/make-it-fail

# Block device I/O injection (specific device)
echo 1  > /sys/block/sdb/make-it-fail
echo 5  > /sys/kernel/debug/fail_make_request/probability
echo -1 > /sys/kernel/debug/fail_make_request/times
<run filesystem test on sdb>
echo 0  > /sys/block/sdb/make-it-fail

# Disable all injection
echo 0 > /sys/kernel/debug/failslab/probability
echo 0 > /sys/kernel/debug/fail_page_alloc/probability
echo 0 > /sys/kernel/debug/fail_make_request/probability
```

## Further Reading

### Kernel Documentation

- [Fault injection capabilities infrastructure](https://docs.kernel.org/fault-injection/fault-injection.html) — complete reference for all parameters and interfaces

### Related

- [KASAN](kasan.md) — memory error detection; pair with fault injection to catch both normal bugs and error-path bugs in one test run
- [KFENCE](kfence.md) — low-overhead production memory safety; can run alongside fault injection in long-running stress tests
- [OOM debugging](oom-debugging.md) — diagnosing and preventing out-of-memory kills; fault injection can trigger OOM-adjacent conditions intentionally
- [page-poisoning](page-poisoning.md) — use-after-free detection; complements fault injection by verifying that freed memory is not reused incorrectly
