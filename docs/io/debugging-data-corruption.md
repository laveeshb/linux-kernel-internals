# Debugging Data Corruption

> When data is written but read back differently — systematic diagnosis of silent data corruption in Linux I/O

## What data corruption looks like

Data corruption in I/O is the silent failure mode: unlike a crash or hang, the system continues operating, and the corruption may not be detected until data is read back — perhaps hours, days, or months later. By then, the corrupted data may have propagated to backups and replicas.

Corruption manifests as:
- Checksums failing in a database, filesystem, or application
- Files that open but contain garbage in specific regions
- Binary data where specific offsets are wrong (bit flips, zero-filled regions)
- Application behavior that is inconsistent with the stored data
- Filesystem tools (`fsck`, `xfs_repair`) reporting inconsistencies

---

## Step 1: Determine the scope

First, understand whether the corruption is widespread or isolated:

```bash
# How many files are affected?
# If using a checksumming filesystem (ZFS, Btrfs, XFS with metadata checksums):
zpool scrub poolname && watch zpool status poolname  # ZFS
btrfs scrub start /mountpoint && btrfs scrub status /mountpoint  # Btrfs

# For ext4: check filesystem metadata consistency
e2fsck -n /dev/sda1   # read-only check (don't fix yet)

# For XFS: check filesystem consistency
xfs_repair -n /dev/sda1  # read-only check

# Check SMART data for sector errors
smartctl -a /dev/sda
# Look for: Reallocated_Sector_Ct, Pending_Sector_Ct, Uncorrectable_Sector_Ct
# Any non-zero value in these counters indicates disk-level errors
```

**If the filesystem or SMART reports errors**: the corruption source is likely at the storage layer (bad sectors, failing drive, cable issue). Do not write to the filesystem until diagnosed — bad sectors that are read can be remapped by the drive, losing the ability to recover the data.

**If the filesystem reports clean but application data is corrupt**: the corruption is above the storage layer (kernel bug, driver bug, application bug, silent I/O error ignored by the application).

---

## Step 2: Check the storage path for hardware errors

```bash
# Kernel log for storage errors
dmesg | grep -E '(error|EIO|failed|exception|offline|bad|corrupt|unrecoverable)' | tail -50

# Look for patterns:
# - Same sector repeatedly: failing sector
# - Different sectors on same drive: failing drive
# - Multiple drives: controller, cable, or power issue
# - After a specific time: thermal issues or intermittent power

# Check for corrected errors (ECC corrections) — these precede uncorrected errors
smartctl -l error /dev/sda  # error log
smartctl -l selftest /dev/sda  # self-test history

# NVMe specific
nvme error-log /dev/nvme0  # NVMe error log
nvme smart-log /dev/nvme0  # includes media_errors and num_err_log_entries
```

**ECC corrections without uncorrected errors**: the drive is catching bit flips before they become visible. This is normal, but a high rate of ECC corrections indicates a drive that may fail soon.

**Write errors returning silently (`EIO` ignored)**: applications that do not check `write()` return values or `fsync()` return values may silently lose data when a write fails. Check:

```bash
# Use strace to verify an application handles write errors
strace -e trace=write,fsync,fdatasync -p <pid> 2>&1 | grep -E '(EAGAIN|EIO|error)'
```

---

## Step 3: Isolate the corrupted region

For corrupted files, identify the exact byte range of the corruption:

```bash
# Compare a file against a known-good copy (if available)
cmp -l original_file corrupted_file | head -20
# Shows byte offset (decimal) and values that differ

# For checksummed data: find which block is corrupt
# Example: if using a database with page checksums
pg_filedump -i /var/lib/postgresql/base/16384/1259 | grep "Bad checksum"

# Hexdump the corrupted region
hexdump -C -s $((CORRUPT_OFFSET - 512)) -n 1024 corrupted_file

# Check if corruption is zero-filled (common for unwritten extents, writeback failures)
dd if=corrupted_file bs=512 skip=$((CORRUPT_OFFSET/512)) count=8 | xxd | grep "0000 0000"
```

**Zero-filled regions**: often indicate a write that was lost (the data was never written, or was written to an uninitialized extent). Check if the file was recently extended (sparse file) or if the write call returned an error that was ignored.

