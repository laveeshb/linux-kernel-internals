# Kernel Oops Analysis

> Reading oops output, decoding addresses, and finding the bug

## What is a kernel oops?

A **kernel oops** is a non-fatal kernel error — the kernel detected an inconsistency (usually a NULL pointer dereference, bad memory access, or BUG()) but can keep running (though the offending task is killed). A **kernel panic** is a fatal oops or a situation where the kernel cannot safely continue.

## Anatomy of an oops message

```
[  123.456789] BUG: kernel NULL pointer dereference, address: 0000000000000018
[  123.456790] #PF: supervisor read access in kernel mode
[  123.456791] #PF: error_code(0x0000) - not-present page
[  123.456792] PGD 0 P4D 0
[  123.456793] Oops: 0000 [#1] PREEMPT SMP NOPTI
```

Breaking down the first line:
- `BUG: kernel NULL pointer dereference` — the fault type
- `address: 0x18` — the virtual address that caused the fault (0x18 = offset 24 in a struct)

The error code `0000`:
- Bit 0 = 0: page not present (vs protection fault)
- Bit 1 = 0: read (vs write)
- Bit 2 = 0: kernel mode (vs user mode)

```
[  123.456794] CPU: 3 PID: 1234 Comm: myapp Tainted: G  --------- -  5.19.0 #1
[  123.456795] Hardware name: QEMU Standard PC, BIOS rel-1.16.0
[  123.456796] RIP: 0010:mydriver_write+0x34/0xb0 [mydriver]
```

- `CPU: 3` — which CPU was running
- `PID: 1234 Comm: myapp` — the task that triggered the oops
- `Tainted: G` — kernel taint flags (G = all loaded modules are GPL-compatible, no proprietary modules)
- `RIP: 0010:` — instruction pointer, `0010` = kernel code segment
- `mydriver_write+0x34/0xb0` — function + offset / function size

### Taint flags

```
G — all loaded modules are GPL-compatible (no proprietary modules)
P — proprietary (non-GPL) module loaded
F — forced module load (bad signature or version mismatch)
S — kernel running on a CPU/system out of specification
M — machine check exception
B — bad page
U — user (userspace explicitly loaded)
D — died (OOPS has been recorded, tainted from now on)
A — ACPI table overridden
W — warning (taint on WARN())
C — staging driver loaded
I — workaround for a bug in platform firmware applied
K — live patched
```

## Register dump

```
[  123.456797] RSP: 0018:ffffc900012c7d28 EFLAGS: 00010246
[  123.456798] RAX: 0000000000000000 RBX: ffff888012345678 RCX: 0000000000000040
[  123.456799] RDX: 0000000000000001 RSI: 00007fff12345678 RDI: ffff888087654321
[  123.456800] RBP: ffffc900012c7d60 R08: 0000000000000000 R09: 0000000000000000
[  123.456801] R10: 0000000000000000 R11: 0000000000000246 R12: ffff888087654321
[  123.456802] R13: ffff888012345678 R14: 0000000000000040 R15: 00007fff12345678
[  123.456803] FS:  00007f1234567890(0000) GS:ffff88813fc00000(0000) knlGS:0000000000000000
[  123.456804] CS:  0010 DS: 0000 ES: 0000 CR0: 0000000080050033
[  123.456805] CR2: 0000000000000018 CR3: 000000010a234000 CR4: 00000000003506e0
```

Key registers for diagnosis:
- `RIP` — where the crash happened
- `CR2` — the faulting address (for page faults)
- `RAX = 0` — often the NULL pointer that was dereferenced
- `RBX`, `R12-15` — often hold struct pointers; can reveal the data structure

**The offset trick**: `CR2 = 0x18 = 24`. A struct member at offset 24 from a NULL pointer. Count struct fields to identify which member was accessed.

## Stack trace

