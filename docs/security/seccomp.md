# seccomp BPF

> Syscall filtering for privilege reduction and attack surface minimization

## What seccomp does

seccomp (secure computing mode) installs a BPF program that runs on every syscall entry. The filter can:
- Allow the syscall to proceed
- Return an error to the caller (without kernel processing)
- Kill the process
- Log the event
- Notify a userspace process (SECCOMP_RET_USER_NOTIF)

```
Process → syscall instruction
             │
             ▼
       seccomp filter runs   (Classic BPF on struct seccomp_data)
             │
     ┌───────┴───────────┐
     │                   │
  ALLOW              KILL_PROCESS / ERRNO / TRAP / USER_NOTIF
     │
     ▼
 kernel handles syscall
```

## From strict mode to seccomp-BPF

### The original seccomp (Linux 2.6.12, 2005)

Andrea Arcangeli introduced seccomp — [`d949d0ec9c60`](https://git.kernel.org/linus/d949d0ec9c601f2b148bed3cdb5f87c052968554) — to address a specific threat: untrusted code running in a computational sandbox (e.g., a commercial "safe browsing" or grid computing service). The design was maximally restrictive: once a process called `prctl(PR_SET_SECCOMP, SECCOMP_MODE_STRICT)`, it could only use four syscalls: `read`, `write`, `exit`, and `sigreturn`. Any other syscall killed it with SIGKILL.

This was safe but completely unusable for real applications. An application that needs to open files, allocate memory, or interact with the network couldn't use strict mode at all.

### Why the kernel couldn't do more (without BPF)

The limitation was policy expression. "Allow only `read` and `write`" is simple. "Allow `read` and `write` on file descriptors that were open before sandbox entry, but not `open`" is stateful and complex. "Allow `mmap` with `PROT_READ` but not `PROT_WRITE|PROT_EXEC`" requires inspecting arguments. Encoding all possible policies in the kernel would have required a domain-specific language — exactly what BPF is.

### seccomp-BPF (Linux 3.5, 2012)

Will Drewry (Google Chrome team) wrote the seccomp-BPF extension — [`e2cfabdfd075`](https://git.kernel.org/linus/e2cfabdfd075648216f99c2c03821cf3f47c1727), [LWN](https://lwn.net/Articles/475043/) — driven by Chrome's sandbox requirements. Chrome needed to isolate its renderer process from the kernel — allow only the syscalls the renderer legitimately needs, with argument filtering to prevent abuse even of allowed syscalls.

The key insight: Classic BPF (the existing socket filter VM) was already a general-purpose policy language for inspecting kernel data. `struct seccomp_data` — the syscall number plus six arguments — is just a 64-byte struct. A cBPF program can inspect any field of that struct and return ALLOW or DENY.

Instead of building a new policy language, seccomp-BPF reused cBPF as-is. The kernel runs the BPF program on every syscall entry; the program returns an action code. This required almost no new kernel machinery — the BPF interpreter/JIT was already there.

Chrome shipped with seccomp-BPF in Chrome 23 (2012), becoming the first major application to sandbox itself this way. systemd, Docker, Firefox, and Android all adopted seccomp-BPF filters. Android's `SECCOMP_RET_USER_NOTIF` extension (Linux 5.0, 2019) allowed supervisors to intercept and handle syscalls on behalf of sandboxed processes, enabling user-namespace container emulation without root.

## Classic (strict) mode

Before BPF filters, seccomp offered only one mode:

```c
/* Allow only read, write, exit, sigreturn */
prctl(PR_SET_SECCOMP, SECCOMP_MODE_STRICT);
/* Any other syscall → SIGKILL */
```

## BPF filter mode

The full seccomp uses Classic BPF programs operating on `struct seccomp_data`:

```c
/* include/uapi/linux/seccomp.h */
struct seccomp_data {
    int     nr;                     /* syscall number */
    __u32   arch;                   /* AUDIT_ARCH_* */
    __u64   instruction_pointer;    /* rip at syscall */
    __u64   args[6];                /* syscall arguments */
};
```

### Filter return values

```c
SECCOMP_RET_KILL_PROCESS  /* kill entire process with SIGSYS (most severe) */
SECCOMP_RET_KILL_THREAD   /* kill calling thread only */
SECCOMP_RET_TRAP          /* deliver SIGSYS (can be caught by signal handler) */
SECCOMP_RET_ERRNO         /* return error: SECCOMP_RET_DATA contains errno */
SECCOMP_RET_USER_NOTIF    /* notify supervisor process (5.0+) */
SECCOMP_RET_TRACE         /* notify ptrace debugger */
SECCOMP_RET_LOG           /* allow but log the syscall */
SECCOMP_RET_ALLOW         /* allow (most permissive) */
```

Return value precedence (lowest wins): KILL > TRAP > ERRNO > USER_NOTIF > TRACE > LOG > ALLOW.

### Raw BPF filter example

```c
#include <sys/prctl.h>
#include <linux/seccomp.h>
#include <linux/filter.h>
#include <linux/audit.h>
#include <sys/syscall.h>

static int install_filter(void)
{
    struct sock_filter filter[] = {
        /* Load architecture */
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                 (offsetof(struct seccomp_data, arch))),
        /* Verify x86-64 */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K,
                 AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),

        /* Load syscall number */
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                 (offsetof(struct seccomp_data, nr))),

        /* Allow read */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_read, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),

        /* Allow write */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_write, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),

        /* Allow exit_group */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_exit_group, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),

        /* Default: kill */
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    };

    struct sock_fprog prog = {
        .len    = ARRAY_SIZE(filter),
        .filter = filter,
    };

    /* Must set PR_SET_NO_NEW_PRIVS before installing filter
       (unless running as root) */
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0)
        return -1;

    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog) < 0)
        return -1;

    return 0;
}
```

### libseccomp: high-level API

Raw BPF is error-prone. Use `libseccomp` instead:

```c
#include <seccomp.h>

/* Allow-list approach: start with everything blocked */
scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_KILL_PROCESS);

/* Add allowances */
seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(read), 0);
seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(write), 0);
seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(exit_group), 0);
seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(mmap), 0);
seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(munmap), 0);

/* Conditional rule: only allow openat with read-only flag */
seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(openat), 1,
    SCMP_A2(SCMP_CMP_MASKED_EQ, O_WRONLY | O_RDWR, 0));
/*          ^ argument 2 (flags) masked against O_WRONLY|O_RDWR must equal 0 */

/* Load the filter */
seccomp_load(ctx);
seccomp_release(ctx);
```

```bash
# Link against libseccomp
gcc -o myapp myapp.c -lseccomp
```

## Container use: Docker's default profile

Docker installs a seccomp profile blocking ~40 dangerous syscalls:

```bash
# Show Docker's default seccomp profile
docker inspect --format '{{.HostConfig.SecurityOpt}}' container_name

# Run with no seccomp (for debugging)
docker run --security-opt seccomp=unconfined ubuntu bash

# Run with custom profile
docker run --security-opt seccomp=/path/to/profile.json ubuntu bash
```

The default Docker profile blocks (among others):
- `acct` — process accounting
- `add_key` — kernel keyring
- `bpf` — BPF programs
- `kexec_load` — kernel replacement
- `mount` — filesystem mounting
- `perf_event_open` — performance monitoring
- `ptrace` — process tracing
- `swapon/swapoff` — swap management
- `syslog` — read kernel ring buffer
- `uselib` — old library loading

## SECCOMP_RET_USER_NOTIF: supervisor pattern

Since Linux 5.0, a filter can defer decisions to a supervisor process. This enables:
- Userspace policy enforcement
- Container escape prevention (container manager approves mounts)
- Debugging (supervisor logs allowed syscalls)

```c
/* Supervisor process: receives notifications */
int notif_fd = seccomp_notify_fd(ctx);  /* after seccomp_load */

struct seccomp_notif *notif = /* allocate */;
struct seccomp_notif_resp *resp = /* allocate */;

while (1) {
    ioctl(notif_fd, SECCOMP_IOCTL_NOTIF_RECV, notif);

    /* Inspect: notif->pid, notif->data.nr (syscall), notif->data.args */
    if (should_allow(notif))
        resp->error  = 0;        /* allow */
        resp->flags  = SECCOMP_USER_NOTIF_FLAG_CONTINUE;
    else
        resp->error  = -EPERM;   /* deny */

    resp->id = notif->id;
    ioctl(notif_fd, SECCOMP_IOCTL_NOTIF_SEND, resp);
}
```

This is how rootless container runtimes (Podman, nerdctl) allow containers to perform privileged operations like `mount` — the supervisor intercepts and handles them safely.

## Kernel seccomp implementation

```c
/* kernel/seccomp.c: in syscall entry path */
static int __seccomp_filter(u32 this_syscall, const struct seccomp_data *sd,
                             const bool recheck_after_trace)
{
    u32 filter_ret, data;
    struct seccomp_filter *match = NULL;
    int action;

    /* Run all installed filters (they're chained) */
    filter_ret = run_filters(sd, &match);

    data    = filter_ret & SECCOMP_RET_DATA;
    action  = filter_ret & SECCOMP_RET_ACTION_FULL;

    switch (action) {
    case SECCOMP_RET_ALLOW:
        return 0;
    case SECCOMP_RET_KILL_PROCESS:
        do_group_exit(SIGSYS);  /* kill the entire thread group */
    case SECCOMP_RET_KILL_THREAD:
        do_exit(SIGSYS);        /* kill the calling thread only */
    case SECCOMP_RET_ERRNO:
        syscall_set_return_value(current, current_pt_regs(),
                                  -data, 0);
        return -1;
    /* ... */
    }
}
```

## Auditing seccomp actions

```bash
# Check process's current seccomp mode
cat /proc/self/status | grep Seccomp
# Seccomp: 2   (0=off, 1=strict, 2=filter)

# See seccomp violations in audit log
ausearch -m SECCOMP | head -20
# type=SECCOMP msg=audit(1234.567:890): avc:  seccomp
# sig=31 arch=c000003e syscall=62 compat=0 ip=0x7f... code=0x80000000

# strace with seccomp
strace -e seccomp ./myprogram
```

## Further reading

- [LSM Framework](lsm.md) — MAC policies that run after seccomp (in individual syscall implementations)
- [Capabilities](capabilities.md) — Privilege reduction before seccomp
- [BPF: Architecture](../bpf/bpf-overview.md) — BPF programs as seccomp filters
- [Cgroups: Container Isolation](../cgroups/container-isolation.md) — seccomp in containers
- `man 2 seccomp` — syscall documentation
