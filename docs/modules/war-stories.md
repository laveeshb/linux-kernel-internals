# Module War Stories

> ABI breaks, signing failures, taint cascades, and versioning surprises

## 1. The CONFIG_MODVERSIONS CRC mismatch

**Symptom:** Loading a freshly compiled driver on a vendor kernel failed immediately:

```
insmod: ERROR: could not insert module mydriver.ko: Invalid module format
dmesg | tail -2
# mydriver: disagrees about version of symbol module_layout
```

**What happened:** The engineer had compiled the module against a vanilla upstream source tree of nominally the same version. The production servers ran a vendor kernel that had backported several patches from a later release cycle, one of which changed the layout of an internal struct that `module_layout` depends on. The vendor's `genksyms` computed a different CRC for `module_layout` than upstream's `genksyms` did, because the type signature traversal reached the modified struct.

From the kernel's perspective, the ABI had changed — and `module_layout` is the very first thing the loader checks. `load_module()` calls `early_mod_check()`, which calls `check_modstruct_version()` before anything else in the module image is used. That looks up the kernel's CRC for the `module_layout` anchor symbol, compares it against the module's `__versions` table, prints `disagrees about version of symbol module_layout`, and returns 0 — `check_version()` is a predicate, not an errno source. It is the caller that converts the failure: `early_mod_check()` returns `-ENOEXEC`, which is the `Invalid module format` that `insmod` reported.

It is worth being precise about which path fired, because there are two and they behave differently. Had an *ordinary* exported symbol mismatched instead, the module-struct check would have passed and the failure would have surfaced much later, during symbol resolution: `resolve_symbol()` turns a failed `check_version()` into `ERR_PTR(-EINVAL)`, and `simplify_symbols()` then prints `mydriver: Unknown symbol <name> (err -22)` — `-22` being `EINVAL`. No such line ever appears for `module_layout`, because `module_layout` is only ever an entry in the CRC table; the module contains no undefined ELF reference to it, so symbol resolution never sees it at all.

**Why it was hard to diagnose:** The build produced no warnings. The upstream headers declared the same prototypes the vendor's did, so nothing in the driver's own source looked wrong, and the struct that had actually changed was never named in it — the mismatch was through a transitive type dependency that `genksyms` tracks but humans rarely inspect. Worse, the number that ends up in a module's `__versions` section is not recomputed from the driver's source at all: `modpost` copies it out of the build tree's `Module.symvers`. The wrong CRC is baked in at build time, from the wrong tree, with nothing at build time to flag it.

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
# modprobe: ERROR: could not insert 'mydriver': Key was rejected by service
```

**What happened:** The admin had enrolled the public signing certificate the only way that worked on the first try: by rebuilding the distribution's kernel source package with the certificate added to `CONFIG_SYSTEM_TRUSTED_KEYS`, so it was compiled into that one kernel image. That worked, and it kept working for as long as that image stayed the default boot entry.

Then the distribution shipped a kernel errata update. The package manager installed a *stock* distro kernel, which became the new default boot entry, and that image had only the distribution's own signing keys built in. The custom key was gone — it had never been anywhere but inside a single locally built vmlinuz.

The modules were still signed with the admin's private key. Their signatures were valid. But the running kernel had no record of the corresponding public key and refused to verify the modules.

**Why it was hard to diagnose:** The modules' signatures had not changed. `modinfo mydriver.ko | grep sig` still showed a signature. The error `Key was rejected by service` pointed to the keyring, not the signature itself. The admin initially assumed the modules needed to be re-signed.

**Fix:** Enroll the public certificate in the UEFI MOK (Machine Owner Key) database, which persists in UEFI NVRAM and survives kernel updates — but enrolling it is only half the job, because *which* kernel keyring a MOK certificate lands in decides whether module signing can use it at all.

`mod_verify_sig()` in `kernel/module/signing.c` verifies module signatures with `VERIFY_USE_SECONDARY_KEYRING`. That resolves to `.secondary_trusted_keys`, which has `.builtin_trusted_keys` linked into it — and, if `CONFIG_INTEGRITY_MACHINE_KEYRING=y`, `.machine` as well (`set_machine_trusted_keys()` in `certs/system_keyring.c` does that `key_link()` at boot). The `.platform` keyring is a *different* trust store. Its Kconfig help text describes it as holding platform/firmware keys "for verifying the kexec'ed kernel image and, possibly, the initramfs signature"; module signature verification never consults it. `CONFIG_INTEGRITY_MACHINE_KEYRING`'s own help text draws the same line explicitly: "Unlike keys in the platform keyring, keys contained in the .machine keyring will be trusted within the kernel."

So on a kernel built without `CONFIG_INTEGRITY_MACHINE_KEYRING` (the option landed upstream in v5.18, commit `d19967764ba8`), MOK enrollment does nothing for module loading: the key is loaded into `.platform` and sits there unused. Check the running kernel's config before assuming the MOK route is available at all:

```bash
# Does this kernel admit MOK keys to a keyring module signing can reach?
grep CONFIG_INTEGRITY_MACHINE_KEYRING /boot/config-$(uname -r)
# CONFIG_INTEGRITY_MACHINE_KEYRING=y

