# userfaultfd: Userspace Page Fault Handling

> Let userspace handle page faults — the mechanism behind QEMU live migration and CRIU

## What problem does userfaultfd solve?

Normally, page faults are handled by the kernel: a missing page triggers an anonymous allocation, swap-in, or file read. But some applications need to **intercept** page faults — to provide pages from their own storage or to implement copy-on-write in userspace.

Use cases:
- **QEMU live migration**: receive guest RAM pages on-the-fly as the guest accesses them
- **CRIU** (Checkpoint/Restore In Userspace): restore process memory lazily
- **Hypervisors**: implement demand-paging for guest memory from userspace
- **Garbage collectors**: implement generational GC barriers without mprotect overhead
- **Sandboxes**: provide deterministic memory contents for testing

## API overview

```c
#include <sys/ioctl.h>
#include <linux/userfaultfd.h>
#include <poll.h>

/* 1. Create userfaultfd */
int uf_fd = syscall(SYS_userfaultfd, O_CLOEXEC | O_NONBLOCK);

/* 2. Check API version */
struct uffdio_api api = {
    .api   = UFFD_API,
    .features = UFFD_FEATURE_PAGEFAULT_FLAG_WP |
                UFFD_FEATURE_MINOR_FAULTS,
};
ioctl(uf_fd, UFFDIO_API, &api);
/* api.features now has supported features */
/* api.ioctls has available ioctls */

/* 3. Register a memory range to intercept */
struct uffdio_register reg = {
    .range.start = (unsigned long)addr,
    .range.len   = size,
    .mode        = UFFDIO_REGISTER_MODE_MISSING,  /* intercept missing pages */
};
ioctl(uf_fd, UFFDIO_REGISTER, &reg);

/* 4. Poll for faults in a thread */
struct pollfd pfd = { .fd = uf_fd, .events = POLLIN };
while (1) {
    poll(&pfd, 1, -1);

    struct uffd_msg msg;
    read(uf_fd, &msg, sizeof(msg));

    if (msg.event == UFFD_EVENT_PAGEFAULT) {
        unsigned long fault_addr = msg.arg.pagefault.address;
        unsigned long flags      = msg.arg.pagefault.flags;
        /* UFFD_PAGEFAULT_FLAG_WRITE: write fault */
        /* UFFD_PAGEFAULT_FLAG_WP:    write-protect fault */

        /* Resolve: provide a zero page */
        struct uffdio_zeropage zp = {
            .range.start = fault_addr & ~(PAGE_SIZE - 1),
            .range.len   = PAGE_SIZE,
        };
        ioctl(uf_fd, UFFDIO_ZEROPAGE, &zp);
    }
}
```

## Fault resolution methods

### UFFDIO_COPY — install a page with data

```c
static char page_data[PAGE_SIZE];
/* Fill page_data with the content you want */

struct uffdio_copy copy = {
    .dst  = fault_addr & ~(PAGE_SIZE - 1),
    .src  = (unsigned long)page_data,
    .len  = PAGE_SIZE,
    .mode = 0,  /* or UFFDIO_COPY_MODE_DONTWAKE if you'll wake later */
};
ioctl(uf_fd, UFFDIO_COPY, &copy);
/* Wakes the faulting thread */
```

### UFFDIO_ZEROPAGE — install a zero page

```c
struct uffdio_zeropage zp = {
    .range.start = fault_addr & ~(PAGE_SIZE - 1),
    .range.len   = PAGE_SIZE,
    .mode = 0,
};
ioctl(uf_fd, UFFDIO_ZEROPAGE, &zp);
```

### UFFDIO_CONTINUE — resolve minor fault (for shared mappings)

```c
/* Minor fault: page exists in page cache but not in PTE */
struct uffdio_continue cont = {
    .range.start = fault_addr & ~(PAGE_SIZE - 1),
    .range.len   = PAGE_SIZE,
    .mode = 0,
};
ioctl(uf_fd, UFFDIO_CONTINUE, &cont);
```

### UFFDIO_WRITEPROTECT — write-protect pages to catch writes

```c
/* Write-protect a region (triggers WP fault on write) */
struct uffdio_writeprotect wp = {
    .range.start = (unsigned long)addr,
    .range.len   = size,
    .mode = UFFDIO_WRITEPROTECT_MODE_WP,     /* enable WP */
};
ioctl(uf_fd, UFFDIO_WRITEPROTECT, &wp);

/* Later, when WP fault arrives (UFFD_PAGEFAULT_FLAG_WP set): */
wp.mode = 0;  /* remove WP — allow future writes */
ioctl(uf_fd, UFFDIO_WRITEPROTECT, &wp);
```

