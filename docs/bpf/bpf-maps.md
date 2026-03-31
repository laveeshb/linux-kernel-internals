# BPF Maps

> The data structures that connect BPF programs to each other and to userspace

## What BPF maps are

BPF maps are key-value stores accessible from both BPF programs (via helpers) and userspace (via the bpf() syscall). They are the primary mechanism for:

- Passing data from BPF programs to userspace (stats, events)
- Passing configuration from userspace to BPF programs
- Sharing state between multiple BPF programs
- Maintaining state across invocations of the same BPF program

```
BPF program                       Userspace
───────────────────────────────────────────────
bpf_map_lookup_elem(&map, &key)  bpf(BPF_MAP_LOOKUP_ELEM, ...)
bpf_map_update_elem(&map, &key, &val, BPF_ANY)
bpf_map_delete_elem(&map, &key)  bpf(BPF_MAP_DELETE_ELEM, ...)
```

## Creating a map

```c
/* From BPF program (using libbpf macros) */
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 10000);
    __type(key, u32);         /* key type (for BTF-aware tools) */
    __type(value, u64);       /* value type */
} counts SEC(".maps");

/* From userspace directly */
union bpf_attr attr = {
    .map_type    = BPF_MAP_TYPE_HASH,
    .key_size    = sizeof(u32),
    .value_size  = sizeof(u64),
    .max_entries = 10000,
};
int map_fd = bpf(BPF_MAP_CREATE, &attr, sizeof(attr));
```

## Map types

### BPF_MAP_TYPE_HASH

Generic hash map with arbitrary key/value sizes.

```c
/* BPF side */
u32 pid = bpf_get_current_pid_tgid() >> 32;
u64 *count = bpf_map_lookup_elem(&counts, &pid);
if (count) {
    (*count)++;
} else {
    u64 init = 1;
    bpf_map_update_elem(&counts, &pid, &init, BPF_NOEXIST);
}
```