# Import the public certificate into MOK
sudo mokutil --import signing_key.der
# (system prompts for a one-time enrollment password on next reboot)

# On UEFI, the kernel only trusts MOK keys if the MokListTrustedRT variable
# is present -- uefi_check_trust_mok_keys() in machine_keyring.c looks for it
sudo mokutil --trust-mok

# After rebooting and confirming both prompts in the MOK Manager UI:
keyctl list %:.machine | grep "your key CN"

# ...and confirm it is reachable from the keyring signatures are checked
# against -- .machine is linked into this one
keyctl list %:.secondary_trusted_keys

# Sign the module
/usr/src/linux-headers-$(uname -r)/scripts/sign-file \
    sha256 signing_key.pem signing_key.der mydriver.ko
```

**Lesson:** Kernel-image-embedded keys are per-kernel; MOK database keys are per-machine, so MOK is the right enrollment path for a key that has to survive kernel updates. But "enrolled" is not the same as "trusted for modules." A MOK certificate only reaches module signature verification through `.machine` → `.secondary_trusted_keys`, which requires `CONFIG_INTEGRITY_MACHINE_KEYRING` in the running kernel and, on UEFI, an explicit `mokutil --trust-mok`. Landing in `.platform` looks like success in `mokutil --list-enrolled` and changes nothing about whether a module loads.

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
Tainted: P           OE
# P = proprietary module loaded
# O = out-of-tree module loaded
# E = unsigned module loaded
```

**What happened:** A proprietary GPU driver had been loaded for a monitoring tool that used CUDA for metric acceleration. The GPU driver was loaded at boot, used for approximately 30 seconds during initialization, and then the monitoring tool transitioned to CPU-only mode — but the module remained loaded.

Three days later, a completely unrelated bug in the block layer caused the crash. The bug was real, reproducible, and not caused by the GPU driver. But the taint flag `P` was set and would not clear.

**Why it matters:** Global taint flags live in a single file-scope `static unsigned long tainted_mask` in `kernel/panic.c`, reachable only through `add_taint(flag, lockdep_ok)`, which does a `set_bit()`, and `get_taint()`, which returns the whole word. Per-module taint is tracked separately in `struct module::taints`. Nothing in the kernel ever clears a bit in `tainted_mask` — `proc_taint()` will accept a write to `/proc/sys/kernel/tainted`, but its own comment states that taint values can only be increased, and it ORs the new bits in. Unloading the offending module does not help either. From the upstream developers' perspective, a tainted kernel cannot be used to confirm a clean bug report because they cannot rule out that the proprietary module corrupted kernel data structures during its 30-second run.

```bash
# Check current taint flags
cat /proc/sys/kernel/tainted
# 12289  (P + O + E: proprietary, out-of-tree, and unsigned modules loaded --
#         bit 0 + bit 12 + bit 13 = 1 + 4096 + 8192)
# See Documentation/admin-guide/tainted-kernels.rst for bit definitions

# Taint bit 0 (value 1): P — proprietary module loaded
# Taint bit 1 (value 2): forced module load
# Taint bit 12 (value 4096): O — out-of-tree module
# Taint bit 13 (value 8192): E — unsigned module
```

