# What Happens During exec()

> From execve() syscall to a running new process

## Overview

`execve()` replaces the current process image with a new one. The PID stays the same, but the address space, file descriptors (non-`O_CLOEXEC`), and registers are replaced:

```
execve("./myprogram", argv, envp)
   │
   ├─ syscall entry → do_execveat_common()
   ├─ bprm allocation (struct linux_binprm)
   ├─ bprm_init: open + read file header
   ├─ search_binary_handler: find ELF/script handler
   ├─ load_elf_binary:
   │     ├─ parse ELF headers, validate
   │     ├─ flush old address space (exec_mmap)
   │     ├─ map PT_LOAD segments → VMAs
   │     ├─ map interpreter (ld.so) → VMAs
   │     ├─ setup stack (argv, envp, auxv)
   │     └─ set entry point: interpreter start or ELF e_entry
   └─ start_thread: set IP = entry, SP = stack top
```

## The linux_binprm structure

```c
/* include/linux/binfmts.h */
struct linux_binprm {
    struct vm_area_struct *vma;
    unsigned long         vma_pages;
    struct mm_struct *mm;

    /* argv[0] path, used for /proc/PID/exe */
    const char *filename;
    const char *interp;

    /* The first BINPRM_BUF_SIZE bytes of the file */
    char buf[BINPRM_BUF_SIZE];  /* 256 bytes */

    struct file *file;
    struct cred *cred;          /* proposed new credentials */

    int argc, envc;

    /* Address of the top of the stack in the new mm */
    unsigned long p;

    /* argv[] and envp[] are stored on the stack above p */
    unsigned long argmin;

    /* ELF-specific: executable type flags */
    unsigned int per_flags;
    unsigned int unsafe;
};
```

## Step 1: syscall entry

```c
/* fs/exec.c */
SYSCALL_DEFINE3(execve,
    const char __user *, filename,
    const char __user *const __user *, argv,
    const char __user *const __user *, envp)
{
    return do_execve(getname(filename), argv, envp);
}

static int do_execveat_common(int fd, struct filename *filename,
                               struct user_arg_ptr argv,
                               struct user_arg_ptr envp,
                               int flags)
{
    struct linux_binprm *bprm;

    bprm = alloc_bprm(fd, filename, flags);

    /* Copy argv/envp strings to bprm (checked for length limits) */
    retval = copy_strings_kernel(1, &bprm->filename, bprm);
    retval = copy_strings(bprm->envc, envp, bprm);
    retval = copy_strings(bprm->argc, argv, bprm);

    /* Read the first 256 bytes of the file (magic number check) */
    retval = bprm_execve(bprm, fd, filename, flags);
}
```

## Step 2: binary format detection

```c
/* fs/exec.c */
static int search_binary_handler(struct linux_binprm *bprm)
{
    /* Walk list of registered binary handlers */
    list_for_each_entry(fmt, &formats, lh) {
        retval = fmt->load_binary(bprm);
        if (retval != -ENOEXEC)
            break;
    }
}

/* Registered handlers (in order): */
/* 1. ELF:     fs/binfmt_elf.c    — matches "\x7fELF" */
/* 2. Scripts: fs/binfmt_script.c — matches "#!"       */
/* 3. Misc:    fs/binfmt_misc.c   — user-defined rules */
/* 4. Flat:    fs/binfmt_flat.c   — uClinux flat binaries */
```

For `#!/bin/sh` scripts, `binfmt_script` re-invokes `search_binary_handler` with `/bin/sh` as the new executable.

## Step 3: ELF loading

```c
/* fs/binfmt_elf.c */
static int load_elf_binary(struct linux_binprm *bprm)
{
    struct elf_phdr *elf_phdata;
    struct elf_ehdr *elf_ex = (struct elf_ehdr *)bprm->buf;

    /* 1. Validate ELF magic and architecture */
    if (memcmp(elf_ex->e_ident, ELFMAG, SELFMAG) != 0)
        return -ENOEXEC;

    /* 2. Read all program headers */
    elf_phdata = load_elf_phdrs(elf_ex, bprm->file);

    /* 3. Find the interpreter (PT_INTERP = dynamic linker path) */
    for (i = 0; i < elf_ex->e_phnum; i++) {
        if (elf_phdata[i].p_type == PT_INTERP) {
            /* Read "/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2" */
            elf_interpreter = kmalloc(elf_phdata[i].p_filesz, GFP_KERNEL);
            kernel_read(bprm->file, elf_interpreter, ...);
        }
    }

    /* 4. Flush old address space, create new mm */
    retval = begin_new_exec(bprm);
    /* → exec_mmap: replace current mm with fresh mm_struct */
    /* → close O_CLOEXEC fds */
    /* → reset signal handlers */

    /* 5. Map PT_LOAD segments */
    for each PT_LOAD segment {
        elf_map(bprm->file, load_addr + vaddr,
                eppnt, elf_prot, elf_flags, total_size);
        /* Creates a VMA for each segment:
             .text: PROT_READ|EXEC, MAP_PRIVATE|FIXED
             .data: PROT_READ|WRITE, MAP_PRIVATE|FIXED  */
    }

    /* 6. Load the interpreter (ld.so) at a random address */
    if (elf_interpreter) {
        interp_load_addr = load_elf_interp(&interp_elf_ex, interpreter);
        elf_entry = interp_load_addr + interp_elf_ex.e_entry;
        /* Process starts at ld.so, not at e_entry of the binary */
    } else {
        elf_entry = elf_ex->e_entry;  /* statically linked */
    }

    /* 7. Set up the stack */
    retval = setup_arg_pages(bprm, randomize_stack_top(STACK_TOP),
                              executable_stack);
    /* Creates the stack VMA: PROT_READ|WRITE, grows down */

    /* 8. Create [vvar] and [vdso] mappings */
    arch_setup_additional_pages(bprm, !!elf_interpreter);

    /* 9. Push auxiliary vector onto stack */
    /* auxv entries: AT_PHDR, AT_PHNUM, AT_ENTRY, AT_BASE,
                     AT_PAGESZ, AT_RANDOM, AT_PLATFORM, ... */

    /* 10. Start the new binary */
    start_thread(regs, elf_entry, bprm->p);
    /* Sets IP=elf_entry, SP=bprm->p (stack top with argv/envp/auxv) */
}
```

