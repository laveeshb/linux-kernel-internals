# Module War Stories

> ABI breaks, signing failures, taint cascades, and versioning surprises

## 1. The CONFIG_MODVERSIONS CRC mismatch

**Symptom:** Loading a freshly compiled driver on a vendor kernel failed immediately:

```
insmod: ERROR: could not insert module mydriver.ko: Invalid module format
dmesg | tail -3
# mydriver: disagrees about version of symbol module_layout
# mydriver: Unknown symbol module_layout (err -22)
```

**What happened:** The engineer had compiled the module against the vanilla upstream kernel headers. The production servers ran a vendor kernel that had backported several patches from a later release cycle, one of which changed the layout of an internal struct that `module_layout` depends on. The vendor's `genksyms` computed a different CRC for `module_layout` than upstream's `genksyms` did, because the type signature traversal reached the modified struct.

From the kernel's perspective, the ABI had changed. The CRC stored in the module's `__versions` section did not match `__crc_module_layout` in the vendor kernel, so `check_version()` returned `ENOEXEC`.

**Why it was hard to diagnose:** The module compiled cleanly against the vendor kernel headers. The headers shipped by the vendor were only slightly out of date and the struct in question was not directly referenced in the driver's own source. The mismatch was through a transitive type dependency that `genksyms` tracks but humans rarely inspect.

**Fix:** Always build out-of-tree modules against the exact `Module.symvers` of the target kernel. Copy `Module.symvers` from the running kernel's build directory:

```bash
# Use the vendor kernel's Module.symvers, not upstream's
cp /lib/modules/$(uname -r)/build/Module.symvers .

# For modules that depend on other out-of-tree modules,
# concatenate their Module.symvers files:
export KBUILD_EXTRA_SYMBOLS="/path/to/dep1/Module.symvers /path/to/dep2/Module.symvers"
make -C /lib/modules/$(uname -r)/build M=$(pwd) modules
```

**Lesson:** CRC mismatches are not just about kernel versions. Vendors routinely backport patches that change exported ABIs without changing the kernel version string. `Module.symvers` is the ground truth; the kernel headers are not.

---

## 2. The module signing loop

**Symptom:** After a distribution switched to `CONFIG_MODULE_SIG_FORCE=y`, all unsigned third-party modules refused to load. An admin enrolled a custom signing key and signed the modules. Everything worked — until the next kernel update, when the modules again refused to load:

```
# After kernel update:
modprobe mydriver
# modprobe: ERROR: could not insert 'mydriver': Required key not available
```

**What happened:** The admin had enrolled the public signing certificate into the kernel's built-in trusted keyring by compiling it into the kernel image (via `CONFIG_SYSTEM_TRUSTED_KEYS`). When the distribution shipped a new kernel, the new image did not include the admin's certificate — it had only the distribution's own signing keys built in. The custom key was gone.

The modules were still signed with the admin's private key. Their signatures were valid. But the running kernel had no record of the corresponding public key and refused to verify the modules.

**Why it was hard to diagnose:** The modules' signatures had not changed. `modinfo mydriver.ko | grep sig` still showed a signature. The error `Required key not available` pointed to the keyring, not the signature itself. The admin initially assumed the modules needed to be re-signed.

**Fix:** Enroll the public certificate in the UEFI MOK (Machine Owner Key) database. MOK entries persist in UEFI NVRAM, survive kernel updates, and are imported into the kernel keyring at boot by the bootloader shim:

```bash
# Import the public certificate into MOK
sudo mokutil --import signing_key.der
# (system prompts for a one-time enrollment password on next reboot)

# After rebooting and confirming enrollment in the MOK Manager UI:
# Verify the key is present
keyctl list %:.platform | grep "your key CN"

# Sign the module
/usr/src/linux-headers-$(uname -r)/scripts/sign-file \
    sha256 signing_key.pem signing_key.der mydriver.ko
```

**Lesson:** Kernel-image-embedded keys are per-kernel. MOK database keys are per-machine. For keys that need to survive kernel updates, MOK is the correct enrollment path.

---

## 3. The taint cascade