**Bit flips (single bit differences)**: suggest DRAM or storage media errors. Run `memtest86+` to rule out DRAM; use SMART extended tests for storage media.

**Fixed-offset pattern (every 4096 bytes, every 512 bytes)**: suggests sector-boundary alignment issues or write combining that splits data incorrectly.

---

## Step 4: Check for silent writeback failures

A write that went to the page cache and appeared successful can fail during writeback — and the error may be lost. This is the "lost write error" problem.

Before Linux 4.13, writeback errors were not reliably delivered to applications. After 4.13, `fsync()` returns `EIO` if a writeback error occurred for the file — but only if the application calls `fsync()` to check.

```bash
# Applications that don't call fsync() won't see writeback errors
# Use this to detect silent writeback failures:

# Method 1: Enable writeback error reporting in trace
echo 1 > /sys/kernel/debug/tracing/events/writeback/writeback_write_inode_start/enable
echo 1 > /sys/kernel/debug/tracing/tracing_on
# Reproduce the I/O
echo 0 > /sys/kernel/debug/tracing/tracing_on
cat /sys/kernel/debug/tracing/trace | grep error

# Method 2: Monitor the device for errors
watch -n 1 'dmesg | tail -5'

# Method 3: Use bpftrace to catch the moment an error is recorded on an inode.
# mapping_set_error() is called when a writeback I/O fails; it records the error
# on the address_space so that a subsequent fsync() can return EIO.
bpftrace -e '
kprobe:mapping_set_error {
    if ((int)arg1 != 0) {
        printf("writeback error %d on inode %ld (%s)\n",
               (int)arg1,
               ((struct address_space *)arg0)->host->i_ino,
               comm);
    }
}'
```

