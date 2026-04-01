# Kernel Core War Stories

> Real incidents: init ordering, boot parameter bugs, panic loops, and more

The kernel core infrastructure — initcalls, boot parameters, `__init` sections, panic/kdump, module loading — is mature and well-tested. But the interaction between these mechanisms and real-world drivers, configurations, and deployment assumptions produces bugs that are genuinely hard to diagnose. The failures tend to be silent, delayed, or self-concealing.

This page presents five incidents drawn from real patterns in kernel development history. The bug patterns are real; they appear repeatedly across different drivers and distributions over time. Each illustrates a fundamental property of how the kernel core works — and what happens when code makes the wrong assumption about it.

---

## Case 1: initcall ordering bug breaking the network stack

### The problem

A team was integrating a new Ethernet driver into their embedded product. The driver registered a netdev and immediately called into the network core to set up some statistics infrastructure during its initialization function. On their development kernel the driver worked fine. On the production kernel — built with a slightly different Kconfig — the system hung at boot with a NULL pointer dereference in `net_device_ops`.

The oops appeared during the `calling ... returned ...` initcall debug output, partway through the `core_initcall` level, before any `device_initcall` drivers had run.

### Diagnosis

With `initcall_debug` enabled on the production kernel, the oops trace looked like this:

```
calling  mydriver_core_init+0x0/0x68 @ 1
BUG: unable to handle kernel NULL pointer dereference at 0000000000000018
RIP: mydriver_net_stats_init+0x34/0x90
Call Trace:
 mydriver_core_init+0x58/0x68
 do_one_initcall+0x58/0x190
```

The driver's init function was calling `mydriver_net_stats_init()`, which called into the network subsystem. But the oops showed the driver was running at `core_initcall` level (level 2). The networking core initializes at `subsys_initcall` level (level 5) via `net_dev_init()` in `net/core/dev.c`.

Level 2 runs before level 5. The network subsystem's internal state — in particular the per-CPU softnet_data structures — had not been allocated yet. The driver was reaching into uninitialized memory.

### Root cause

The driver's registration macro read:

```c
/* WRONG: runs before networking is ready */
core_initcall(mydriver_core_init);
```

It had been written as `core_initcall` because the developer confused "core" to mean "this is a core part of our system" rather than "this runs at initcall level 2, before subsystems like networking."

### Fix

```c
/* CORRECT: runs at level 8, after all subsystem init */
module_init(mydriver_core_init);
/* or equivalently: device_initcall(mydriver_core_init); */
```

Moving to `device_initcall` (or equivalently `module_init`) places the driver at initcall level 8, after `subsys_initcall` level 5 where `net_dev_init()` runs. The initialization succeeded immediately.

### Lesson

The initcall level names are not descriptive of what *your* code is — they describe when your code runs relative to other things. Most drivers belong at `device_initcall` (`module_init`). Use an earlier level only when you have an explicit reason to run before a specific subsystem, and verify that every subsystem you call into initializes at an earlier level. The `initcall_debug` boot parameter makes this visible at runtime.

---

## Case 2: "Freeing init memory" crash due to `__init` section misuse

### The problem

A storage driver had worked correctly for several kernel versions. After a refactoring pass, a field engineer reported that systems loaded with the driver would oops approximately 30 minutes after boot — specifically whenever the driver processed a certain type of I/O request under memory pressure. The oops showed:

```
BUG: Bad page state in process kworker/u8:2 pfn:12a4b0
page:ffffea0004a92c00 refcount:0 mapcount:0 mapping:0000000000000000
flags: 0x200000000(reserved)
...
Call Trace:
 free_pages_prepare+0x1a4/0x2b0
 __free_pages_ok+0x29/0xd0
 my_driver_handle_io+0x7c/0x1a0
```

`Bad page state` with `flags: reserved` is a signature of accessing memory that has been freed by `free_initmem()`.

### Diagnosis

The `reserved` flag is set on pages that belong to the init sections. After `free_initmem()` runs, these pages are returned to the allocator and the `reserved` flag is cleared. A "Bad page state" oops on a reserved-flagged page means code was holding a pointer into init memory and tried to use it after those pages had been freed and reallocated.

Searching the driver for anything stored during init and used later, the offending pattern emerged:

