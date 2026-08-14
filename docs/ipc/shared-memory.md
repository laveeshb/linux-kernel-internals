# Shared Memory, Semaphores, and eventfd

> Zero-copy IPC and lightweight synchronization primitives

## POSIX shared memory

POSIX shared memory creates a named object backed by tmpfs that multiple processes can `mmap` into their address spaces:

```c
#include <sys/mman.h>
#include <fcntl.h>

/* Process A: create and write */
int fd = shm_open("/myshm",
                  O_CREAT | O_RDWR,
                  0600);
ftruncate(fd, 4096);  /* set size */

void *ptr = mmap(NULL, 4096,
                 PROT_READ | PROT_WRITE,
                 MAP_SHARED, fd, 0);
close(fd);  /* fd no longer needed after mmap */

*(int *)ptr = 42;
munmap(ptr, 4096);

/* Remove the name (pages freed when last mmap is gone) */
shm_unlink("/myshm");

/* Process B: open and read */
int fd = shm_open("/myshm", O_RDONLY, 0);
void *ptr = mmap(NULL, 4096, PROT_READ, MAP_SHARED, fd, 0);
close(fd);
int val = *(int *)ptr;   /* val == 42 */
munmap(ptr, 4096);
```

`shm_open` is implemented as `open` on `/dev/shm/` (a tmpfs mount). The shared pages are in the page cache, mapped into both processes' page tables.

```bash
ls /dev/shm/   # see current shared memory objects
ipcs -m        # see System V shared memory segments
```

## System V shared memory

The older but more widely available SHM API:

```c
#include <sys/shm.h>
#include <sys/ipc.h>

/* Create/get a segment */
key_t key = ftok("/tmp/myfile", 'A');  /* generate key from path+id */
int shmid = shmget(key,
                   4096,               /* size */
                   IPC_CREAT | 0600);  /* flags */

/* Attach (map into address space) */
void *ptr = shmat(shmid, NULL, 0);     /* NULL = kernel chooses addr */

/* Use it */
*(int *)ptr = 99;

/* Detach */
shmdt(ptr);

/* Remove (kernel frees when all processes detach) */
shmctl(shmid, IPC_RMID, NULL);
```

```bash
# Show System V shared memory
ipcs -m
# ------ Shared Memory Segments --------
# key        shmid    owner   perms  bytes  nattch  status
# 0x00000000 0        root    600    4096   0

# Remove a segment
ipcrm -m <shmid>
```

## Synchronization: POSIX semaphores

Shared memory requires external synchronization. POSIX semaphores provide a counter that can be atomically incremented/decremented:

### Named semaphores (between unrelated processes)

```c
#include <semaphore.h>

/* Process A */
sem_t *sem = sem_open("/mysem",
                      O_CREAT, 0600, 1);  /* initial value = 1 */

sem_wait(sem);       /* P(): decrement, block if 0 */
/* critical section */
sem_post(sem);       /* V(): increment, wake one waiter */

sem_close(sem);      /* close fd */
sem_unlink("/mysem"); /* remove name */

/* Process B */
sem_t *sem = sem_open("/mysem", 0);  /* open existing */
sem_wait(sem);
/* ... */
sem_post(sem);
sem_close(sem);
```

### Unnamed semaphores (shared memory or threads)

```c
/* In shared memory, accessible to multiple processes */
struct shared {
    sem_t sem;
    int   data;
};

struct shared *sh = mmap(NULL, sizeof(*sh),
                         PROT_READ|PROT_WRITE,
                         MAP_SHARED|MAP_ANONYMOUS, -1, 0);

sem_init(&sh->sem, 1, 1);  /* pshared=1: shared between processes */

/* Process A/B: */
sem_wait(&sh->sem);
sh->data++;
sem_post(&sh->sem);

/* Cleanup */
sem_destroy(&sh->sem);
munmap(sh, sizeof(*sh));
```

### Kernel implementation

POSIX semaphores use futexes internally:

```c
/* glibc sem_wait: */
sem_wait(sem) {
    if (__atomic_sub_fetch(&sem->value, 1, __ATOMIC_ACQ_REL) >= 0)
        return;  /* fast path: counter was > 0 */
    /* slow path: wait */
    futex_wait(&sem->value, ...);
}

sem_post(sem) {
    if (__atomic_add_fetch(&sem->value, 1, __ATOMIC_RELEASE) <= 0)
        futex_wake(&sem->value, 1);  /* wake one waiter */
}
```

## eventfd: lightweight event notification

`eventfd` creates a file descriptor backed by a 64-bit counter. It's the lightest-weight notification mechanism:

```c
#include <sys/eventfd.h>

/* Create eventfd with initial value 0 */
int efd = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);

/* Signal: add 1 to counter */
uint64_t val = 1;
write(efd, &val, sizeof(val));

/* Wait and consume: reads the counter value, resets to 0 */
uint64_t count;
read(efd, &count, sizeof(count));  /* blocks if counter == 0 */
/* count = number of signals since last read */

/* With EFD_SEMAPHORE: read decrements by 1 instead of resetting to 0 */
int efd = eventfd(0, EFD_SEMAPHORE);
write(efd, &(uint64_t){5}, 8);  /* counter = 5 */
read(efd, &count, 8);  /* count = 1, counter = 4 */
read(efd, &count, 8);  /* count = 1, counter = 3 */
```

### eventfd with epoll (the idiomatic pattern)

