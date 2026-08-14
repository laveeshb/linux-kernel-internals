# kdump and crash

> Capturing and analyzing kernel crash dumps

## How kdump works

kdump uses `kexec` to pre-load a second "capture kernel" into a reserved region of memory. When the primary kernel crashes (panic), it hands control to the capture kernel via kexec. The capture kernel boots, saves the first kernel's memory (the "vmcore") to disk, and reboots.

```
Normal operation:
  Primary kernel runs
  Capture kernel pre-loaded at reserved address (e.g., 0x100000000)
  ────────────────────────────────────────────────
Crash:
  Primary kernel panics
  kexec jumps to capture kernel entry point
  ────────────────────────────────────────────────
Capture kernel:
  Boots with crashkernel= memory
  Mounts root filesystem
  /proc/vmcore: primary kernel's memory accessible here
  makedumpfile saves compressed vmcore to /var/crash/
  System reboots
```

## Setup

### Step 1: Reserve memory for capture kernel

Add to kernel boot parameters:

```bash
# /etc/default/grub (or equivalent)
GRUB_CMDLINE_LINUX="crashkernel=256M"
# Reserve 256MB for the capture kernel at a high address

# For systems with > 4GB RAM (common):
crashkernel=256M,high   # prefer high memory
crashkernel=64M,low     # also reserve 64MB in low memory (for DMA)

# Regenerate grub config
sudo update-grub
sudo reboot
```

```bash
# Verify reservation after boot
cat /proc/cmdline | grep crashkernel
dmesg | grep "crashkernel"
# crashkernel: memory value: 0x10000000 at 0x100000000
```

### Step 2: Install and configure kdump

```bash
# Debian/Ubuntu
sudo apt install kdump-tools

# RHEL/Fedora
sudo dnf install kexec-tools

# Start kdump service (loads capture kernel via kexec)
sudo systemctl enable --now kdump

# Verify kdump is ready
sudo kdump-config show
# DUMP_MODE:        kdump
# USE_KDUMP:        1
# KDUMP_SYSCTL:     kernel.panic_on_oops=1
# current state:    ready to kdump
```

### Step 3: Test kdump

```bash
# Force a crash to test (writes crash dump then reboots)
echo 1 > /proc/sys/kernel/sysrq
echo c > /proc/sysrq-trigger

# After reboot: check /var/crash/
ls /var/crash/
# 202601301234/  vmcore  vmcore-dmesg.txt
```

## Analyzing a crash dump with crash

The `crash` tool is the standard way to analyze vmcore files:

```bash
# Install crash
sudo apt install crash   # Debian/Ubuntu
sudo dnf install crash   # RHEL

# Open the crash dump
crash /usr/lib/debug/boot/vmlinux-$(uname -r) /var/crash/*/vmcore
# Or with a kernel debuginfo package:
crash /path/to/vmlinux vmcore
```

### crash command reference

Once inside crash:

```
crash> help          # list all commands

# System information
crash> sys           # kernel version, panic string, uptime
# KERNEL: /usr/lib/debug/.../vmlinux
# DUMPFILE: vmcore  [PARTIAL DUMP]
# CPUS: 8
# DATE: Mon Jan 30 12:34:56 2026
# UPTIME: 2 days, 03:21:45
# PANIC: "general protection fault, maybe for address..."

# The panic message and task
crash> bt            # backtrace of the crashing task
crash> bt -a         # backtraces of all tasks
crash> bt <pid>      # backtrace of specific task

# Process information
crash> ps            # process list (like ps aux)
crash> ps -t         # thread list
crash> task <pid>    # full task_struct of a process
crash> files <pid>   # open files of a process

# Memory inspection
crash> rd address 16          # read 16 words at address
crash> wr address value       # write (modify vmcore — dangerous)
crash> kmem -i                # memory info
crash> kmem -z                # zone info
crash> kmem -s                # slab info

# Kernel structures
crash> struct task_struct <address>      # pretty-print struct
crash> p variable_name                   # print variable
crash> p *((struct inode *)0xffff..)    # dereference pointer

# Modules
crash> mod                    # list modules
crash> mod -s mymodule /path/to/mymodule.ko  # load module symbols

# Virtual memory
crash> vm <pid>               # VMAs of process
crash> pte <address>          # page table entry
crash> vtop <virtual>         # virtual→physical translation

# Log
crash> log                    # kernel ring buffer from vmcore
crash> log -m                 # include timestamp prefix
```

### Reading the backtrace

```
crash> bt
PID: 1234   TASK: ffff888012345678  CPU: 3   COMMAND: "myapp"
 #0 [ffff8880abcd0000] machine_kexec at ffffffff81064180
 #1 [ffff8880abcd0058] __crash_kexec at ffffffff8112e943
 #2 [ffff8880abcd0120] crash_kexec at ffffffff8112ea8c
 #3 [ffff8880abcd0138] oops_end at ffffffff810512e1
 #4 [ffff8880abcd0160] no_context at ffffffff81065e28
 #5 [ffff8880abcd01b0] __bad_area_nosemaphore at ffffffff81066037
 #6 [ffff8880abcd0200] bad_area_nosemaphore at ffffffff81066167
 #7 [ffff8880abcd0210] do_user_addr_fault at ffffffff81066b8e
 #8 [ffff8880abcd0280] exc_page_fault at ffffffff8106765f
 #9 [ffff8880abcd02a0] asm_exc_page_fault at ffffffff81c00b62
    RIP: 0033:0x7f1234abcd00   RSP: 0018:ffff8880abcd0300   EFLAGS: 00010246
    RAX: 0000000000000000  RBX: ffff888001234567  RCX: 0000000000000000
```