**The per-file writeback error tracking** (`errseq_t`, introduced in v4.13) means that `fsync()` returns `EIO` the first time it is called after a writeback error for that file — but subsequent `fsync()` calls on the same fd return 0 (until the next error). This "poll" semantics means the first caller gets the error; subsequent callers may miss it. See [commit 1b9b571](https://git.kernel.org/linus/1b9b571).

---

## Step 5: Detect O_DIRECT / buffered I/O coherency issues

If data is written with `O_DIRECT` and read back with buffered I/O (or vice versa), the reader may see stale data from the page cache. This is a known limitation, not a bug, but it produces corruption-like symptoms.

```bash
# Check if an application is using O_DIRECT for some fds and not others
for pid in $(pgrep -f your_application); do
    for fd in /proc/$pid/fdinfo/*; do
        fdnum=$(basename $fd)
        flags=$(grep flags $fd | awk '{print $2}')
        # O_DIRECT = 0x4000 (decimal 16384, octal 040000)
        if echo $flags | grep -q "4"; then
            file=$(readlink /proc/$pid/fd/$fdnum 2>/dev/null)
            echo "PID $pid FD $fdnum: O_DIRECT set on $file (flags: $flags)"
        fi
    done
done
```

If the same file is opened with O_DIRECT in one path and without O_DIRECT in another, reads on the non-direct path may see the old page cache contents.

---

## Step 6: Test for DRAM errors

Memory errors can corrupt data in the page cache before it is written to storage, or corrupt data read from storage before it reaches the application.

```bash
# Check EDAC (Error Detection And Correction) counters
cat /sys/devices/system/edac/mc/mc0/ce_count   # correctable errors
cat /sys/devices/system/edac/mc/mc0/ue_count   # uncorrectable errors

# If EDAC shows errors, identify the DIMM:
edac-util -s

# Run memtest86+ for thorough DRAM testing (requires reboot)
# Or: stress test memory while running
stress-ng --vm 4 --vm-bytes 75% --timeout 3600s  # 1 hour memory stress test

# Check kernel for reported memory errors
dmesg | grep -E '(EDAC|MCE|memory error|corrected|uncorrected)'
```

DRAM errors are more common than widely believed, especially at scale. A single bit flip in a cached page can corrupt application data without triggering any storage-layer error.

---

## Step 7: Reproduce the corruption systematically

Once the corruption pattern is understood, try to reproduce it:

```bash
# Write a known pattern and verify it reads back correctly
# Method: fill a file with a checksum-verifiable pattern

python3 - << 'EOF'
import struct, hashlib

# Write blocks with embedded checksums
with open("/tmp/test_corruption", "wb") as f:
    for i in range(1024):
        data = struct.pack(">Q", i) * 511  # 4088 bytes of block number
        checksum = hashlib.md5(data).digest()  # 16 bytes
        f.write(data + checksum)

# Read back and verify
with open("/tmp/test_corruption", "rb") as f:
    for i in range(1024):
        block = f.read(4104)
        data, checksum = block[:4088], block[4088:]
        expected = hashlib.md5(data).digest()
        if checksum != expected:
            block_num = struct.unpack(">Q", data[:8])[0]
            print(f"CORRUPTION at block {i}: embedded block number {block_num}")
        else:
            print(f"Block {i}: OK")
EOF

# Use fio's verify mode for block device testing
fio --name=verify_test \
    --rw=randwrite \
    --bs=4k \
    --direct=1 \
    --verify=md5 \
    --verify_fatal=1 \
    --numjobs=1 \
    --iodepth=32 \
    --filename=/dev/nvme1n1 \
    --size=10G \
    --time_based \
    --runtime=3600  # run for 1 hour
```

`fio --verify` writes data with a checksum and reads it back, reporting any discrepancies. It is a reliable way to detect intermittent storage corruption.

---

## Common corruption patterns and their causes

| Pattern | Likely cause | Diagnosis |
|---------|--------------|-----------|
| Zero-filled regions | Unwritten extent, lost write | Check `fsync()` return values, SMART pending sectors |
| Single-bit flips | DRAM error, storage media error | EDAC counters, SMART, memtest86+ |
| Fixed-stride pattern (every 4KB) | Sector alignment bug, partial page write | `cmp -l` to find stride |
| Corruption only after reboot | Buffered write lost, writeback error silenced | Check `fsync()` usage, writeback error reporting |
| Corruption after `rename()` | Missing `fsync(dir)` | Check crash timing, directory entry persistence |
| Stale data (old content returned) | O_DIRECT + buffered I/O mixed, NFS stale cache | Check O_DIRECT flags, NFS mount options |
| Corruption only under load | Race condition, dirty page throttling interaction | Reproduce with stress test + checksums |
| Corruption correlated with heat | Thermal throttling causing DRAM or storage errors | CPU temperature logs, SMART temperature history |

---

## Filesystems with built-in checksumming

The most robust defense against silent corruption is a checksumming filesystem:

**Btrfs**: checksums all data and metadata. Scrub (`btrfs scrub start /mountpoint`) detects corruption across the entire filesystem.

**ZFS**: checksums everything, supports self-healing with redundant devices.

**XFS** (v5+): checksums all metadata by default (v5 format has been the default since kernel v4.0). User data blocks are not checksummed regardless of format version. To verify format version: `xfs_info /mountpoint | grep ftype`.

**ext4**: checksums metadata but not data. Use `tune2fs -E metadata_csum=1 /dev/sda1`.

With data checksumming, corruption is detected at read time, not at application level:

```bash
# Btrfs: detect corruption immediately on read
mount /dev/sda1 /mnt  # checksums verified automatically on read
# A corrupt block triggers: BTRFS error (device sda1): bdev /dev/sda1 errs: ...

# Btrfs: periodic scrub (checks all blocks including unread ones)
btrfs scrub start -B /mnt  # -B: wait for completion
btrfs scrub status /mnt
```

---

## Related pages

- [War Stories: Data Loss](war-stories-data-loss.md) — real corruption incidents
- [War Stories: CVEs](war-stories-cves.md) — security-relevant I/O corruption
- [Debugging I/O Hangs](debugging-io-hangs.md) — when I/O is stuck, not corrupt
- [Debugging Slow I/O](debugging-slow-io.md) — when I/O is slow, not corrupt
- [I/O Consistency and Ordering](io-consistency.md) — ordering guarantees
- [fsync, fdatasync, and O_SYNC](fsync-fdatasync.md) — durability mechanisms
- [strace and bpftrace for I/O](strace-bpftrace-io.md) — tracing tools for I/O investigation
