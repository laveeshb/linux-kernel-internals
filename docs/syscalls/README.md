# System Calls

> The contract between userspace and the kernel

## What system calls are

A system call is a controlled entry point into the kernel. It:

1. **Saves CPU state** — registers, flags
2. **Switches privilege** — user mode (ring 3) → kernel mode (ring 0)
3. **Validates arguments** — checks pointers, copies data from userspace
4. **Executes kernel code** — the actual operation
5. **Returns to userspace** — restores registers, switches back to ring 3

On x86-64, the `syscall` instruction triggers this transition. The kernel uses the value in `rax` as the syscall number to dispatch to the right handler.

```
Userspace                    Kernel
─────────────────────────────────────────────────────
glibc: write(fd, buf, len)
  │
  │  mov rax, 1  (SYS_write)
  │  mov rdi, fd
  │  mov rsi, buf
  │  mov rdx, len
  │  syscall
  │              ──────────→  entry_SYSCALL_64
  │                           saves registers
  │                           calls sys_write()
  │                               → vfs_write()
  │              ←──────────  returns result in rax
  │
  │  return rax (bytes written, or -errno)
```

## Pages in this section

| Page | What it covers |
|------|----------------|
| [Syscall Entry Path](syscall-entry.md) | x86-64 entry, privilege switch, argument passing, vDSO |
| [SYSCALL_DEFINE and dispatch](syscall-define.md) | How syscalls are defined, the dispatch table, ABI |
| [Adding a new syscall](adding-syscall.md) | Step-by-step walkthrough for kernel contributors |

## Quick reference

```bash
# List all syscalls with numbers
ausyscall --dump | head -20

# Trace syscalls of a process
strace ls

# Count syscalls
strace -c ls 2>&1

# See syscall overhead
perf stat -e 'syscalls:sys_enter_*' -- ls

# See syscall table in kernel
grep -r "SYSCALL_DEFINE" kernel/sys.c | head -10
```