## The resulting address space

After exec completes, `/proc/<pid>/maps` shows:

```
Address           Perms  Name
00400000-00401000 r--p   /usr/bin/myprogram    [ELF .text]
00401000-00402000 r-xp   /usr/bin/myprogram    [ELF .text]
00402000-00403000 r--p   /usr/bin/myprogram    [ELF .rodata]
00403000-00404000 r--p   /usr/bin/myprogram    [.data start]
00404000-00405000 rw-p   /usr/bin/myprogram    [ELF .data/.bss]
7f1234560000-...  r--p   /lib/.../ld-linux.so  [ld.so segments]
7f1234590000-...  r-xp   /lib/.../ld-linux.so
7ffcc1234000-...  rw-p   [stack]
7ffcc1400000-...  r--p   [vvar]
7ffcc1401000-...  r-xp   [vdso]
```

## Dynamic linker startup

The kernel jumps to `ld.so`'s entry point, not the main binary's. `ld.so`:
1. Maps itself (it's position-independent)
2. Reads the binary's `PT_DYNAMIC` segment to find shared library dependencies
3. Loads each `.so` via `mmap()` (creating new VMAs)
4. Resolves PLT/GOT relocations (symbol addresses)
5. Calls `DT_INIT` constructors (e.g., `__attribute__((constructor))` functions)
6. Jumps to the main binary's `e_entry` (the `_start` symbol)

```c
/* ld.so loads libraries into the process address space */
/* After ld.so finishes: */
00400000-...  r-xp   /usr/bin/myprogram
7f0000000000-...  r-xp   /lib/x86_64-linux-gnu/libc.so.6
7f0001000000-...  r-xp   /lib/x86_64-linux-gnu/libm.so.6
/* Each shared library gets its own set of VMAs */
```

## begin_new_exec: the point of no return

```c
/* fs/exec.c */
int begin_new_exec(struct linux_binprm *bprm)
{
    struct task_struct *me = current;

    /* Create a new mm_struct (blank address space) */
    retval = exec_mmap(bprm->mm);
    /* This replaces current->mm — old mappings gone! */

    /* Close O_CLOEXEC file descriptors */
    do_close_on_exec(current->files);

    /* Reset signal handlers to SIG_DFL */
    flush_signal_handlers(me, 0);

    /* Drop capabilities acquired via set-uid */
    /* Update credentials if set-uid/set-gid binary */
    retval = install_exec_creds(bprm);

    /* Change process name (/proc/PID/comm) */
    __set_task_comm(me, kbasename(bprm->filename), true);

    return 0;
}
```

## exec and threads

If the calling process has multiple threads, `execve` kills all other threads before replacing the address space:

```c
/* fs/exec.c */
static int de_thread(struct task_struct *tsk)
{
    struct signal_struct *sig = tsk->signal;
    struct sighand_struct *oldsighand = tsk->sighand;

    /* Unshare the thread group */
    /* Signal all other threads to exit */
    zap_other_threads(tsk);

    /* Wait for all other threads to die */
    while (atomic_read(&sig->count) > 1)
        schedule_timeout(1);
}
```

## Observing exec

```bash
# Trace exec syscalls
strace -e execve /bin/ls

# Trace all execs system-wide
bpftrace -e 'tracepoint:syscalls:sys_enter_execve { printf("%s exec %s\n", comm, str(args->filename)); }'

# See ELF segments
readelf -l /usr/bin/ls | grep -A1 LOAD

# See dynamic linker loading
LD_DEBUG=all /usr/bin/ls 2>&1 | head -50

# See full address space after exec
cat /proc/$(pgrep myprogram)/maps
```

## Further reading

- [What Happens When You fork()](fork.md) — fork creates the starting mm
- [Process Address Space](mmap.md) — VMA layout
- [Life of a malloc](life-of-malloc.md) — heap after exec
- [Copy-on-Write](cow.md) — ELF data segments use COW
- `fs/exec.c` — execve implementation
- `fs/binfmt_elf.c` — ELF loader
