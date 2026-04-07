# Zero-copy internals

> Where copies actually happen — and where they don't — across the Linux I/O stack

The term "zero-copy" is applied to at least four different things in Linux documentation, driver code, and blog posts. They are not the same thing. This document maps each mechanism to the copies it actually eliminates, the copies it does not, and the kernel data structures that make it work.

For the high-level API usage of `sendfile(2)`, `splice(2)`, and `tee(2)`, see [splice-sendfile.md](splice-sendfile.md). This document focuses on the internals.

---

## What "zero-copy" means (and doesn't mean)

There are three distinct senses in which code can claim to be zero-copy:

**Zero kernel copies** — data does not pass through a kernel-managed intermediate buffer. The classic `read() + write()` loop copies from the page cache into a `sk_buff`; `sendfile` and `splice` eliminate that. This is the most common meaning and the easiest to achieve.

**Zero userspace copies** — data never enters userspace virtual memory at all. `sendfile` achieves this too: the application never calls `read()` into its own buffer. `MSG_ZEROCOPY` inverts the direction: the application *has* data in userspace and hands it to the kernel without a copy.

**Zero CPU copies** — no `memcpy` anywhere; the CPU is not involved in moving the bytes at all. DMA achieves this for the disk-to-DRAM and DRAM-to-NIC legs. The CPU-copy legs in the middle are what the other techniques eliminate.

Most "zero-copy" techniques achieve the first or second sense. Eliminating all CPU copies requires hardware support from both the storage device and the NIC.

### The four copies in naive file-to-socket I/O

```
                  ┌─────────────────────────────────────────────────────────┐
                  │  read(file_fd, buf, n) + write(sock_fd, buf, n)         │
                  │                                                          │
                  │  Copy 1 (DMA):                                           │
                  │  ┌──────┐  DMA   ┌──────────────┐                       │
                  │  │ Disk │──────► │  page cache  │                       │
                  │  └──────┘        └──────┬───────┘                       │
                  │                         │ Copy 2 (CPU: copy_to_user)    │
                  │                         ▼                                │
                  │                  ┌──────────────┐                       │
                  │                  │  userspace   │                       │
                  │                  │   buffer     │                       │
                  │                  └──────┬───────┘                       │
                  │                         │ Copy 3 (CPU: copy_from_user)  │
                  │                         ▼                                │
                  │                  ┌──────────────┐                       │
                  │                  │   sk_buff /  │  Copy 4 (DMA)         │
                  │                  │  socket buf  │──────────► NIC        │
                  │                  └──────────────┘                       │
                  └─────────────────────────────────────────────────────────┘
```

`sendfile()` and `splice()` eliminate copies 2 and 3 — the userspace round-trip. Copy 1 (disk to page cache) is unavoidable unless the filesystem supports DAX. Copy 4 (socket buffer to NIC) is unavoidable unless the NIC supports scatter-gather DMA, in which case the NIC can read the page cache page directly and copy 4 becomes a DMA operation sourced from the page cache rather than a CPU copy from a separate `sk_buff`.

With a scatter-gather capable NIC (`NETIF_F_SG`):

```
  Disk ──DMA──► page cache ──page ref──► sk_frag ──DMA──► NIC
                              (no CPU copy at all)
```

This is what people mean when they say sendfile is "truly zero-copy": zero CPU copies, two DMA transfers.

### Where CPU copies remain unavoidable

- **Encryption and compression**: TLS, gzip, brotli — the CPU must transform every byte. There is no way around this without hardware offload (kTLS, hardware crypto engines).
- **Alignment mismatches**: a device that requires contiguous aligned DMA cannot directly access a page that only partially contributes to the transfer; the driver must bounce-buffer that portion.
- **Protocol headers**: a TCP/IP header is usually 40–60 bytes and cannot be DMA'd from disk. It is always assembled by the CPU.
- **Checksums**: software checksums (CRC32, IP, TCP) require touching every byte. NIC hardware offload avoids this.

---

## Layer 1: DMA and scatter-gather

DMA (Direct Memory Access) is the fundamental mechanism that allows hardware to transfer data to and from RAM without occupying the CPU. Both storage controllers and NICs use DMA.

### Basic DMA

A device DMA transfer requires:
1. A physical address (or IOMMU-translated virtual address) in RAM
2. A byte count
3. A direction (device-to-memory or memory-to-device)

The driver programs these into a descriptor ring in device memory (or a set of device-visible registers), rings a doorbell, and the device performs the transfer asynchronously. An interrupt (or a polled completion queue entry, for NVMe) signals completion.

The constraint is that the buffer must be physically contiguous — which is why large DMA transfers have historically been difficult: getting a large contiguous physical allocation is expensive.

### Scatter-gather DMA