**Symptom:** A production database server crashed with a NULL pointer dereference in `blk_mq_complete_request()`. The kernel oops was filed as a bug report upstream. Kernel developers closed the report within hours asking for reproduction on an untainted kernel.

```
BUG: kernel NULL pointer dereference, address: 0000000000000008
...
Call Trace:
  blk_mq_complete_request+0x42/0x90
  nvme_complete_rq+0x31/0x70
  ...
Tainted: P OE
# P = proprietary module loaded
# O = out-of-tree module loaded
# E = unsigned module loaded
```

**What happened:** A proprietary GPU driver had been loaded for a monitoring tool that used CUDA for metric acceleration. The GPU driver was loaded at boot, used for approximately 30 seconds during initialization, and then the monitoring tool transitioned to CPU-only mode — but the module remained loaded.

Three days later, a completely unrelated bug in the block layer caused the crash. The bug was real, reproducible, and not caused by the GPU driver. But the taint flag `P` was set and would not clear.

**Why it matters:** The `tainted` field in `struct kernel_info` is set per-kernel-session. Once set, taint bits are never cleared, even if the offending module is unloaded. From the upstream developers' perspective, a tainted kernel cannot be used to confirm a clean bug report because they cannot rule out that the proprietary module corrupted kernel data structures during its 30-second run.

```bash
# Check current taint flags
cat /proc/sys/kernel/tainted
# 4096  (OE: out-of-tree + unsigned)
# See Documentation/admin-guide/tainted-kernels.rst for bit definitions

# Taint bit 0 (value 1): P — proprietary module loaded
# Taint bit 1 (value 2): forced module load
# Taint bit 12 (value 4096): O — out-of-tree module
# Taint bit 13 (value 8192): E — unsigned module
```

**Fix:** There is no runtime fix — taint bits cannot be cleared without rebooting. For upstream bug reporting:

1. Reproduce the bug on a kernel with no proprietary or out-of-tree modules loaded.
2. If a proprietary module is required for the workload, file the bug with the hardware vendor.
3. Consider using `rmmod` to unload unnecessary modules before initiating the workload under test — they must never have been loaded in the session.

**Lesson:** Taint is a session-level flag. Even a brief load of a proprietary module taints the kernel for the rest of its uptime. Production kernels used for upstream bug reporting should have a policy of never loading proprietary modules.

---

## 4. The init section use-after-free

**Symptom:** An embedded system ran stably for days, then crashed with a call trace pointing into unmapped memory. The crash address was different on each occurrence, and it only manifested under moderate I/O load. KASAN was not enabled in production.

```
BUG: unable to handle kernel paging request at ffffffff81234567
...
Call Trace:
  [<ffffffff81234567>] ? 0xffffffff81234567
  [<ffffffffc0401f30>] my_device_event_handler+0x28/0x50 [mydriver]
```

**What happened:** During `probe()`, the driver stored a function pointer in a persistent callback structure:

```c
static int __init mydriver_probe(struct platform_device *pdev)
{
    struct my_device *dev = /* ... */;

    /* BUG: __init function pointer stored in persistent structure */
    dev->error_handler = mydriver_init_error_handler;
    /* mydriver_init_error_handler is marked __init */

    platform_set_drvdata(pdev, dev);
    return 0;
}

static void __init mydriver_init_error_handler(struct my_device *dev)
{
    /* handles errors that can only occur during initialization */
}
```

`mydriver_init_error_handler` was marked `__init`, so it lived in the `.init.text` section. After all initcalls completed, the kernel called `free_initmem()` (or `do_free_init()` for module init sections), freeing the pages that held `.init.text`. The function pointer in `dev->error_handler` now pointed to freed memory.

Under normal operation, those pages were not immediately reused. Under I/O load, the allocator reused them for something else. When a device event triggered `dev->error_handler`, the CPU jumped to whatever bytes happened to be at that address — producing an unpredictable crash.

**Why it was intermittent:** The freed `.init.text` pages are returned to the page allocator. Whether they are quickly reused depends on memory pressure. Low-memory systems crash quickly; systems with ample free memory may run for days before the pages are overwritten.

