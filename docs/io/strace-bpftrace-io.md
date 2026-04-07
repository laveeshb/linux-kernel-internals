# strace and bpftrace for I/O Analysis

> Practical recipes for tracing I/O syscalls, kernel functions, and block layer events

## Two tools, two vantage points

**strace** traces at the syscall boundary — what the application sees. It shows which syscalls are made, what arguments are passed, what is returned, and how long each call took. It does not show what happens inside the kernel after the syscall is entered.

**bpftrace** traces at arbitrary points inside the kernel — functions, tracepoints, kprobes, uprobes. It can follow an I/O request from syscall entry through page cache, block layer, device driver, and back. It answers "why is the syscall slow?" — not just "is the syscall slow?"

```
Application → [strace boundary] → VFS → Page Cache → Block Layer → Device
                                   ↑                      ↑
                               bpftrace can probe anywhere in here
```

---

## strace: I/O syscall tracing

### Basic I/O syscall trace

```bash
# Trace all I/O-related syscalls for a process
strace -e trace=read,write,pread64,pwrite64,readv,writev,fsync,fdatasync,\
open,openat,close,lseek,mmap,munmap,sendfile,splice \
-p <pid>

# Show syscall timing (-T) and human-readable sizes (-s 128)
strace -e trace=read,write,fsync -T -s 128 -p <pid> 2>&1 | head -50

# Example output:
# read(5, "\x00\x00\x00\x01\x00\x00\x00\x02"..., 8192) = 8192 <0.000043>
# write(6, "HTTP/1.1 200 OK\r\n"..., 128) = 128 <0.000012>
# fsync(6) = 0 <0.002341>   ← 2.3ms fsync latency
```

### Find which files a process is reading/writing

```bash
# Show open() calls to see which files are being accessed
strace -e trace=openat,open -e signal=none -p <pid> 2>&1

# Combined: trace opens and I/O on specific file descriptors
strace -e trace=openat,read,write,close -e signal=none \
    -y \  # show file paths for each fd
    -p <pid> 2>&1

# Example output with -y:
# openat(AT_FDCWD, "/var/lib/postgresql/pg_wal/000000010000000000000001", O_RDWR) = 7</var/lib/postgresql/...>
# write(7</var/lib/postgresql/pg_wal/...>, "\x00\x01"..., 8192) = 8192 <0.000891>
# fdatasync(7</var/lib/postgresql/pg_wal/...>) = 0 <0.001423>
```

### Measure I/O syscall time distribution

```bash
# Summary of syscall counts and timing (-c)
strace -c -e trace=read,write,fsync,fdatasync -p <pid> &
sleep 30
kill -INT %1

# Example output:
# % time     seconds  usecs/call     calls    errors syscall
# ------ ----------- ----------- --------- --------- ----------------
#  78.23    2.345678        2341      1002           fdatasync
#  15.44    0.463291          46     10070           write
#   4.12    0.123456          12     10070           read
#   2.21    0.066310          33      2004           fsync
```

### Detect ignored write errors

```bash
# Watch for write() or fsync() returning errors
strace -e trace=write,fsync,fdatasync -p <pid> 2>&1 | \
    grep -E '= -[0-9]|ERRNO|EIO|ENOSPC|EDQUOT|EROFS'

# Common errors and their meanings:
# EIO = I/O error from the device
# ENOSPC = filesystem full
# EDQUOT = disk quota exceeded
# EROFS = read-only filesystem (remounted on error)
# EFAULT = invalid user buffer address (application bug)
```

### Trace with timestamps for latency analysis

```bash
# Absolute timestamps for correlation with other events
strace -tt -e trace=read,write,fsync -p <pid> 2>&1

# Example:
# 14:23:01.234567 write(4, ..., 65536) = 65536 <0.000023>
# 14:23:01.234601 write(4, ..., 65536) = 65536 <0.000019>
# 14:23:01.234625 fdatasync(4) = 0 <0.002891>  ← 2.89ms spike at 14:23:01.234625

# Correlate with dmesg timestamps:
dmesg -T | grep '14:23:01'
```

---

## bpftrace: kernel-level I/O tracing

### Trace VFS read/write calls