The solution is scatter-gather (SG) DMA. Instead of one (address, length) pair, the driver programs a list of them — a scatter-gather list — and the device handles them as one logical transfer, reading or writing them in order.

```
Scatter-gather list:
  Entry 0: phys_addr=0x10000, len=4096
  Entry 1: phys_addr=0x30000, len=4096   ← not contiguous with entry 0
  Entry 2: phys_addr=0x50000, len=2048

DMA controller reads all three ranges as if they were one 10240-byte buffer.
```

The kernel's scatter-gather descriptor is `struct scatterlist` (`include/linux/scatterlist.h`):

```c
/* include/linux/scatterlist.h */
struct scatterlist {
    unsigned long   page_link;    /* encodes struct page * + flags */
    unsigned int    offset;       /* byte offset within the page */
    unsigned int    length;       /* byte count for this entry */
    dma_addr_t      dma_address;  /* filled by dma_map_sg() */
#ifdef CONFIG_NEED_SG_DMA_LENGTH
    unsigned int    dma_length;
#endif
};
```

`page_link` uses the bottom two bits as flags: `0x01` means the entry is a chain to another `scatterlist` array (enabling linked lists of SG entries); `0x02` means this is the last entry in the array.

Building a scatter-gather list from a set of pages is a mechanical translation:

```c
/* Build a scatterlist from an array of struct page * */
struct scatterlist sg[nr_pages];
sg_init_table(sg, nr_pages);

for (int i = 0; i < nr_pages; i++) {
    sg_set_page(&sg[i], pages[i],
                (i == nr_pages - 1) ? last_len : PAGE_SIZE,
                (i == 0) ? first_offset : 0);
}
sg_mark_end(&sg[nr_pages - 1]);
```

### dma_map_sg: from virtual to DMA address

`dma_map_sg()` converts the `page_link`-encoded pages in a scatterlist into `dma_address` values that the device can actually use:

```c
/* include/linux/dma-mapping.h */
int dma_map_sg(struct device *dev, struct scatterlist *sg,
               int nents, enum dma_data_direction dir);
```

On a system without an IOMMU this is a thin wrapper that calls `page_to_phys()` for each entry and stores the result in `dma_address`. On a system with an IOMMU (Intel VT-d, AMD-Vi, ARM SMMU), `dma_map_sg()` programs the IOMMU to map those physical pages into a contiguous region of the device's address space (IOVA space). From the device's perspective it sees one contiguous buffer; the IOMMU handles the scatter.

```
Without IOMMU:
  scatterlist → physical addresses → device programs these directly

With IOMMU:
  scatterlist → IOMMU mapping (IOVA) → device uses IOVA
                                ↓
                      IOMMU translates IOVA → physical pages
```

IOMMU mapping has a cost: programming the IOMMU's translation tables takes time. For high-IOPS workloads, this is measurable. DMA-API-bypass paths (VFIO, RDMA, io_uring fixed buffers) amortize this by keeping mappings alive.

### DMA bounce buffers

Not all devices can address all of physical memory. 32-bit PCI devices can only access the first 4 GiB. When the kernel allocates a buffer above 4 GiB for such a device, the driver must use a "bounce buffer": a buffer in the low 4 GiB into which the data is copied before DMA, and out of which it is copied after. This is a CPU copy inserted by the DMA layer — a hidden cost that can surprise profilers.

```c
/* The kernel handles this transparently via the swiotlb:
   drivers/iommu/dma-iommu.c, kernel/dma/swiotlb.c */
```

The `SWIOTLB` (software I/O translation lookaside buffer) implements bounce buffering. On modern x86 systems with 64-bit DMA-capable devices, the swiotlb is rarely used for storage or network I/O, but it is still needed for some USB, sound, and legacy PCI devices.

### NVMe scatter-gather lists

NVMe commands carry a PRP (Physical Region Page) list or an SGL (Scatter Gather List) embedded in the command submission queue entry. The SGL format allows up to two data segments in the 16-byte SGL descriptor embedded in the 64-byte command capsule; larger transfers use an SGL descriptor that points to a list of `(address, length)` pairs in a separate memory region.

```
NVMe SGL descriptor (8 bytes address + 4 bytes length + 4 bytes type/subtype):
  type=SGL_DATA_BLOCK:   direct reference to a contiguous data range
  type=SGL_KEYED_DATA:   includes a remote key (for NVMe-oF RDMA)
  type=SGL_SEGMENT:      points to another SGL segment (chaining)
```

The NVMe driver builds a scatter-gather list from the `struct request` bio chain, maps it with `dma_map_sg()`, and encodes the resulting DMA addresses into the NVMe SGL.

---

## Layer 2: page pinning for DMA

