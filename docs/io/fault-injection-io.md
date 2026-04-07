# Fault Injection for I/O Testing

> Deliberately failing block I/O requests, timeouts, and NFS calls to exercise error-handling paths

## What is I/O fault injection?

The Linux kernel's fault injection framework (`lib/fault-inject.c`) can deliberately cause specific kernel operations to fail with a configured probability. For I/O subsystems, this means:

- Failing `bio` submissions at the block layer (`FAIL_MAKE_REQUEST`)
- Injecting I/O timeouts (`FAIL_IO_TIMEOUT`)
- Failing NFS/SunRPC calls (`FAIL_SUNRPC`)
- Injecting arbitrary block device errors via `dm-flakey` or `blk-mq` error injection

Fault injection answers the question: *"What does my application do when the disk returns an error?"* In production, disk errors are rare and unexpected. In a test environment with fault injection, they become routine — and you find out whether your error handling is correct before it matters.

---

## Kernel configuration

```
# Core fault injection framework
CONFIG_FAULT_INJECTION=y
CONFIG_FAULT_INJECTION_DEBUG_FS=y       # debugfs control interface (required)
CONFIG_FAULT_INJECTION_STACKTRACE_FILTER=y  # per-call-site filtering

# I/O-specific fault types
CONFIG_FAIL_MAKE_REQUEST=y   # fail bio submissions to block devices
CONFIG_FAIL_IO_TIMEOUT=y     # inject I/O timeouts (triggers device error handling)
CONFIG_FAIL_SUNRPC=y         # fail NFS/SunRPC RPC calls
```

Check your running kernel:

```bash
grep -E '(FAIL_MAKE_REQUEST|FAIL_IO_TIMEOUT|FAULT_INJECTION)' /boot/config-$(uname -r)
ls /sys/kernel/debug/fail_make_request/ 2>/dev/null && echo "block fault injection available"
```

---

## `FAIL_MAKE_REQUEST`: failing block I/O submissions

`FAIL_MAKE_REQUEST` intercepts block I/O submissions at the `submit_bio()` boundary and fails the BIO with `-EIO` through the completion path. `submit_bio()` itself is `void`; the error is injected asynchronously — the BIO is never dispatched to the device and instead completes with an error, exactly as a real device rejection would appear to the filesystem above.

### Setup

```bash
# Enable with 10% failure rate
cd /sys/kernel/debug/fail_make_request

echo 10 > probability      # fail 10% of requests (0–100)
echo -1 > times           # fail indefinitely (-1) or N times
echo 0  > space           # fail all sizes (or set minimum size in bytes)
echo 2  > verbose         # 0=silent, 1=log failures, 2=log+stacktrace

# Start injecting
echo 1 > /sys/kernel/debug/fail_make_request/task-filter
# (Without task-filter=1, all processes are affected — use carefully)
```

### Target a specific process

```bash
# Only inject for a specific process
echo 1 > /proc/<pid>/make-it-fail

# Verify
cat /proc/<pid>/make-it-fail  # should print 1
```

### Test your application's error handling

```bash
# Start the target application
./my_db_application &
APP_PID=$!

# Enable fault injection for that process only
echo 1 > /proc/$APP_PID/make-it-fail

# Enable FAIL_MAKE_REQUEST
echo 5 > /sys/kernel/debug/fail_make_request/probability  # 5%
echo -1 > /sys/kernel/debug/fail_make_request/times

# Run a workload and observe behavior
# Application should: log the error, not silently corrupt state, not panic

# Disable
echo 0 > /sys/kernel/debug/fail_make_request/probability
echo 0 > /proc/$APP_PID/make-it-fail
```

### What to look for

A correct application will:
- Propagate `EIO` to the caller with an appropriate error message
- Not lose data it believed was committed
- Not corrupt internal state (e.g., database page not marked clean if write failed)
- Retry transient errors with backoff, or fail fast with a clear error