## Registration modes

```c
/* UFFDIO_REGISTER_MODE_MISSING: intercept missing page faults */
reg.mode = UFFDIO_REGISTER_MODE_MISSING;

/* UFFDIO_REGISTER_MODE_WP: intercept write-protect faults */
reg.mode = UFFDIO_REGISTER_MODE_WP;

/* Both (Linux 5.7+): */
reg.mode = UFFDIO_REGISTER_MODE_MISSING | UFFDIO_REGISTER_MODE_WP;

/* UFFDIO_REGISTER_MODE_MINOR (Linux 5.13+): for shmem/hugetlb minor faults */
reg.mode = UFFDIO_REGISTER_MODE_MINOR;
```

## Complete example: lazy page provider

```c
#include <sys/mman.h>
#include <sys/ioctl.h>
#include <sys/syscall.h>
#include <linux/userfaultfd.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define SIZE    (64 * 1024 * 1024)  /* 64MB */

static int uf_fd;
static void *region;

static void *fault_handler_thread(void *arg)
{
    struct pollfd pfd = { .fd = uf_fd, .events = POLLIN };
    static char page[4096];

    while (1) {
        poll(&pfd, 1, -1);

        struct uffd_msg msg;
        if (read(uf_fd, &msg, sizeof(msg)) != sizeof(msg))
            break;

        if (msg.event != UFFD_EVENT_PAGEFAULT)
            continue;

        unsigned long page_addr = msg.arg.pagefault.address & ~0xFFFUL;
        unsigned long page_index = (page_addr - (unsigned long)region) / 4096;

        /* Generate the page content on-demand */
        memset(page, 0, sizeof(page));
        snprintf(page, 64, "Page %lu: generated on demand", page_index);

        struct uffdio_copy copy = {
            .dst = page_addr,
            .src = (unsigned long)page,
            .len = PAGE_SIZE,
        };
        ioctl(uf_fd, UFFDIO_COPY, &copy);
    }
    return NULL;
}

int main(void)
{
    /* Create a large anonymous mapping (no physical pages yet) */
    region = mmap(NULL, SIZE, PROT_READ | PROT_WRITE,
                  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);

    /* Create userfaultfd */
    uf_fd = syscall(SYS_userfaultfd, O_CLOEXEC | O_NONBLOCK);

    struct uffdio_api api = { .api = UFFD_API };
    ioctl(uf_fd, UFFDIO_API, &api);

    /* Register the entire region */
    struct uffdio_register reg = {
        .range = { .start = (unsigned long)region, .len = SIZE },
        .mode  = UFFDIO_REGISTER_MODE_MISSING,
    };
    ioctl(uf_fd, UFFDIO_REGISTER, &reg);

    /* Start fault handler thread */
    pthread_t thr;
    pthread_create(&thr, NULL, fault_handler_thread, NULL);

    /* Access memory — each access triggers a fault, handled by our thread */
    for (int i = 0; i < SIZE / 4096; i += 1024) {
        char *p = (char *)region + i * 4096;
        printf("Reading page %d: '%s'\n", i, p);
    }

    return 0;
}
```

## QEMU live migration with userfaultfd

QEMU uses userfaultfd for **post-copy live migration**: start the destination VM before all memory has arrived.

```
Source VM                              Destination VM
─────────────────────────────────────────────────────
                                       QEMU registers guest RAM with uffd
Transfer CPU state + a few pages ────►
                                       Start guest execution
                                       ↓
                                       Guest accesses page not yet received
                                       → userfaultfd fault event
                                       ↓
                                       Fault handler requests page from source
                               ◄────── request page N
Transfer page N ──────────────────────►
                                       uffd_copy resolves fault
                                       Guest continues
                                       (background: transfer remaining pages)
```

The key benefit: the destination VM starts running quickly, with only hot pages needing to be fetched on-demand.

## Kernel implementation

### Fault interception

