# I/O Patterns

> Direct I/O, asynchronous I/O, and the evolution from AIO to io_uring

## I/O interface landscape

```
Application I/O interfaces:

read()/write()          — synchronous, buffered (page cache)
mmap()                  — memory-mapped I/O (page cache backed)
O_DIRECT                — synchronous, bypasses page cache
POSIX AIO               — async, user-thread-based (glibc)
Linux AIO               — async kernel, but limited to O_DIRECT
io_uring                — modern async I/O for everything
epoll + non-blocking    — async for network/pipes (not files)
```

## Pages in this section

| Page | What it covers |
|------|----------------|
| [Direct I/O](direct-io.md) | O_DIRECT, alignment requirements, DIO path, mmap comparison |
| [Async I/O evolution](async-io.md) | POSIX AIO, Linux AIO limitations, io_uring advantages |

## Quick reference

```bash
# Check if filesystem supports O_DIRECT
open("file", O_RDONLY | O_DIRECT)
# EINVAL if not supported (tmpfs, procfs, etc.)

# Linux AIO submit
io_submit(ctx, 1, iocbs)   # blocking submit
io_getevents(ctx, 1, 1, events, timeout)  # wait for completion

# io_uring submit
io_uring_submit(ring)      # lock-free, may need 0 syscalls with SQPOLL
```
