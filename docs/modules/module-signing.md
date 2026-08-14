# Kernel Module Signing

> Cryptographic verification of modules before loading

## Why module signing?

Without module signing, anyone with root access can insert arbitrary kernel code via `insmod`. Module signing prevents loading unauthorized modules in security-sensitive environments:
- **Secure Boot**: UEFI firmware verifies the boot chain; modules must also be verified
- **Locked-down kernel**: `lockdown=integrity` mode prevents unsigned modules
- **Compliance**: PCI-DSS, FIPS 140-2 requirements

## Configuration

```bash
# Kconfig options:
CONFIG_MODULE_SIG=y           # Enable module signature support
CONFIG_MODULE_SIG_FORCE=y     # Require signatures (refuse unsigned)
CONFIG_MODULE_SIG_ALL=y       # Automatically sign all modules at build
CONFIG_MODULE_SIG_SHA512=y    # Use SHA-512 for signing hash. The choice in
                              # kernel/module/Kconfig is SHA-256/384/512 and
                              # SHA3-256/384/512 (SHA-1 and SHA-224 are gone);
                              # exactly one is selected, SHA-512 is the default
CONFIG_MODULE_SIG_KEY="certs/signing_key.pem"  # Signing key path

# Check current configuration:
zcat /proc/config.gz | grep CONFIG_MODULE_SIG
```

## Generating signing keys

```bash
# Generate a new key pair (during kernel build):
# The kernel build system auto-generates if CONFIG_MODULE_SIG_KEY points
# to a non-existent file.

# Manual generation:
openssl req -new -nodes -utf8 -sha512 -days 36500 \
    -batch -x509 \
    -config x509.genkey \
    -outform PEM \
    -out signing_key.pem \
    -keyout signing_key.pem

# x509.genkey contents:
cat > x509.genkey << 'EOF'
[ req ]
default_bits = 4096
distinguished_name = req_distinguished_name
prompt = no
string_mask = utf8only
x509_extensions = myexts

[ req_distinguished_name ]
O = My Organization
CN = Module Signing Key
emailAddress = root@localhost

[ myexts ]
basicConstraints=critical,CA:FALSE
keyUsage=digitalSignature
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
EOF
```

## Signing a module

```bash
# Sign a module using the kernel's sign-file utility:
/usr/src/linux-<version>/scripts/sign-file sha512 \
    signing_key.pem \
    signing_key.pem \
    mymodule.ko
# First pem: private key, Second pem: X.509 certificate

# sign-file has NO verification mode -- it can only sign, never check.
# Its own usage text is the whole interface:
#   sign-file [-dp] <hash algo> <key> <x509> <module> [<dest>]
#   sign-file -s <raw sig> <hash algo> <x509> <module> [<dest>]
# and getopt(argc, argv, "sdpk") accepts exactly four flags:
#   -p  also write the PKCS#7 blob to <module>.p7s
#   -d  sign only: write <module>.p7s and stop, don't append (implies -p)
#   -s  take an already-made raw signature from a file instead of signing
#   -k  identify the signer by keyid rather than by issuer+serial
# There are no long options at all, so no --dry-run and no --verify.
# The only thing that checks a signature is the kernel, at load time.

# Inspect the signature on a signed module:
hexdump -C mymodule.ko | tail -5
# Reading backwards from EOF: the final 28 bytes are the
# "~Module signature appended~\n" marker, before it the 12-byte
# struct module_signature, and before that the PKCS#7 blob.
```

## Module signature format

The signature is appended at the end of the `.ko` file:

```c
/* include/uapi/linux/module_signature.h */
struct module_signature {
    __u8  algo;        /* Public-key crypto algorithm [0] */
    __u8  hash;        /* Digest algorithm [0] */
    __u8  id_type;     /* Key identifier type [enum module_signature_type] */
    __u8  signer_len;  /* Length of signer's name [0] */
    __u8  key_id_len;  /* Length of key identifier [0] */
    __u8  __pad[3];
    __be32 sig_len;    /* Length of signature data */
};
```