**Fix:** There is no runtime fix — taint bits cannot be cleared without rebooting. For upstream bug reporting:

1. Reproduce the bug on a kernel that has never loaded a proprietary or out-of-tree module in the current boot. Blacklisting the module on the kernel command line (`module_blacklist=nvidia`, the comma-separated list `blacklisted()` checks in `kernel/module/main.c`) and rebooting is the only reliable way to get there; `rmmod` after the fact does nothing, because unloading a module cannot clear a bit that `add_taint()` already set.
2. If a proprietary module is required for the workload, file the bug with the hardware vendor.
3. Build the reporting kernel with `CONFIG_MODULE_UNLOAD_TAINT_TRACKING=y`. It does not clear taint — nothing does — but it makes taint attributable: `kernel/module/tracking.c` keeps an `unloaded_tainted_modules` list, and `print_unloaded_tainted_modules()` appends an `Unloaded tainted modules:` line to the oops, naming each module that tainted the kernel and was subsequently unloaded. That turns "something tainted this kernel three days ago" into a specific module name, which is often enough for a maintainer to decide whether the report is still worth looking at.

**Lesson:** Taint is a session-level flag. Even a brief load of a proprietary module taints the kernel for the rest of its uptime. Production kernels used for upstream bug reporting should have a policy of never loading proprietary modules.

---

## 4. The init section use-after-free

**Symptom:** An embedded system ran stably for days, then crashed with a call trace pointing into unmapped memory. The crash address was different on each occurrence, and it only manifested under moderate I/O load. KASAN was not enabled in production.

```
BUG: unable to handle kernel paging request at ffffffffc03a8120
...
Call Trace:
  [<ffffffffc03a8120>] ? 0xffffffffc03a8120
  [<ffffffffc0401f30>] my_device_event_handler+0x28/0x50 [mydriver]
```

**What happened:** During `probe()`, the driver stored a function pointer in a persistent callback structure:

```c
static void __init mydriver_init_error_handler(struct my_device *dev)
{
    /* handles errors that can only occur during initialization */
}

static int __init mydriver_probe(struct platform_device *pdev)
{
    struct my_device *dev = /* ... */;

    /* BUG: __init function pointer stored in persistent structure */
    dev->error_handler = mydriver_init_error_handler;

    platform_set_drvdata(pdev, dev);
    return 0;
}

static struct platform_driver mydriver_driver = {
    .remove = mydriver_remove,
    .driver = { .name = "mydriver" },
};

/* Note: no .probe field. platform_driver_probe() takes the probe function
 * as a separate argument precisely so that it may live in __init. */
module_platform_driver_probe(mydriver_driver, mydriver_probe);
```

`mydriver_init_error_handler` was marked `__init`, so it lived in the `.init.text` section. For modules, the init section is freed via `do_free_init()` (a work item) immediately after **that specific module's** `mod->init()` returns successfully — not after all initcalls complete. The function pointer in `dev->error_handler` now pointed to memory the module no longer owned.

When a device event triggered `dev->error_handler`, the CPU jumped to an address that was no longer this driver's code.

**Why the build was silent:** `scripts/mod/modpost.c` runs `check_section_mismatch()` on every relocation at every build, and its first rule — `fromsec = { TEXT_SECTIONS, DATA_SECTIONS }`, `bad_tosec = { ALL_INIT_SECTIONS, ... }` — exists to catch exactly this. It did not fire, for two reasons that both happen to hold here. First, the offending store lives inside `mydriver_probe()`, which is itself `__init`; the relocation is `.init.text` → `.init.text`, and no rule forbids init code from referencing init code. Second, the usual way an `__init` probe *does* get caught — a `struct platform_driver` in `.data` with `.probe` pointing at `.init.text`, which is a `DATA_SECTIONS` → `ALL_INIT_SECTIONS` mismatch, and is not covered by `secref_whitelist()`'s `*_ops`/`*_console` exemptions — was sidestepped by registering through `platform_driver_probe()`, whose header comment says it exists so "probe() and its support may live in `__init` sections, conserving runtime memory." The driver used the officially blessed pattern for an `__init` probe and then violated the one invariant that pattern depends on: that nothing survives the probe holding a pointer into it.