DMA requires that the physical pages involved do not move or get reclaimed while the transfer is in flight. The kernel's virtual memory subsystem normally has the freedom to swap pages out to disk, migrate them between NUMA nodes, or reclaim them under memory pressure. For DMA, this must be prevented.

### get_user_pages and FOLL_PIN

The standard mechanism to pin userspace pages for DMA is `get_user_pages()` (GUP):

```c
/* mm/gup.c */
long get_user_pages(unsigned long start, unsigned long nr_pages,
                    unsigned int gup_flags,
                    struct page **pages);
```

GUP walks the page tables for the virtual address range `[start, start + nr_pages * PAGE_SIZE)`, faults in any pages that are not present, and increments the reference count of each `struct page`. As long as the reference count is nonzero, the page allocator will not reclaim or migrate the page.

After the DMA completes, the driver calls `put_page()` (or `unpin_user_page()`) to decrement the reference count.

The problem with `get_user_pages()` for DMA is subtle: it increments the page's normal reference count. If the page is a file-backed page (from the page cache) and its reference count reaches zero after the DMA application is done with it, the page can be freed and the physical frame reused. But while the DMA is in flight, the NIC holds a reference in its DMA descriptor ring — and a freed-then-reallocated page at the same physical address would corrupt the new allocation. This is not a theoretical issue: transparent huge page splitting and NUMA page migration have historically triggered it.

**`FOLL_PIN`** (Linux 5.2, introduced in commit `eddb1c228f79`) solves this by maintaining a separate pin count distinct from the normal reference count. Pages pinned with `FOLL_PIN` (via `pin_user_pages()`) are tracked by the memory management subsystem and block operations that would otherwise be safe on a merely-referenced page:

```c
/* mm/gup.c — preferred for DMA since 5.2 */
long pin_user_pages(unsigned long start, unsigned long nr_pages,
                    unsigned int gup_flags,
                    struct page **pages);

/* Unpin after DMA completes */
void unpin_user_page(struct page *page);
void unpin_user_pages(struct page **pages, unsigned long npages);
```

`FOLL_PIN` pages are incompatible with `KSM` (kernel samepage merging) and with `->migrate_page` operations, which prevents the subtle corruption scenarios.

### The pin lifecycle in practice

```
1. Application calls sendmsg(MSG_ZEROCOPY) or io_uring submits a fixed-buffer op
      │
      ▼
2. Kernel calls pin_user_pages() on the user buffer pages
      │
      ▼
3. dma_map_sg() maps the pages for the NIC
      │
      ▼
4. NIC DMA descriptor programmed with the IOVA/physical addresses
      │
      ▼
5. NIC transmits; data leaves the machine
      │
      ▼
6. NIC interrupt / completion queue poll signals done
      │
      ▼
7. dma_unmap_sg() releases the IOMMU mappings
      │
      ▼
8. unpin_user_pages() decrements pin count
      │
      ▼
9. Application notified (MSG_ZEROCOPY error queue / io_uring CQE)
      │
      ▼
10. Application may now reuse or free the buffer
```

Steps 2–8 happen entirely in the kernel; the application only sees steps 1 and 9–10.

---

## Layer 3: pipe buffers as the zero-copy primitive

The kernel's internal zero-copy mechanism is built on top of pipe buffers. This is the actual data structure that `splice()`, `sendfile()`, and `tee()` manipulate.

### struct pipe_buffer

```c
/* include/linux/pipe_fs_i.h */
struct pipe_buffer {
    struct page      *page;    /* the cached (or user) page */
    unsigned int      offset;  /* byte offset within the page */
    unsigned int      len;     /* byte count in this buffer entry */
    const struct pipe_buf_operations *ops;
    unsigned int      flags;   /* PIPE_BUF_FLAG_LRU, PIPE_BUF_FLAG_GIFT,
                                   PIPE_BUF_FLAG_PACKET, PIPE_BUF_FLAG_CAN_MERGE,
                                   PIPE_BUF_FLAG_WHOLE, PIPE_BUF_FLAG_LOSS */
    unsigned long     private; /* ops-specific, e.g. offset into a net page */
};
```

A `pipe_buffer` is a reference to a page (a `struct page *`) with an offset and length. It is not a copy of the page's bytes; it is a pointer to them, with the page's reference count incremented.

The `ops` field points to a `pipe_buf_operations` table:

```c
struct pipe_buf_operations {
    /*
     * Attempt to steal ownership of this pipe_buffer's page.
     * Returns 0 if the page now belongs to the caller.
     * Returns nonzero if it cannot be stolen (e.g., it's shared).
     */
    int (*confirm)(struct pipe_inode_info *, struct pipe_buffer *);
    void (*release)(struct pipe_inode_info *, struct pipe_buffer *);
    bool (*try_steal)(struct pipe_inode_info *, struct pipe_buffer *);
    bool (*get)(struct pipe_inode_info *, struct pipe_buffer *);
};
```

