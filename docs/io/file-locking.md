# File Locking

> `flock()`, POSIX advisory locks, OFD locks, mandatory locks, and lease locks: five mechanisms, one kernel, and a lot of historical baggage

## Why there are five locking mechanisms

Linux file locking is one of those areas where the kernel's history is written in the API. Each mechanism exists because its predecessor had a flaw:

1. **BSD `flock(2)`** came first. Simple, whole-file, easy to use — but its process-death semantics differ from POSIX, and it does not work across NFS.
2. **POSIX advisory locks** (`fcntl F_SETLK`) were standardized to fix NFS and add byte-range granularity, but introduced a new bug: closing *any* file descriptor to an inode releases *all* POSIX locks for that process on that inode.
3. **OFD locks** (`fcntl F_OFD_SETLK`, Linux 3.15) were added to fix the POSIX close bug without breaking the POSIX API.
4. **Mandatory locks** were an attempt to provide kernel-enforced locking so that uncooperative processes would still be blocked. They were removed in Linux 5.15 after decades of races and zero real-world adoption.
5. **Lease locks** (`fcntl F_SETLEASE`) are an entirely different model — the kernel notifies the leaseholder when someone else wants to open the file, enabling NFS delegation and Samba oplock semantics.

The result is that all five exist simultaneously. The quick reference:

| Type | Syscall | Scope | Inherited at fork? | Released at close? |
|------|---------|-------|--------------------|--------------------|
| BSD flock | `flock(2)` | whole file | yes (shared OFD) | on last close of OFD |
| POSIX advisory | `fcntl(F_SETLK)` | byte range | no | on any close of same inode/PID |
| OFD locks | `fcntl(F_OFD_SETLK)` | byte range | no | when OFD is closed |
| Mandatory | `fcntl` + inode mode | byte range | — | kernel-enforced (removed 5.15) |
| Lease | `fcntl(F_SETLEASE)` | whole file | — | notification-based |

"OFD" throughout this document means *open file description* — the kernel object that two file descriptors share after `dup(2)` or `fork(2)`. This distinction is critical for understanding the difference between `flock` and POSIX locks.

## `flock(2)`: BSD-style whole-file locks

`flock(2)` is the simplest lock interface. It locks an entire file:

```c
#include <sys/file.h>

int flock(int fd, int operation);
```

The `operation` argument is one of:

| Flag | Meaning |
|------|---------|
| `LOCK_SH` | Acquire a shared (read) lock |
| `LOCK_EX` | Acquire an exclusive (write) lock |
| `LOCK_UN` | Release the lock |
| `LOCK_NB` | Non-blocking flag; combine with `LOCK_SH` or `LOCK_EX` |

```c
/* Exclusive lock, blocking */
if (flock(fd, LOCK_EX) == -1)
    perror("flock");

/* Non-blocking attempt; returns EWOULDBLOCK immediately if busy */
if (flock(fd, LOCK_EX | LOCK_NB) == -1) {
    if (errno == EWOULDBLOCK)
        /* someone else holds the lock */;
    else
        perror("flock");
}

/* Release */
flock(fd, LOCK_UN);
/* or just close(fd) — the lock is released automatically */
```

### Scope: per open file description

The critical point: `flock` locks are attached to the **open file description**, not the file descriptor number. Two file descriptors that refer to the same open file description — created by `dup(2)`, `dup2(2)`, `fcntl(F_DUPFD)`, or inherited across `fork(2)` — share the same flock lock.

```
Process A:                Process B (forked from A):
  fd=3 ──┐                  fd=3 ──┐
  fd=4 ──┴── open file ─── fd=5 ──┴── (same open file description)
              description
              │
              └── flock lock (LOCK_EX)
```

All four of those file descriptors represent the *same* lock. Calling `flock(fd4, LOCK_UN)` in process A releases the lock for process B too — they share the underlying `struct file`.

Contrast this with two independent `open()` calls to the same path:

```c
int fd1 = open("data", O_RDWR);
int fd2 = open("data", O_RDWR);
/* fd1 and fd2 are different open file descriptions */
/* flock(fd1, LOCK_EX) and flock(fd2, LOCK_EX) compete with each other */
```

### Inheritance across fork

When a process calls `fork(2)`, the child inherits all open file descriptors, which point to the same open file descriptions. A `LOCK_EX` held by the parent on a given OFD is immediately visible to the child — they share it. The lock is released only when the *last* file descriptor referring to that OFD is closed.

This is usually what you want for parent–child coordination, but it means a child cannot independently acquire a different lock on the same OFD.

### Release semantics: last close

A flock lock is released when the last file descriptor referencing its open file description is closed. If you `dup` a locked fd and then close the original, the lock persists until the dup'd fd is also closed.

```c
int fd = open("data", O_RDWR);
flock(fd, LOCK_EX);

int fd2 = dup(fd);
close(fd);           /* lock still held — fd2 references the same OFD */
close(fd2);          /* lock released here */
```

### NFS: flock does not cross the network

On NFS mounts, `flock(2)` is silently local. The lock is not communicated to the NFS server and is invisible to other NFS clients. Two processes on different machines mounting the same NFS export can both hold `LOCK_EX` on the same file simultaneously with no conflict detected.

This is a notorious source of bugs. If you need cross-host locking on NFS, use POSIX advisory locks (`fcntl F_SETLK`), which are transmitted via the NLM or NFSv4 protocol.

### Kernel structure

Each flock lock is represented by a `struct file_lock` (in `include/linux/filelock.h`). For flock-style locks, `fl_flags` contains `FL_FLOCK` and `fl_owner` points to the `struct file` of the open file description:

```c
/* fs/locks.c — flock() syscall entry */
SYSCALL_DEFINE2(flock, unsigned int, fd, unsigned int, cmd)
{
    struct fd f = fdget(fd);
    struct file_lock *lock;

    lock = flock_make_lock(f.file, cmd, NULL);
    /* ... */
    error = do_flock(f.file, lock);
    /* ... */
}
```

The per-inode lock list for flock locks lives at `inode->i_flctx->flc_flock`.

## POSIX advisory locks (`fcntl F_SETLK`/`F_SETLKW`)

POSIX locks offer two advantages over `flock`: byte-range granularity and NFS support. They come at the cost of more complex semantics.

### The `struct flock` interface

```c
#include <fcntl.h>

struct flock {
    short  l_type;    /* F_RDLCK, F_WRLCK, F_UNLCK */
    short  l_whence;  /* SEEK_SET, SEEK_CUR, SEEK_END */
    off_t  l_start;   /* starting offset */
    off_t  l_len;     /* number of bytes; 0 means "to EOF" */
    pid_t  l_pid;     /* PID holding lock (F_GETLK only; ignored on set) */
};
```

The three `fcntl` commands:

| Command | Behavior |
|---------|----------|
| `F_SETLK` | Non-blocking acquire or release; returns `EAGAIN`/`EACCES` if busy |
| `F_SETLKW` | Blocking acquire; sleeps until the lock is available |
| `F_GETLK` | Query: does any lock conflict with the described region? If yes, fills `l_pid` |

```c
struct flock fl = {
    .l_type   = F_WRLCK,
    .l_whence = SEEK_SET,
    .l_start  = 0,
    .l_len    = 0,   /* lock entire file */
};

/* Blocking exclusive lock on the whole file */
if (fcntl(fd, F_SETLKW, &fl) == -1)
    perror("fcntl F_SETLKW");

/* Byte-range: lock bytes [1024, 2047] */
fl.l_start = 1024;
fl.l_len   = 1024;
if (fcntl(fd, F_SETLK, &fl) == -1) {
    if (errno == EAGAIN || errno == EACCES)
        /* conflicting lock exists */;
}

/* Unlock */
fl.l_type = F_UNLCK;
fcntl(fd, F_SETLK, &fl);
```

### Lock compatibility

Two locks on overlapping byte ranges conflict unless both are `F_RDLCK`:

| Held \ Requested | `F_RDLCK` | `F_WRLCK` |
|------------------|-----------|-----------|
| `F_RDLCK` | compatible | conflict |
| `F_WRLCK` | conflict | conflict |

Read locks from multiple processes can coexist. Any write lock excludes all other locks on the same byte range.

### Process-owned: the PID is the lock owner

POSIX locks are owned by the *process*, not the open file description. All file descriptors in the same process that refer to the same inode share one lock set. This has a critical consequence.

### The "close releases all" bug

This is the most dangerous POSIX lock behaviour. Consider:

```c
int fd1 = open("data", O_RDWR);
int fd2 = open("data", O_RDWR);  /* different OFD, same inode */

struct flock fl = { .l_type = F_WRLCK, .l_whence = SEEK_SET,
                    .l_start = 0, .l_len = 0 };
fcntl(fd1, F_SETLKW, &fl);   /* acquire write lock via fd1 */

/* ... do work ... */

close(fd2);   /* BUG: releases ALL POSIX locks this PID holds on this inode */
              /* The write lock acquired via fd1 is now GONE */
```

Closing `fd2` — a completely unrelated file descriptor — silently releases the lock acquired via `fd1`. The POSIX spec requires this; it is not a Linux bug. But it is a severe trap:

- A library function that opens the same file and closes its own fd will silently unlock the application's lock.
- A thread calling `close()` on what it believes is its own private fd can disrupt another thread's lock.

The OFD locks (`F_OFD_SETLK`) were created specifically to fix this.

### Not inherited across fork

Unlike `flock`, POSIX locks are **not** inherited by the child process after `fork(2)`. The child starts with no POSIX locks. This is part of the POSIX specification.

### F_SETLKW and EINTR

`F_SETLKW` blocks until the lock is available. It is an interruptible sleep and returns `EINTR` if a signal is delivered:

```c
int acquire_lock(int fd, struct flock *fl)
{
    while (fcntl(fd, F_SETLKW, fl) == -1) {
        if (errno == EINTR)
            continue;   /* restart after signal */
        return -1;
    }
    return 0;
}
```

Forgetting the `EINTR` retry is a common bug, especially in signal-heavy servers.

### NFS support

POSIX locks work across NFS via the **NLM (Network Lock Manager)** protocol on NFSv2/v3, and via the native locking operations in **NFSv4**. The NFS client translates `fcntl F_SETLK` into a network RPC to the server's lock daemon or NFSv4 state manager. Lock state is maintained on the server; a client crash can leave stale locks until the server's grace period expires.

Unlike `flock`, POSIX locks on NFS are visible to all clients and provide real mutual exclusion across hosts — at the cost of additional latency for each lock operation.

## OFD locks (`F_OFD_SETLK`) — Linux 3.15+

Open File Description locks were introduced in Linux 3.15 to provide the byte-range capabilities of POSIX locks without the "close releases all" semantics.

### Three new commands

| Command | Behavior |
|---------|----------|
| `F_OFD_SETLK` | Non-blocking acquire or release |
| `F_OFD_SETLKW` | Blocking acquire |
| `F_OFD_GETLK` | Query for conflicts |

The `struct flock` layout is identical to POSIX locks:

```c
struct flock fl = {
    .l_type   = F_WRLCK,
    .l_whence = SEEK_SET,
    .l_start  = 0,
    .l_len    = 0,
    .l_pid    = 0,   /* must be 0 for OFD locks */
};

if (fcntl(fd, F_OFD_SETLK, &fl) == -1)
    perror("fcntl F_OFD_SETLK");
```

Note: `l_pid` must be set to 0 for OFD lock operations. The kernel returns `EINVAL` if it is nonzero.

### Owned by the open file description

An OFD lock is tied to the `struct file` (the open file description), not the PID. The implications:

- Closing a different fd that refers to a different OFD has **no effect** on an OFD lock.
- The lock is released when the open file description itself is closed — i.e., when the last fd referencing that OFD is closed.
- After `fork()`, the child inherits the fd, inherits the OFD, and therefore inherits the OFD lock. Both parent and child hold the lock.

### Why OFD locks are right for multi-threaded servers

In a multi-threaded server where each thread opens its own file descriptor, POSIX locks are dangerous: one thread closing its fd releases every other thread's lock on the same file. OFD locks are scoped to each thread's independent `open()` call:

```c
/* Thread 1 */
int fd1 = open("records.db", O_RDWR);
struct flock fl = { .l_type = F_WRLCK, .l_whence = SEEK_SET,
                    .l_start = record_offset, .l_len = record_size };
fcntl(fd1, F_OFD_SETLKW, &fl);
/* ... modify record ... */
fl.l_type = F_UNLCK;
fcntl(fd1, F_OFD_SETLK, &fl);
close(fd1);

/* Thread 2: closing its own fd has no effect on Thread 1's lock */
int fd2 = open("records.db", O_RDWR);
close(fd2);   /* does NOT release Thread 1's OFD lock */
```

### Kernel flag

In `struct file_lock`, OFD locks have `fl_flags |= FL_OFDLCK`. The owner (`fl_owner`) is the `struct file *` pointer of the open file description, the same as for flock locks. This is what distinguishes them from POSIX locks, where `fl_owner` is `files_struct *` (the process's file descriptor table).

## Kernel internals: `struct file_lock`

All five locking mechanisms share the same underlying kernel structure, `struct file_lock`, defined in `include/linux/filelock.h`:

```c
/* include/linux/filelock.h */
struct file_lock {
    struct file_lock  *fl_blocker;   /* lock we're blocked waiting for */
    struct list_head   fl_list;      /* per-inode lock list linkage */
    struct hlist_node  fl_link;      /* global hash table (deadlock detection) */
    struct list_head   fl_blocked_requests;  /* locks blocked by this lock */
    struct list_head   fl_blocked_member;    /* this lock's place in a blocker's list */
    fl_owner_t         fl_owner;     /* flock/OFD: struct file *
                                      * POSIX:     files_struct * (process) */
    unsigned int       fl_flags;     /* FL_POSIX, FL_FLOCK, FL_LEASE, FL_OFDLCK */
    unsigned char      fl_type;      /* F_RDLCK, F_WRLCK, F_UNLCK */
    unsigned int       fl_pid;       /* owning PID (POSIX locks only) */
    int                fl_link_cpu;  /* CPU for hash table */
    wait_queue_head_t  fl_wait;      /* processes sleeping for this lock */
    struct file       *fl_file;      /* file this lock is on */
    loff_t             fl_start;     /* first byte of locked range */
    loff_t             fl_end;       /* last byte of locked range (OFFSET_MAX = EOF) */
    struct fasync_struct *fl_fasync; /* for lease break notification */
    unsigned long      fl_break_time;       /* lease break deadline */
    unsigned long      fl_downgrade_time;   /* lease downgrade deadline */
    const struct file_lock_operations  *fl_ops;   /* lock type operations */
    const struct lock_manager_operations *fl_lmops; /* NFS/CIFS/NFSv4 */
    union {
        struct nfs4_lock_state *nfs4_fl_state;
        struct nlm_lockowner   *nfs_fl_owner;
        /* ... CIFS, other NLM data ... */
    } fl_u;   /* filesystem-private lock manager state */
};
```

Key `fl_flags` values:

| Flag | Meaning |
|------|---------|
| `FL_POSIX` | POSIX advisory lock (`fcntl F_SETLK`) |
| `FL_FLOCK` | BSD flock lock |
| `FL_LEASE` | Lease lock |
| `FL_OFDLCK` | OFD lock (`fcntl F_OFD_SETLK`) |
| `FL_SLEEP` | Lock is blocking (`F_SETLKW` / `LOCK_NB` not set) |
| `FL_DOWNGRADE_PENDING` | Lease being downgraded |
| `FL_UNLOCK_PENDING` | Lease being broken |

## Lock storage: the inode's lock context

Locks are stored per-inode. The inode holds a pointer to a lazily-allocated `struct file_lock_context`:

```c
/* include/linux/filelock.h */
struct file_lock_context {
    spinlock_t          flc_lock;
    struct list_head    flc_flock;   /* list of FL_FLOCK locks */
    struct list_head    flc_posix;   /* list of FL_POSIX and FL_OFDLCK locks */
    struct list_head    flc_lease;   /* list of FL_LEASE locks */
};
```

The context is allocated on first use by `locks_inode_context()` (formerly `get_lock_context()`). When a process requests a lock, the kernel searches the appropriate list for conflicts before granting it.

```
inode
 └─ i_flctx ──► file_lock_context
                 ├─ flc_flock  ──► [FL_FLOCK lock] ──► [FL_FLOCK lock] ──► NULL
                 ├─ flc_posix  ──► [FL_POSIX lock] ──► [FL_OFDLCK lock] ──► NULL
                 └─ flc_lease  ──► [FL_LEASE lock] ──► NULL
```

Lock compatibility is checked by walking the relevant list. For POSIX and OFD locks, overlapping byte ranges are detected; read locks are compatible with each other, write locks conflict with everything.

### The global locks hash table

For deadlock detection, all sleeping POSIX lock requests are also inserted into a global hash table (`blocked_hash` in `fs/locks.c`), keyed by the lock owner. This allows the kernel to efficiently walk the "who is waiting for whom" graph.

## Deadlock detection for POSIX locks

When `F_SETLKW` would block — because a conflicting lock is held by another process — the kernel checks whether granting the sleep would create a deadlock:

```
Process A holds lock L1, wants L2
Process B holds lock L2, wants L1
→ circular wait → EDEADLK
```

The detection algorithm is in `posix_locks_deadlock()` in `fs/locks.c`. It performs a depth-first search on the waiting graph:

1. The requesting lock's owner is the starting node.
2. Follow `fl_blocker` pointers: each blocked lock points to the lock it is waiting for.
3. From that lock, find its owner, and check if that owner is also waiting for something.
4. If the DFS reaches the original requester, a cycle is found: return `EDEADLK`.

```c
/* fs/locks.c (simplified) */
static int posix_locks_deadlock(struct file_lock *caller_fl,
                                 struct file_lock *block_fl)
{
    struct file_lock *fl = block_fl->fl_blocker;

    while (fl) {
        if (posix_same_owner(caller_fl, fl))
            return 1;   /* cycle detected */
        fl = fl->fl_blocker;
    }
    return 0;
}
```

The search is bounded in depth (`MAX_DEADLK_ITERATIONS`, currently 10) to avoid unbounded latency in pathological cases. Deep chains may miss some deadlocks.

Deadlock detection applies only to POSIX locks (`FL_POSIX`). OFD locks and flock locks do not participate in deadlock detection.

## Mandatory locks (obsolete, removed in Linux 5.15)

Mandatory locking was a feature that made the kernel *enforce* advisory locks rather than relying on all processes to cooperate. It was enabled by setting the `setgid` bit and clearing the group-execute bit on a file:

```bash
chmod g+s,g-x sensitive_file
```

With mandatory locking enabled on a file, `read(2)` and `write(2)` by any process would block if a conflicting `F_RDLCK` or `F_WRLCK` lock was held by another process — even if the second process never called `fcntl`.

### Why it was removed

Mandatory locking was removed in Linux 5.15 (commit `b8852d4`) for several reasons:

- **Races with `mmap`**: A process holding a mandatory write lock could still be bypassed by mapping the file and writing through the mapping, since `mmap`-based access did not check mandatory locks consistently.
- **TOCTOU hazards**: The window between a `stat(2)` check and the actual `open()` could lead to security issues in programs expecting mandatory lock protection.
- **No real users**: No production software was found to rely on mandatory locking. Linux was the only major operating system that had attempted POSIX mandatory locking; even POSIX itself only describes mandatory locking as an XSI extension.
- **Complexity with no benefit**: Maintaining the code alongside OFD locks, leases, and NFS added burden with no practical payoff.

Mandatory lock behaviour can be approximated safely with a combination of OFD locks and careful `open(O_EXCL)` use.

## Lease locks (`fcntl F_SETLEASE`)

Leases are a qualitatively different mechanism: rather than *blocking* access by other processes, they *notify* the leaseholder when another process wants to open the file.

### Acquiring a lease

```c
#include <fcntl.h>
#include <signal.h>

/* Set up a signal handler for SIGIO (or use SA_SIGINFO with sigaction) */
signal(SIGIO, lease_break_handler);

/* Acquire a write lease: valid only when you are the sole opener */
if (fcntl(fd, F_SETLEASE, F_WRLCK) == -1)
    perror("F_SETLEASE");

/* Acquire a read lease: valid when no write opener exists */
if (fcntl(fd, F_SETLEASE, F_RDLCK) == -1)
    perror("F_SETLEASE");

/* Remove the lease */
fcntl(fd, F_SETLEASE, F_UNLCK);
```

A `F_WRLCK` lease can only be held when the process is the sole opener of the file. If another process already has the file open, `F_SETLEASE` with `F_WRLCK` returns `EAGAIN`. An `F_RDLCK` lease can be held by multiple readers simultaneously, as long as no writer has the file open.

### Lease break notification

When another process opens the file in a way that conflicts with the current lease:

1. The kernel sends `SIGIO` (or a custom signal set with `F_SETSIG`) to the leaseholder.
2. The leaseholder has `/proc/sys/fs/lease-break-time` seconds (default: 45) to respond.
3. The leaseholder should flush any cached state, downgrade or release the lease with `fcntl(fd, F_SETLEASE, F_UNLCK)` or `F_RDLCK`.
4. Once the leaseholder releases the lease (or the timeout expires), the kernel allows the other process's `open()` to proceed.

```c
void lease_break_handler(int sig)
{
    /*
     * Flush cached data, then release the lease.
     * This function runs in signal context — keep it simple.
     * Use a flag and handle in the main loop for production code.
     */
    lease_break_requested = 1;
}

/* Main loop */
if (lease_break_requested) {
    fsync(lease_fd);          /* flush pending writes */
    fcntl(lease_fd, F_SETLEASE, F_UNLCK);   /* release lease */
    lease_break_requested = 0;
}
```

If the leaseholder does not respond within `lease-break-time` seconds, the kernel forcibly breaks the lease and allows the other opener to proceed. From the leaseholder's perspective, the lease is simply gone.

### Use cases

- **NFS delegations**: The NFS server uses lease-like semantics to delegate file ownership to a client, allowing the client to serve reads and writes locally. The NFSv4 delegation recall is the NFS-level analog of a lease break.
- **Samba oplocks**: The Samba SMB server uses `F_SETLEASE` to hold an oplock on behalf of a Windows client. When another client opens the file, the kernel notifies Samba, which recalls the oplock from the Windows client before proceeding.
- **File content caching**: A caching daemon can hold a write lease on a file it has read into memory. When another process opens the file for write, the lease break signals the daemon to invalidate its cache.

### Lease and `O_NONBLOCK`

`F_SETLEASE` on a non-blocking fd behaves the same as a blocking fd — the `O_NONBLOCK` flag on the file descriptor does not affect lease acquisition. The blocking occurs in the *breaker's* `open()` call, not in the leaseholder.

## `/proc/locks`

The file `/proc/locks` shows all active locks on the system:

```
$ cat /proc/locks
1: POSIX  ADVISORY  WRITE 1234 fd:08:1048576 0 EOF
2: POSIX  ADVISORY  READ  5678 fd:08:1048577 1024 2047
3: FLOCK  ADVISORY  WRITE 9012 fd:08:1048578 0 EOF
4: OFDLCK ADVISORY  WRITE -1   fd:08:1048579 0 1023
5: LEASE  ACTIVE    WRITE 3456 fd:08:1048580 0 EOF
```

Field breakdown:

| Field | Example | Meaning |
|-------|---------|---------|
| Lock number | `1:` | Sequential ID for this boot; no stable meaning |
| Lock type | `POSIX` / `FLOCK` / `OFDLCK` / `LEASE` | Which locking mechanism |
| Advisory/mandatory | `ADVISORY` | `MANDATORY` was possible before Linux 5.15 |
| Access mode | `WRITE` / `READ` | `F_WRLCK` or `F_RDLCK` |
| PID | `1234` | Owning process; `-1` for OFD locks (owned by OFD, not PID) |
| Major:minor:inode | `fd:08:1048576` | Device and inode number of the locked file |
| Start | `0` | First locked byte |
| End | `EOF` or `2047` | Last locked byte; `EOF` means `OFFSET_MAX` (to end of file) |

The PID field is `-1` for OFD locks because they are not owned by a process; they are owned by an open file description. To identify which process holds an OFD lock, look for the OFD's fd in `/proc/<pid>/fdinfo/<fd>` — the kernel annotates it with the lock details.

### Correlating locks with processes

```bash
# Find which process holds a lock on a specific inode
inode=$(stat -c '%i' /path/to/file)
device=$(stat -c '%d' /path/to/file | xargs printf '%x')
grep ":$device:$inode" /proc/locks

# List lock info for a specific process
ls -l /proc/1234/fd          # see which fds are open
cat /proc/1234/fdinfo/3      # shows lock info for fd 3
```

## Lock limits

There is no separate per-process or per-system limit on the number of file locks. Lock count is effectively bounded by the number of open file descriptors, which is governed by:

- `fs.nr_open` — the hard ceiling on file descriptors per process (default: 1,048,576)
- `fs.file-max` — the system-wide maximum across all processes
- `RLIMIT_NOFILE` — the per-process soft/hard limit set by `ulimit -n`

Each lock is a heap allocation (`struct file_lock` via a slab cache), so memory pressure is the practical limit. A system-wide lock count is visible via:

```bash
# Total file lock count
cat /proc/sys/fs/file-nr   # (open fds, not locks directly)

# Rough lock count from /proc/locks
wc -l /proc/locks
```

There is no equivalent of the old SVR4 `NLOCK_RECORD` tunable.

## Common bugs

### 1. POSIX lock released by close of wrong fd

```c
/* BUG: classic multi-threaded library interaction */
int fd = open("database", O_RDWR);
struct flock fl = { .l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 0, .l_len = 0 };
fcntl(fd, F_SETLKW, &fl);   /* acquire exclusive lock */

/* Meanwhile, a library function opens the same file and closes it: */
some_library_log_function();  /* internally: open("database", ...) + close() */
/* The close() in the library just released YOUR POSIX lock */
/* The lock is gone; you don't know it */

/* FIX: use OFD locks */
fcntl(fd, F_OFD_SETLKW, &fl);
```

### 2. Using `flock` on NFS expecting network semantics

```c
/* BUG: this lock is invisible to other NFS clients */
int fd = open("/nfs/mount/shared.db", O_RDWR);
flock(fd, LOCK_EX);   /* silently local only */

/* FIX: use POSIX locks for NFS */
struct flock fl = { .l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 0, .l_len = 0 };
fcntl(fd, F_SETLKW, &fl);
```

### 3. Lock not released on crash

Advisory locks — both `flock` and POSIX — are cleaned up by the kernel when the process exits, even on crash. This is intentional and usually desirable. However, it means that:

- A crashed NFS client may leave locks on the server until the server's grace period expires (typically 90 seconds for NFSv3 NLM).
- Lock-as-PID-file patterns (`flock` on a `.lock` file) are safe on local filesystems: the lock is released when the process dies, even without an explicit `LOCK_UN`.

There is no scenario on a local filesystem where an advisory lock outlives the process that holds it.

### 4. Forgetting to handle `EINTR` on `F_SETLKW`

```c
/* BUG: signal interrupts the blocking lock acquisition */
fcntl(fd, F_SETLKW, &fl);   /* returns -1, errno=EINTR if signalled */
/* lock was NOT acquired; subsequent code assumes it was */

/* FIX: retry loop */
int r;
do {
    r = fcntl(fd, F_SETLKW, &fl);
} while (r == -1 && errno == EINTR);
if (r == -1)
    perror("fcntl F_SETLKW");
```

### 5. Assuming upgrade from read to write lock is atomic

```c
/* BUG: there is no atomic upgrade in Linux */
struct flock fl = { .l_type = F_RDLCK, /* ... */ };
fcntl(fd, F_SETLKW, &fl);   /* acquire read lock */

fl.l_type = F_WRLCK;
fcntl(fd, F_SETLKW, &fl);   /* request upgrade to write lock */
/*
 * The upgrade is NOT atomic. The read lock is released first, then
 * the write lock is acquired. Between those two steps, another process
 * can acquire a write lock. The file may have been modified.
 */
```

There is no `F_UPGRDLCK` or similar. If you need to upgrade, design your locking protocol to avoid it, or re-validate the data after the upgrade.

### 6. Using `F_GETLK` to check before locking

```c
/* BUG: TOCTOU race */
fcntl(fd, F_GETLK, &fl);    /* check: is there a conflicting lock? */
if (fl.l_type == F_UNLCK) {
    fl.l_type = F_WRLCK;
    fcntl(fd, F_SETLK, &fl); /* the lock we checked for may now be held */
}
```

`F_GETLK` is useful for diagnostics (finding who holds a lock) but not for lock-then-acquire patterns. Always use `F_SETLK` or `F_SETLKW` directly.

## Choosing the right lock mechanism

| Scenario | Recommended mechanism |
|----------|-----------------------|
| Simple whole-file locking, single machine | `flock(LOCK_EX)` |
| Multi-threaded server, per-thread locking | `fcntl(F_OFD_SETLKW)` |
| Byte-range locking, single machine | `fcntl(F_OFD_SETLK)` |
| Locking across NFS | `fcntl(F_SETLKW)` (POSIX) |
| Byte-range on NFS | `fcntl(F_SETLKW)` (POSIX) |
| File caching / oplock delegation | `fcntl(F_SETLEASE)` |
| Lock file (pidfile pattern) | `flock(LOCK_EX \| LOCK_NB)` |

When in doubt: use OFD locks (`F_OFD_SETLK`) for new code on Linux 3.15+. They have the byte-range capability of POSIX locks, the correct close semantics of `flock`, and no ambiguity about lock ownership.

## Key source files

| File | Contents |
|------|----------|
| `fs/locks.c` | All lock implementation: `flock()`, `fcntl` locks, leases, deadlock detection |
| `include/linux/filelock.h` | `struct file_lock`, `struct file_lock_context`, `FL_*` flags |
| `include/uapi/linux/fcntl.h` | `F_OFD_SETLK`, `F_SETLEASE`, and other `fcntl` constants |
| `fs/nfs/nfs4proc.c` | NFSv4 lock delegation |
| `fs/nfs/nfs4state.c` | NFSv4 lock state machine |
| `fs/lockd/clntlock.c` | NLM client (NFSv3 locking) |
| `kernel/signal.c` | Signal delivery for lease breaks |

## Further reading

- [Life of an open](life-of-an-open.md) — how `open()` interacts with leases before returning the fd
- [Life of a write](life-of-a-write.md) — how write paths interact with mandatory locks (historically)
- [VFS file operations](file-operations.md) — `f_op->lock` and `f_op->flock` dispatch
- [Observability](observability.md) — tracing lock contention with `perf`, `bpftrace`, and `ftrace`
- `man 2 flock` — `flock(2)` semantics and NFS caveats
- `man 2 fcntl` — POSIX lock, OFD lock, and lease interfaces
- `man 5 proc` — `/proc/locks` field documentation