```c
/* In the driver header: */
struct my_driver_ops {
    int (*handle_compressed)(struct request *rq, const u8 *buf, size_t len);
    /* ... */
};

/* In the driver: */
static struct my_driver_ops global_ops;

static int __init decompress_init_helper(struct request *rq,
                                          const u8 *buf, size_t len)
{
    /* used only during init to process compressed firmware */
    return decompress_and_store(rq, buf, len);
}

static int __init mydriver_init(void)
{
    global_ops.handle_compressed = decompress_init_helper; /* BUG */
    /* ... */
    return 0;
}

/* Later, at runtime: */
static void my_driver_handle_io(struct request *rq)
{
    if (rq->flags & MY_COMPRESSED)
        global_ops.handle_compressed(rq, rq->data, rq->len); /* oops */
}
```

`decompress_init_helper` was marked `__init`, placing it in `.init.text`. The function pointer was stored in `global_ops`, which lives in `.data` (not freed). After `free_initmem()` ran, the init text pages were returned to the allocator. Eventually one was reallocated for something else. When `handle_compressed` was called under memory pressure (triggering a code path that hadn't been exercised before), the function pointer pointed to a page that was now being used as a slab object. Calling it as a function produced the bad page state oops.

The bug was latent for the entire uptime and only triggered when certain requests arrived — making it look unrelated to the refactoring.

### Root cause

The refactoring had moved `decompress_init_helper` to a new file and a developer added `__init` to it, reasoning that it was "only used during initialization." This is true for the case of processing compressed firmware at probe time, but the function pointer was stored for potential later use.

### Fix

Remove `__init` from any function whose pointer might be stored and called after boot:

```c
/* CORRECT: no __init annotation, stays in .text permanently */
static int decompress_init_helper(struct request *rq,
                                   const u8 *buf, size_t len)
{
    return decompress_and_store(rq, buf, len);
}
```

Alternatively, if the function truly is only needed during init, do not store its pointer anywhere that persists past the init phase. Use the pointer immediately and set it to NULL afterward — but this is fragile. The safe rule is: if a function pointer is stored in a data structure with `__data` lifetime, the pointed-to function must not be `__init`.

### Lesson

The `__init` annotation has a deceptively simple appearance. It is not just a hint to the compiler — it changes the physical page that contains the function, and that page is freed after boot. Any stored function pointer to `__init` code is a time bomb. KASAN will not catch this if the page gets reallocated to something other than slab memory. The cleanest detection strategy is `KASAN_VMALLOC` or manually auditing for `__init` functions whose addresses escape to non-`__initdata` storage.

---

## Case 3: panic loop — kdump not capturing the crash

### The problem

A production server began exhibiting a reboot loop. The system would come up, run for a while, panic (for an unrelated reason — a buggy NIC driver under development), and then reboot without leaving a vmcore for analysis. The operations team had set up kdump for exactly this purpose: the crash kernel was configured, the `kexec -p` was run at boot time by a systemd unit, and `/proc/vmcore` was expected to appear in the crash kernel environment. Instead the system just rebooted cleanly.

Without a vmcore, diagnosing the underlying NIC driver bug was nearly impossible.

### Diagnosis

The first clue was in the crash kernel's `dmesg`, captured via serial console. The serial console logged the crash kernel's boot sequence but it ended abruptly:

```
[    0.342819] Booting crash kernel...
[    0.344102] Linux version 5.15.0 (gcc version 11.3.0) #1 SMP
[    0.512433] Command line: root=/dev/sda1 irqpoll maxcpus=1 reset_devices
...
[    2.214891] Out of memory: Kill process 1 (makedumpfile) score 1000
[    2.214903] Killed process 1 (makedumpfile) total-vm:1048576kB, anon-rss:524288kB
[    2.215011] Kernel panic - not syncing: System is deadlocked on memory
```

The crash kernel itself was OOMing. `makedumpfile` (the tool that copies `/proc/vmcore` to disk) was being killed because it needed to read and filter the vmcore of the original kernel, which required significant memory. But the crash kernel had been allocated only 128 MB via `crashkernel=128M`.

The original kernel had 256 GB of RAM. A vmcore of a 256 GB system — even after filtering out free pages — was tens of gigabytes. `makedumpfile` needed enough memory to buffer its working set and the kernel's page table analysis structures. 128 MB was not nearly enough.

The crash kernel panicked, triggering `emergency_restart()`, and the system rebooted cleanly as if nothing had happened.

### Root cause

The `crashkernel=128M` reservation was set when the system had 16 GB of RAM and was never updated when the system was upgraded to 256 GB. The rule of thumb for `crashkernel` sizing scales with the amount of RAM in the system because:

1. The crash kernel needs enough memory to boot (kernel + initramfs + basic infrastructure): typically 64–128 MB on its own
2. `makedumpfile` needs working memory proportional to the number of pages it must analyze and filter (roughly 1 byte of metadata per page = 64 MB for 256 GB at 4KB pages)
3. Buffer space for I/O and the vmcore filtering process

Total: for a 256 GB system, `crashkernel=512M` or more is appropriate.

### Fix

```bash
# In /etc/default/grub:
GRUB_CMDLINE_LINUX="... crashkernel=512M"

# Regenerate grub config and reboot:
update-grub
reboot
```

Test the kdump configuration before relying on it in production:

```bash
# Trigger a test panic (nondestructive way to test kdump):
echo c > /proc/sysrq-trigger
# (system will panic and attempt to capture vmcore)
```

Modern distributions expose automatic sizing via `crashkernel=auto`, which the kernel computes based on system RAM. However, "auto" values are conservative minimums and may still be insufficient for systems with many loaded modules or complex memory topologies.

### Lesson

kdump is a second kernel bootstrapped from reserved memory. That reservation must be sized for the work the crash kernel will do, which scales with the RAM of the production kernel, not a fixed value. The kdump configuration must be tested — the worst time to discover it does not work is during an actual production incident. Run periodic `echo c > /proc/sysrq-trigger` tests in a maintenance window and verify that vmcore files are produced and analyzable.

---

## Case 4: boot parameter typo causing silent SMP misconfiguration

### The problem

A sysadmin managing a fleet of QEMU virtual machines added a kernel command line parameter intended to limit each VM to 4 CPUs. The parameter was added to the VM's GRUB configuration:

```
GRUB_CMDLINE_LINUX="... mxcpus=4"
```

The VMs booted without error. `dmesg` showed no warnings at a glance. Application performance monitoring showed the VMs were using more CPU than expected — a workload that should run on 4 CPUs was clearly using all 8 available. On investigation, `nproc` returned 8 and `/proc/cpuinfo` showed all 8 CPUs.

### Diagnosis

The correct parameter is `maxcpus=4`, not `mxcpus=4`. The kernel does not recognize `mxcpus`, so `parse_args()` reaches its fallback handler. Since the parameter does not match any `__setup()` handler, and does not contain a `.` (which would indicate a module parameter), it is logged and passed to the init process as an environment variable:

```bash
# In the kernel boot log (easily missed among hundreds of lines):
dmesg | grep -i 'unknown\|mxcpus'
# Unknown kernel command line parameters "mxcpus=4", will be passed to userspace
```

The message is at `KERN_WARNING` level, which at the default console loglevel of 4 does not appear on the screen during boot — it goes only to the ring buffer. The SMP initialization code never saw the parameter, so all 8 CPUs came online.

### Root cause

The kernel's policy for unknown parameters is to pass them to the init process as environment variables, not to fail. This is intentional: some parameters are genuinely meant for the init system (e.g., `systemd.unit=emergency.target`), and the kernel cannot distinguish between "a user typo" and "a valid init parameter." The failure is silent from the kernel's perspective.

### Detection

```bash
# Check for unknown parameters that were passed to userspace:
dmesg | grep "Unknown kernel command line"

# Validate the command line before rebooting:
# (Check against the documented parameter list)
grep -w 'mxcpus' /proc/cmdline  # returns nothing if not present

# The canonical parameter list:
grep 'maxcpus' Documentation/admin-guide/kernel-parameters.txt
```

Some distributions include `bootparamchk` or similar tools in their initramfs to validate command line parameters against a known-good list. For automated deployments, comparing `nproc` against the expected CPU count in a post-boot health check catches this class of error immediately.

### Lesson

The kernel silently accepts unknown parameters — by design. A typo in a critical boot parameter produces no error, only a log message buried in hundreds of lines of dmesg output. Operational processes should verify that the expected effect occurred (check CPU count, memory limits, etc.) rather than assuming the parameter took effect. For fleet management, define the expected post-boot state in a configuration management tool and assert it.

---

## Case 5: module init returning wrong error code

### The problem

A driver for a custom PCIe device passed code review and was merged into the company's internal tree. During integration testing, the driver appeared to load successfully — `modprobe` returned exit code 0, `lsmod` showed the driver loaded, and the device responded to initial commands. But over the following days, sporadic memory leak reports appeared in the kernel log:

```
unreferenced object 0xffff9d4b81234500 (size 512):
  comm "modprobe", pid 1234, jiffies 4294987654
  hex dump (first 32 bytes):
  ...
  backtrace:
    kmalloc+0x...
    mydriver_probe+0x60/0x180
```

`kmemleak` (enabled in the debug kernel) was tracking allocations that were never freed.

### Diagnosis

The driver's `init()` function allocated internal state, registered a character device, and registered a PCI driver. If the PCI driver registration failed (because the device was not present on some test machines), the function was supposed to clean up and return an error. Instead:

```c
static int __init mydriver_init(void)
{
    int ret;

    mydriver_state = kmalloc(sizeof(*mydriver_state), GFP_KERNEL);
    if (!mydriver_state)
        return -ENOMEM;

    ret = cdev_add(&mydriver_cdev, mydriver_devno, 1);
    if (ret) {
        kfree(mydriver_state);
        return ret;
    }

    ret = pci_register_driver(&mydriver_pci_driver);
    if (ret) {
        cdev_del(&mydriver_cdev);
        kfree(mydriver_state);
        return 1;  /* BUG: should be a negative errno */
    }

    return 0;
}
```

The `return 1` on PCI registration failure returned a *positive* value instead of a negative errno. The kernel's `do_one_initcall()` checks the return value:

```c
/* init/main.c */
static int __init_or_module do_one_initcall(initcall_t fn)
{
    int ret;
    ...
    ret = fn();
    ...
    if (ret >= 0)
        pr_debug("initcall %pF returned %d after %llu usecs\n",
                 fn, ret, duration);
    else
        pr_warn("initcall %pF returned %d after %llu usecs\n",
                fn, ret, duration);
    return ret;
}
```

A return value `>= 0` is treated as success by the initcall machinery and by `load_module()`. The module was reported as loaded. But because `pci_register_driver()` had actually failed, the `cdev_del()` and `kfree()` cleanup branches ran — freeing the character device registration and the allocated state. The module was in a state where `init()` returned "success" but had cleaned up everything, leaving a partially-initialized shell.

Subsequent access through the character device (or driver framework callbacks) reached freed memory or missing registrations. The kmemleaks came from a slightly different path: on machines where the PCI device was present but returned a transient error, `cdev_add` had registered the device but `pci_register_driver` failed. The `cdev_del` ran, but a racing process had already opened the character device, preventing the `cdev_del` from fully completing. The state allocation (`mydriver_state`) was freed while references to it still existed.

### Root cause

`return 1` is not a valid return code for a module init function. The kernel's convention is: 0 = success, negative errno = failure. A positive return is treated as success but is meaningless — it is neither a valid errno nor documented as a success code variant. The mistake was compounded by the half-cleanup that ran: the function freed resources but reported success, leaving the module in an impossible state.

### Fix

```c
    ret = pci_register_driver(&mydriver_pci_driver);
    if (ret) {
        cdev_del(&mydriver_cdev);
        kfree(mydriver_state);
        return ret;  /* pci_register_driver returns negative errno on failure */
    }
```

`pci_register_driver()` already returns a negative errno on failure; passing it through directly is correct. If generating a local error code, use a negative value: `return -ENODEV;`, never `return 1;`.

The cleanup order should also be the reverse of the allocation order (LIFO), and it should be factored into a single error path:

```c
static int __init mydriver_init(void)
{
    int ret;

    mydriver_state = kmalloc(sizeof(*mydriver_state), GFP_KERNEL);
    if (!mydriver_state)
        return -ENOMEM;

    ret = cdev_add(&mydriver_cdev, mydriver_devno, 1);
    if (ret)
        goto err_free_state;

    ret = pci_register_driver(&mydriver_pci_driver);
    if (ret)
        goto err_del_cdev;

    return 0;

err_del_cdev:
    cdev_del(&mydriver_cdev);
err_free_state:
    kfree(mydriver_state);
    return ret;
}
```

### Lesson

Module init functions must return 0 on success or a negative errno on failure. A positive return is treated as success and the module is considered loaded, even if internal state is inconsistent. Positive values from kernel API functions (like a device minor number or a count) must not be returned directly from `init()`. The `goto`-based error path pattern (sometimes called "gotos for error handling") makes the cleanup order explicit and hard to get wrong. Tools like `kmemleak` and KASAN are invaluable for catching the resulting inconsistencies in development and CI.

---

## Further reading

- [Early Boot and start_kernel()](early-boot.md) — initcall levels and ordering
- [Module Init and Initcalls](initcalls-modules.md) — `load_module()`, error code handling
- [Kernel Panic and Oops](panic-oops.md) — crash analysis and kdump setup
- [Boot Parameters](boot-params.md) — `__setup()`, `early_param()`, unknown parameter handling
- [Kmemleak](../mm/kmemleak.md) — detecting memory leaks like Case 5
- `Documentation/admin-guide/kdump/kdump.rst` — kdump sizing guidelines
- `Documentation/process/coding-style.rst` — error path conventions in kernel code
