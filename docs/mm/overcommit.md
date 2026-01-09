# Memory Overcommit: Why It's the Only Sane Default

> The real question isn't "why overcommit" - it's "why would you NOT overcommit"

## The Real Question

You have 8GB of RAM. A program calls `malloc(16GB)`. Should the kernel refuse?

On most Linux systems (with default settings), this allocation is allowed. But the question isn't "why does Linux do this crazy thing?" The question is: **what's the alternative?**

## Without Overcommit, fork() Breaks

The answer starts with `fork()` and [copy-on-write](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memory.c) (COW).

When you `fork()`, the child gets a copy of the parent's address space - but no pages are actually copied until one process writes to them (see `copy_present_pte()`). This is COW, and it's essential for Unix.

But here's the problem: without overcommit, the kernel must **reserve** physical memory for all those potential copies at fork time. A 3GB process on a 4GB system couldn't fork - even if the child immediately calls `exec()` and discards everything.

That would be insane. So overcommit exists.

Once you accept overcommit for fork(), extending it to general allocations is a small step:
1. Sparse arrays work (map 1GB, touch 10MB)
2. Memory-mapped files don't require RAM for unread pages
3. Programs that reserve-then-use (like JVMs) don't waste memory

## The fork() Example

Consider `fork()`:

```c
// Parent process using 4GB of RAM
pid_t pid = fork();
// Child is created with a copy of 4GB address space
if (pid == 0) {
    char *args[] = {"/bin/ls", NULL};
    execve("/bin/ls", args, NULL);  // Immediately replaces address space
}
```

Without overcommit, `fork()` would need 8GB total (4GB parent + 4GB child) even though the child immediately calls `exec()` and discards its copy.

With copy-on-write and overcommit:
- Child shares parent's pages (no copy yet)
- `exec()` replaces address space before any copy happens
- Actual memory needed: ~4GB (not 8GB)

## How Overcommit Works

When a process requests memory via `mmap()` or `brk()` (the actual syscalls - `malloc()` is a userspace wrapper that calls these), the kernel:

1. **Creates a VMA** - A `vm_area_struct` describing the region (defined in [include/linux/mm_types.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/mm_types.h), operations in [mm/vma.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/vma.c))
2. **Doesn't allocate physical RAM** - No pages assigned yet
3. **Returns success** - The process can use the addresses

Note: Page tables are **not** populated at mmap time. They're created on-demand when pages are first accessed (page fault).

Physical RAM is allocated later, on first access (demand paging):

```
mmap(1GB)            First write to page
     │                      │
     ▼                      ▼
┌─────────┐           ┌─────────┐
│ VMA     │           │ Page    │
│ created │    ───►   │ fault   │
│ (no RAM)│           │ handler │
└─────────┘           └─────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │ Allocate    │
                    │ physical    │
                    │ page now    │
                    └─────────────┘
```

## Overcommit Modes

Linux provides three modes via `/proc/sys/vm/overcommit_memory`:

### Mode 0: Heuristic (Default)

```bash
$ cat /proc/sys/vm/overcommit_memory
0
```

**Behavior:** Linux uses heuristics to decide if an allocation is "reasonable."

- Rejects obviously excessive allocations
- Allows moderate overcommit
- Considers available RAM, swap, and current usage

The heuristic is implemented in `__vm_enough_memory()` ([mm/util.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/util.c)). It considers total RAM, swap, hugetlb reservations, admin/user reserves, and existing commitments. The simplified rule: reject if obviously excessive, allow if plausibly satisfiable.

### Mode 1: Always Overcommit

```bash
$ echo 1 > /proc/sys/vm/overcommit_memory
```

**Behavior:** Never refuse an allocation based on memory availability.

- A 1TB `mmap()` succeeds on a 16GB system
- Useful for sparse arrays, memory-mapped files
- Dangerous if programs actually touch what they allocate

### Mode 2: Strict Accounting

```bash
$ echo 2 > /proc/sys/vm/overcommit_memory
```

**Behavior:** Track commit charge, refuse if over limit.

Commit limit is calculated in [mm/util.c:vm_commit_limit()](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/util.c):

```
If overcommit_kbytes is set:
    Commit limit = overcommit_kbytes + Swap

Otherwise:
    Commit limit = ((RAM - HugePages) * overcommit_ratio/100) + Swap
```

```bash
$ cat /proc/sys/vm/overcommit_ratio
50  # Default: 50%

# Alternatively, set an absolute limit ([added in kernel 3.14](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=49f0ce5f9232)):
$ echo 8388608 > /proc/sys/vm/overcommit_kbytes  # 8GB

# On an 8GB RAM + 2GB swap system with default ratio:
# Commit limit = (8GB * 0.5) + 2GB = 6GB
```

Check current status:
```bash
$ cat /proc/meminfo | grep Commit
CommitLimit:    6291456 kB
Committed_AS:   2145678 kB
```

## When Overcommit Fails: The OOM Killer

If programs actually use more memory than available, someone must die:

```
Physical RAM exhausted
        │
        ▼
┌───────────────────┐
│    OOM Killer     │
│                   │
│ Scores processes: │
│ - RSS + swap      │
│ - Page tables     │
│ - oom_score_adj   │
│                   │
│ Kills highest     │
│ scoring process   │
└───────────────────┘
```

The OOM killer selects a victim based on ([mm/oom_kill.c:oom_badness()](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/oom_kill.c)):

- **`RSS`** - Resident memory usage
- **Swap entries** - Memory swapped out
- **Page tables** - Memory used for page tables
- **oom_score_adj** - User-tunable adjustment (-1000 to 1000)