```bash
# Trace all read/write syscalls with their size and latency
bpftrace -e '
tracepoint:syscalls:sys_enter_read {
    @start_read[tid] = nsecs;
    @size_read[tid] = args->count;
}
tracepoint:syscalls:sys_exit_read /args->ret > 0/ {
    $lat = (nsecs - @start_read[tid]) / 1000;  /* µs */
    @read_lat_us = hist($lat);
    @read_bytes = hist(args->ret);
    delete(@start_read[tid]);
    delete(@size_read[tid]);
}
tracepoint:syscalls:sys_enter_write {
    @start_write[tid] = nsecs;
}
tracepoint:syscalls:sys_exit_write /args->ret > 0/ {
    $lat = (nsecs - @start_write[tid]) / 1000;
    @write_lat_us = hist($lat);
    delete(@start_write[tid]);
}'
```

### Track fsync latency by file path

```bash
# Show fsync latency distribution with the file path being synced
bpftrace -e '
tracepoint:syscalls:sys_enter_fsync,
tracepoint:syscalls:sys_enter_fdatasync {
    @start[tid] = nsecs;
    @fd[tid] = args->fd;
}
tracepoint:syscalls:sys_exit_fsync,
tracepoint:syscalls:sys_exit_fdatasync /@start[tid]/ {
    $lat_ms = (nsecs - @start[tid]) / 1000000;
    if ($lat_ms > 5) {  /* only show syncs > 5ms */
        printf("PID %d fsync(%d) took %d ms\n", pid, @fd[tid], $lat_ms);
    }
    @fsync_ms = hist($lat_ms);
    delete(@start[tid]);
    delete(@fd[tid]);
}'
```

### Block I/O latency histogram

```bash
# End-to-end block I/O latency from submission to completion
bpftrace -e '
kprobe:blk_account_io_start {
    @io_start[arg0] = nsecs;
}
kprobe:blk_account_io_done /@io_start[arg0]/ {
    $lat_us = (nsecs - @io_start[arg0]) / 1000;
    @blk_lat_us = hist($lat_us);
    delete(@io_start[arg0]);
}
END {
    printf("Block I/O latency distribution (microseconds):\n");
    print(@blk_lat_us);
}'
```

### Find the top I/O consumers by process

```bash
# Top processes by bytes written
bpftrace -e '
tracepoint:syscalls:sys_exit_write /args->ret > 0/ {
    @bytes_written[comm, pid] = sum(args->ret);
}
interval:s:5 {
    print(@bytes_written);
    clear(@bytes_written);
}'

# Top processes by number of fsync calls (WAL-heavy processes stand out)
bpftrace -e '
tracepoint:syscalls:sys_enter_fsync { @fsyncs[comm, pid] = count(); }
tracepoint:syscalls:sys_enter_fdatasync { @fsyncs[comm, pid] = count(); }
interval:s:5 { print(@fsyncs); clear(@fsyncs); }'
```

### Track page cache hit rate

```bash
# Page cache hits vs misses for file reads
bpftrace -e '
kretprobe:pagecache_get_page /retval != 0/ {
    @cache_hits = count();
}
kretprobe:pagecache_get_page /retval == 0/ {
    @cache_misses = count();
}
interval:s:5 {
    $total = @cache_hits + @cache_misses;
    if ($total > 0) {
        printf("Cache hit rate: %d%% (%d hits, %d misses)\n",
            @cache_hits * 100 / $total, @cache_hits, @cache_misses);
    }
    clear(@cache_hits); clear(@cache_misses);
}'
```

### Trace readahead effectiveness

```bash
# Track readahead pages issued vs pages actually used
bpftrace -e '
tracepoint:mm:mm_readahead_file {
    @ra_pages_issued = sum(args->nr);
}
tracepoint:mm:mm_filemap_add_to_page_cache {
    @pages_added = count();
}
interval:s:10 {
    printf("Readahead issued: %d pages, Pages cached: %d pages\n",
        @ra_pages_issued, @pages_added);
    printf("Readahead efficiency: %d%%\n",
        @pages_added * 100 / (@ra_pages_issued + 1));
    clear(@ra_pages_issued); clear(@pages_added);
}'
```

### Detect dirty page throttling stalls

```bash
# Detect when application writers are being throttled by balance_dirty_pages
bpftrace -e '
kprobe:balance_dirty_pages_ratelimited {
    @throttle_start[tid] = nsecs;
}
kretprobe:balance_dirty_pages_ratelimited /@throttle_start[tid]/ {
    $lat_us = (nsecs - @throttle_start[tid]) / 1000;
    if ($lat_us > 1000) {  /* > 1ms throttle pause */
        printf("PID %d (%s) throttled for %d µs\n", pid, comm, $lat_us);
    }
    @throttle_us = hist($lat_us);
    delete(@throttle_start[tid]);
}'
```