**Why it was intermittent:** `do_free_init()` calls `execmem_free()`, and what that does depends on the kernel. Without `CONFIG_ARCH_HAS_EXECMEM_ROX`, `execmem_cache_free()` declines and `execmem_free()` falls through to `vfree()` — the range is unmapped, and a jump into it is an immediate, deterministic page fault, which is the trace above. On x86-64 with `CONFIG_ARCH_HAS_EXECMEM_ROX=y` the range instead goes back to the execmem ROX cache: `__execmem_cache_free()` fills it with trapping instructions (`INT3` on x86) and leaves it **mapped**, ready to be handed to the next module that needs executable memory. That makes the modern failure mode strictly less predictable, not more. If nothing has reused the range yet, the call lands on `INT3` and traps; if a later `insmod` has already been given that range, the call lands in the middle of an unrelated module's code and does whatever those bytes do. So the crash signature depends on what else the machine has loaded since — which is precisely why this bug hid for days and never reproduced the same way twice.

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

The build-time net for this class of bug is `modpost`, not sparse — sparse has no notion of `__init` or of ELF sections, so `make C=1` will never say a word about it. `check_section_mismatch()` runs during the MODPOST stage of every build, with no extra flag required, and catches any relocation from ordinary text or data into `.init.*`. What it cannot catch is a *runtime* store of an init pointer made from init context, as here: the relocation modpost sees is init-to-init, which is legal. Those need runtime analysis — KASAN, or code review that treats "does this pointer outlive probe?" as a question worth asking every time.

**Lesson:** `__init` is a strong promise — the memory *will* be freed. Any pointer to an `__init` function that escapes into a persistent data structure is a time-delayed use-after-free.

---

## 5. The negative ring size

**Symptom:** A NIC driver crashed with a NULL-pointer dereference immediately at `insmod` time, but only on servers where an automation script had passed a non-default RX ring size. Every affected server hit it identically, at the same point in boot, on the first attempt.

```
insmod mydriver.ko rx_ring_size=-1
dmesg | tail -4
# mydriver: allocating RX ring
# ------------[ cut here ]------------
# WARNING: ... at mm/page_alloc.c:... __alloc_pages+...
# BUG: kernel NULL pointer dereference, address: 0000000000000018
```

**What happened:** The module parameter was declared as a signed `int`, and validated with an upper bound only:

```c
static int rx_ring_size = 256;
module_param(rx_ring_size, int, 0644);
MODULE_PARM_DESC(rx_ring_size, "Number of RX descriptors (max 4096)");

static int __init mydriver_init(void)
{
    if (rx_ring_size > 4096) {
        pr_err("rx_ring_size too large\n");
        return -EINVAL;
    }
    /* BUG: no lower-bound check */
    pr_info("allocating RX ring\n");
    ring = dma_alloc_coherent(dev, rx_ring_size * sizeof(struct rx_desc),
                               &dma_handle, GFP_KERNEL);
    ring[0].status = 0;   /* BUG: no NULL check either */
    ...
}
```

An automation script deploying the driver had a template bug and passed `rx_ring_size=-1` on one class of servers. `kstrtoint()` (the parser `param_set_int()` uses) has no concept that this particular `int` is logically a count — it accepts any value that fits in a signed 32-bit integer, and `-1` fits. The `if (rx_ring_size > 4096)` check also accepts it: `-1 > 4096` is false in signed comparison, so the only validation the driver had let it straight through.

