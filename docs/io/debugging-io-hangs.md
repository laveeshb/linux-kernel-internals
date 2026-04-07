# Debugging I/O Hangs

> When I/O is not just slow but completely stuck — how to identify, triage, and recover from I/O hangs in Linux

## What is an I/O hang?

A process in **D state** (uninterruptible sleep) is waiting for I/O to complete. Normally this lasts microseconds to milliseconds. An I/O hang occurs when a process stays in D state for seconds, minutes, or indefinitely — typically because:

- A storage device stopped responding (hardware failure, firmware hang, cable issue)
- A network filesystem (NFS, CIFS) lost its server connection
- The block layer detected an error and is retrying without limit
- A kernel lock is held by a D-state process, causing a chain of dependents

The kernel logs a "hung task" warning after 120 seconds by default:

```
[12345.678901] INFO: task kworker/u8:2:1234 blocked for more than 120 seconds.
[12345.678902]       Not tainted 6.8.0 #1
[12345.678903] "echo 0 > /proc/sys/kernel/hung_task_timeout_secs" disables this message.
[12345.678904] task:kworker/u8:2    state:D stack:    0 pid: 1234 ppid:     2 flags:0x00004000
[12345.678905] Call Trace:
[12345.678906]  <TASK>
[12345.678907]  __schedule+0x2d4/0x8a0
[12345.678908]  schedule+0x46/0xb0
[12345.678909]  io_schedule+0x42/0x70
[12345.678910]  wait_for_completion_io+0x6e/0x110
```

---

## Step 1: Identify which processes are hung

```bash
# Find all processes in D (uninterruptible sleep)
ps aux | awk '$8 ~ /^D/ { print $0 }'

# Or with more detail
for pid in $(ls /proc | grep '^[0-9]'); do
    state=$(cat /proc/$pid/status 2>/dev/null | grep '^State' | awk '{print $2}')
    if [ "$state" = "D" ]; then
        comm=$(cat /proc/$pid/comm 2>/dev/null)
        wchan=$(cat /proc/$pid/wchan 2>/dev/null)
        echo "PID $pid ($comm): blocked in $wchan"
    fi
done
```

**Reading `/proc/<pid>/wchan`:**

| `wchan` value | What the process is waiting for |
|---------------|--------------------------------|
| `io_schedule` | Generic block I/O |
| `jbd2_log_wait_commit` | ext4 journal commit |
| `nfs_wait_bit_killable` | NFS operation |
| `wait_on_page_writeback` | Waiting for a specific page to be flushed |
| `balance_dirty_pages_ratelimited` | Dirty throttling (usually resolves quickly) |
| `blk_execute_rq` | Synchronous block request in progress |
| `md_flush_request` | md/RAID flush |

---

## Step 2: Get the full kernel stack

```bash
# Requires CAP_SYS_ADMIN (root)
cat /proc/<pid>/stack

# Example output for a stuck ext4 write:
# [<0>] jbd2_log_wait_commit+0xb4/0x110
# [<0>] jbd2__journal_start+0x18c/0x340
# [<0>] __ext4_journal_start_sb+0x6c/0xf0
# [<0>] ext4_dirty_inode+0x34/0x60
# [<0>] __mark_inode_dirty+0x1cc/0x4b0
# [<0>] generic_write_end+0xb4/0x100
# [<0>] ext4_write_end+0x68/0x1c0
# [<0>] generic_perform_write+0x124/0x1c0
# [<0>] ext4_buffered_write_iter+0x58/0x100
# [<0>] vfs_write+0x298/0x3e0
# [<0>] __x64_sys_write+0x5c/0x100
```

The stack trace tells you exactly where in the kernel the process is blocked. Work upward from the innermost frame.

**Getting stacks for all D-state processes at once (useful during an incident):**