Different sources of pages use different operation tables:
- `page_cache_pipe_buf_ops` — pages from the filesystem page cache (reference is `get_page`/`put_page`)
- `anon_pipe_buf_ops` — anonymous pages written into the pipe via `write()`
- `user_page_pipe_buf_ops` — user pages handed in via `vmsplice(SPLICE_F_GIFT)`
- `nosteal_pipe_buf_ops` — pages that cannot be stolen (e.g., pages shared with another pipe after `tee()`)

### struct pipe_inode_info: the ring buffer

```c
/* include/linux/pipe_fs_i.h */
struct pipe_inode_info {
    struct mutex             mutex;
    wait_queue_head_t        rd_wait, wr_wait;
    unsigned int             head;       /* next slot to fill (writer index) */
    unsigned int             tail;       /* next slot to drain (reader index) */
    unsigned int             ring_size;  /* number of slots (power of 2) */
    unsigned int             nr_accounted;
    unsigned int             readers;
    unsigned int             writers;
    unsigned int             files;      /* open fds pointing here */
    unsigned int             r_counter;
    unsigned int             w_counter;
    unsigned int             poll_usage;
    struct page             *tmp_page;   /* cached free page for small writes */
    struct fasync_struct    *fasync_readers;
    struct fasync_struct    *fasync_writers;
    struct pipe_buffer      *bufs;       /* the ring: bufs[tail % ring_size .. head % ring_size] */
    struct user_struct      *user;
};
```

The ring holds `ring_size` entries of `struct pipe_buffer`. The default ring size is 16 entries (16 pages = 64 KiB), adjustable via `fcntl(F_SETPIPE_SZ)`. The maximum is `/proc/sys/fs/pipe-max-size` (default 1 MiB).

### The zero-copy move: adding a page reference

When `splice(file_fd, ..., pipe_wr, ...)` runs, `do_splice_to()` calls the file's `splice_read` operation. For regular files this is `filemap_splice_read()` (or the filesystem's override):

```c
/* fs/splice.c — simplified */
ssize_t filemap_splice_read(struct file *in, loff_t *ppos,
                             struct pipe_inode_info *pipe,
                             size_t len, unsigned int flags)
{
    struct page *page;
    struct pipe_buffer *buf;

    /* Find (or read in) the page from the page cache */
    page = find_or_create_page(in->f_mapping, index, GFP_KERNEL);

    /* Get a slot in the pipe ring */
    buf = &pipe->bufs[pipe->head & (pipe->ring_size - 1)];

    /* Install a reference — NOT a copy */
    buf->page   = page;          /* get_page() already incremented refcount */
    buf->offset = page_offset;
    buf->len    = copy_len;
    buf->ops    = &page_cache_pipe_buf_ops;

    pipe->head++;   /* advance write index */
    /* page's bytes haven't moved; only the pointer has */
}
```

When `splice(pipe_rd, ..., sock_fd, ...)` subsequently runs, `do_splice_from()` calls the socket's `splice_write`. For TCP this ends up in `tcp_sendpage()`, which attaches the `struct page *` as a fragment in an `sk_buff`:

```c
/* net/ipv4/tcp.c — simplified */
static int tcp_sendpage_locked(struct sock *sk, struct page *page,
                                int offset, size_t size, int flags)
{
    struct sk_buff *skb = tcp_write_queue_tail(sk);

    /* Attach as a frag: no copy */
    skb_fill_page_desc(skb, skb_shinfo(skb)->nr_frags,
                       page, offset, size);
    get_page(page);   /* sk_buff holds a reference */
    skb->len      += size;
    skb->data_len += size;
    /* skb_frag points to the page cache page; NIC will DMA from there */
}
```

The `sk_buff` now holds a reference to the original page cache page. When the NIC's DMA engine processes the transmit descriptor ring, it reads the data directly from the page cache — no `memcpy` involved.

---

## sendfile: the kernel path

`sendfile(out_fd, in_fd, offset, count)` calls `do_sendfile()` in `fs/read_write.c`. The implementation uses a temporary pipe as an intermediary:

