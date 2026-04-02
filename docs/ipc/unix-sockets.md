# Unix Domain Sockets

> Local IPC with file descriptor passing, abstract namespace, and SOCK_SEQPACKET

Unix domain sockets (`AF_UNIX`) provide full-duplex, connection-oriented or datagram IPC entirely within the kernel — no network stack involved. They are the foundation of D-Bus, systemd socket activation, Docker's control socket, and countless other local daemons.

## Socket types

| Type | Semantics | Boundary preserved | Use case |
|------|-----------|--------------------|----------|
| `SOCK_STREAM` | Reliable byte stream | No | High-throughput pipes, databases |
| `SOCK_DGRAM` | Unreliable datagrams | Yes | Short fire-and-forget messages |
| `SOCK_SEQPACKET` | Reliable, ordered messages | **Yes** | RPC, privilege separation |

`SOCK_SEQPACKET` is the sweet spot for structured IPC: it combines the reliability of `SOCK_STREAM` with the message-boundary preservation of `SOCK_DGRAM`. Each `send()` maps to exactly one `recv()` on the other side.

```c
#include <sys/socket.h>
#include <sys/un.h>

/* Server side */
int srv = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
```

## struct sockaddr_un

```c
#include <sys/un.h>

struct sockaddr_un {
    sa_family_t sun_family;   /* AF_UNIX */
    char        sun_path[108]; /* socket path or abstract name */
};
```

`sun_path` is 108 bytes total (`UNIX_PATH_MAX`). For abstract-namespace sockets the first byte is `\0` and the remaining 107 bytes form the name.

## Filesystem namespace

Binding to a filesystem path creates a socket inode in the VFS:

```c
struct sockaddr_un addr = {
    .sun_family = AF_UNIX,
    /* null-terminated path */
};
strncpy(addr.sun_path, "/run/myservice.sock", sizeof(addr.sun_path) - 1);

bind(srv, (struct sockaddr *)&addr, sizeof(addr));
listen(srv, SOMAXCONN);
```

Properties:
- Permissions are enforced by the file's mode bits (`chmod 0660 /run/myservice.sock`)
- The socket file persists after the server exits — must be removed with `unlink()` before rebinding
- Controlled by the filesystem namespace: containers with separate mount namespaces cannot see each other's socket files

## Abstract namespace

An abstract socket name starts with a null byte (`\0`). The kernel tracks the binding in memory — there is no filesystem entry:

```c
struct sockaddr_un addr = { .sun_family = AF_UNIX };
/* First byte \0, then the name */
memcpy(addr.sun_path, "\0myservice", 10);

/* sun_path length includes the leading \0 */
socklen_t addrlen = offsetof(struct sockaddr_un, sun_path) + 10;
bind(srv, (struct sockaddr *)&addr, addrlen);
```

Properties:
- Automatically cleaned up when the last file descriptor referencing it is closed — no `unlink()` needed
- Name is arbitrary bytes, not a C string; can contain null bytes beyond the first
- Visible only within the same network namespace (`ip netns` or container namespaces provide isolation)
- `ss -xlp` shows abstract sockets with a `@` prefix in the address column

## socketpair()

`socketpair()` creates a connected pair of sockets without binding or listening — the simplest way to create a bidirectional channel between a parent and child process:

```c
int sv[2];
socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, sv);
/* sv[0] and sv[1] are connected */

if (fork() == 0) {
    close(sv[0]);
    /* child uses sv[1] */
} else {
    close(sv[1]);
    /* parent uses sv[0] */
}
```

This is preferable to a pipe for bidirectional IPC and to an anonymous socket pair for structured (message-boundary-preserving) communication.

## File descriptor passing with SCM_RIGHTS

The `SCM_RIGHTS` control message lets a process send open file descriptors across a Unix socket. The kernel duplicates the file description into the receiver's file descriptor table — the receiver gets a new fd number pointing to the same underlying open file, including its offset, flags, and access mode.

```c
#include <sys/socket.h>
#include <sys/un.h>

/* --- Sender --- */
int fd_to_pass = open("/etc/passwd", O_RDONLY);

struct msghdr msg = {};
char buf[CMSG_SPACE(sizeof(int))];  /* control message buffer */
struct iovec iov = { .iov_base = "x", .iov_len = 1 }; /* must send ≥1 data byte */

msg.msg_iov        = &iov;
msg.msg_iovlen     = 1;
msg.msg_control    = buf;
msg.msg_controllen = sizeof(buf);

struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
cmsg->cmsg_level = SOL_SOCKET;
cmsg->cmsg_type  = SCM_RIGHTS;
cmsg->cmsg_len   = CMSG_LEN(sizeof(int));
memcpy(CMSG_DATA(cmsg), &fd_to_pass, sizeof(int));

sendmsg(sock, &msg, 0);
close(fd_to_pass);  /* sender no longer needs it */

/* --- Receiver --- */
char data[1];
char cbuf[CMSG_SPACE(sizeof(int))];
struct iovec riov = { .iov_base = data, .iov_len = sizeof(data) };
struct msghdr rmsg = {
    .msg_iov        = &riov,
    .msg_iovlen     = 1,
    .msg_control    = cbuf,
    .msg_controllen = sizeof(cbuf),
};

recvmsg(sock, &rmsg, 0);

struct cmsghdr *rcmsg = CMSG_FIRSTHDR(&rmsg);
if (rcmsg && rcmsg->cmsg_type == SCM_RIGHTS) {
    int received_fd;
    memcpy(&received_fd, CMSG_DATA(rcmsg), sizeof(int));
    /* received_fd is usable immediately */
}
```