```bash
# Write a script to dump all D-state stacks
for pid in $(ls /proc | grep '^[0-9]'); do
    state=$(awk '/^State/{print $2}' /proc/$pid/status 2>/dev/null)
    if [ "$state" = "D" ]; then
        echo "=== PID $pid ($(cat /proc/$pid/comm 2>/dev/null)) ==="
        cat /proc/$pid/stack 2>/dev/null
        echo ""
    fi
done

# Alternatively, use sysrq to dump all stacks to dmesg
echo l > /proc/sysrq-trigger  # dumps all CPU stacks
# Then: dmesg | tail -200
```

---

## Step 3: Check device health

If processes are stuck in block I/O, check whether the device itself has stopped responding.

```bash
# Check for device errors in kernel log
dmesg | grep -E '(error|timeout|reset|offline|failed|EIO|SCSI|ata|nvme)' | tail -30

# NVMe health
nvme smart-log /dev/nvme0

# SATA/SAS health
smartctl -a /dev/sda

# Check if device is still responding to I/O (will block if device is hung)
# Use timeout to avoid hanging your shell
timeout 5 dd if=/dev/sda of=/dev/null bs=512 count=1 iflag=direct 2>&1
# If this hangs: device is not responding to I/O

# Check block device queue state
cat /sys/block/sda/queue/in_flight    # I/Os currently in flight to the device
cat /sys/block/sda/queue/nr_requests  # maximum queue depth
```

**Common device hang signatures in dmesg:**

```
# NVMe timeout:
nvme nvme0: I/O 23 QID 1 timeout, aborting

# SCSI timeout:
sd 0:0:0:0: [sda] tag#0 FAILED Result: hostbyte=DID_TIMEOUT driverbyte=DRIVER_OK

# ATA timeout:
ata1.00: exception Emask 0x10 SAct 0x0 SErr 0x4010000 action 0x6
ata1.00: hard resetting link

# I/O error returned to filesystem:
EXT4-fs error (device sda1): ext4_find_entry:1455: inode #2: comm bash: reading directory lblock 0
```

---

## Step 4: Check for NFS hangs

NFS hangs are a common cause of D-state processes. They occur when the NFS server becomes unreachable, or when the client's connection times out.

```bash
# Check NFS mount options
mount | grep nfs
# Look for: hard vs soft, timeo=, retrans=, intr

# Check NFS statistics for errors
nfsstat -c  # client-side stats
cat /proc/net/rpc/nfs  # raw NFS client RPC stats

# Check for pending RPC calls
cat /proc/net/rpc/nfsd  # server-side if this is a server
```

**Hard vs soft NFS mounts:**

A mount with `hard` (the default) will retry indefinitely on server failure — processes will hang in D state until the server returns. A `soft` mount will return `EIO` after `retrans` retries × `timeo` timeout.

```bash
# Re-mount with soft and timeo to avoid infinite hangs
mount -o remount,soft,timeo=30,retrans=3 /nfs/mountpoint

# Or force-unmount a stuck NFS mount (lazy unmount)
umount -l /nfs/mountpoint   # lazy: detach immediately, clean up when refs drop
umount -f /nfs/mountpoint   # force: attempt immediate unmount even with active files
```

!!! warning "Data risk with force unmount"
    Force-unmounting an NFS filesystem with dirty data may lose writes that have not yet reached the server. Only use `-f` when you accept potential data loss and need to recover the system.

---

## Step 5: Check for writeback hangs

A writeback hang occurs when dirty pages cannot be flushed: the flusher kworker is stuck, or the device is returning errors that cause retries.

```bash
# Check writeback state
grep -E '(nr_dirty|nr_writeback|nr_dirty_threshold|nr_dirty_background_threshold)' /proc/vmstat

# Check if kworker threads are stuck
ps aux | grep kworker
# A kworker in D state doing writeback will show in its stack:
# writeback_sb_inodes / wb_writeback / wb_do_writeback

# Check BDI (Backing Device Info) state per device
ls /sys/class/bdi/
cat /sys/class/bdi/8:0/max_ratio          # max dirty ratio for this device
cat /sys/class/bdi/8:0/read_ahead_kb

# If a device has errors, writeback will retry:
dmesg | grep -E '(writeback|EIO|write error)' | tail -20
```