The allocation size is where it turned dangerous. `rx_ring_size * sizeof(struct rx_desc)` multiplies a **signed** `int` by an **unsigned** `size_t`. C's usual arithmetic conversions convert the `int` operand to `size_t` before the multiply — `-1` as a 32-bit int sign-extends to a 64-bit `-1` and is then reinterpreted as unsigned, becoming `0xFFFFFFFFFFFFFFFF` (`SIZE_MAX` on a 64-bit build). Multiplying that by `sizeof(struct rx_desc)` does **not** wrap to something small: for any negative `int` and any plausible struct size, the product stays within a few thousand bytes of `SIZE_MAX` — astronomically, not modestly, oversized. There is no struct-size or compiler variation that turns this into an undersized allocation.

What actually happens downstream is a size so large it breaks the allocator's own arithmetic before it ever reaches the page allocator's normal "out of memory" path: `PAGE_ALIGN()` on a value that close to `SIZE_MAX` overflows and wraps to `0`, and the resulting page order is computed at `BITS_PER_LONG - PAGE_SHIFT` — comfortably past `MAX_PAGE_ORDER`. The page allocator's own sanity check catches that and refuses the allocation outright, logging a `WARNING` and returning `NULL`. That part is deterministic: every server that loads this driver with `rx_ring_size=-1` gets the identical `NULL`, on the first call, every time.

The crash comes from what the driver does next: nothing. `ring[0].status = 0` dereferences the `NULL` `dma_alloc_coherent()` just returned, faulting immediately.

**Why it was not caught earlier:** The driver worked correctly for every positive value up to 4096; the missing lower bound was invisible in code review because nobody tried a negative RX ring size by hand, and the missing NULL check on the allocation was invisible because `dma_alloc_coherent()` essentially never fails for the small, valid sizes the driver was tested with. Two independent, unrelated omissions — no lower bound, no failure check — had to combine before either one mattered.

**Fix:** Use the correct parameter type, validate both bounds, and check the allocation:

```c
static unsigned int rx_ring_size = 256;

/* Use uint, not int, for a value that is logically a count */
module_param(rx_ring_size, uint, 0644);
MODULE_PARM_DESC(rx_ring_size, "Number of RX descriptors (64-4096)");

static int __init mydriver_init(void)
{
    if (rx_ring_size < 64 || rx_ring_size > 4096) {
        pr_err("invalid rx_ring_size %u, must be 64-4096\n", rx_ring_size);
        return -EINVAL;
    }
    ring = dma_alloc_coherent(dev, rx_ring_size * sizeof(struct rx_desc),
                               &dma_handle, GFP_KERNEL);
    if (!ring)
        return -ENOMEM;
    ...
}
```

Switching to `unsigned int` would, by itself, have caught this specific mistake: `kstrtouint()` rejects a leading `-` outright, so `rx_ring_size=-1` would have failed to parse at `insmod` time with `-EINVAL`, well before the driver ever ran. It is not a complete fix on its own, though — `kstrtouint()` still accepts `4294967295`, an equally nonsensical ring size that no type change alone rejects — so the explicit range check still matters. For parameters that must be validated on runtime writes via sysfs as well, use `module_param_cb()` with a custom `set` function that enforces the same range on every write, not just at load time.

**Lesson:** A signed parameter with only an upper-bound check lets every negative value through, and mixed signed/unsigned arithmetic in a size calculation turns a negative count into a value near `SIZE_MAX` rather than a small one — allocators are built to reject that cleanly, not silently accept it, so the practical risk is a `NULL` return, not a wraparound overflow. The bug that actually reaches hardware is almost always the second, unrelated mistake: not checking the allocation for failure. Validate both bounds of a count-like parameter, prefer an unsigned type as a second line of defense, and never skip the NULL check on an allocation whose size an attacker or a bad config might influence.

---

## Further reading

### Kernel source