```c
/* Thread 1: event producer */
void producer(int efd) {
    while (1) {
        /* ... do work ... */
        uint64_t val = 1;
        write(efd, &val, sizeof(val));  /* signal consumer */
    }
}

/* Thread 2: event consumer with epoll */
void consumer(int efd) {
    int epfd = epoll_create1(EPOLL_CLOEXEC);
    struct epoll_event ev = { .events = EPOLLIN, .data.fd = efd };
    epoll_ctl(epfd, EPOLL_CTL_ADD, efd, &ev);

    struct epoll_event events[8];
    while (1) {
        int n = epoll_wait(epfd, events, 8, -1);
        for (int i = 0; i < n; i++) {
            uint64_t count;
            read(events[i].data.fd, &count, sizeof(count));
            /* process 'count' pending events */
        }
    }
}
```

eventfd is used extensively in:
- QEMU/KVM virtio notifications
- io_uring completion notification
- libuv/libevent event loop backends
- Container runtimes (cgroup event notification)

## memfd: anonymous file-backed shared memory

`memfd_create` creates an anonymous file in memory (no filesystem path), useful for sharing without name collisions:

```c
#include <sys/mman.h>

/* Create anonymous file */
int fd = memfd_create("mydata", MFD_CLOEXEC | MFD_ALLOW_SEALING);
ftruncate(fd, size);

void *ptr = mmap(NULL, size, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0);

/* Seal: prevent future modifications (useful for read-only sharing) */
fcntl(fd, F_ADD_SEALS, F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK);

/* Pass fd to another process via Unix socket (SCM_RIGHTS) */
send_fd_over_socket(socket_fd, fd);
/* Other process can mmap the fd — no name needed */
```

`memfd_create` is used by:
- Graphics/Wayland: sharing framebuffers between client and compositor
- dbus-broker: passing large messages without DBUS limits
- D-Bus: replacing shared memory segments

## Comparing shared memory approaches

| Approach | Setup | Name in fs | fd | Sealing | Best for |
|----------|-------|-----------|-----|---------|---------|
| POSIX shm (`shm_open`) | Path in `/dev/shm/` | Yes | After open | No | Named, persistent |
| System V (`shmget`) | IPC key | Via `ipcs` | No | No | Legacy compatibility |
| `mmap(MAP_SHARED | MAP_ANONYMOUS)` | Anonymous | No | No | Parent-child only |
| `memfd_create` | Anonymous file | No | Yes | Yes | Dynamic, fd-passing |

## Further reading

### Kernel source

- [ipc/shm.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/ipc/shm.c) — `shmget()`, `shmat()`/`shmdt()`, and `shmctl()` syscalls; `newseg()` creates the segment's hidden backing file via `shmem_kernel_file_setup()` (or `hugetlb_file_setup()` for `SHM_HUGETLB`)
- [mm/shmem.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/shmem.c) — `shmem_file_setup()`/`shmem_kernel_file_setup()`: the tmpfs backing shared by both POSIX `shm_open()` objects and SysV `shmget()` segments
- [mm/memfd.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/memfd.c) — `memfd_create()` syscall and the `F_SEAL_*` sealing checks
- [fs/eventfd.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/eventfd.c) — `eventfd_write()`/`eventfd_read()` and the `struct eventfd_ctx` counter/wait-queue implementation

### Man pages

- [`shmget(2)`](https://man7.org/linux/man-pages/man2/shmget.2.html) — allocate a System V shared memory segment
- [`shmat(2)`/`shmdt(2)`](https://man7.org/linux/man-pages/man2/shmat.2.html) — attach/detach a System V segment
- [`shmctl(2)`](https://man7.org/linux/man-pages/man2/shmctl.2.html) — control operations, including `IPC_RMID`
- [`shm_open(3)`](https://man7.org/linux/man-pages/man3/shm_open.3.html) — POSIX shared memory objects; documents the `/dev/shm` tmpfs implementation on Linux
- [`shm_overview(7)`](https://man7.org/linux/man-pages/man7/shm_overview.7.html) — POSIX shared memory API overview
- [`sem_overview(7)`](https://man7.org/linux/man-pages/man7/sem_overview.7.html) — POSIX semaphores: named vs. unnamed, `/dev/shm` persistence for named semaphores
- [`memfd_create(2)`](https://man7.org/linux/man-pages/man2/memfd_create.2.html) — anonymous sealable memory files
- [`eventfd(2)`](https://man7.org/linux/man-pages/man2/eventfd.2.html) — counter-backed notification fd, including `EFD_SEMAPHORE`

### Related pages

- [Process Address Space](../mm/mmap.md) — VMAs and the `MAP_SHARED` flag that both POSIX shm and anonymous shared mappings rely on
- [File-Backed mmap and Page Faults](../mm/file-mmap.md) — `MAP_PRIVATE` vs `MAP_SHARED` fault handling in detail
- [Futex Internals](../locking/futex.md) — how `sem_wait()`/`sem_post()` fall back to the kernel when the uncontended fast-path atomic isn't enough
- [SysV IPC: Semaphores and Message Queues](sysv-semaphores.md) — `semget`/`semop`, `SEM_UNDO`, and the SysV IPC leak problem
- [eventfd and signalfd](eventfd-signalfd.md) — `struct eventfd_ctx`, epoll integration, and signalfd covered in depth
- [Unix Domain Sockets](unix-sockets.md) — `SCM_RIGHTS`, the generic mechanism for passing any open file descriptor (including a `memfd_create()` fd) between processes

### LWN articles

- [Sealed files](https://lwn.net/Articles/593918/) (2014) — Jonathan Corbet on the `memfd_create()` and `F_SEAL_*` sealing mechanism described in this page's memfd section

### External

- [tmpfs — The Linux Kernel documentation](https://docs.kernel.org/filesystems/tmpfs.html) — confirms both POSIX `shm_open()`/`/dev/shm` and SysV `shmget()` segments are backed by tmpfs (SysV via an internal, non-visible mount)