The `[0]` in those comments is not decoration: everything except `id_type` and
`sig_len` is a legacy field that must be zero. They date from the pre-PKCS#7
format, where the signer name, key ID and digest algorithm were carried in the
clear; PKCS#7 now carries all of that inside the signature blob itself, so the
fields are dead weight kept only for layout compatibility. `mod_check_sig()` in
`kernel/module_signature.c` enforces it — a non-zero `algo`, `hash`,
`signer_len`, `key_id_len` or `__pad` byte fails the module with `-EBADMSG`,
and an `id_type` that is not `MODULE_SIGNATURE_TYPE_PKCS7` (= 2) fails it with
`-ENOPKG`. That constant used to be called `PKEY_ID_PKCS7`, a leftover from
when the enum lived in generic crypto code; it was renamed (keeping the value
2) in the same v7.1 series that moved the struct from
`include/linux/module_signature.h` into uapi.

So only two fields are live: `id_type`, which is always 2, and the big-endian
`sig_len`, which tells the kernel how far back from the struct the PKCS#7 blob
begins.

Layout at end of signed `.ko`:
```
[ELF sections]
[PKCS#7 signed data (DER encoded)]
[struct module_signature]
"~Module signature appended~\n"
```

```bash
# Read the signature info:
modinfo mymodule.ko | grep sig
# sig_id: PKCS#7
# signer: My Organization: Module Signing Key
# sig_key: 01:23:45:67:89:ab:cd:ef:...
# sig_hashalgo: sha512
```

## Loading and verification

```c
/* kernel/module/signing.c */
int module_sig_check(struct load_info *info, int flags)
{
    int err = -ENODATA;
    const unsigned long markerlen = sizeof(MODULE_SIGNATURE_MARKER) - 1;
    const char *reason;
    const void *mod = info->hdr;
    bool mangled_module = flags & (MODULE_INIT_IGNORE_MODVERSIONS |
                                   MODULE_INIT_IGNORE_VERMAGIC);
    /*
     * Do not allow mangled modules as a module with version information
     * removed is no longer the module that was signed.
     */
    if (!mangled_module &&
        info->len > markerlen &&
        memcmp(mod + info->len - markerlen, MODULE_SIGNATURE_MARKER, markerlen) == 0) {
        /* We truncate the module to discard the signature */
        info->len -= markerlen;
        err = mod_verify_sig(mod, info);
        if (!err) {
            info->sig_ok = true;
            return 0;
        }
    }

    /*
     * We don't permit modules to be loaded into the trusted kernels
     * without a valid signature on them, but if we're not enforcing,
     * certain errors are non-fatal.
     */
    switch (err) {
    case -ENODATA:
        reason = "unsigned module";
        break;
    case -ENOPKG:
        reason = "module with unsupported crypto";
        break;
    case -ENOKEY:
        reason = "module with unavailable key";
        break;

    default:
        /*
         * All other errors are fatal, including lack of memory,
         * unparseable signatures, and signature check failures --
         * even if signatures aren't required.
         */
        return err;
    }

    if (is_module_sig_enforced()) {
        pr_notice("Loading of %s is rejected\n", reason);
        return -EKEYREJECTED;
    }

    return security_locked_down(LOCKDOWN_MODULE_SIGNATURE);
}
```

Four things in that function are easy to get wrong:

**The `mangled_module` guard comes first.** If the caller passed
`MODULE_INIT_IGNORE_MODVERSIONS` or `MODULE_INIT_IGNORE_VERMAGIC` to
`finit_module(2)`, the marker is never even looked for. A module whose version
information has been stripped is not the module that was signed, so the kernel
declines to pretend otherwise and falls straight through to the `-ENODATA`
("unsigned module") path.

