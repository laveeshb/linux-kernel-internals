# SysV IPC: Semaphores and Message Queues

> The original Unix IPC primitives: semaphores, message queues, and their kernel internals

SysV IPC is the oldest IPC layer in Linux, inherited from System V Unix. It predates POSIX IPC and has a notoriously awkward API, but it remains in wide use because many commercial applications and databases (PostgreSQL, Oracle) still depend on it. Understanding its internals — and its failure modes — is essential for anyone debugging production systems.

## SysV Semaphores

### Creating and opening: semget()

```c
#include <sys/sem.h>

/* IPC_PRIVATE: private to this process tree (key is ignored) */
int semid = semget(IPC_PRIVATE, 1, IPC_CREAT | 0600);

/* Shared key derived from a file + project ID */
key_t key = ftok("/var/run/myapp.pid", 'A');
int semid = semget(key, 3, IPC_CREAT | IPC_EXCL | 0600);
/* nsems=3: create a set of 3 semaphores */
```

`semget()` returns a semaphore set identifier (`semid`). The set holds `nsems` individual semaphores, each independently addressable. All semaphores in the set are operated on atomically by a single `semop()` call.

### Operations: semop()

```c
#include <sys/sem.h>

struct sembuf {
    unsigned short sem_num;  /* semaphore index within the set (0..nsems-1) */
    short          sem_op;   /* operation: >0 increment, <0 decrement, 0 wait-for-zero */
    short          sem_flg;  /* IPC_NOWAIT | SEM_UNDO */
};

/* P (down/wait): decrement by 1, block if value would go negative */
struct sembuf lock_op   = { .sem_num = 0, .sem_op = -1, .sem_flg = SEM_UNDO };
/* V (up/signal): increment by 1, wake waiters */
struct sembuf unlock_op = { .sem_num = 0, .sem_op = +1, .sem_flg = SEM_UNDO };
/* Wait for zero: block until semaphore reaches 0 */
struct sembuf zero_op   = { .sem_num = 0, .sem_op =  0, .sem_flg = 0 };

semop(semid, &lock_op, 1);
/* ... critical section ... */
semop(semid, &unlock_op, 1);
```