**Force a writeback stall to resolve:**

```bash
# Drop all clean cached pages (does NOT help if writeback is stuck on errors)
echo 1 > /proc/sys/vm/drop_caches

# Attempt to sync all filesystems (will block if writeback is hung)
timeout 30 sync

# If sync hangs, check which device is causing problems via blktrace
blktrace -d /dev/sda -o /tmp/btrace &
sleep 5
kill %1
blkparse -i /tmp/btrace.blktrace.0 | tail -50
```

---

## Step 6: Check for lock contention causing hangs

Sometimes a process appears to be doing I/O but is actually waiting for a kernel lock held by a D-state I/O waiter. This creates a chain of stuck processes.

```bash
# lockdep output (if enabled in kernel config)
cat /proc/lockdep_stats

# Check for mutex/rwsem contention in process stacks
# Look for frames like:
#   mutex_lock_slowpath
#   rwsem_down_read_slowpath
#   down_read
```

**Using `perf lock` to find lock contention:**

```bash
# Record lock contention events for 10 seconds
perf lock record -a -- sleep 10

# Analyze: show contention by lock
perf lock report --key=wait

# Or use bpftrace to trace mutex contention
bpftrace -e '
kprobe:mutex_lock_slowpath {
    @[kstack] = count();
}
interval:s:5 {
    print(@);
    clear(@);
}'
```

---

## Step 7: Recover from a device hang without rebooting

If a single device has hung but the system is otherwise functional, you may be able to reset the device without rebooting.

**SCSI/SATA device reset:**

```bash
# Trigger a SCSI device reset
echo 1 > /sys/block/sda/device/delete   # removes the device from the system
# Then rescan to re-add it:
echo "- - -" > /sys/class/scsi_host/host0/scan

# Or use sg_reset to send a bus reset
sg_reset --device /dev/sda
sg_reset --bus /dev/sda
```

**NVMe reset:**

```bash
# Reset an NVMe controller
nvme reset /dev/nvme0

# Or remove and re-add via sysfs
echo 1 > /sys/bus/pci/devices/<pci-id>/remove
echo 1 > /sys/bus/pci/rescan
```

**md/RAID recovery:**

```bash
# Check RAID status
cat /proc/mdstat

# Mark a failed drive as faulty and remove it
mdadm /dev/md0 --fail /dev/sdb
mdadm /dev/md0 --remove /dev/sdb

# Re-add after replacement
mdadm /dev/md0 --add /dev/sdb
```

---

## Preventive configuration

```bash
# Reduce hung_task timeout to get faster warnings
echo 30 > /proc/sys/kernel/hung_task_timeout_secs

# Panic on hung tasks (for servers where a hang is worse than a reboot)
echo 1 > /proc/sys/kernel/hung_task_panic

# Enable NMI watchdog to detect hard lockups
echo 1 > /proc/sys/kernel/nmi_watchdog

# Set NFS mounts to soft with reasonable timeout
# Add to /etc/fstab: nfsserver:/export /mnt nfs soft,timeo=30,retrans=3 0 0

# Configure block device error handling
# The `max_sectors_kb` and error policy are device-specific
cat /sys/block/sda/device/timeout    # seconds before SCSI timeout
echo 30 > /sys/block/sda/device/timeout  # reduce from default 30s if needed
```

---

## Related pages

- [Why is my I/O slow?](debugging-slow-io.md) — for slow but not stuck I/O
- [Debugging Data Corruption](debugging-data-corruption.md) — when I/O completes but data is wrong
- [War Stories: Data Loss](war-stories-data-loss.md) — real incidents from I/O failures
- [I/O Tracepoints](io-tracepoints.md) — tracepoint reference
- [ftrace for I/O](ftrace-io.md) — function tracing