- [kernel/module/version.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/module/version.c) — `check_version()` and its `"disagrees about version of symbol"` warning, plus `check_modstruct_version()`, which looks up the CRC of the `module_layout` anchor symbol before anything else in the module is touched, behind Case 1
- [scripts/genksyms/genksyms.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/scripts/genksyms/genksyms.c) — the parser that expands an exported symbol's full type definition, including nested structs, into the CRC that Case 1's vendor and upstream builds disagreed about
- [scripts/mod/modpost.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/scripts/mod/modpost.c) — `sym_add_unresolved("module_layout", ...)` and `add_versions()`, which build the module's `__versions` CRC table from `Module.symvers` (Case 1), and `check_section_mismatch()` with its `ALL_INIT_SECTIONS` rules, the build-time check that flags non-init references into `.init.*` (Case 4)
- [kernel/module/main.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/module/main.c) — `resolve_symbol()`, which fails a symbol whose `check_version()` disagrees, and `do_init_module()`/`do_free_init()`, which release a module's `.init.text` right after *that* module's init function returns, behind Cases 1 and 4
- [include/linux/init.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/init.h) — `__init` expanding to `__section(".init.text")`, the annotation whose memory Case 4's driver kept a live pointer into
- [mm/execmem.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/mm/execmem.c) — `execmem_free()`, the call `do_free_init()` uses to hand module init text back, and the ROX cache that decides whether the range is unmapped or recycled, behind Case 4
- [kernel/module/signing.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/module/signing.c) — `mod_verify_sig()`, which verifies module signatures with `VERIFY_USE_SECONDARY_KEYRING`, and the `sig_enforce` parameter behind `CONFIG_MODULE_SIG_FORCE`, in Case 2
- [certs/system_keyring.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/certs/system_keyring.c) — the `.builtin_trusted_keys`, `.secondary_trusted_keys`, `.machine`, and `.platform` keyrings; module signatures are checked against the secondary keyring chain, which is what Case 2's enrolled key has to reach
- [security/integrity/Kconfig](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/security/integrity/Kconfig) — `CONFIG_INTEGRITY_MACHINE_KEYRING`, the option that admits Machine Owner Keys to the `.machine` keyring; its help text spells out that, unlike platform-keyring keys, `.machine` keys are trusted within the kernel — the distinction Case 2's fix depends on
- [scripts/sign-file.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/scripts/sign-file.c) — the `sign-file` tool invoked in Case 2's fix
- [kernel/panic.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/panic.c) — the `tainted_mask` bitmask with `add_taint()`/`get_taint()`, and `proc_taint()`, whose "Taint values can only be increased" comment is why Case 3's taint never clears
- [include/linux/panic.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/panic.h) — the `TAINT_PROPRIETARY_MODULE` (0), `TAINT_FORCED_MODULE` (1), `TAINT_OOT_MODULE` (12), and `TAINT_UNSIGNED_MODULE` (13) bit numbers quoted in Case 3
- [include/linux/module.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/module.h) — `struct module`'s `taints` field, commented "same bits as kernel:taint_flags", the per-module taint record in Case 3
- [kernel/module/tracking.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/module/tracking.c) — the `unloaded_tainted_modules` list, which preserves the identity of tainting modules that have already been unloaded, the closest thing to a remedy for Case 3
- [kernel/params.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/params.c) — `STANDARD_PARAM_DEF(int, int, "%i", kstrtoint)`, which is all `param_set_int()` is: it validates only that the value fits in a signed `int`, with no notion that a given `int` parameter is logically non-negative, behind Case 5
- [lib/kstrtox.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/lib/kstrtox.c) — `kstrtoint()`, which accepts any in-range signed value including negative ones, the reason `rx_ring_size=-1` parses cleanly in Case 5

### Man pages