### Full I/O stack trace for slow operations

```bash
# Get kernel stack for any write that takes more than 10ms
bpftrace -e '
tracepoint:syscalls:sys_enter_write { @start[tid] = nsecs; }
tracepoint:syscalls:sys_exit_write /@start[tid]/ {
    $lat_ms = (nsecs - @start[tid]) / 1000000;
    if ($lat_ms > 10) {
        printf("Slow write: %d ms\n", $lat_ms);
        printf("%s\n", kstack);
    }
    delete(@start[tid]);
}'

# The kstack output shows where in the kernel the time was spent:
# write_begin (filesystem copying from userspace)
# balance_dirty_pages_ratelimited (dirty throttling)
# jbd2_log_wait_commit (waiting for journal commit)
# io_schedule (waiting for block I/O)
```

---

## BCC tools for I/O analysis

The BCC (BPF Compiler Collection) tools provide ready-made analysis scripts:

```bash
# fileslower: show file operations (reads/writes) slower than N ms
/usr/share/bcc/tools/fileslower 10  # operations > 10ms

# ext4slower, xfsslower, btrfsslower: filesystem-specific versions
/usr/share/bcc/tools/ext4slower 5

# biolatency: block device I/O latency histogram
/usr/share/bcc/tools/biolatency -d nvme0n1 30  # 30-second window

# biotop: top block I/O by process
/usr/share/bcc/tools/biotop

# cachestat: page cache hit/miss rate
/usr/share/bcc/tools/cachestat 1  # 1-second interval

# cachetop: page cache activity by process
/usr/share/bcc/tools/cachetop

# dcstat: directory cache (dcache) hit rate
/usr/share/bcc/tools/dcstat 1

# opensnoop: trace open() calls
/usr/share/bcc/tools/opensnoop -p <pid>

# filelife: trace file creation and deletion with duration
/usr/share/bcc/tools/filelife
```

---

## Combining strace and bpftrace

Use strace to identify the slow syscall, then bpftrace to understand why:

```bash
# Step 1: Find slow syscalls with strace
strace -c -T -e trace=read,write,fsync -p <pid>
# Output: fsync takes 15ms on average

# Step 2: Use bpftrace to trace the slow fsync path
bpftrace -e '
kprobe:vfs_fsync_range {
    @start[tid] = nsecs;
}
kretprobe:vfs_fsync_range /@start[tid]/ {
    $lat = (nsecs - @start[tid]) / 1000000;
    if ($lat > 5) {
        printf("fsync %d ms:\n%s\n", $lat, kstack);
    }
    delete(@start[tid]);
}'
```

---

## Quick reference: I/O tracing recipes

```bash
# "What files is this process accessing?"
strace -e trace=openat -y -p <pid>

# "Why are writes slow?"
bpftrace -e 'tracepoint:syscalls:sys_enter_write { @start[tid]=nsecs; }
tracepoint:syscalls:sys_exit_write { @lat=hist((nsecs-@start[tid])/1000); delete(@start[tid]); }'

# "Is the application calling fsync?"
strace -e trace=fsync,fdatasync -c -p <pid>

# "What's the block device latency?"
/usr/share/bcc/tools/biolatency -d nvme0n1 10

# "Which process is generating the most I/O?"
/usr/share/bcc/tools/biotop

# "Is the page cache being used effectively?"
/usr/share/bcc/tools/cachestat 1

# "Where is time being spent in a slow write?"
bpftrace -e 'tracepoint:syscalls:sys_enter_write { @s[tid]=nsecs; }
tracepoint:syscalls:sys_exit_write /(nsecs-@s[tid])/1000000 > 10/ {
printf("%d ms\n%s\n",(nsecs-@s[tid])/1000000,kstack); delete(@s[tid]); }'
```

---

## Related pages

- [ftrace for I/O](ftrace-io.md) — function-level tracing without writing BPF programs
- [I/O Tracepoints](io-tracepoints.md) — complete list of I/O-related tracepoints
- [perf for I/O](perf-io.md) — PMU-based I/O profiling and flame graphs
- [Debugging Slow I/O](debugging-slow-io.md) — systematic I/O diagnosis workflow
- [Debugging I/O Hangs](debugging-io-hangs.md) — when I/O is stuck
