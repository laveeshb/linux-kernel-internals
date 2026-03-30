# Adding a New System Call

> A complete walkthrough for kernel contributors

## When to add a new syscall

A new syscall is the right approach when:
- Exposing a new kernel capability to userspace
- The operation requires privilege or atomic semantics unavailable in userspace
- It needs access to kernel-internal state

Avoid adding syscalls for things that can be done via:
- `ioctl` on an existing device/file (for device-specific operations)
- `sysfs`/`procfs` (for configuration and observation)
- Netlink (for networking-related configuration)
- An existing syscall extension (e.g., `fcntl` with a new `cmd`)

## Step 1: Define the syscall

Use the modern struct-based pattern for new syscalls:

```c
/* Example: a hypothetical "hello" syscall in kernel/hello.c */
#include <linux/syscalls.h>
#include <linux/uaccess.h>
#include <uapi/linux/hello.h>

/**
 * sys_hello - write a greeting to a buffer
 * @uargs: pointer to struct hello_args in userspace
 * @size: size of the struct passed by userspace
 *
 * Returns 0 on success, -errno on failure.
 */
SYSCALL_DEFINE2(hello, struct hello_args __user *, uargs, size_t, size)
{
    struct hello_args args;
    char kernel_name[64];
    int ret;

    /* Validate and copy the struct */
    if (size < HELLO_ARGS_SIZE_VER0)
        return -EINVAL;
    if (copy_struct_from_user(&args, sizeof(args), uargs, size))
        return -EFAULT;

    /* Validate flags: only known flags allowed */
    if (args.flags & ~HELLO_FLAG_LOUD)
        return -EINVAL;

    /* Copy the name string from userspace */
    if (strncpy_from_user(kernel_name, u64_to_user_ptr(args.name),
                          sizeof(kernel_name)) < 0)
        return -EFAULT;
    kernel_name[sizeof(kernel_name) - 1] = '\0';

    /* Do the work */
    pr_info("Hello, %s!\n", kernel_name);
    if (args.flags & HELLO_FLAG_LOUD)
        pr_info("HELLO, %s!!!\n", kernel_name);

    return 0;
}
```

## Step 2: Define the UAPI struct

Put userspace-visible types in `include/uapi/linux/hello.h`:

```c
/* include/uapi/linux/hello.h */
#ifndef _UAPI_LINUX_HELLO_H
#define _UAPI_LINUX_HELLO_H

#include <linux/types.h>

/* Flags for hello() */
#define HELLO_FLAG_LOUD  (1 << 0)

/* Version 0 struct size */
#define HELLO_ARGS_SIZE_VER0  (sizeof(struct hello_args))

struct hello_args {
    __u32   flags;      /* HELLO_FLAG_* */
    __u32   pad;        /* explicit padding (never leave implicit gaps) */
    __u64   name;       /* pointer to name string (use __u64 for 64/32-bit compat) */
};

#endif /* _UAPI_LINUX_HELLO_H */
```

Key rules for UAPI structs:
- Use `__u8`, `__u16`, `__u32`, `__u64` (not `int`, `long`, etc.)
- Add explicit padding (`__u32 pad`) for alignment — never rely on implicit struct holes
- Use `__u64` for pointer-sized fields (enables compat with 32-bit userspace)
- The struct is an ABI — once merged it cannot be changed incompatibly

## Step 3: Add to the syscall table

### For x86-64: `arch/x86/entry/syscalls/syscall_64.tbl`

```
# Append at the end (after the highest existing number)
451     common  hello           sys_hello
```

### For generic architectures: `include/uapi/asm-generic/unistd.h`

```c
#define __NR_hello 451
__SYSCALL(__NR_hello, sys_hello)
#undef __NR_syscalls
#define __NR_syscalls 452
```

### For ARM64: `arch/arm64/include/asm/unistd.h`

ARM64 uses the generic table, so `include/uapi/asm-generic/unistd.h` covers it.

### For 32-bit compat

If the syscall takes a struct with pointers (stored as `__u64`), it already works correctly for 32-bit processes — no compat version needed. If it uses architecture-specific types, add a compat version:

```c
/* Only if needed (most modern syscalls don't need this) */
#ifdef CONFIG_COMPAT
COMPAT_SYSCALL_DEFINE2(hello, compat_uptr_t, uargs, compat_size_t, size)
{
    /* handle 32-bit callers */
}
#endif
```

## Step 4: Add the kernel header