- [`init_module(2)`](https://man7.org/linux/man-pages/man2/init_module.2.html) — the load-time errors these cases produce: `ENOEXEC` for a module image the kernel rejects (Case 1); the man page documents `ENOKEY` for a missing signature key, but since v5.4 (commit `49fcf732bdae`, "lockdown: Enforce module signatures if the kernel is locked down") an enforcing kernel actually returns `EKEYREJECTED` — "Key was rejected by service" — behind Case 2
- [`delete_module(2)`](https://man7.org/linux/man-pages/man2/delete_module.2.html) — the unload path behind the `rmmod` advice in Case 3, and its `O_TRUNC` forced-unload flag
- [`modprobe(8)`](https://man7.org/linux/man-pages/man8/modprobe.8.html) — the loader used in Cases 2 and 5, including how trailing `name=value` module parameters are handed to the kernel
- [`modinfo(8)`](https://man7.org/linux/man-pages/man8/modinfo.8.html) — `-F field` extraction of module attributes from a `.ko`, the inspection step in Cases 1 and 2 (the man page's own field list doesn't mention `sig*`/`vermagic`, but `modinfo` prints them in practice — see `Documentation/admin-guide/module-signing.rst`)
- [`keyctl(1)`](https://man7.org/linux/man-pages/man1/keyctl.1.html) — `keyctl list` and the `%:<name>` keyring-by-name notation used in Case 2's verification step

### Related pages

- [Module Loading Internals](module-loading-internals.md) — `load_module()`, the `__versions` CRC check, and `Module.symvers`, the machinery behind Case 1
- [Module Signing](module-signing.md) — `CONFIG_MODULE_SIG_FORCE`, signature format, and key enrollment, behind Case 2
- [Module Parameters, Symbols, and Kconfig](module-params.md) — `module_param()` types, `module_param_cb()`, and the same `has no CRC!`/version-mismatch symptoms, behind Cases 1 and 5
- [Kbuild: The Kernel Build System](kbuild.md) — out-of-tree `M=` builds, the build side of Case 1's fix
- [Writing and Loading Kernel Modules](module-basics.md) — the `__init`/`__exit` annotations and module lifecycle behind Case 4
- [Kernel Keyring](../crypto/keyring.md) — key types and keyring search semantics behind Case 2's `keyctl` check
- [Kernel Oops Analysis](../debugging/oops-analysis.md) — decoding the tainted call traces quoted in Cases 3 and 4
- [Platform Drivers](../drivers/platform-driver.md) — the `probe()`/`platform_set_drvdata()` pattern Case 4's driver is built on

### LWN articles

- [The end of modversions?](https://lwn.net/Articles/707520/) (November 30, 2016) — vermagic versus modversions, and how a single changed CRC stops a module from loading into an otherwise compatible kernel, the mechanism behind Case 1
- [A new version of modversions](https://lwn.net/Articles/986892/) (August 26, 2024) — how `genksyms` derives a symbol's checksum from its expanded type information, which is why a transitive struct change breaks Case 1's module
- [The module signing endgame](https://lwn.net/Articles/525592/) (November 21, 2012) — how module signing and the built-in public key were wired into the kernel build and install steps, the setup Case 2 inherited
- [Tracing unsigned modules](https://lwn.net/Articles/588799/) (March 5, 2014) — `CONFIG_MODULE_SIG_FORCE`, the `module.sig_enforce` boot parameter, and the taint flag raised for unsigned modules, spanning Cases 2 and 3
- [module: Introduce module unload taint tracking](https://lwn.net/Articles/893584/) (May 2, 2022) — Aaron Tomlin's series adding a record of tainting modules that were later unloaded, aimed squarely at Case 3's "which module tainted this kernel?" problem
- [Yet another memory allocator for executable code](https://lwn.net/Articles/933867/) (June 8, 2023) — the proposal that became `execmem`, the allocator that now hands out and frees the module init text in Case 4

### External

- [Tainted kernels](https://docs.kernel.org/admin-guide/tainted-kernels.html) — the authoritative taint bit table (4096 = externally-built module, 8192 = unsigned module) and the statement that the kernel stays tainted after the offending module is unloaded, behind Case 3
- [Reporting issues](https://docs.kernel.org/admin-guide/reporting-issues.html) — upstream's "check the taint flag" step and its insistence on reproducing on a healthy, untainted kernel, the rule Case 3's bug report ran into
- [Building External Modules](https://docs.kernel.org/kbuild/modules.html) — `Module.symvers`, `KBUILD_EXTRA_SYMBOLS`, and the `__versions` sections, the documented form of Case 1's fix
- [Kernel module signing facility](https://docs.kernel.org/admin-guide/module-signing.html) — `CONFIG_MODULE_SIG_FORCE`, `CONFIG_SYSTEM_TRUSTED_KEYS`, and `scripts/sign-file`, the exact configuration Case 2 started from