```c
/* fs/read_write.c — simplified */
static ssize_t do_sendfile(int out_fd, int in_fd, loff_t *ppos,
                            size_t count, loff_t max)
{
    struct file *in_file, *out_file;
    struct pipe_inode_info *pipe;
    ssize_t retval;

    in_file  = fget(in_fd);
    out_file = fget(out_fd);

    /* Allocate a temporary in-kernel pipe (not visible to userspace) */
    create_pipe_files(pipes, 0);
    pipe = get_pipe_info(pipes[0], true);

    /* Step 1: splice from file into the temporary pipe
       This installs page cache references as pipe_buffer entries.
       No CPU copy. */
    retval = do_splice_to(in_file, ppos, pipe, count,
                          SPLICE_F_MOVE);

    /* Step 2: splice from the temporary pipe to the socket
       For TCP: attaches pipe_buffer pages as sk_buff frags.
       For NIC with NETIF_F_SG: NIC DMAs directly from page cache. */
    retval = do_splice_from(pipe, out_file, &out_file->f_pos,
                             count, SPLICE_F_MOVE);

    fput(in_file);
    fput(out_file);
    /* temporary pipe is freed; page references were transferred to sk_buff */
}
```

The temporary pipe is an implementation detail invisible to the application. The key insight is that both `do_splice_to` and `do_splice_from` operate on `struct page *` references; the bytes never move.

### The NIC's role: scatter-gather DMA from page cache

Without NIC scatter-gather support (`NETIF_F_SG` not set in `dev->features`), the networking stack cannot DMA from fragmented pages. In that case the driver calls `__skb_linearize()`, which copies all fragments into a single contiguous buffer — one CPU copy. This copy is unavoidable on such hardware.

With `NETIF_F_SG`, the NIC driver programs its DMA descriptor ring with one entry per `sk_buff` fragment, each pointing to the physical address of a page cache page. The NIC performs the DMA transfers in order; the CPU is not involved in moving the data bytes.

```c
/* Example: ixgbe (Intel 10GbE) tx path — simplified */
static void ixgbe_tx_map(struct ixgbe_ring *tx_ring, struct sk_buff *skb, ...)
{
    /* Linear portion (headers): one DMA descriptor */
    dma = dma_map_single(dev, skb->data, skb_headlen(skb), DMA_TO_DEVICE);
    tx_desc->read.buffer_addr = cpu_to_le64(dma);

    /* Fragments (page cache pages from sendfile): one descriptor each */
    for (i = 0; i < skb_shinfo(skb)->nr_frags; i++) {
        skb_frag_t *frag = &skb_shinfo(skb)->frags[i];
        dma = skb_frag_dma_map(dev, frag, 0,
                                skb_frag_size(frag), DMA_TO_DEVICE);
        tx_desc->read.buffer_addr = cpu_to_le64(dma);
        /* NIC will DMA directly from the page cache page */
    }
}
```

---

## MSG_ZEROCOPY: userspace buffer to NIC without copy

`MSG_ZEROCOPY` (Linux 4.14, `net/core/sock.c`) addresses the inverse problem: the application has data in its own memory and wants to send it without the kernel making a copy into `sk_buff` linear memory.

### Enabling and using MSG_ZEROCOPY

```c
/* Enable zero-copy on the socket */
int one = 1;
setsockopt(sock, SOL_SOCKET, SO_ZEROCOPY, &one, sizeof one);

/* Send without copying the buffer */
struct iovec iov = { .iov_base = buf, .iov_len = len };
struct msghdr msg = { .msg_iov = &iov, .msg_iovlen = 1 };
sendmsg(sock, &msg, MSG_ZEROCOPY);

/*
 * The kernel has pinned buf's pages. Do NOT modify buf yet.
 * Wait for the completion notification via the error queue.
 */
struct msghdr cmsg = {};
char control[100];
cmsg.msg_control    = control;
cmsg.msg_controllen = sizeof control;
recvmsg(sock, &cmsg, MSG_ERRQUEUE);

/* Parse the cmsg to find the completion range, then reuse buf */
struct sock_extended_err *serr = (struct sock_extended_err *)
    CMSG_DATA(CMSG_FIRSTHDR(&cmsg));
/* serr->ee_data = highest completed send id */
/* serr->ee_info = lowest completed send id */
```

### Internals: sock_zerocopy_alloc and ubuf_info

```c
/* net/core/sock.c */
struct ubuf_info *sock_zerocopy_alloc(struct sock *sk, size_t size)
{
    struct ubuf_info *uarg;

    uarg = kmalloc(sizeof(*uarg), GFP_KERNEL);
    uarg->callback  = sock_zerocopy_callback; /* posts to error queue on completion */
    uarg->id        = atomic_inc_return(&sk->sk_zckey) - 1;
    uarg->len       = 0;
    uarg->bytelen   = size;
    uarg->zerocopy  = 1;
    refcount_set(&uarg->refcnt, 1);

    return uarg;
}
```

The send path calls `pin_user_pages_fast()` on the user buffer pages. The pages are then attached to the `sk_buff` as fragments, exactly as in the `sendfile` case — the NIC DMAs from user pages rather than page cache pages:

```c
/* net/core/skbuff.c — zerocopy send path */
int skb_zerocopy_iter_stream(struct sock *sk, struct sk_buff *skb,
                              struct msghdr *msg, int len,
                              struct ubuf_info *uarg)
{
    struct iov_iter *from = &msg->msg_iter;

    /* Pin the userspace pages */
    npages = iov_iter_get_pages2(from, pages, len, MAX_SKB_FRAGS, &start);

    /* Attach pages as sk_buff frags */
    for (i = 0; i < npages; i++) {
        skb_fill_page_desc(skb, skb_shinfo(skb)->nr_frags,
                           pages[i], start, copy);
    }
    skb_shinfo(skb)->destructor_arg = uarg;
    skb_shinfo(skb)->tx_flags |= SKBTX_ZEROCOPY_FRAG;
}
```

When the NIC's transmit completion fires, the `sk_buff` destructor calls `sock_zerocopy_callback()`, which posts a notification to the socket's error queue. The application collects this via `recvmsg(MSG_ERRQUEUE)`.

### The MSG_ZEROCOPY cost model

`MSG_ZEROCOPY` is not free. The overhead vs. a standard `send()` includes:
- `pin_user_pages_fast()` — page table walk and pin count increment per page
- Reference count manipulation per `sk_buff` fragment
- Error queue notification allocation and delivery
- Application must drain the error queue

For sends smaller than approximately 10 KB, the overhead of pinning, tracking, and notification exceeds the cost of a single `memcpy`. The Linux kernel networking team's benchmarks (documented in the 4.14 commit message and subsequent lwn.net coverage) put the practical break-even point at roughly 10–100 KB depending on CPU, NIC, and workload.

A wrinkle: `MSG_ZEROCOPY` does not guarantee zero copy. The kernel may fall back to a regular copy if the `sk_buff` cannot accommodate fragments (e.g., when the socket is in a state that requires linearization). Applications can detect whether the actual send was zero-copy by checking `serr->ee_code & SO_EE_CODE_ZEROCOPY_COPIED` in the error queue notification.

---

## io_uring fixed buffers: amortized pin cost

io_uring (Linux 5.1) introduced "fixed buffers" — a mechanism to register I/O buffers once at ring creation time, keeping the pages pinned for the ring's lifetime. Each individual I/O operation then skips the `pin_user_pages()` / `unpin_user_pages()` round trip.

### Registration

```c
/* Register N buffers at startup */
#include <liburing.h>

#define NUM_BUFS 8
#define BUF_SIZE (256 * 1024)   /* 256 KiB each */

struct iovec iov[NUM_BUFS];
void *bufs[NUM_BUFS];

for (int i = 0; i < NUM_BUFS; i++) {
    posix_memalign(&bufs[i], getpagesize(), BUF_SIZE);
    iov[i].iov_base = bufs[i];
    iov[i].iov_len  = BUF_SIZE;
}

struct io_uring ring;
io_uring_queue_init(256, &ring, 0);

/* Pin all pages once; stored in ring->ring_fd's registered buffer table */
io_uring_register_buffers(&ring, iov, NUM_BUFS);
```

### Using fixed buffers

```c
/* Read using pre-pinned buffer — no per-op pin/unpin */
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
io_uring_prep_read_fixed(sqe,
    fd,
    bufs[0],        /* pointer into the pre-registered buffer */
    BUF_SIZE,       /* length */
    0,              /* file offset */
    0);             /* buffer index (which of the NUM_BUFS registered) */
io_uring_submit(&ring);

/* Collect completion */
struct io_uring_cqe *cqe;
io_uring_wait_cqe(&ring, &cqe);
ssize_t n = cqe->res;
io_uring_cqe_seen(&ring, cqe);
/* bufs[0][0..n-1] contains the data; no pin/unpin overhead incurred */
```

### Internals: io_uring_register_buffers

```c
/* io_uring/rsrc.c — simplified */
int io_register_buffers(struct io_ring_ctx *ctx,
                         void __user *arg, unsigned nr_args)
{
    struct io_rsrc_data *data;
    struct iovec iov;

    data = io_rsrc_data_alloc(ctx, io_buffer_unmap, nr_args);

    for (int i = 0; i < nr_args; i++) {
        copy_from_user(&iov, &uvec[i], sizeof iov);

        /* Pin the pages for this buffer region */
        ret = io_buffer_account_pin(ctx, pages, nr_pages,
                                     &data->tags[i]);
        /*
         * Internally calls pin_user_pages() and builds a
         * struct bio_vec array for each registered buffer.
         * The pages remain pinned until io_uring_unregister_buffers()
         * or the ring is closed.
         */
    }
    ctx->user_bufs = data;
}
```