A broken application will:
- Ignore the `write()` or `fsync()` return code
- Mark data as durable when it has not reached storage
- Crash or corrupt its state on unexpected `EIO`

```bash
# Watch the kernel log for injected errors
dmesg -w | grep -E '(fault injection|EIO|failed|error)'
```

---

## `FAIL_IO_TIMEOUT`: injecting device timeouts

`FAIL_IO_TIMEOUT` causes submitted I/O requests to time out rather than complete normally. This exercises the device error recovery path: the block layer's timeout handler (`blk_mq_timeout_work`), the driver's abort logic, and the filesystem's EIO handling.

```bash
# Setup
cd /sys/kernel/debug/fail_io_timeout

echo 5  > probability   # 5% of I/Os time out
echo -1 > times         # indefinite
echo 1  > verbose

# This is more disruptive than FAIL_MAKE_REQUEST because timeouts
# trigger the full device reset path, potentially affecting all I/O
# in flight. Use on a dedicated test device.
```

**Timeout injection test scenario**:

```bash
# Use dm-flakey (safer) instead of FAIL_IO_TIMEOUT for controlled testing
# dm-flakey lets you fail I/Os on a specific virtual device without
# touching real devices

# Create a virtual block device backed by a loop device
dd if=/dev/zero of=/tmp/test.img bs=1M count=1024
LOOP=$(losetup -f --show /tmp/test.img)

# Create a dm-flakey device that fails every 10th I/O
dmsetup create flakey --table "0 2097152 flakey $LOOP 0 200000 20000"
# dm-flakey up/down parameters are in 512-byte SECTORS, not seconds.
# up_sectors=200000 (≈100MB), down_sectors=20000 (≈10MB):
# failures occur for every 10MB of I/O after 100MB of good I/O.
# To approximate time-based cycles, multiply target seconds by your
# expected throughput in sectors/second: at 50MB/s = 100000 sectors/s,
# 100 seconds ≈ 10000000 sectors.

mkfs.ext4 /dev/mapper/flakey
mount /dev/mapper/flakey /mnt/test

# Run your workload on /mnt/test — it will see periodic I/O failures
# Check application behavior during the 10-second failure window
```

---

## `dm-flakey`: production-quality block error simulation

`dm-flakey` (Device Mapper Flakey) is the preferred method for block-level fault injection in test environments. Unlike `FAIL_MAKE_REQUEST`, it operates on a specific virtual device and supports fine-grained error modes.

```bash
# Load dm-flakey module
modprobe dm-flakey

# Create a loop-backed device
dd if=/dev/zero of=/tmp/disk.img bs=1M count=2048
LOOP=$(losetup -f --show /tmp/disk.img)
SECTORS=$(blockdev --getsz $LOOP)

# Basic flakey: up_sectors=3600000 (~1.8GB), down_sectors=400000 (~200MB)
# Parameters are in 512-byte sectors, not seconds.
dmsetup create flakey --table "0 $SECTORS flakey $LOOP 0 3600000 400000"

# During down_interval, all writes return EIO:
# dmsetup create flakey --table "0 $SECTORS flakey $LOOP 0 180 20 1 drop_writes"

# Corrupt reads instead of failing them (tests checksum detection):
# dmsetup create flakey --table "0 $SECTORS flakey $LOOP 0 180 20 1 corrupt_bio_byte 10 r 1 0"
# corrupt_bio_byte: flip byte 10 of read I/Os (r), set to 0x01

# Remove when done
dmsetup remove flakey
losetup -d $LOOP
```

### `dm-flakey` error modes

| Mode | Effect | Tests |
|------|--------|-------|
| (default) | All I/Os return EIO during down period | Basic error handling |
| `drop_writes` | Write requests silently discarded (no error returned) | Silent data loss — does application detect? |
| `error_writes` | Write requests return EIO | Explicit write error handling |
| `corrupt_bio_byte` | Flip a byte in read I/Os | Checksum validation, data integrity |