`semop()` applies all `nsops` operations **atomically** — either all succeed or none do. This is the key advantage over POSIX semaphores: you can atomically decrement multiple semaphores, which enables deadlock-free resource allocation (Dijkstra's "banker's algorithm" style).

### SEM_UNDO: automatic cleanup on exit

`SEM_UNDO` is critical for robustness. When a process exits (normally or via signal), the kernel automatically reverses all `SEM_UNDO` operations that process performed:

```c
/* Always use SEM_UNDO when locking */
struct sembuf op = { 0, -1, SEM_UNDO };
semop(semid, &op, 1);
/* If this process crashes, semaphore is automatically incremented back */
```

The kernel tracks per-process undo lists in `struct sem_undo` (defined in `ipc/sem.c`). On `do_exit()`, `exit_sem()` walks the undo list and reverses each pending adjustment.

**Without `SEM_UNDO`**: a process that dies while holding a semaphore leaves it permanently decremented — all subsequent waiters block forever.

### semctl(): control and inspection

```c
#include <sys/sem.h>

union semun {
    int              val;    /* SETVAL */
    struct semid_ds *buf;    /* IPC_STAT / IPC_SET */
    unsigned short  *array;  /* GETALL / SETALL */
};

/* Initialize semaphore 0 to value 1 (mutex) */
union semun arg = { .val = 1 };
semctl(semid, 0, SETVAL, arg);

/* Read current value */
int val = semctl(semid, 0, GETVAL);

/* Read all values in the set */
unsigned short vals[3];
arg.array = vals;
semctl(semid, 0, GETALL, arg);

/* Get queue statistics */
struct semid_ds ds;
arg.buf = &ds;
semctl(semid, 0, IPC_STAT, arg);
printf("last semop: %ld, nsems: %lu\n",
       (long)ds.sem_otime, (unsigned long)ds.sem_nsems);

/* Remove the semaphore set */
semctl(semid, 0, IPC_RMID);
```

### Kernel internals

```c
/* ipc/sem.c (internal kernel structures, not exported in headers) */
struct sem_array {
    struct kern_ipc_perm  sem_perm;    /* permissions + IPC id */
    time64_t              sem_ctime;   /* last semctl() time */
    time64_t              sem_otime;   /* last semop() time */
    struct list_head      pending_alter;  /* pending sops that alter the set */
    struct list_head      pending_const;  /* pending sops that don't alter (wait-for-zero) */
    struct list_head      list_id;     /* list of all sem_arrays */
    int                   sem_nsems;   /* number of semaphores in set */
    int                   complex_count; /* # of multi-semaphore operations pending */
    unsigned int          use_global_lock; /* use global sem_lock or per-sem lock */
    struct sem             sems[];     /* flexible array of semaphores */
};

struct sem {
    int          semval;        /* current value */
    struct pid  *sempid;        /* pid of last semop() (namespace-aware) */
    spinlock_t   lock;          /* per-semaphore lock (simple ops) */
    struct list_head pending_alter;  /* simple pending alter ops */
    struct list_head pending_const;  /* simple pending const ops */
};
```

Waiting operations are tracked in `struct sem_queue` (defined in `ipc/sem.c`, an internal structure not exported in headers). When `semop()` cannot complete immediately, it enqueues a `sem_queue` entry and sleeps. `do_semop()` in `ipc/sem.c` walks the pending queue and wakes sleepers when a semaphore increment makes their operation satisfiable.

## SysV Message Queues

### Creating and opening: msgget()

```c
#include <sys/msg.h>

key_t key = ftok("/var/run/myapp", 'M');
int msqid = msgget(key, IPC_CREAT | 0600);
```

### Sending: msgsnd()

```c
struct msgbuf {
    long mtype;    /* message type: must be > 0 */
    char mtext[256]; /* message data */
};

struct msgbuf msg = {
    .mtype = 1,
};
snprintf(msg.mtext, sizeof(msg.mtext), "hello");

/* msgsz = data size only (not including mtype) */
msgsnd(msqid, &msg, strlen(msg.mtext) + 1, 0);
/* IPC_NOWAIT flag: return EAGAIN instead of blocking if queue is full */
msgsnd(msqid, &msg, sizeof(msg.mtext), IPC_NOWAIT);
```

### Receiving: msgrcv()

The `msgtyp` argument controls which message is dequeued:

```c
long msgtyp;
struct msgbuf recv_buf;

/* msgtyp == 0: receive the oldest message regardless of type */
msgtyp = 0;
msgrcv(msqid, &recv_buf, sizeof(recv_buf.mtext), msgtyp, 0);

/* msgtyp > 0: receive oldest message of exactly that type */
msgtyp = 2;
msgrcv(msqid, &recv_buf, sizeof(recv_buf.mtext), msgtyp, 0);

/* msgtyp < 0: receive oldest message with type <= |msgtyp| */
msgtyp = -5;  /* lowest type that is <= 5 */
msgrcv(msqid, &recv_buf, sizeof(recv_buf.mtext), msgtyp, 0);
```

This type-based filtering enables multiple message classes on a single queue, simulating priority.

### msgctl(): control and inspection

```c
#include <sys/msg.h>

struct msqid_ds ds;
msgctl(msqid, IPC_STAT, &ds);
printf("messages in queue: %lu\n",   (unsigned long)ds.msg_qnum);
printf("bytes in queue:    %lu\n",   (unsigned long)ds.msg_cbytes);
printf("queue byte limit:  %lu\n",   (unsigned long)ds.msg_qbytes);
printf("last send:  %ld\n",          (long)ds.msg_stime);
printf("last recv:  %ld\n",          (long)ds.msg_rtime);

/* Increase the byte limit (requires CAP_SYS_RESOURCE or owner) */
ds.msg_qbytes = 1048576;
msgctl(msqid, IPC_SET, &ds);

/* Remove the queue */
msgctl(msqid, IPC_RMID, NULL);
```

### Kernel internals

```c
/* ipc/msg.c */
struct msg_queue {
    struct kern_ipc_perm q_perm;   /* permissions + IPC id */
    time64_t             q_stime;  /* last msgsnd() time */
    time64_t             q_rtime;  /* last msgrcv() time */
    time64_t             q_ctime;  /* last msgctl() time */
    unsigned long        q_cbytes; /* current bytes in queue */
    unsigned long        q_qnum;   /* current message count */
    unsigned long        q_qbytes; /* max bytes in queue */
    struct pid          *q_lspid;  /* pid of last msgsnd() */
    struct pid          *q_lrpid;  /* pid of last msgrcv() */
    struct list_head     q_messages; /* list of struct msg_msg */
    struct list_head     q_receivers; /* blocked receivers */
    struct list_head     q_senders;   /* blocked senders */
};
```

Messages are stored as linked `struct msg_msg` entries on `q_messages`. When the queue is full (`q_cbytes >= q_qbytes`), the sending process sleeps on `q_senders`. When empty, the receiver sleeps on `q_receivers`. A successful send or receive wakes the opposite wait queue.

## Observing SysV IPC

### /proc/sysvipc

```bash
# List all semaphore sets
cat /proc/sysvipc/sem
# key      semid perms      nsems   uid   gid  cuid  cgid      otime      ctime

# List all message queues
cat /proc/sysvipc/msg
# key      msqid perms      cbytes  qnum    lspid   lrpid   uid   gid  cuid  cgid      stime      rtime      ctime
```

### ipcs / ipcrm

```bash
# Show all SysV IPC resources
ipcs

# Show only semaphores, verbose
ipcs -s -v

# Show only message queues
ipcs -q

# Remove a specific semaphore set
ipcrm -s <semid>

# Remove a specific message queue
ipcrm -q <msqid>

# Remove ALL semaphore sets owned by current user (nuclear option)
ipcs -s | awk 'NR>2 && $1 != "" {print $2}' | xargs -I{} ipcrm -s {}
```

### System limits (sysctls)

```bash
# Max semaphore sets system-wide
sysctl kernel.sem
# kernel.sem = 250 32000 32 128
#              SEMMSL SEMMNS SEMOPM SEMMNI
#   SEMMSL: max semaphores per set
#   SEMMNS: max semaphores system-wide
#   SEMOPM: max ops per semop() call
#   SEMMNI: max semaphore sets (hitting this causes ENOSPC)

# Message queue limits
sysctl kernel.msgmni    # max message queues
sysctl kernel.msgmax    # max message size in bytes
sysctl kernel.msgmnb    # max bytes per queue (default msg_qbytes)
```

## Comparison: semaphore mechanisms

| Mechanism | API | Blocking | Atomic multi-sem | Auto-cleanup | epoll-compatible |
|-----------|-----|---------|------------------|--------------|-----------------|
| SysV semaphore | `semop()` | Yes | **Yes** | `SEM_UNDO` only | No |
| POSIX named sem | `sem_wait()` | Yes | No | `sem_unlink()` | No |
| POSIX unnamed sem | `sem_wait()` | Yes | No | On destroy | No |
| `futex` | `futex()` | Yes | No | On process exit (robust) | No |
| `eventfd` | `read()`/`write()` | Yes | No | On fd close | **Yes** |

## The SysV IPC leak problem

SysV IPC objects — semaphore sets and message queues — **persist until explicitly removed (`IPC_RMID`) or until system reboot**. Unlike file descriptors, they are not tied to any process's lifetime. A process that crashes without cleanup leaves orphaned objects behind.

This causes two classes of failures:

1. **Resource exhaustion**: `SEMMNI` (typically 128–32768) limits semaphore sets. When the limit is hit, `semget()` returns `ENOSPC`. New service instances cannot start.

2. **Stale state**: An orphaned semaphore with a non-zero value can cause the next service instance to block indefinitely on `semop()`.

### Diagnosis

```bash
# Find semaphore sets not attached to any running process
ipcs -s -v | grep -v "^--" | awk 'NR>2 {
    cmd = "kill -0 " $5 " 2>/dev/null"; # $5 = cpid (creator pid)
    if (system(cmd) != 0)
        print "ORPHANED semid=" $2 " key=" $1 " creator_pid=" $5
}'

# Count by owner
ipcs -s | awk 'NR>2 {print $5}' | sort | uniq -c | sort -rn
```

### Prevention

- Always call `semctl(semid, 0, IPC_RMID)` in all exit paths, including signal handlers
- Alternatively, prefer POSIX named semaphores (`sem_open()` / `sem_unlink()`): the name is removed by `sem_unlink()` and the semaphore itself is destroyed when the last `sem_t` is closed — no persistent kernel object
- For pure intra-process synchronization, use `pthread_mutex` or `futex` directly

## Further reading

- `ipc/sem.c`, `ipc/msg.c` — kernel implementations
- `include/linux/sem.h`, `include/uapi/linux/sem.h` — data structures
- [Shared Memory](shared-memory.md) — SysV `shmget`/`shmat` and POSIX `shm_open`
- [eventfd and signalfd](eventfd-signalfd.md) — pollable alternatives to semaphores
- `semop(2)`, `msgop(2)`, `ipcs(1)`, `ipcrm(1)` man pages
