# BTF and CO-RE

> Writing BPF programs that run across different kernel versions

## The problem BTF solves

Kernel data structures change between versions. A BPF program compiled against kernel 5.15 might access `struct task_struct` at the wrong offsets on kernel 6.1 if the struct was reorganized.

Before BTF/CO-RE, BPF programs were compiled with kernel headers from a specific version and only ran on that version (or required recompilation per kernel).

**CO-RE** (Compile Once, Run Everywhere), developed by Andrii Nakryiko, lets you compile a BPF program once and have it work on any kernel version ≥ 5.8 that has BTF.

## BTF: BPF Type Format

BTF is a compact type information format stored in a special ELF section (`.BTF`) and loaded into the kernel alongside BPF programs. It was introduced in Linux 4.18 by Martin KaFai Lau. [(commit)](https://git.kernel.org/linus/69b693f0aefad82d714c6e76c4b5b3b54c0aaed1)

```bash
# Check if kernel has BTF
ls /sys/kernel/btf/vmlinux
# If present, the kernel exposes its full type information

# Generate vmlinux.h (all kernel types as C headers)
bpftool btf dump file /sys/kernel/btf/vmlinux format c > vmlinux.h
```

### BTF type encoding

```c
/* BTF represents types as a sequence of type descriptors */
struct btf_type {
    __u32 name_off;    /* offset in string table */
    /* info encoding:
     * bits 0-15:  vlen (number of struct members, etc.)
     * bits 16-23: unused
     * bits 24-28: kind (BTF_KIND_INT, STRUCT, ARRAY, FUNC, ...)
     * bit 31:     kind_flag
     */
    __u32 info;
    union {
        __u32 size;   /* for INT, STRUCT, UNION: size in bytes */
        __u32 type;   /* for PTR, TYPEDEF, VOLATILE: referred type id */
    };
};

/* struct member follows btf_type for STRUCT/UNION */
struct btf_member {
    __u32 name_off;  /* offset in string table */
    __u32 type;      /* type id of this member */
    __u32 offset;    /* bit offset (or bit field spec) */
};
```

The kernel loads BTF via `BTF_LOAD` bpf() command and uses it:
- For the verifier: to understand pointed-to struct layouts
- For CO-RE relocation: to patch field offsets at program load time
- For bpftool/libbpf: to pretty-print map values and program contexts
- For BPF iterators and kfuncs: function signatures

## vmlinux.h: all kernel types in one header

Instead of including individual kernel headers, CO-RE programs typically use a generated `vmlinux.h`:

```bash
bpftool btf dump file /sys/kernel/btf/vmlinux format c > vmlinux.h
```

This single header contains every struct, union, enum, and typedef in the running kernel — extracted from BTF.

```c
/* In your BPF program, instead of: */
#include <linux/sched.h>
#include <linux/fs.h>
#include <linux/mm_types.h>

/* You write: */
#include "vmlinux.h"         /* all kernel types, from BTF */
#include <bpf/bpf_helpers.h> /* BPF helper declarations */
#include <bpf/bpf_core_read.h> /* CO-RE macros */
```

## CO-RE field access

The key CO-RE mechanism is `BPF_CORE_READ`, which records relocations that libbpf patches at load time:

```c
#include "vmlinux.h"
#include <bpf/bpf_core_read.h>

SEC("kprobe/do_sys_open")
int trace_open(struct pt_regs *ctx)
{
    struct task_struct *task = (struct task_struct *)bpf_get_current_task();

    /* WITHOUT CO-RE: fixed offset, breaks across kernel versions */
    pid_t pid = *(pid_t *)((char *)task + offsetof(struct task_struct, pid));

    /* WITH CO-RE: offset resolved at load time from BTF */
    pid_t pid = BPF_CORE_READ(task, pid);

    /* Nested field access */
    u32 ns_inum = BPF_CORE_READ(task, nsproxy, pid_ns_for_children, ns.inum);

    bpf_printk("open by pid=%d ns=%u\n", pid, ns_inum);
    return 0;
}
```

`BPF_CORE_READ(ptr, field)` expands to a safe read with relocation metadata embedded in the BPF bytecode as special instructions. When libbpf loads the program, it:
1. Reads the target kernel's BTF from `/sys/kernel/btf/vmlinux`
2. Looks up the actual offset of `task_struct.pid` in that kernel
3. Patches the instruction with the correct offset

### CO-RE read variants

```c
/* Basic read */
BPF_CORE_READ(ptr, field)

/* Read into a variable */
BPF_CORE_READ_INTO(&dest, ptr, field)

/* Bitfield read (handles bitfield packing differences) */
BPF_CORE_READ_BITFIELD(ptr, field)
BPF_CORE_READ_BITFIELD_PROBED(ptr, field)

/* String read */
BPF_CORE_READ_STR_INTO(dest, ptr, field)

/* Check if a field exists in the target kernel */
bpf_core_field_exists(ptr->field)   /* returns 0 or 1 */
bpf_core_type_exists(struct foo)

/* Check field size (handles changed types) */
bpf_core_field_size(ptr->field)
```

### CO-RE for enum values

Enum values can also change between kernels. CO-RE handles this:

```c
/* Check if kernel uses a renamed enum value */
u32 state;
if (bpf_core_enum_value_exists(enum task_state, TASK_DEAD))
    state = BPF_CORE_READ(task, state);
else
    state = BPF_CORE_READ(task, __state);  /* renamed in 5.14 */
```

## Kernel version checks at load time

For features that were added or removed:

```c
/* Conditional compilation based on kernel version */
extern int LINUX_KERNEL_VERSION __kconfig;

SEC("kprobe/...")
int my_prog(struct pt_regs *ctx)
{
    if (LINUX_KERNEL_VERSION >= KERNEL_VERSION(5, 16, 0)) {
        /* Use newer field or API */
    } else {
        /* Fallback for older kernels */
    }
}
```

The `extern ... __kconfig` syntax reads values from `/proc/config.gz` or `Kconfig` symbols, also resolved by libbpf at load time.

## BTF-based tracing: fentry/fexit

BTF enables a more efficient alternative to kprobes — `fentry` and `fexit` programs:

```c
/* fentry: no function arguments rewriting needed,
   BTF provides the type info directly */
SEC("fentry/tcp_sendmsg")
int BPF_PROG(trace_tcp_sendmsg,
             struct sock *sk,      /* BTF tells us: arg 1 is sock* */
             struct msghdr *msg,   /* arg 2 is msghdr* */
             size_t size)          /* arg 3 is size_t */
{
    u32 pid = bpf_get_current_pid_tgid() >> 32;
    u64 bytes = BPF_CORE_READ(sk, sk_sndbuf);
    bpf_printk("tcp_sendmsg: pid=%u sndbuf=%llu size=%zu\n",
               pid, bytes, size);
    return 0;
}

/* fexit: also gets return value */
SEC("fexit/tcp_sendmsg")
int BPF_PROG(trace_tcp_sendmsg_ret,
             struct sock *sk, struct msghdr *msg, size_t size,
             int ret)   /* return value appended as last arg */
{
    if (ret < 0)
        bpf_printk("tcp_sendmsg failed: %d\n", ret);
    return 0;
}
```

`fentry`/`fexit` use trampolines — direct calls into the BPF JIT code — and are 10–100x lower overhead than kprobes.

## BTF in maps: typed map values

With BTF, map values can be self-describing:

```c
struct event {
    u32 pid;
    u32 uid;
    char comm[16];
} __attribute__((preserve_access_index));  /* enable CO-RE for this struct */

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 24);
} events SEC(".maps");
```

With BTF attached to the map:
```bash
# bpftool can pretty-print map values using BTF
bpftool map dump id 42
# [{
#     "pid": 1234,
#     "uid": 0,
#     "comm": "bash"
# }]
```

## Observing BTF

```bash
# List all BTF objects loaded in the kernel
bpftool btf list
# 1: name [vmlinux]  size 5.5MB
# 42: name [bpf_prog] size 1.2KB

# Dump type information
bpftool btf dump id 1 format raw | grep -A5 "task_struct"

# Show struct layout from BTF
bpftool btf dump file /sys/kernel/btf/vmlinux format c | \
    grep -A 30 "^struct task_struct {"

# Verify a BPF object's BTF
bpftool prog list
bpftool btf dump id <btf_id>
```

## Writing portable BPF programs: checklist

1. Use `vmlinux.h` instead of kernel headers
2. Use `BPF_CORE_READ()` for all kernel struct field accesses
3. Use `bpf_core_field_exists()` for fields added after 5.2
4. Use `LINUX_KERNEL_VERSION` guards for behavioral differences
5. Compile with `clang -target bpf -g` (`-g` embeds BTF in the .o)
6. Use libbpf to load (it handles CO-RE relocation)

```bash
# Compile with BTF embedded
clang -target bpf -O2 -g \
    -I/usr/include/bpf \
    -c my_prog.bpf.c -o my_prog.bpf.o

# Verify BTF is present in the object
llvm-readelf --sections my_prog.bpf.o | grep BTF
# .BTF         PROGBITS  ...
# .BTF.ext     PROGBITS  ...  (line number info for verifier)
```

## Further reading

- [libbpf and Skeletons](libbpf.md) — Using CO-RE with libbpf's load workflow
- [BPF Verifier](bpf-verifier.md) — How BTF improves verifier type checking
- `tools/lib/bpf/` in the kernel tree — libbpf source
- `Documentation/bpf/btf.rst` — BTF format specification
