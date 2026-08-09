# Storage & I/O

The path data takes from an application's read or write down to a physical device — and the layers that make it general and fast.

- [VFS (vfs/)](../vfs/README.md) — the abstraction that lets one API drive every filesystem
- [Filesystems (filesystems/)](../filesystems/README.md) — how on-disk formats and the page cache turn bytes into files
- [Block Layer (block/)](../block/README.md) — the path from a filesystem request to a physical device
- [I/O Patterns (io/)](../io/README.md) — buffered vs. direct, sync vs. async, and the tradeoffs between them
- [io_uring (io-uring/)](../io-uring/README.md) — the ring-based interface for high-performance asynchronous I/O