For each operation using a fixed buffer (`IORING_OP_READ_FIXED`, `IORING_OP_WRITE_FIXED`), the kernel looks up the pre-built `bio_vec` array for the given buffer index and submits it to the block layer directly, skipping the per-operation GUP step.

For high-IOPS workloads (NVMe SSDs at 1M+ IOPS), the per-operation pin/unpin overhead in the non-fixed path is measurable — typically 5–15% of CPU time. Fixed buffers eliminate this entirely.

### io_uring zero-copy send: IORING_OP_SEND_ZC

Linux 6.0 added `IORING_OP_SEND_ZC`, combining io_uring's async submission model with `MSG_ZEROCOPY`-style page pinning:

```c
/* Async zero-copy send via io_uring */
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
io_uring_prep_send_zc(sqe, sock_fd, buf, len, 0, 0);
/* IOSQE_FIXED_FILE: use registered file descriptor
   IORING_RECVSEND_FIXED_BUF: use registered buffer (pre-pinned) */
sqe->flags |= IOSQE_CQE_SKIP_SUCCESS;   /* optional: skip intermediate CQEs */
io_uring_submit(&ring);

/*
 * Two CQEs are generated:
 * 1. First CQE: IORING_CQE_F_MORE set — send submitted (not yet complete)
 * 2. Second CQE: completion — NIC done, buffer can be reused
 */
```

When combined with registered buffers (pre-pinned), `IORING_OP_SEND_ZC` achieves:
- Zero `pin_user_pages()` calls per send
- Zero `memcpy` from user buffer to `sk_buff`
- Async completion via CQE rather than error queue poll

This is the state-of-the-art zero-copy send path for Linux user-space applications as of 6.0+.

---

## RDMA: zero-copy across the network

RDMA (Remote Direct Memory Access) extends the zero-copy concept to the network: the NIC reads from and writes to application memory directly, bypassing the kernel entirely on the data path.

### Memory regions and IOMMU

An application registers a memory region with the RDMA NIC:

```c
/* User-space RDMA (libibverbs) */
struct ibv_mr *mr = ibv_reg_mr(pd, addr, length,
                                IBV_ACCESS_LOCAL_WRITE |
                                IBV_ACCESS_REMOTE_READ |
                                IBV_ACCESS_REMOTE_WRITE);
```

`ibv_reg_mr()` is a system call (via the RDMA Character Device) that:
1. Calls `pin_user_pages()` to lock the pages in RAM
2. Programs the IOMMU to allow the RDMA NIC to access those physical pages
3. Returns a memory region handle including a local and remote key

The remote key (`mr->rkey`) is sent to the remote peer. The peer's NIC then issues RDMA READ or RDMA WRITE operations that directly access the registered memory, with no CPU involvement on either side.

```
Local machine:                          Remote machine:
  Application memory (pinned)              Application (or OS) posts an RDMA WRITE
       ↑                                         │
  IOMMU maps physical pages                      │
       ↑                                         ▼
  RDMA NIC ◄─────── PCIe ◄─────────────── RDMA NIC
             (data crosses the network)
```

The kernel is not in the data path at all. Neither machine's CPU touches the data bytes. This is the only mechanism in common Linux use that achieves true zero-CPU-copy across the network.

### Kernel-side RDMA: io_uring and kTLS interaction

`IORING_OP_SEND_ZC` was explicitly designed with RDMA patterns as inspiration. The completion model (two CQEs: one for submission acknowledgment, one for buffer release) mirrors the RDMA send/completion queue model.

For software RDMA (RoCE over standard Ethernet NICs), the kernel's `rxe` driver implements RDMA semantics in software, with the same registration and pin lifecycle as hardware RDMA.

---

## True zero-copy: a precise accounting

The table below accounts for every copy in each mechanism. "DMA" means the CPU is not involved; "CPU" means `memcpy` or equivalent is required.

| Mechanism | Disk → RAM | RAM → NIC | CPU copies eliminated vs. read+write |
|-----------|-----------|----------|---------------------------------------|
| `read() + write()` | DMA | DMA, but via sk_buff copy | 0 (baseline) |
| `sendfile` (no SG NIC) | DMA | DMA (from sk_buff copy) | 2 (page cache → user, user → sk_buff) |
| `sendfile` (SG NIC) | DMA | DMA (from page cache) | 2 + skips sk_buff linearization |
| `MSG_ZEROCOPY` | n/a | DMA (from user pages) | 1 (user buf → sk_buff) |
| `MSG_ZEROCOPY` + fixed buffers | n/a | DMA (from pre-pinned user pages) | 1 + skips per-op GUP |
| `RDMA WRITE` | n/a | DMA, no kernel involvement | all (kernel entirely bypassed) |
| `io_uring READ_FIXED` | DMA → pre-pinned user buf | n/a | skips per-op GUP overhead |