Each frame shows: frame number, kernel stack address, function name, source address.

### Inspecting the crashing code

```
# Find the faulting instruction
crash> dis -l ffffffff81066b8e     # disassemble with source lines
# do_user_addr_fault():
# /build/linux/arch/x86/mm/fault.c: 1402
# 0xffffffff81066b80: mov    (%rbx),%rax    ← NULL deref here
# 0xffffffff81066b83: test   %rax,%rax

# Print the faulting variable
crash> p my_struct->field

# Find what module a function belongs to
crash> sym ffffffffc0a01234
# ffffffffc0a01234 (t) mymodule_function [mymodule]
```

## makedumpfile

Raw vmcore files can be very large (equal to physical RAM). `makedumpfile` compresses and filters them:

```bash
# Create compressed dump, excluding zero pages and free pages
makedumpfile -c -d 31 /proc/vmcore /var/crash/dump

# Compression levels: -d N where bits mean:
# bit 0 (1): zero pages
# bit 1 (2): cache pages
# bit 2 (4): cache private
# bit 3 (8): user-space pages
# bit 4 (16): free pages
# 31 = all of the above

# For later analysis on a different machine:
makedumpfile --dump-dmesg /proc/vmcore dmesg.txt
```

## pstore: persistent storage across reboots

For embedded systems or when full kdump is impractical, pstore saves the kernel console log and oops backtraces to persistent storage (ACPI APEI, NVRAM, MTD flash, ramoops):

```bash
# ramoops: reserve RAM region that survives kexec
# (add to boot parameters)
ramoops.mem_address=0x8f000000 ramoops.mem_size=0x100000

# After crash/reboot, read saved logs:
ls /sys/fs/pstore/
# dmesg-ramoops-0   (console output before crash)
# console-ramoops-0

cat /sys/fs/pstore/dmesg-ramoops-0

# Erase after reading (pstore files are deleted by removing them)
rm /sys/fs/pstore/dmesg-ramoops-0
```

## Observing panic behavior

```bash
# Control what happens on panic
cat /proc/sys/kernel/panic
# 0 = hang (default)
# N > 0 = reboot after N seconds
# N < 0 = reboot immediately
echo 10 > /proc/sys/kernel/panic

# Panic on any oops (not just fatal ones)
echo 1 > /proc/sys/kernel/panic_on_oops

# Panic on soft lockup (hung task watchdog)
echo 1 > /proc/sys/kernel/softlockup_panic

# Hung task timeout (panic after N seconds of task stuck)
echo 120 > /proc/sys/kernel/hung_task_timeout_secs
```

## Further reading

### Kernel source

- [kernel/panic.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/panic.c) — `panic_timeout` and `panic_on_oops`: the variables behind the `kernel.panic` and `kernel.panic_on_oops` sysctl entries in `kern_panic_table[]`
- [kernel/watchdog.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/watchdog.c) — `softlockup_panic`: the variable behind `kernel.softlockup_panic`, checked when the soft lockup watchdog fires
- [kernel/hung_task.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/hung_task.c) — `sysctl_hung_task_timeout_secs`: backs `kernel.hung_task_timeout_secs`
- [fs/pstore/ram.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/fs/pstore/ram.c) — `mem_address`/`mem_size` module parameters: back the `ramoops.mem_address=`/`ramoops.mem_size=` boot parameters used to reserve the ramoops region

### Man pages

- [`kexec_load(2)`](https://man7.org/linux/man-pages/man2/kexec_load.2.html) — documents `KEXEC_ON_CRASH`, the flag that registers a kernel image as the crash kernel loaded into the memory reserved by `crashkernel=`

### Related pages

- [Oops analysis](oops-analysis.md) — reading oops without crash tool
- [KGDB](kgdb.md) — live kernel debugging
- [Kernel Panic and Oops](../kernel/panic-oops.md) — the `die()`/`panic()` code path that actually triggers kdump (`crash_kexec()`/`__crash_kexec()`)
- [Memory Management: KASAN](../mm/kasan.md) — catching use-after-free before crashes
- [Memory Management: KFENCE](../mm/kfence.md) — lightweight memory error detection

### LWN articles

- [Crash dumps with kexec](https://lwn.net/Articles/108595/) — Jonathan Corbet on the original kexec-based crash dump design (2004)
- [Persistent storage for a kernel's "dying breath"](https://lwn.net/Articles/434821/) — Jake Edge's introduction to pstore, the mechanism behind ramoops (2011)

### External

- [Kdump](https://docs.kernel.org/admin-guide/kdump/kdump.html) — official kdump setup guide: `crashkernel=` syntax, `/proc/vmcore`, `makedumpfile` usage
- [Ramoops oops/panic logger](https://docs.kernel.org/admin-guide/ramoops.html) — the ramoops pstore backend, including the `mem_address`/`mem_size` parameters