```c
/* include/linux/hello.h */
#ifndef _LINUX_HELLO_H
#define _LINUX_HELLO_H

#include <uapi/linux/hello.h>

/* kernel-internal declarations (not exported to userspace) */
long ksys_hello(struct hello_args __user *uargs, size_t size);

#endif
```

## Step 5: Wire it up in the build

Add to the appropriate `Makefile`:

```makefile
# kernel/Makefile
obj-y += hello.o
```

Or add it to an existing file if it's small enough.

## Step 6: Add a man page stub

```
man2/hello.2  ← syscall man pages live in section 2
```

The man-pages project (not in the kernel tree) documents syscalls. Submit a patch there too.

## Step 7: Write a selftest

```c
/* tools/testing/selftests/hello/hello_test.c */
#include <sys/syscall.h>
#include <unistd.h>
#include <stdio.h>
#include <assert.h>

#ifndef __NR_hello
#define __NR_hello 451
#endif

#include <linux/hello.h>

int main(void)
{
    struct hello_args args = {
        .flags = 0,
        .pad   = 0,
        .name  = (unsigned long)"world",
    };

    long ret = syscall(__NR_hello, &args, sizeof(args));
    assert(ret == 0);

    /* Test: unknown flag should fail */
    args.flags = 0xdeadbeef;
    ret = syscall(__NR_hello, &args, sizeof(args));
    assert(ret == -1 && errno == EINVAL);

    /* Test: NULL pointer should fail */
    args.flags = 0;
    args.name = 0;
    ret = syscall(__NR_hello, &args, sizeof(args));
    assert(ret == -1 && errno == EFAULT);

    printf("All tests passed\n");
    return 0;
}
```

```makefile
# tools/testing/selftests/hello/Makefile
TEST_GEN_PROGS := hello_test
include ../lib.mk
```

## Common mistakes

### Forgetting to validate struct size

```c
/* WRONG: assumes struct is exactly this size */
if (copy_from_user(&args, uargs, sizeof(args)))

/* RIGHT: use copy_struct_from_user for versioned structs */
if (copy_struct_from_user(&args, sizeof(args), uargs, size))
```

### Leaving implicit padding in structs

```c
/* WRONG: compiler adds 4 bytes of padding after flags */
struct bad_args {
    __u32 flags;
    __u64 ptr;   /* 8-byte alignment requires 4 bytes padding before this */
};

/* RIGHT: explicit padding, no surprises */
struct good_args {
    __u32 flags;
    __u32 pad;   /* explicit padding */
    __u64 ptr;
};
```

### Using kernel types in UAPI

```c
/* WRONG: size_t is 4 or 8 bytes depending on arch */
struct bad {
    size_t size;
};

/* RIGHT: explicitly sized */
struct good {
    __u64 size;
};
```

### Directly dereferencing userspace pointers

```c
/* WRONG: UB + security vulnerability */
int result = *(int *)uargs->ptr;

/* RIGHT: use copy_from_user or get_user */
int value;
if (get_user(value, (int __user *)uargs->ptr))
    return -EFAULT;
```

### Missing capability check

```c
/* If the syscall requires privilege: */
if (!capable(CAP_SYS_ADMIN))
    return -EPERM;

/* For namespace-scoped privilege: */
if (!ns_capable(current_user_ns(), CAP_SYS_ADMIN))
    return -EPERM;
```

## Testing without merging

```bash
# Build the kernel with your changes
make -j$(nproc) LOCALVERSION="-test"

# Install in a VM
make INSTALL_MOD_PATH=/tmp/modules modules_install
make INSTALL_PATH=/boot install

# Test with the selftest
cd tools/testing/selftests/hello
make
sudo ./run_kselftest.sh
```

## The review process

Expect these questions from reviewers:
1. **Why a new syscall?** Can't this be done with ioctl/sysfs/etc.?
2. **ABI review**: Is the struct future-proof? Does it have explicit padding?
3. **Security**: Are all pointers validated? Can a malicious value cause harm?
4. **Error handling**: All paths return meaningful errno?
5. **Compat**: Does it work for 32-bit processes on 64-bit kernels?
6. **Documentation**: man page? kernel-doc comments?
7. **Tests**: selftests included?

## Further reading

- [Syscall Entry Path](syscall-entry.md) — How the new syscall gets called
- [SYSCALL_DEFINE and dispatch](syscall-define.md) — The dispatch mechanism
- `Documentation/process/adding-syscalls.rst` — The authoritative kernel guide
- `man 2 syscall` — Low-level syscall invocation from C