```
[  123.456806] Call Trace:
[  123.456807]  <TASK>
[  123.456808]  mydriver_write+0x34/0xb0 [mydriver]
[  123.456809]  vfs_write+0xb5/0x2a0
[  123.456810]  ksys_write+0x67/0xe0
[  123.456811]  __x64_sys_write+0x1d/0x30
[  123.456812]  do_syscall_64+0x3b/0x80
[  123.456813]  entry_SYSCALL_64_after_hwframe+0x63/0xcd
[  123.456814]  </TASK>
```

Read from top (most recent) to bottom (oldest call). The crash happened in `mydriver_write` at offset `0x34` within the function.

## addr2line: finding the source line

Given the faulting address, find the exact source line:

```bash
# Method 1: addr2line with vmlinux
addr2line -e /usr/lib/debug/vmlinux ffffffff81234567
# /build/linux/drivers/mydriver/mydriver.c:245

# With function name:
addr2line -e vmlinux -f ffffffff81234567
# mydriver_write
# /build/linux/drivers/mydriver/mydriver.c:245

# Method 2: for a module (needs unstripped .ko)
addr2line -e mydriver.ko 0x34   # offset within the module
# /path/to/mydriver.c:245
```

## decode_stacktrace.sh

The kernel ships a script that resolves all addresses in a stack trace:

```bash
# Pipe the oops through decode_stacktrace
./scripts/decode_stacktrace.sh /path/to/vmlinux /path/to/kernel/source < oops.txt

# Or with modules:
./scripts/decode_stacktrace.sh vmlinux . mydriver.ko < oops.txt
```

Output resolves each `function+0xNN/0xNN` to `function (file.c:line)`.

## objdump: disassembling around the crash

```bash
# Disassemble the function that crashed
objdump -d --start-address=0xffffffff81234500 --stop-address=0xffffffff81234600 vmlinux

# For a module:
objdump -d mydriver.ko | grep -A 30 "<mydriver_write>"
```

The crash was at offset `0x34` in `mydriver_write`:

```
0000000000000000 <mydriver_write>:
   0: push %rbp
   1: mov %rsp,%rbp
  ...
  34: mov 0x18(%rax),%rdx    ← crash here: rax was NULL, accessing offset 0x18
  38: test %rdx,%rdx
```

This tells us: `%rax` was NULL, and the code tried to read member at offset 0x18 from it.

## Common oops patterns

### NULL pointer dereference

```
BUG: kernel NULL pointer dereference, address: 0000000000000018
RIP: mydriver_write+0x34/0xb0
RAX: 0000000000000000
```

Diagnosis: `RAX = 0` (the NULL pointer). Offset `0x18` tells you which field. Look at the struct at that offset.

```c
/* If the struct is: */
struct mydev {
    spinlock_t lock;      /* offset 0 */
    void *private;        /* offset 8 */
    struct device *dev;   /* offset 16 = 0x10 */
    int refcount;         /* offset 24 = 0x18 ← this field */
};
/* Reading offset 0x18 = reading mydev->refcount from a NULL mydev* */
```

### Use-after-free

```
BUG: KASAN: use-after-free in mydriver_read+0x45/0x100
Read of size 8 at addr ffff888012345678 by task myapp/1234
Freed by task 5678:
  kfree+0x...
  mydriver_cleanup+0x...
Allocated by task 1234:
  kmalloc+0x...
  mydriver_probe+0x...
```

KASAN shows exactly where the memory was allocated and freed — invaluable for race conditions.

### Stack overflow

```
BUG: stack guard page was hit at 0000000012345678 (stack is 0xffff888012340000..0xffff888012348000)
kernel stack overflow (page fault): 0000 [#1] PREEMPT SMP
```

Kernel stacks are typically 8-16KB. Deep recursion (e.g., deep VFS recursion with overlayfs) can overflow them.

### Soft lockup

```
watchdog: BUG: soft lockup - CPU#3 stuck for 22s!
Modules linked in: ...
CPU: 3 PID: 5678 Comm: kworker/3:1
Call Trace:
  <IRQ>
  do_something_slow+0x123/0x456
```