### When zero-copy is not beneficial

**Small transfers**: the overhead of page pinning, scatter-gather setup, and (for `MSG_ZEROCOPY`) error queue notification can exceed a single `memcpy` for small buffers. The break-even point is hardware-dependent but generally 10–64 KB.

**Encrypted connections without kTLS**: TLS requires transforming every byte. `sendfile` cannot help. With kTLS (`SO_TLS_TX`, Linux 4.17+), the kernel encrypts data on its way to the NIC, preserving the zero-copy property for the file-to-network segment. See [kTLS](../net/ktls.md).

**Content transformation**: any per-byte processing (compression, encoding, checksumming in software) requires CPU access to the data. The only optimisation available is to minimize extra copies — process in-place rather than copying to a staging buffer.

**Non-scatter-gather NICs**: virtual machine NICs, USB network adapters, and some older hardware do not support `NETIF_F_SG`. The kernel must linearize `sk_buff` fragments before the NIC can process them, reintroducing a CPU copy.

**NUMA topology**: when the page cache is on a different NUMA node from the NIC's DMA engine, the "zero-copy" DMA still crosses the NUMA interconnect. This is unavoidable without pinning the page allocator to the NIC's local node.

---

## Putting it together: copy accounting for common workloads

### Static file HTTP server (nginx + sendfile + SG NIC)

```
disk ──DMA──► page cache ──page ref──► sk_frag ──DMA──► NIC
     copy 1                                      copy 2

CPU copies: 0
DMA transfers: 2
Context switches: 2 (syscall entry, return)
```

### HTTPS with kTLS

```
disk ──DMA──► page cache ──page ref──► kTLS encrypt (CPU) ──► sk_frag ──DMA──► NIC
     copy 1                              (unavoidable)                   copy 2

CPU copies: 1 (encryption, cannot be eliminated without hardware offload)
```

### io_uring fixed-buffer NVMe read (database hot path)

```
NVMe ──DMA──► pre-pinned user buffer (no GUP per-op)

CPU copies: 0
DMA transfers: 1
pin_user_pages() calls: 0 (amortized at registration)
```

### MSG_ZEROCOPY TCP send

```
user buffer (pinned) ──page ref──► sk_frag ──DMA──► NIC
(already in user memory)                    copy 1

CPU copies: 0 (for large sends; fallback copy for small sends)
Completion notification: required before buffer reuse
```

---

## Key source files

- `fs/splice.c` — `sys_splice`, `sys_tee`, `do_splice_to`, `do_splice_from`, `filemap_splice_read`, `splice_from_pipe`, `generic_splice_sendpage`
- `fs/read_write.c` — `do_sendfile`, `sys_copy_file_range`
- `include/linux/pipe_fs_i.h` — `struct pipe_inode_info`, `struct pipe_buffer`, `struct pipe_buf_operations`
- `include/linux/scatterlist.h` — `struct scatterlist`, `sg_set_page`, `sg_mark_end`
- `include/linux/dma-mapping.h` — `dma_map_sg`, `dma_unmap_sg`, `dma_map_single`
- `mm/gup.c` — `get_user_pages`, `pin_user_pages`, `unpin_user_page`; FOLL_PIN semantics
- `net/core/sock.c` — `sock_zerocopy_alloc`, `sock_zerocopy_callback`, `SO_ZEROCOPY` socket option
- `net/core/skbuff.c` — `skb_zerocopy_iter_stream`, `skb_fill_page_desc`
- `io_uring/rsrc.c` — `io_register_buffers`, fixed buffer table management
- `io_uring/net.c` — `IORING_OP_SEND_ZC` implementation
- `kernel/dma/swiotlb.c` — bounce buffer implementation for constrained DMA
- `drivers/iommu/dma-iommu.c` — IOMMU DMA mapping

---

## Further reading

- [splice, sendfile, and friends](splice-sendfile.md) — API usage, practical patterns, when to use each
- [Direct I/O](direct-io.md) — O_DIRECT, iomap DIO, NVMe submission path
- [iov_iter](iov-iter.md) — the buffer abstraction that unifies all I/O paths including zero-copy
- [Async I/O evolution](async-io.md) — io_uring architecture; fixed buffers in context
- [Buffered I/O and the page cache](buffered-io.md) — what splice's page references point into
- [Page cache internals](page-cache-internals.md) — `struct page` reference counting that makes zero-copy safe
- `Documentation/core-api/dma-api.rst` — DMA API documentation
- `Documentation/core-api/pin_user_pages.rst` — FOLL_PIN semantics and motivation
- `tools/testing/selftests/net/msg_zerocopy.c` — in-tree MSG_ZEROCOPY selftest and benchmark
