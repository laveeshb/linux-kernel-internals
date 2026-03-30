# KGDB: Kernel GDB Debugger

> Live debugging of a running kernel with GDB

## Overview

KGDB allows debugging a live kernel using GDB as the front-end. The kernel halts at breakpoints and exposes a GDB remote protocol stub over a serial port or netconsole. A second machine (or a VM host) runs GDB.

```
Target machine (running kernel to debug)
  │
  │  kgdb serial/network transport
  │
  ▼
Host machine (running GDB)
  gdb vmlinux
  (gdb) target remote /dev/ttyS0
```

For single-machine debugging, KGDB over a VM's virtual serial port is the most practical setup.

## Kernel configuration

```bash
# Required kernel config options:
CONFIG_KGDB=y
CONFIG_KGDB_SERIAL_CONSOLE=y   # kgdboc: KGDB over console
CONFIG_KGDB_KDB=y              # optional: built-in KDB shell
CONFIG_FRAME_POINTER=y         # reliable stack traces
CONFIG_DEBUG_INFO=y            # symbol information in vmlinux
CONFIG_GDB_SCRIPTS=y           # GDB python scripts for kernel types
```

## Setting up the connection

### Over serial (physical or VM)

```bash
# Target: configure kgdb to use serial port ttyS0 at 115200 baud
# At boot (kernel parameter):
console=ttyS0,115200 kgdboc=ttyS0,115200

# Or at runtime (if kernel supports it):
echo ttyS0,115200 > /sys/module/kgdboc/parameters/kgdboc

# Trigger entry into the debugger:
echo g > /proc/sysrq-trigger
# Or: send SysRq-g over serial: Alt+SysRq+g
# Or: hit a breakpoint
```

```bash
# Host: connect GDB
gdb vmlinux
(gdb) set serial baud 115200
(gdb) target remote /dev/ttyS0
# Remote debugging using /dev/ttyS0
# (gdb) ...
```

### Over network (kgdboe)

kgdboe (KGDB over Ethernet) uses the netpoll framework:

```bash
# Target: kgdboe configuration
# Format: @target_ip/interface,@host_ip
insmod kgdb_nmi.ko
echo "g" > /proc/sysrq-trigger  # (after kgdboe setup)
# Or at boot:
kgdboe=@192.168.1.10/eth0,@192.168.1.1

# Host: use GDB with UDP
# (requires agent-proxy or similar)
```

For most use cases, serial is simpler and more reliable.

## Basic GDB commands for kernel debugging

Once connected:

```
# Show kernel version info
(gdb) info threads
(gdb) thread apply all bt    # backtrace all threads

# Inspect current task
(gdb) p $lx_current()        # current task_struct (requires GDB scripts)
(gdb) lx-ps                  # list all processes (GDB script)

# Stack trace
(gdb) bt
(gdb) bt full                # with local variables

# Navigate frames
(gdb) up
(gdb) down
(gdb) frame 3

# Inspect variables
(gdb) p variable_name
(gdb) p *ptr
(gdb) p *(struct task_struct*)0xffff888012345678

# Memory inspection
(gdb) x/16x address          # 16 hex words
(gdb) x/s address            # string
(gdb) x/i address            # disassemble

# Continue
(gdb) c                      # continue execution
(gdb) s                      # single step (into)
(gdb) n                      # next (over)
(gdb) finish                 # run until function return
```

## Breakpoints

```
# Software breakpoint (INT3 on x86)
(gdb) break function_name
(gdb) break kernel/sched/core.c:1234
(gdb) break *0xffffffff81234567   # by address

# Conditional breakpoint
(gdb) break schedule if current->pid == 1234

# Hardware watchpoint: break when memory is written
(gdb) watch *address           # break on write
(gdb) rwatch *address          # break on read
(gdb) awatch *address          # break on read or write

# Example: catch when a specific inode is modified
(gdb) watch -l inode->i_count

# List and manage breakpoints
(gdb) info breakpoints
(gdb) disable 2
(gdb) delete 2
```

## GDB scripts for kernel

The kernel ships Python-based GDB scripts (`scripts/gdb/`) that add kernel-specific commands:

```
# Load scripts (automatic if CONFIG_GDB_SCRIPTS=y and .gdbinit configured)
(gdb) source /path/to/kernel/scripts/gdb/vmlinux-gdb.py

# Kernel-specific commands:
(gdb) lx-version          # kernel version string
(gdb) lx-ps              # process list (like ps)
(gdb) lx-dmesg           # kernel ring buffer
(gdb) lx-lsmod           # loaded modules
(gdb) lx-mounts          # mounted filesystems
(gdb) lx-iomem           # /proc/iomem equivalent
(gdb) lx-symbols         # load module symbols

# Pretty-printers: struct task_struct, list_head, etc.
(gdb) p $lx_per_cpu("runqueues", 0)  # runqueue of CPU 0
(gdb) p $lx_current()               # current task
(gdb) $lx_container_of(ptr, "struct task_struct", "mm")
```

## Debugging a kernel module

Modules are loaded at runtime at unknown addresses. You must load their symbols into GDB:

```bash
# On target: find where module is loaded
cat /proc/modules | grep mymodule
# mymodule 16384 0 - Live 0xffffffffc0a00000

# Or via sysfs
cat /sys/module/mymodule/sections/.text
cat /sys/module/mymodule/sections/.data
```

```
# In GDB: add symbols at the reported address
(gdb) add-symbol-file mymodule.ko 0xffffffffc0a00000

# Or use lx-symbols to load all modules automatically
(gdb) lx-symbols /lib/modules/$(uname -r)/
```

## KDB: the built-in kernel debugger

KDB (`CONFIG_KGDB_KDB=y`) provides a simpler text-based debugger that runs entirely on the target, without needing a second machine:

```bash
# Enter KDB: press Alt+SysRq+g or trigger a panic
# Or at a breakpoint

# KDB prompt:
[0]kdb> help
[0]kdb> ps              # process list
[0]kdb> bt              # backtrace current task
[0]kdb> btp <pid>       # backtrace specific task
[0]kdb> md 0xffff888012345678 16   # memory dump
[0]kdb> mm address value           # memory modify
[0]kdb> bp function_name           # set breakpoint
[0]kdb> go                         # continue
[0]kdb> dmesg                      # print ring buffer
[0]kdb> lsmod                      # list modules
```

## Common debugging scenarios

### Debugging a kernel oops

```bash
# After an oops, the system may or may not be still running
# If still running (non-fatal oops), enter kgdb and:
(gdb) bt           # see where we are
(gdb) frame 5      # go to the faulting frame
(gdb) p *ptr       # inspect the null/invalid pointer
(gdb) list         # show source around crash point
```

### Race condition debugging

```bash
# Breakpoint with a counter (hit on 100th call)
(gdb) break kmalloc
(gdb) ignore 1 99        # skip first 99 hits
```

### Inspecting scheduler state

```bash
(gdb) break __schedule
(gdb) c
# At breakpoint:
(gdb) p *current         # current task
(gdb) p *current->mm     # current mm_struct
(gdb) p runqueue_of_cpu(0)  # runqueue
```

## Further reading

- [kdump and crash](kdump.md) — post-mortem crash analysis
- [Oops analysis](oops-analysis.md) — decoding oops without a debugger
- [Kernel Modules](../modules/module-basics.md) — loading module debug symbols
- [Tracing: ftrace](../tracing/ftrace.md) — lighter-weight alternative to breakpoints
- `Documentation/dev-tools/kgdb.rst` in the kernel tree
