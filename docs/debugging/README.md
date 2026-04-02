# Kernel Debugging

> Tools and techniques for debugging the Linux kernel

## Debugging approaches

```
Problem type                  Best tool
────────────────────────────────────────────────────────────
Kernel crash (already happened) kdump + crash
Live kernel, single machine     kgdb over serial/netconsole
Memory corruption               KASAN, KFENCE, SLUB debug
Race conditions                 lockdep, KCSAN
Crashes with no debugger        Oops analysis, addr2line
Performance                     perf, ftrace, BPF
Logic bugs in drivers           dynamic debug, pr_debug
Boot failures                   early_printk, earlyprintk=ttyS0
```

## Pages in this section

| Page | What it covers |
|------|----------------|
| [KGDB](kgdb.md) | Live kernel debugging with GDB over serial or network |
| [kdump and crash](kdump.md) | Capturing and analyzing kernel crash dumps |
| [Oops analysis](oops-analysis.md) | Reading oops output, addr2line, decode_stacktrace |
| [KCSAN](kcsan.md) | Data race detection using watchpoints and the Linux Kernel Memory Model |
| [syzkaller](syzkaller.md) | Automated syscall fuzzing, syzbot, and reproducer workflow |
| [KASAN and KFENCE](kasan-kfence.md) | Memory error detection: out-of-bounds, use-after-free, shadow memory |
| [lockdep in Practice](dynamic-debug-lockdep.md) | Reading splats, annotating false positives, contention stats |
| [War Stories](war-stories.md) | Real bugs caught by KASAN, lockdep, syzkaller, kdump, and KFENCE |

## Quick reference

```bash
# Trigger an oops on demand (testing)
echo c > /proc/sysrq-trigger

# Enable SysRq
echo 1 > /proc/sys/kernel/sysrq

# Common SysRq keys:
# Alt+SysRq+t: dump all tasks
# Alt+SysRq+m: memory info
# Alt+SysRq+l: backtrace all CPUs
# Alt+SysRq+b: reboot
# Alt+SysRq+c: crash (for kdump testing)

# Panic on oops (useful for kdump testing)
echo 1 > /proc/sys/kernel/panic_on_oops
echo 5 > /proc/sys/kernel/panic          # reboot 5s after panic

# kernel.org decode
./scripts/decode_stacktrace.sh vmlinux < oops.txt
```