`drop_writes` is particularly insidious: writes appear to succeed from the application's perspective — including `fsync()`, which returns 0 — but the data never reaches storage. The kernel and filesystem believe the writes went through; dm-flakey discards them silently at the device mapper level. The only way to detect the loss is to read the data back and compare it, or use a filesystem with per-block checksums (Btrfs, ZFS) that will catch the discrepancy. This mode tests whether an application does read-after-write verification rather than trusting `fsync()` alone.

---

## `FAIL_SUNRPC`: NFS error injection

For NFS workloads, `FAIL_SUNRPC` injects failures into RPC calls before they leave the client:

```bash
cd /sys/kernel/debug/fail_sunrpc

echo 5  > probability
echo -1 > times
echo 1  > ignore-client-disconnect  # continue after disconnect

# Test NFS client error handling:
# - Does the application retry on EAGAIN?
# - Does it handle ESTALE (stale file handle) correctly?
# - Does it fail fast or hang indefinitely on hard-mount?
```

---

## Filtering by call site

`FAULT_INJECTION_STACKTRACE_FILTER` allows injecting failures only when called from a specific code path:

```bash
# Only fail submissions from ext4's writeback path
echo 1 > /sys/kernel/debug/fail_make_request/require-start
echo "ext4_writepages" > /sys/kernel/debug/fail_make_request/stacktrace-filter

# This injects failures only when bio submissions come through ext4_writepages,
# testing ext4's writeback error handling without affecting reads or direct I/O
```

---

## Integration with automated testing

The fault injection framework integrates with kernel selftests and can be scripted:

```bash
#!/bin/bash
# Test script: verify application handles write errors correctly

DEVICE=/dev/mapper/flakey
MOUNT=/mnt/flakey_test

setup_flakey() {
    dd if=/dev/zero of=/tmp/flakey.img bs=1M count=512 2>/dev/null
    LOOP=$(losetup -f --show /tmp/flakey.img)
    SECTORS=$(blockdev --getsz $LOOP)
    dmsetup create flakey --table "0 $SECTORS flakey $LOOP 0 60 10"
    mkfs.ext4 -q $DEVICE
    mount $DEVICE $MOUNT
}

teardown_flakey() {
    umount $MOUNT 2>/dev/null
    dmsetup remove flakey 2>/dev/null
    losetup -d $LOOP 2>/dev/null
    rm -f /tmp/flakey.img
}

run_workload() {
    # Run your application against $MOUNT
    # It should return a non-zero exit code when I/O fails
    ./my_application --data-dir=$MOUNT --duration=120
    return $?
}

setup_flakey
run_workload
EXIT=$?
teardown_flakey

if [ $EXIT -ne 0 ]; then
    echo "PASS: application correctly reported I/O failure"
else
    echo "FAIL: application did not detect I/O failure"
    exit 1
fi
```

---

## What good I/O error handling looks like

```c
/* Bad: ignoring return values */
write(fd, data, len);        /* return value ignored */
fsync(fd);                   /* return value ignored */
/* Application believes data is safe. It may not be. */

/* Good: checking every I/O return value */
ssize_t n = write(fd, data, len);
if (n < 0) {
    log_error("write failed: %s", strerror(errno));
    goto abort;
}
if (n < len) {
    log_error("short write: %zd of %zu bytes", n, len);
    goto abort;
}

if (fsync(fd) < 0) {
    log_error("fsync failed: %s", strerror(errno));
    goto abort;
    /* Don't mark data as committed — it may not be on storage */
}
```

---

## Related pages

- [Debugging Data Corruption](debugging-data-corruption.md) — diagnosing real corruption in production
- [Debugging I/O Hangs](debugging-io-hangs.md) — when I/O is stuck
- [I/O Consistency and Ordering](io-consistency.md) — durability guarantees
- [War Stories: Data Loss](war-stories-data-loss.md) — what happens when error handling is missing
- [Life of a write()](life-of-a-write.md) — the path where errors can occur