**Fix:** Never store pointers to `__init` functions in structures that outlive the init phase. Either remove the `__init` annotation from functions that may be called after init, or restructure the code so that the persistent callback points to a non-init function:

```c
/* Option 1: remove __init — function is kept after init */
static void mydriver_error_handler(struct my_device *dev) { /* ... */ }

/* Option 2: use a non-__init wrapper that checks state */
static void mydriver_error_handler(struct my_device *dev)
{
    if (dev->init_complete)
        return;  /* silently ignore post-init errors */
    /* handle init-phase error */
}
```

The kernel's `initcall_debug` mechanism and sparse's `__init` checking (`make C=1`) can catch some of these at build time, but pointer stores through structures require runtime analysis (KASAN, careful code review).

**Lesson:** `__init` is a strong promise — the memory *will* be freed. Any pointer to an `__init` function that escapes into a persistent data structure is a time-delayed use-after-free.

---

## 5. The module parameter integer overflow

**Symptom:** A network driver failed to initialize on one particular server when its MTU was set to a non-default value. The device appeared in `lsmod` but `ip link show` showed it as `DOWN` and the NIC firmware log reported an invalid configuration:

```
insmod mydriver.ko mtu=4294967295
dmesg | tail -5
# mydriver: NIC firmware rejected MTU configuration
# mydriver: device initialization failed: -EIO
```

**What happened:** The module parameter was declared as a signed `int`:

```c
static int mtu = 1500;
module_param(mtu, int, 0644);
MODULE_PARM_DESC(mtu, "Maximum Transmission Unit in bytes");
```

The user set `mtu=4294967295` (0xFFFFFFFF), the maximum value of an unsigned 32-bit integer. The kernel's `param_set_int()` handler uses `kstrtoint()` to parse the value. `kstrtoint()` checks whether the value fits in a signed 32-bit integer — it does not, since 4294967295 > INT_MAX (2147483647). However, in the kernel version in use, the parameter subsystem at that time fell back to treating the overflow as a truncation to `-1` (the result of a 32-bit unsigned-to-signed reinterpretation).

The driver then used the MTU value:

```c
ret = nic_firmware_set_mtu(priv, (unsigned int)mtu);
```

Casting `-1` (signed int) to `unsigned int` yields `4294967295`. The firmware rejected this as an invalid MTU and the driver returned `-EIO`.

**Why it was not caught earlier:** The driver worked correctly for all MTU values up to `INT_MAX`. The value `4294967295` was chosen by an automation script that was passing the system's configured receive buffer size, which happened to be the sentinel value `0xFFFFFFFF` used by that system's configuration management tool for "use firmware default." The script did not validate the value before passing it.

**Fix:** Use the correct parameter type and validate the range explicitly:

```c
static unsigned int mtu = 1500;

/* Use uint, not int, for values that are logically unsigned */
module_param(mtu, uint, 0644);
MODULE_PARM_DESC(mtu, "Maximum Transmission Unit in bytes (68-9000)");

static int __init mydriver_init(void)
{
    if (mtu < 68 || mtu > 9000) {
        pr_err("invalid mtu %u, must be 68-9000\n", mtu);
        return -EINVAL;
    }
    /* ... */
}
```

For parameters that must be validated on runtime writes via sysfs as well, use `module_param_cb()` with a custom `set` function that enforces the range on every write, not just at load time.

**Lesson:** Module parameter types should reflect the semantic type of the value. `int` for a byte count or size is almost always wrong. Defensive range validation in the init function catches bad values before they reach hardware.

---

## Further reading

- [Module Loading Internals](module-loading-internals.md) — CRC checking, taint flags, and the load_module() sequence
- [Module Signing](module-signing.md) — MOK enrollment and CONFIG_MODULE_SIG_FORCE
- [Module Parameters, Symbols, and Kconfig](module-params.md) — module_param types and KBUILD_EXTRA_SYMBOLS
- `Documentation/admin-guide/tainted-kernels.rst` — taint bit definitions
- `Documentation/kbuild/modules.rst` — KBUILD_EXTRA_SYMBOLS and Module.symvers