The CPU hasn't scheduled in 20+ seconds. Usually: holding a spinlock too long, or a tight loop without `cond_resched()`.

### RCU stall

```
rcu: INFO: rcu_sched self-detected stall on CPU 2 (...)
rcu:     3-second stall for cpumask={2} (t=...
rcu: rcu_sched kthread starved for ...ms
```

An RCU read-side critical section has been held for too long, or the RCU grace period is stalled. Often caused by holding a lock while preemption is disabled for an extended time.

## BUG() and WARN()

```c
/* In kernel code: force an oops at a specific point */
BUG();                      /* always: oops + stack trace */
BUG_ON(condition);          /* conditional */

WARN();                     /* log + stack trace, but continue */
WARN_ON(condition);
WARN_ON_ONCE(condition);    /* print only once */
WARN_ONCE(condition, fmt);
```

`WARN` is useful for detecting unexpected conditions without crashing the system. Check `dmesg` for `WARNING:` lines even if the system seems fine.

## netconsole: capture oops over the network

For headless servers where you can't see the serial console:

```bash
# Load netconsole (or configure as module)
modprobe netconsole netconsole=@192.168.1.10/eth0,@192.168.1.1/00:11:22:33:44:55
# Format: @src_ip/src_dev,@dst_ip/dst_mac

# On the receiving machine:
nc -ulp 6665   # listen on default netconsole port

# Or with dynamic netconsole (uses configfs):
mkdir /sys/kernel/config/netconsole/target1
echo eth0              > /sys/kernel/config/netconsole/target1/dev_name
echo 192.168.1.10     > /sys/kernel/config/netconsole/target1/local_ip
echo 192.168.1.1      > /sys/kernel/config/netconsole/target1/remote_ip
echo 00:11:22:33:44:55 > /sys/kernel/config/netconsole/target1/remote_mac
echo 1                > /sys/kernel/config/netconsole/target1/enabled
```

## Further reading

### Kernel source

- [arch/x86/include/asm/trap_pf.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/include/asm/trap_pf.h) — the `X86_PF_*` bit definitions behind the page-fault `error_code` breakdown (bit 0 = not-present/protection, bit 1 = read/write, bit 2 = kernel/user)
- [kernel/panic.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/panic.c) — the `taint_flags[]` table: the authoritative letter-to-flag mapping behind the `Tainted:` line (see [tainted-kernels.rst](https://docs.kernel.org/admin-guide/tainted-kernels.html), cited below, for the human-readable meaning of each flag)
- [scripts/decode_stacktrace.sh](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/scripts/decode_stacktrace.sh) — resolves `function+0xNN/0xNN` entries in a captured oops to `function (file.c:line)`
- [Documentation/networking/netconsole.rst](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/networking/netconsole.rst) — the `netconsole=` module parameter format and the configfs-based dynamic reconfiguration interface (`dev_name`, `local_ip`, `remote_ip`, `remote_mac`, `enabled`, ...)

### Man pages

- [`addr2line(1)`](https://man7.org/linux/man-pages/man1/addr2line.1.html) — converts addresses (or `function+offset`) into file names and line numbers
- [`objdump(1)`](https://man7.org/linux/man-pages/man1/objdump.1.html) — disassembles object files; used here with `--start-address`/`--stop-address` to inspect the faulting instruction

### Related pages

- [Kernel Panic and Oops](../kernel/panic-oops.md) — the kernel-side code path: `die()`, `oops_begin()`/`oops_end()`, ORC unwinding, and `panic()`
- [kdump and crash](kdump.md) — automated crash dump collection
- [KGDB](kgdb.md) — live kernel debugging
- [Memory Management: KASAN](../mm/kasan.md) — memory error detection
- [Memory Management: KFENCE](../mm/kfence.md) — lightweight production memory checking
- [Tracing: kprobes](../tracing/kprobes-tracepoints.md) — probing without crashing

### External

- [Tainted kernels](https://docs.kernel.org/admin-guide/tainted-kernels.html) — full taint flag reference with official descriptions for every letter