The kernel's `unix_stream_sendmsg()` / `unix_scm_to_skb()` path (in `net/unix/af_unix.c`) attaches the file references to the socket buffer. On the receive side, `unix_scm_recv()` installs them into the receiver's `files_struct` via `receive_fd()`.

### Leak risk

Every received fd must be closed, including on error paths. If the receiver does not close the fd, it accumulates in the process's file descriptor table invisibly. `lsof -p <pid>` will reveal them, but the damage is done when `EMFILE` hits.

Use `SOCK_CLOEXEC` on the *socket* to prevent the socket fds themselves from leaking across `exec()`. For received fds, set `O_CLOEXEC` with `fcntl(received_fd, F_SETFD, FD_CLOEXEC)` immediately after receipt.

## Peer credential passing with SCM_CREDENTIALS

`SCM_CREDENTIALS` lets a sender attach its `pid`, `uid`, and `gid` to a message. The kernel validates the credentials against the sender's actual values — a process cannot forge a different uid (unless it is root).

```c
/* Enable credential reception on the socket */
int enable = 1;
setsockopt(sock, SOL_SOCKET, SO_PASSCRED, &enable, sizeof(enable));

/* Sender: attach credentials */
struct ucred cred = {
    .pid = getpid(),
    .uid = getuid(),
    .gid = getgid(),
};
char cbuf[CMSG_SPACE(sizeof(struct ucred))];
struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
cmsg->cmsg_level = SOL_SOCKET;
cmsg->cmsg_type  = SCM_CREDENTIALS;
cmsg->cmsg_len   = CMSG_LEN(sizeof(struct ucred));
memcpy(CMSG_DATA(cmsg), &cred, sizeof(cred));
```

For a connected socket, the simpler alternative is `SO_PEERCRED`, which returns the credentials of the *connected* peer without requiring a per-message control message:

```c
struct ucred peer;
socklen_t len = sizeof(peer);
getsockopt(sock, SOL_SOCKET, SO_PEERCRED, &peer, &len);
printf("peer pid=%d uid=%d gid=%d\n", peer.pid, peer.uid, peer.gid);
```

`SO_PEERCRED` is used by systemd, D-Bus, and polkit to authenticate the calling process before granting privileged operations.

## Performance

Unix domain sockets bypass the entire TCP/IP stack. Data is copied directly between socket send and receive buffers in the kernel, or in some configurations uses zero-copy tricks via `sk_buff`. Typical throughput on modern hardware:

| Mechanism | Throughput |
|-----------|-----------|
| `AF_INET` loopback (`127.0.0.1`) | ~5 GB/s |
| `AF_UNIX SOCK_STREAM` | ~10–15 GB/s |
| Shared memory | ~30–50 GB/s |

`AF_UNIX` with `SOCK_DGRAM` avoids connection setup overhead entirely, which is useful for short fire-and-forget control messages between co-located processes.

## Kernel implementation

The implementation lives in `net/unix/af_unix.c`. Key structures:

```c
/* include/net/af_unix.h */
struct unix_sock {
    /* WARNING: sk has to be the first member */
    struct sock     sk;
    struct unix_address *addr;      /* bound address */
    struct path     path;           /* socket file path (filesystem sockets) */
    struct mutex    iolock, bindlock;
    struct sock    *peer;           /* connected peer (SOCK_STREAM/SEQPACKET) */
    struct list_head link;          /* list of all unix sockets */
    atomic_long_t   inflight;       /* SCM_RIGHTS fds in flight */
    spinlock_t      lock;
    unsigned long   gc_flags;
    struct socket_wq peer_wq;
    wait_queue_entry_t peer_wake;
};
```

Messages for `SOCK_DGRAM` and `SOCK_SEQPACKET` are stored as `sk_buff` entries in `sk->sk_receive_queue`. For `SOCK_STREAM`, `unix_stream_sendmsg()` copies data into the peer's receive queue directly.

The `inflight` counter tracks file descriptors currently in-flight via `SCM_RIGHTS`. The kernel garbage collector (`net/unix/garbage.c`) detects cycles where in-flight fds reference the very sockets they are being sent over, preventing reference count leaks.

## Further reading

- `net/unix/af_unix.c`, `net/unix/garbage.c` — full implementation
- [Pipes and FIFOs](pipes.md) — unidirectional byte-stream IPC
- [Shared Memory](shared-memory.md) — zero-copy data exchange
- [eventfd and signalfd](eventfd-signalfd.md) — pollable notification fds
- `unix(7)` man page — complete API reference