Update flags:
- `BPF_ANY` — create or update
- `BPF_NOEXIST` — create only (fail if key exists)
- `BPF_EXIST` — update only (fail if key doesn't exist)

Internals: uses a lock-based hash table, `htab_elem` per entry. Supports concurrent access from multiple CPUs.

### BPF_MAP_TYPE_ARRAY

Fixed-size array indexed by u32. Pre-allocated, no dynamic memory during runtime. Value must be zeroed (no deletion).

```c
/* Good for per-event counters indexed by small integers */
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 256);    /* index 0..255 */
    __type(key, u32);
    __type(value, u64);
} hist SEC(".maps");

u32 slot = /* compute histogram bucket */;
u64 *val = bpf_map_lookup_elem(&hist, &slot);
if (val)
    __sync_fetch_and_add(val, 1);  /* atomic increment */
```

### BPF_MAP_TYPE_PERCPU_HASH / BPF_MAP_TYPE_PERCPU_ARRAY

One value per CPU — eliminates atomic operations for per-CPU counters:

```c
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, u32);
    __type(value, u64);
} bytes_total SEC(".maps");

u32 key = 0;
u64 *val = bpf_map_lookup_elem(&bytes_total, &key);
if (val)
    *val += skb->len;  /* no atomic needed — this CPU only */
```

Userspace reads all CPU values and sums them:
```c
/* Userspace: reads nr_cpus values */
u64 values[nr_cpus];
bpf_map_lookup_elem(map_fd, &key, values);
u64 total = 0;
for (int i = 0; i < nr_cpus; i++)
    total += values[i];
```

### BPF_MAP_TYPE_RINGBUF

The preferred mechanism for sending variable-length events from BPF to userspace (replaces perf_event_output for most use cases).

```c
struct event {
    u32 pid;
    u32 uid;
    char comm[16];
    u32 syscall_nr;
};

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 24);  /* 16 MB ring buffer */
} events SEC(".maps");

/* BPF side: reserve → fill → submit */
SEC("tracepoint/syscalls/sys_enter_execve")
int trace_execve(struct trace_event_raw_sys_enter *ctx)
{
    struct event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
    if (!e)
        return 0;  /* ring full, drop */

    e->pid = bpf_get_current_pid_tgid() >> 32;
    e->uid = bpf_get_current_uid_gid();
    bpf_get_current_comm(e->comm, sizeof(e->comm));
    e->syscall_nr = ctx->id;

    bpf_ringbuf_submit(e, 0);  /* 0 = no BPF_RB_* flags */
    return 0;
}
```

```c
/* Userspace: poll with epoll */
struct ring_buffer *rb = ring_buffer__new(map_fd, handle_event, NULL, NULL);

while (true) {
    ring_buffer__poll(rb, 100 /* timeout ms */);
}

static int handle_event(void *ctx, void *data, size_t size)
{
    struct event *e = data;
    printf("pid=%u comm=%s syscall=%u\n", e->pid, e->comm, e->syscall_nr);
    return 0;
}
```

Why ringbuf over perf_event output:
- Single shared ring across all CPUs (no per-CPU waste)
- Events are ordered within the ring
- No copy — userspace reads directly from the ring memory
- Variable-size entries

### BPF_MAP_TYPE_LRU_HASH

Hash map with LRU eviction when full. Useful for tracking connections without explicit cleanup:

```c
struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 100000);
    __type(key, struct flow_key);
    __type(value, struct flow_stats);
} flows SEC(".maps");
/* Automatically evicts least recently used entries */
```

### BPF_MAP_TYPE_PROG_ARRAY

Array of BPF program file descriptors for tail calls. Enables program chaining without growing the stack:

```c
struct {
    __uint(type, BPF_MAP_TYPE_PROG_ARRAY);
    __uint(max_entries, 10);
    __uint(key_size, sizeof(u32));
    __uint(value_size, sizeof(u32));  /* prog fds */
} jump_table SEC(".maps");

/* Tail call: jumps to prog[index], never returns */
u32 index = 3;
bpf_tail_call(ctx, &jump_table, index);
/* If tail call succeeds, code below never runs */
/* If prog[3] is empty, execution continues here */
```

Tail calls don't increase the call stack depth. They replace the current program. Max chain length: 33.

### BPF_MAP_TYPE_HASH_OF_MAPS / BPF_MAP_TYPE_ARRAY_OF_MAPS

Map-in-map: values are other map file descriptors. Useful for per-CPU or per-namespace map isolation:

```c
/* Outer map: key=netns inode, value=inner map fd */
struct {
    __uint(type, BPF_MAP_TYPE_HASH_OF_MAPS);
    __uint(max_entries, 1000);
    __type(key, u32);
    __uint(value_size, sizeof(u32));  /* inner map fd */
    __array(values, struct inner_map_type);
} per_netns_stats SEC(".maps");
```

### BPF_MAP_TYPE_SOCKMAP / BPF_MAP_TYPE_SOCKHASH

Stores references to sockets. Used for socket redirection in the sk_msg and sk_skb program types:

```c
/* Redirect between sockets without kernel copies */
bpf_msg_redirect_map(msg, &sock_map, key, 0);
```

## Map operations summary

| Operation | BPF helper | Userspace syscall |
|-----------|-----------|-------------------|
| Lookup | `bpf_map_lookup_elem` | `BPF_MAP_LOOKUP_ELEM` |
| Update | `bpf_map_update_elem` | `BPF_MAP_UPDATE_ELEM` |
| Delete | `bpf_map_delete_elem` | `BPF_MAP_DELETE_ELEM` |
| Iterate | — (not from BPF) | `BPF_MAP_GET_NEXT_KEY` |
| Batch ops | — | `BPF_MAP_LOOKUP_BATCH` |

## Map pinning (persistence)

By default, a map lives as long as its file descriptor is open. Pin it to `/sys/fs/bpf/` to make it survive process exit:

```bash
# Pin via bpftool
bpftool map pin id 42 /sys/fs/bpf/my_map

# Access from another process
bpftool map dump pinned /sys/fs/bpf/my_map
```

```c
/* Pin from userspace code */
bpf(BPF_OBJ_PIN, &(union bpf_attr){
    .pathname = (uint64_t)"/sys/fs/bpf/my_map",
    .bpf_fd   = map_fd,
}, sizeof(union bpf_attr));

/* Retrieve later */
int map_fd = bpf(BPF_OBJ_GET, &(union bpf_attr){
    .pathname = (uint64_t)"/sys/fs/bpf/my_map",
}, sizeof(union bpf_attr));
```

## Map limits and memory

```bash
# Check map memory usage
bpftool map list
# 3: hash  name counts  flags 0x0
#    key 4B  value 8B  max_entries 10000  memlock 819200B

# Total BPF memory
cat /proc/meminfo | grep Bpf

# Per-process BPF memory limit (ulimit)
ulimit -l  # RLIMIT_MEMLOCK
# Root is unlimited; unprivileged users limited
```

Memory accounting: maps are charged to `memlock` rlimit of the creating process (unless `BPF_F_MMAPABLE` or newer accounting).

## Atomic operations in maps

For per-CPU-free atomic updates in hash/array maps:

```c
/* Atomic add (BPF built-in) */
u64 *count = bpf_map_lookup_elem(&map, &key);
if (count)
    __sync_fetch_and_add(count, 1);

/* BPF atomic instructions (since kernel 5.12) */
u64 *val = bpf_map_lookup_elem(&map, &key);
if (val)
    __atomic_add_fetch(val, 1, __ATOMIC_RELAXED);
```

For high-frequency counters, prefer `BPF_MAP_TYPE_PERCPU_ARRAY` to avoid atomics entirely.

## Further reading

- [BPF Verifier](bpf-verifier.md) — How map access is safety-checked
- [libbpf and Skeletons](libbpf.md) — Convenient map access from userspace
- `kernel/bpf/hashtab.c` — hash map implementation
- `kernel/bpf/ringbuf.c` — ring buffer implementation