```c
/* mm/userfaultfd.c */

/*
 * Called from handle_mm_fault() when a page is missing.
 * Returns VM_FAULT_RETRY if userfaultfd will handle it.
 */
vm_fault_t handle_userfault(struct vm_fault *vmf, unsigned long reason)
{
    struct mm_struct *mm = vmf->vma->vm_mm;
    struct userfaultfd_ctx *ctx;
    struct uffd_msg msg = {};

    ctx = vmf->vma->vm_userfaultfd_ctx.ctx;
    if (!ctx)
        return 0;  /* no uffd registered for this VMA */

    /* Build the fault message */
    msg.event = UFFD_EVENT_PAGEFAULT;
    msg.arg.pagefault.flags = 0;
    if (reason & VM_UFFD_WP)
        msg.arg.pagefault.flags |= UFFD_PAGEFAULT_FLAG_WP;
    if (vmf->flags & FAULT_FLAG_WRITE)
        msg.arg.pagefault.flags |= UFFD_PAGEFAULT_FLAG_WRITE;
    msg.arg.pagefault.address = vmf->address;

    /* Enqueue the fault message — the uffd file becomes readable */
    userfaultfd_event_wait_completion(ctx, &ewq);

    /*
     * The fault-handler thread has resolved the fault via UFFDIO_COPY
     * or UFFDIO_ZEROPAGE. Now retry the fault — the page is present.
     */
    return VM_FAULT_RETRY;
}
```

### struct userfaultfd_ctx

```c
struct userfaultfd_ctx {
    wait_queue_head_t   fault_pending_wqh; /* faults waiting to be read */
    wait_queue_head_t   fault_wqh;         /* faults waiting for resolution */
    wait_queue_head_t   event_wqh;         /* non-fault events (fork, remap) */
    wait_queue_head_t   fd_wqh;            /* fd poll wait queue */

    seqcount_spinlock_t refile_seq;
    unsigned long       features;
    bool                released;
    atomic_t            mmap_changing;

    struct mm_struct    *mm;
};
```

## Events beyond page faults

userfaultfd can also deliver non-fault events when the monitored region changes:

```c
/* Features to enable non-fault events: */
api.features = UFFD_FEATURE_EVENT_FORK        |  /* fork() duplicates VMA */
               UFFD_FEATURE_EVENT_REMAP       |  /* mremap() */
               UFFD_FEATURE_EVENT_REMOVE      |  /* madvise(MADV_REMOVE) */
               UFFD_FEATURE_EVENT_UNMAP;         /* munmap() */

/* In the handler: */
switch (msg.event) {
case UFFD_EVENT_FORK:
    /* msg.arg.fork.ufd = new uffd for child process */
    break;
case UFFD_EVENT_REMAP:
    /* msg.arg.remap.from/to/len */
    break;
case UFFD_EVENT_REMOVE:
case UFFD_EVENT_UNMAP:
    /* msg.arg.remove.start/end */
    break;
}
```

## Performance considerations

```
userfaultfd overhead:
  - Per fault: ~1-10µs (syscall + thread wakeup + copy + wakeup)
  - UFFDIO_COPY for 1 page: ~5µs
  - vs. normal page fault: ~1µs (anon) to 1ms+ (from disk)

Optimization techniques:
  1. Batch: use UFFDIO_COPY with larger ranges when possible
  2. Async wake: UFFDIO_COPY_MODE_DONTWAKE, then UFFDIO_WAKE
  3. Multiple handler threads: each reads from the same uf_fd
  4. Huge pages: register with huge page alignment, copy 2MB at a time
```

```bash
# Monitor userfaultfd activity
bpftrace -e '
kprobe:handle_userfault {
    @[kstack] = count();
}'

# Check if a process uses userfaultfd
ls -la /proc/<pid>/fd/ | grep userfaultfd

# Trace uffd ioctls
bpftrace -e '
tracepoint:syscalls:sys_enter_ioctl
/args->fd > 0 && (args->cmd == 0xc018aa03 || args->cmd == 0xc028aa04)/
{ printf("UFFDIO from pid %d\n", pid); }'
```

## Further reading

- [Page Fault Handler](page-fault.md) — handle_mm_fault, the entry point for userfaultfd
- [File-backed mmap](file-mmap.md) — mmap fundamentals
- [QEMU](../virtualization/kvm-memory.md) — live migration using userfaultfd
- [CRIU documentation](https://criu.org/Userfaultfd) — restore using lazy page transfer
- `mm/userfaultfd.c` — kernel implementation
- `tools/testing/selftests/mm/userfaultfd.c` — kernel self-test and usage example