**`err` starts at `-ENODATA`, not `-ENOKEY`.** That initial value is what the
switch sees when the marker is missing entirely, which is why "no signature at
all" and "signature present but no key to check it with" produce different
messages. The three tolerated errors are `-ENODATA` (unsigned), `-ENOPKG`
(signed with crypto this kernel doesn't have) and `-ENOKEY` (signed by a key
that isn't trusted). Anything else — a corrupt signature, `-EBADMSG` from
`mod_check_sig()`, `-ENOMEM` — is fatal whether or not enforcement is on.

**Enforcement returns `-EKEYREJECTED`, not the underlying error.** So userspace
sees a single "key was rejected by service" errno regardless of which of the
three reasons applied; the reason string only appears in `dmesg`.

**The non-enforcing path returns a lockdown decision, not `0`.** This is the
actual seam between module signing and kernel lockdown that the rest of this
page talks about: with lockdown off, `security_locked_down()` returns 0 and the
load proceeds; at `lockdown=integrity` or above it returns `-EPERM` and the
unsigned module is refused even though `sig_enforce` is unset.

Note that `module_sig_check()` does not taint the kernel itself. Tainting
happens later, in `module_augment_kernel_taints()` in `kernel/module/main.c`,
which sees `info->sig_ok == false` and does:

```c
/* kernel/module/main.c */
pr_notice_once("%s: module verification failed: signature "
               "and/or required key missing - tainting "
               "kernel\n", mod->name);
add_taint_module(mod, TAINT_UNSIGNED_MODULE, LOCKDEP_STILL_OK);
```

That is `TAINT_UNSIGNED_MODULE`, the `E` flag — not `TAINT_OOT_MODULE` (`O`),
which is a separate check in the same function for a module with no `intree`
modinfo tag. An in-tree module you built and forgot to sign gets `E` and not
`O`; an out-of-tree module that is properly signed gets `O` and not `E`.

## Enrolled keys: the system keyring

The kernel maintains several keyrings, and it matters a great deal which one a
certificate lands in — `mod_verify_sig()` passes `VERIFY_USE_SECONDARY_KEYRING`
to `verify_pkcs7_signature()`, so module signature verification consults
`.secondary_trusted_keys` and, through links, `.builtin_trusted_keys` and
`.machine`. It does **not** consult `.platform`.

```bash
# View the kernel's built-in keyring:
keyctl show %:.builtin_trusted_keys
# Keyring
#  1234567 ---lswrv      0     0  keyring: .builtin_trusted_keys
#  7654321 ---lswrv      0     0   \_ asymmetric: My Org: Module Signing Key: abc123

# View the secondary keyring: keys added at runtime, plus a link to
# .builtin_trusted_keys and (if configured) a link to .machine:
keyctl show %:.secondary_trusted_keys
```

The four keyrings that matter for module signing, and what can reach each (the
kernel has others — `.blacklist`, `.ima`, `.evm` — that play no part here):

| Keyring | Populated by | Consulted for module signatures? |
| --- | --- | --- |
| `.builtin_trusted_keys` | compiled in: `CONFIG_MODULE_SIG_KEY`, `CONFIG_SYSTEM_TRUSTED_KEYS` | yes |
| `.secondary_trusted_keys` | keys added at runtime; also links to `.builtin_trusted_keys` and `.machine` | yes (`CONFIG_SECONDARY_TRUSTED_KEYRING`) |
| `.machine` | MOK certs, if `CONFIG_INTEGRITY_MACHINE_KEYRING` | yes — it is linked into `.secondary_trusted_keys` |
| `.platform` | UEFI Secure Boot `db`, and MOK certs otherwise | **no** — used for kexec images, dm-verity and similar, never modules |

Adding a key at runtime is not a matter of privilege — and in current mainline
it is not `.builtin_trusted_keys` you would be adding it to.
`Documentation/admin-guide/module-signing.rst` still describes a `keyctl padd`
flow against that keyring, but that flow is dead upstream. In
`system_trusted_keyring_init()` (`certs/system_keyring.c`),
`.builtin_trusted_keys` is allocated with `NULL` for the link-restriction
argument — it has no link restriction at all — and its permission mask is
`KEY_USR_VIEW | KEY_USR_READ | KEY_USR_SEARCH` with no `KEY_USR_WRITE`. It is
also never linked into any process keyring, so nothing in userspace *possesses*
it and the `KEY_POS_*` bits never come into play either. You can look at it;
you cannot write to it. It is filled once, at build time, from the compiled-in
certificates.

`.secondary_trusted_keys` is the ring that actually takes runtime additions,
and it is what the example below targets. It is allocated with `KEY_USR_WRITE`
and with the restriction returned by `get_builtin_and_secondary_restriction()`,
which installs `restrict_link_by_builtin_secondary_and_machine` when
`CONFIG_INTEGRITY_MACHINE_KEYRING=y` and
`restrict_link_by_builtin_and_secondary_trusted` otherwise. For a certificate
the rule is the same either way: the new key's X.509 wrapper must be validly
signed by a key already resident in the builtin or secondary ring (or, with the
machine keyring enabled, the machine ring). The machine-aware variant differs
only in also permitting the `.machine` keyring itself to be linked in — it
delegates every other case straight to
`restrict_link_by_builtin_and_secondary_trusted()`. Being root, holding
`CAP_SYS_ADMIN`, or turning `sig_enforce` off does not help; there is no
capability that lets you inject an unvouched-for key into the trust chain,
which is rather the point.

`restrict_link_by_builtin_trusted()` is a real function in the same file, and
it is the one usually named in write-ups about this — but it does not guard
`.builtin_trusted_keys`. Its users are the IMA blacklist keyring
(`.ima_blacklist`, in `security/integrity/ima/ima_mok.c`) and the
`"builtin_trusted"` method that `keyctl restrict_keyring` can apply to a
keyring of asymmetric keys (`crypto/asymmetric_keys/asymmetric_type.c`).

```bash
# Add a key that IS validly signed by a resident key:
keyctl padd asymmetric "" %:.secondary_trusted_keys < my_key.x509
# A key that is not vouched for is refused here no matter who you are.
```

## Enrolling a custom key (UEFI + Secure Boot)

```bash
# 1. Export the certificate
openssl x509 -in signing_key.pem -outform DER -out signing_key.der

# 2. Enroll into UEFI Machine Owner Key (MOK) database:
mokutil --import signing_key.der
# Prompts for a password; requires reboot to confirm in UEFI

# 3. Tell the firmware the MOK list may be trusted *inside* the kernel:
mokutil --trust-mok
# Also confirmed at reboot, like --import. This is what makes the firmware
# expose MokListTrustedRT. Without it, MOK certs land in .platform, which
# module signing does not consult.

# 4. Verify enrollment:
mokutil --list-enrolled | grep "Subject:"

# 5. Load a module signed with this key:
insmod mymodule.ko
```

Step 3 is the step most write-ups omit, and without it the whole exercise
silently accomplishes nothing for module loading. `get_handler_for_mok()` in
`security/integrity/platform_certs/keyring_handler.c` routes a MOK certificate
to `add_to_machine_keyring()` only when `CONFIG_INTEGRITY_MACHINE_KEYRING` is
enabled *and* the firmware exposes `MokListTrustedRT`; otherwise it falls back
to `add_to_platform_keyring()`, and a `.platform` key is invisible to
`mod_verify_sig()`. So "after reboot the key is trusted and modules signed with
it load" holds only on a kernel built with `CONFIG_INTEGRITY_MACHINE_KEYRING`
(v5.18+, commit `d19967764ba8`) whose MOK list has been marked trusted. On a
kernel without it there is no upstream path from `mokutil --import` to module
signature verification at all — you must rebuild with the certificate in
`CONFIG_SYSTEM_TRUSTED_KEYS` instead.

## Kernel lockdown mode

Linux lockdown (5.4+) restricts what root can do:

```bash
# Check lockdown mode:
cat /sys/kernel/security/lockdown
# [none] integrity confidentiality

# Modes:
# none:           no restrictions
# integrity:      prevent bypassing module signing and integrity checks
# confidentiality: also prevent reading kernel memory

# Set lockdown. lockdown_write() performs no capability check at all --
# access is governed purely by the securityfs file's mode (0644, root-owned).
# The one restriction is direction: lock_kernel_down() returns -EPERM if the
# requested level is not stronger than the current one, so you can ratchet
# up but never back down.
echo integrity > /sys/kernel/security/lockdown

# The other two ways in, both one-way as well:
#   lockdown=integrity        on the kernel command line (early_param)
#   CONFIG_LOCK_DOWN_KERNEL_FORCE_INTEGRITY at build time
```

!!! warning "Secure Boot does not enable lockdown upstream"

    A widely repeated claim is that enabling UEFI Secure Boot automatically
    puts the kernel into `lockdown=integrity`. That is **distro-kernel
    behaviour** — Fedora, RHEL and Ubuntu carry patches that do it — and not
    what mainline does. In mainline, `lock_kernel_down()` is `static` in
    `security/lockdown/lockdown.c` and has exactly three callers: the
    `lockdown=` boot parameter, the `CONFIG_LOCK_DOWN_KERNEL_FORCE_*` build
    choice, and the securityfs write above. No EFI or Secure Boot code path
    calls it. Coupling the two was proposed repeatedly and rejected upstream —
    see "Kernel lockdown locked out — for now" in the further reading below.
    On a vanilla kernel with Secure Boot on,
    `cat /sys/kernel/security/lockdown` still reports `[none]`.

    Mainline *does* couple Secure Boot to one thing, just not to lockdown: with
    `CONFIG_IMA_ARCH_POLICY=y`, detecting Secure Boot turns on module signature
    enforcement directly, without going through lockdown at all. See
    [the enforcement paths](#modprobe-force-does-not-defeat-enforcement) at the
    end of this page.

The reason codes are ordered in `enum lockdown_reason`, and
`LOCKDOWN_MODULE_SIGNATURE` is the very first one after `LOCKDOWN_NONE` — so
any lockdown level at all blocks unsigned modules. Everything up to
`LOCKDOWN_INTEGRITY_MAX` is an integrity reason; what comes after it is
blocked only at `confidentiality`.

Under `lockdown=integrity` (`lockdown_reasons[]` in `security/security.c`):

- Unsigned modules rejected — regardless of `MODULE_SIG_FORCE`, via the
  `security_locked_down()` call at the end of `module_sig_check()`
- `/dev/mem`, `/dev/kmem`, `/dev/port` access denied
- kexec of unsigned images, hibernation, direct PCI access, raw ioport and MSR
  access, ACPI table and device-tree modification
- debugfs access, unsafe module parameters, mmiotrace
- use of BPF to write *user* RAM, and kgdb/kdb to write kernel RAM

`confidentiality` adds the read-side restrictions on top: `/proc/kcore`,
kprobes, tracefs, perf, and BPF or kgdb reading kernel RAM.

## Debugging module signature issues

```bash
# Why did a module fail to load?
dmesg | grep -E "module|sig|sign|Lockdown" | tail -20
# Enforcement on, from module_sig_check():
#   Loading of unsigned module is rejected
# Enforcement off but loaded anyway, from module_augment_kernel_taints():
#   mymodule: module verification failed: signature and/or required key
#   missing - tainting kernel
# Lockdown refused it, from lockdown_is_locked_down():
#   Lockdown: insmod: unsigned module loading is restricted; see man
#   kernel_lockdown.7

# Check if module is signed:
modinfo mymodule.ko | grep sig_id
# (empty if unsigned)

# What's the kernel's signature enforcement status?
# sig_enforce is a module parameter of the built-in "module" module,
# not a sysctl -- there is no /proc/sys/kernel/sig_enforce:
cat /sys/module/module/parameters/sig_enforce
# Y or N. It is declared bool_enable_only, so it can be flipped N -> Y
# at runtime but never Y -> N:
echo 1 > /sys/module/module/parameters/sig_enforce   # works
echo 0 > /sys/module/module/parameters/sig_enforce   # -EROFS once set

# Check taint flags:
cat /proc/sys/kernel/tainted
# Bit 13 (value 8192) is TAINT_UNSIGNED_MODULE, the 'E' flag.
# Bit 12 (value 4096) is TAINT_OOT_MODULE, the 'O' flag -- different thing.
# See Documentation/admin-guide/tainted-kernels.rst for bit meanings
```

### `modprobe --force` does not defeat enforcement

A persistent myth is that `modprobe --force` bypasses `sig_enforce`. It does
the opposite of helping. `--force` is `--force-vermagic` plus
`--force-modversion`, which makes modprobe pass
`MODULE_INIT_IGNORE_VERMAGIC | MODULE_INIT_IGNORE_MODVERSIONS` to
`finit_module(2)` — and those are precisely the two flags that set
`mangled_module` in `module_sig_check()`. The signature is then not checked at
all; the module is treated as unsigned regardless of whether it carries a
perfectly valid signature.

```bash
# On a kernel with enforcement OFF: this loads, and taints with 'E'
modprobe --force mymodule

# On a kernel with enforcement ON: this FAILS, even for a signed module,
# because forcing marks it mangled and the unsigned path then rejects it
modprobe --force mymodule
# modprobe: ERROR: could not insert 'mymodule': Key was rejected by service
```

`Key was rejected by service` is `EKEYREJECTED`, the errno
`module_sig_check()` returns under enforcement. There is no flag that makes an
enforcing kernel load an unsigned module; the only ways out are to sign it with
a key the kernel already trusts, or to run a kernel that is not enforcing.

"Not enforcing" is a narrower condition than it looks, because `sig_enforce`
can never be cleared once set and mainline has three separate ways of setting
it:

1. **`CONFIG_MODULE_SIG_FORCE=y` at build time.** It is literally the
   initialiser: `static bool sig_enforce = IS_ENABLED(CONFIG_MODULE_SIG_FORCE)`
   in `kernel/module/signing.c`.
2. **`module.sig_enforce=1` on the command line**, or a later `1` written to
   `/sys/module/module/parameters/sig_enforce` — the same `bool_enable_only`
   parameter, which is why the write is one-way.
3. **Secure Boot, on a kernel with `CONFIG_IMA_ARCH_POLICY=y`.** This is the
   one that catches people out, because neither of the first two is present.
   `arch_get_ima_policy()` in `security/integrity/ima/ima_efi.c` calls
   `set_module_sig_enforced()` — unconditionally, before it returns the
   architecture rule set — as soon as `arch_get_secureboot()` reports Secure
   Boot on. `arch/powerpc/kernel/ima_arch.c` has the equivalent for
   `is_ppc_secureboot_enabled()`. So on x86, arm64 or powerpc (the three
   architectures that select the underlying
   `CONFIG_IMA_SECURE_AND_OR_TRUSTED_BOOT`), a kernel built with the IMA arch
   policy and booted under Secure Boot enforces module signatures even though
   `CONFIG_MODULE_SIG_FORCE` is unset, the command line says nothing about
   `sig_enforce`, and — per the warning above — lockdown still reads `[none]`.
   `cat /sys/module/module/parameters/sig_enforce` is the thing to check, not
   the config or the command line.

## Further reading

### Kernel source

- [kernel/module/signing.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/module/signing.c) — `module_sig_check()` and `mod_verify_sig()`: the marker check, the truncation of the signature block, and the `verify_pkcs7_signature()` call that does the actual verification against the secondary keyring
- [include/uapi/linux/module_signature.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/module_signature.h) — `MODULE_SIGNATURE_MARKER` (`"~Module signature appended~\n"`) and `struct module_signature`, with the field-order comment describing the signer/key-id/signature/info-block layout
- [kernel/module_signature.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/module_signature.c) — `mod_check_sig()`: the sanity check that rejects anything whose `id_type` is not `MODULE_SIGNATURE_TYPE_PKCS7`, or whose `algo`/`hash`/`signer_len`/`key_id_len` fields are non-zero
- [scripts/sign-file.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/scripts/sign-file.c) — the signing tool: argument order, the OpenSSL CMS/PKCS#7 call, and its four flags (`-s`, `-p`, `-d`, `-k`)
- [certs/system_keyring.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/certs/system_keyring.c) — allocation of `.builtin_trusted_keys` and `.secondary_trusted_keys` (the only two `keyring_alloc()` calls in the file), the link restriction on the latter via `get_builtin_and_secondary_restriction()`, and `set_machine_trusted_keys()`, which links the `.machine` ring — allocated over in `security/integrity/digsig.c` — into the secondary ring
- [certs/Kconfig](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/certs/Kconfig) — `CONFIG_MODULE_SIG_KEY`, the RSA/ECDSA/ML-DSA key-type choice, `CONFIG_SYSTEM_TRUSTED_KEYS`, and `CONFIG_SECONDARY_TRUSTED_KEYRING`
- [kernel/module/Kconfig](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/kernel/module/Kconfig) — `CONFIG_MODULE_SIG`, `CONFIG_MODULE_SIG_FORCE`, `CONFIG_MODULE_SIG_ALL`, and the full `CONFIG_MODULE_SIG_SHA*` hash choice
- [security/lockdown/lockdown.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/security/lockdown/lockdown.c) — the lockdown LSM: the `lockdown=` boot parameter, the `/sys/kernel/security/lockdown` securityfs file, and `lock_kernel_down()`'s refusal to move to a weaker level
- [commit 000d388ed3bb](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=000d388ed3bbed745f366ce71b2bb7c2ee70f449) — "security: Add a static lockdown policy LSM" (August 2019, merged for 5.4), the commit that introduced the integrity/confidentiality levels used above
- [commit d19967764ba8](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=d19967764ba876f5c82dabaa28f983b21eb642a2) — "integrity: Introduce a Linux keyring called machine" (January 2022, merged for 5.18), the upstream mechanism that lets MOK-enrolled keys reach the trust chain module signing consults

### Man pages

- [`finit_module(2)`](https://man7.org/linux/man-pages/man2/finit_module.2.html) — the load path itself; documents `EBADMSG` (misformatted signature) and `ENOKEY` ("returned only if the kernel was configured with `CONFIG_MODULE_SIG_FORCE`"), plus the `MODULE_INIT_IGNORE_MODVERSIONS`/`MODULE_INIT_IGNORE_VERMAGIC` flags. Note that the `ENOKEY` text is stale and contradicts the kernel as described above: since 5.4 an enforcing kernel returns `EKEYREJECTED`, not `ENOKEY`, and `ENOKEY` is instead one of the three *tolerated* errors inside `module_sig_check()`
- [`kernel_lockdown(7)`](https://man7.org/linux/man-pages/man7/kernel_lockdown.7.html) — what lockdown actually blocks: unsigned modules, `/dev/mem`, `/dev/kmem`, `/dev/kcore`, `/dev/ioports`, unsigned kexec images, BPF and kprobes
- [`keyctl(1)`](https://man7.org/linux/man-pages/man1/keyctl.1.html) — the `keyctl show` and `keyctl padd` subcommands and the `%:<name>` syntax used above to name `.builtin_trusted_keys`
- [`modprobe(8)`](https://man7.org/linux/man-pages/man8/modprobe.8.html) — what `--force` really is (`--force-vermagic` plus `--force-modversion`), which matters because a mangled module is no longer the module that was signed
- [`modinfo(8)`](https://man7.org/linux/man-pages/man8/modinfo.8.html) — dumping a `.ko`'s attribute fields, with `-F` to select a single one

### Related pages

- [Writing and Loading Kernel Modules](module-basics.md) — the module lifecycle this verification sits in front of
- [Module Loading Internals](module-loading-internals.md) — `load_module()`, ELF parsing, and where the signature check happens relative to relocation and symbol resolution
- [Kernel Keyring](../crypto/keyring.md) — key types, keyrings, and the key retention service that holds the trusted certificates
- [Kernel Crypto API](../crypto/crypto-api.md) — the hash machinery (`crypto_shash`) underneath signature verification; for the asymmetric side, see the "asymmetric" key type on the keyring page above
- [LSM Framework](../security/lsm.md) — the hook tables, `security_add_hooks()`, and how a module registers itself, which is the machinery the lockdown LSM plugs into
- [Linux Capabilities](../security/capabilities.md) — `CAP_SYS_MODULE`, the privilege required before signature checking is even reached

### LWN articles

- [Loading signed kernel modules](https://lwn.net/Articles/470906/) — Jake Edge, December 2011, on David Howells's early signed-module patches, which carried the signature in a `.module_sig` ELF section rather than appending it outside the ELF container
- [The module signing endgame](https://lwn.net/Articles/525592/) — Jake Edge, November 2012, on the build-time versus install-time signing argument that shaped `CONFIG_MODULE_SIG_ALL` and the standalone `scripts/sign-file` tool
- [Kernel lockdown locked out — for now](https://lwn.net/Articles/751061/) — Jonathan Corbet, April 2018, on Torvalds's objection to automatically enabling lockdown when UEFI Secure Boot is detected; worth reading before assuming any given kernel couples the two
- [Lockdown as a security module](https://lwn.net/Articles/791863/) — Jonathan Corbet, June 2019, on the LSM rework that landed, including why integrity reasons sort below confidentiality ones and where `LOCKDOWN_MODULE_SIGNATURE` fits

### External

- [Documentation/admin-guide/module-signing.rst](https://docs.kernel.org/admin-guide/module-signing.html) — the authoritative guide: every `CONFIG_MODULE_SIG_*` option, key generation via `certs/x509.genkey`, the four `sign-file` arguments, and the warning that signed modules must not be stripped afterwards
- [Documentation/security/keys/core.rst](https://docs.kernel.org/security/keys/core.html) — the key retention service behind the trusted keyrings, including `/proc/keys` and the `keyctl` interface
- [Documentation/admin-guide/tainted-kernels.rst](https://docs.kernel.org/admin-guide/tainted-kernels.html) — decoding `/proc/sys/kernel/tainted`, including the `E` flag set when an unsigned module is loaded on a signature-capable kernel
