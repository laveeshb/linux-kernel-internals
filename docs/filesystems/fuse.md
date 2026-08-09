# FUSE: Filesystems in Userspace

> How the kernel lets an *ordinary program* implement a filesystem — the request/response protocol over `/dev/fuse`, why it costs what it costs, and how virtiofs and io_uring change the math

Everything else in this section is kernel code: ext4, XFS, and btrfs are compiled into the kernel and run in kernel context. FUSE is the exception that makes the rest possible to sidestep — it lets a filesystem be implemented by a normal userspace process. sshfs, s3fs, gluster's client, `ntfs-3g`, GNOME's gvfs, AppImage, and rclone's mount all work this way. The trade is flexibility (write a filesystem in any language, with no kernel code and no reboot) against a performance cost that comes directly from the architecture.

## The architecture: a kernel driver that forwards to a daemon

FUSE is two halves that talk through a device:

1. A **kernel module** (`fs/fuse/`) that registers `fuse` as a real filesystem type. To the VFS it looks like any other filesystem — it implements the inode and file operations.
2. A **userspace daemon** (usually built on `libfuse`) that contains the actual filesystem logic.

They communicate through the character device **`/dev/fuse`**. When a process does `open()`, `read()`, `stat()`, or `readdir()` on a FUSE mount, the VFS calls into the FUSE kernel module, which does *not* know how to answer — instead it packages the operation into a **request** and makes it available for the daemon to read from `/dev/fuse`. The daemon reads the request, does whatever it means (fetch from S3, read over SSH, decode NTFS), and writes a **reply** back. The kernel unpacks the reply and returns it to the original caller, which was blocked the whole time.

```
  user process              kernel                         FUSE daemon (userspace)
  ────────────              ──────                         ───────────────────────
  read(fd) ──────────►  VFS ──► FUSE module
                                    │  build FUSE_READ request
                                    ▼
                               /dev/fuse   ────read()────►  handle it (e.g. HTTP GET)
                                    ▲                              │
                                    └────────write() reply ◄───────┘
  ◄──────── data ───── VFS ◄── FUSE module (copies reply into the page)
```

Each request carries an opcode (`FUSE_LOOKUP`, `FUSE_OPEN`, `FUSE_READ`, `FUSE_WRITE`, `FUSE_GETATTR`, …) and its arguments; the protocol is versioned and negotiated at mount via a `FUSE_INIT` handshake.

## Why it costs what it costs

A single `read()` that a native filesystem answers with a page-cache hit becomes, under FUSE, a round trip out to userspace and back:

- **Context switches.** The calling task blocks; the daemon must be scheduled to read the request; then control comes back. That's at least two extra scheduling boundaries per uncached operation.
- **Data copies.** Historically the reply data was copied from the daemon's buffer through `/dev/fuse` into the kernel's page. `splice()` later removed some of these copies, but the boundary crossing remains.
- **Serialization.** Every operation is marshaled into the FUSE protocol format and unmarshaled again.

FUSE mitigates rather than eliminates this. The kernel side caches aggressively — dentries, attributes, and page data are cached with negotiated timeouts, so repeated lookups and cached reads never leave the kernel. Writeback caching batches dirty data. `max_pages` and readahead let one request move up to a megabyte at a time. But the fundamental "cross to userspace for a cache miss" cost is inherent to the model, which is why FUSE filesystems trail native ones on metadata-heavy and small-I/O workloads.

## Security: unprivileged mounts

Because a FUSE daemon is untrusted userspace serving filesystem responses to other processes, mounting one was historically privileged. The kernel gained support for **fully unprivileged FUSE mounts inside user namespaces** ([`4ad769f3c346`](https://git.kernel.org/linus/4ad769f3c346) "fuse: Allow fully unprivileged mounts"), which is what lets rootless containers and sandboxes mount FUSE filesystems safely — the kernel restricts what such a mount can do (e.g. `allow_other` is confined to the mounting namespace) so a malicious daemon can't attack processes outside its own domain.

## Beyond the classic model

Two developments attack FUSE's central cost — the userspace round trip:

- **virtiofs** applies the FUSE protocol to a different problem: sharing a host directory into a virtual machine. Instead of `/dev/fuse`, requests travel over a **virtio** transport to a device the host services, giving VMs a shared filesystem with near-native semantics and, via DAX, the ability to map host page cache directly. See the kernel's [virtiofs documentation](https://docs.kernel.org/filesystems/virtiofs.html) ([`a62a8ef9d97d`](https://git.kernel.org/linus/a62a8ef9d97d) "virtio-fs: add virtiofs filesystem").
- **FUSE over io_uring** replaces the read/write-on-`/dev/fuse` request loop with shared ring buffers, so the kernel and daemon exchange requests and replies with far fewer syscalls and context switches, and can keep a request serviced on the same CPU. See [FUSE-over-io-uring](https://docs.kernel.org/filesystems/fuse/fuse-io-uring.html). (For the ring mechanism itself, see [io_uring](../io-uring/README.md).)

## Further reading

- [Kernel docs: FUSE](https://docs.kernel.org/filesystems/fuse/fuse.html) — the protocol and the design rationale
- [Kernel docs: virtiofs](https://docs.kernel.org/filesystems/virtiofs.html) — FUSE protocol over virtio for VMs
- [Kernel docs: FUSE over io_uring](https://docs.kernel.org/filesystems/fuse/fuse-io-uring.html) — the ring-based transport
- [VFS](../vfs/README.md) — the layer FUSE plugs into as just another filesystem type