Earlier kernels considered process age and child processes, but these heuristics were [removed in 2019](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=bbbe48029720) as unreliable. See the [LKML discussion](https://lore.kernel.org/lkml/20190225065854.30027-1-shakeelb@google.com/) for the rationale.

```bash
# View OOM score for a process
$ cat /proc/<pid>/oom_score
150

# Protect a critical process
$ echo -500 > /proc/<pid>/oom_score_adj
```

## Why Not Just Disable Overcommit?

Strict mode (mode 2) sounds safer. Why isn't it default?

**Problem 1: `fork()` becomes expensive**

Without overcommit, every `fork()` must reserve memory for potential COW copies, even if `exec()` follows immediately.

**Problem 2: Sparse data structures fail**

```c
// Sparse array: reserve 1GB address space, use 10MB
void *sparse = mmap(NULL, 1UL << 30,  // 1GB
                    PROT_READ | PROT_WRITE,
                    MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
// Only pages actually written consume physical RAM
// Without overcommit: allocation might fail or reserve 1GB
// With overcommit: works fine, RSS reflects actual usage
```

**Problem 3: Memory-mapped files**

```c
// Map 10GB file, read 100 bytes
void *p = mmap(NULL, 10UL*1024*1024*1024,
               PROT_READ, MAP_PRIVATE, fd, 0);
// Without overcommit: might fail
// With overcommit: only accessed pages loaded
```

**Problem 4: JVM and similar runtimes**

```bash
# JVM reserves max heap at startup
java -Xmx8g -jar app.jar
# Actual usage might be 500MB
```

## The Trade-off

| Approach | Pros | Cons |
|----------|------|------|
| Overcommit (default) | More programs run, `fork()` works, sparse structures | OOM killer may strike |
| Strict (mode 2) | Predictable failures | Wastes memory, `fork()` heavy, breaks sparse usage |

## Historical Context

### Before Linux: Traditional Unix

Early Unix systems (1970s-80s) typically used **strict memory accounting**. When you called `malloc()`, the system checked if physical memory (or swap) was available. This was simpler but wasteful - memory reserved but unused by one process couldn't be used by others.

### Linux's Aggressive Approach (1990s)

Linux chose a different path from the start. Linus Torvalds favored **optimistic allocation** - let programs allocate freely, deal with shortages when they actually occur. This matched how programs really behave: they often allocate more than they use.

Why this made sense:
1. **Memory was expensive** - Maximize utilization of scarce RAM
2. **`fork()`/`exec()` pattern** - The dominant Unix pattern, benefits enormously from COW + overcommit
3. **Sparse usage is common** - Real programs don't touch all allocated memory

### The OOM Killer (1998)

The inevitable consequence of optimistic allocation: sometimes the bet fails. [Rik van Riel](https://github.com/torvalds/linux/blob/master/mm/oom_kill.c) created the OOM killer in **August 1998** (Linux 2.1.x development series) to handle this:

> *"Copyright (C) 1998,2000 Rik van Riel"*
> *"Thanks go out to Claus Fischer for some serious inspiration and for goading me into coding this file."*

The OOM killer was controversial from day one. But the alternatives are worse:
- **(a)** Return `ENOMEM` and have programs crash anyway
- **(b)** Never overcommit and waste enormous amounts of memory
- **(c)** Kill something and let the system recover

Option (c) is the least bad. That's engineering reality.

### Evolution of Overcommit Controls

- **Linux 2.4**: Formalized `vm.overcommit_memory` sysctl (modes 0, 1, 2)
- **Linux 2.6**: Added `vm.overcommit_ratio` for strict mode tuning
- **Linux 3.14**: Added `vm.overcommit_kbytes` as alternative to ratio ([commit 49f0ce5f](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=49f0ce5f9232))
- **2010**: OOM killer [rewritten by David Rientjes](https://lwn.net/Articles/391222/) (Google)
- **Linux 4.6 (2016)**: OOM reaper introduced ([commit aac4536355](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=aac453635549)) - reclaims memory from OOM victims faster
- **Linux 4.19 (2018)**: `cgroup`-aware OOM killer ([commit 3d8b38eb81](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=3d8b38eb81ca)) - can kill entire `cgroup` as a unit

## Recommendations

**For most workloads:** Keep default (mode 0)

**For databases/critical services:**
```bash
# Protect from OOM killer
echo -1000 > /proc/<pid>/oom_score_adj
```

**For containers:**
- Use memory cgroups to limit and isolate
- Let container runtime handle OOM

**For strict environments:**
```bash
# Mode 2 with careful ratio
echo 2 > /proc/sys/vm/overcommit_memory
echo 80 > /proc/sys/vm/overcommit_ratio
```

## Try It Yourself

```bash
# Check current mode
cat /proc/sys/vm/overcommit_memory

# See commit limit and usage
grep -i commit /proc/meminfo

# View OOM scores
for pid in /proc/[0-9]*; do
    echo "$(cat $pid/oom_score 2>/dev/null) $(cat $pid/comm 2>/dev/null)"
done | sort -rn | head -10

# Watch for OOM events
dmesg -w | grep -i oom
```

## Further Reading

- [overcommit-accounting.rst](https://www.kernel.org/doc/Documentation/mm/overcommit-accounting.rst) - Official documentation
- [LWN: The OOM killer](https://lwn.net/Articles/317814/) - OOM killer deep dive
- [vm_overcommit_memory sysctl](https://docs.kernel.org/admin-guide/sysctl/vm.html#overcommit-memory) - Sysctl documentation
