# The fs_context Legacy Parameter Overflow

> CVE-2022-0185 — a bounds check written as `PAGE_SIZE - 2 - size` in unsigned arithmetic let `unshare -Urm` plus a loop of `fsconfig()` calls write past the end of a 4 KB slab object, and turned Google's hardened Kubernetes CTF cluster into a $31,337 payout

**Disclosed:** 18 January 2022 &nbsp;·&nbsp; **Reported by:** the Crusaders of Rust CTF team — Alec Petridis, Hrvoje Mišetić, Isaac Badipe, Jamie Hill-Daniel, Philip Papurt and William Liu — after independent discoveries by syzbot (31 December 2021, on an Android tree) and by StarLabs &nbsp;·&nbsp; **CVSS:** 8.4 HIGH (`CVSS:3.1/AV:L/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H`, NVD primary) &nbsp;·&nbsp; **Bug present since:** 5.1-rc1 (2019) &nbsp;·&nbsp; **Fixed in:** 5.4.173, 5.10.93, 5.15.16, 5.16.2 (all 20 January 2022), mainline 5.17-rc1 &nbsp;·&nbsp; **Exploit tool:** yes — two independent public exploits, no Exploit-DB or Metasploit entry &nbsp;·&nbsp; **Actively exploited:** yes — added to [CISA's KEV catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) on 21 August 2024

*Part of [War Stories: Linux Security Bugs and CVEs](../war-stories.md).*

## Before state

Linux 5.1 shipped David Howells' filesystem context work, merged as [`3e1aeb00e6d1`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=3e1aeb00e6d132efc151dacc062b38269bc9eccc) ("vfs: Implement a filesystem superblock creation/configuration context") — the `fs_context` infrastructure and `legacy_parse_param()`. Linux 5.2 then added the new mount API syscalls that actually drive it from userspace — `fsopen()`, `fsconfig()`, `fsmount()`, `move_mount()`. Instead of handing the kernel one opaque option string at `mount()` time, userspace now opens a *context* and feeds it parameters one at a time, each as a separate syscall.

Almost no filesystem was converted to the new interface at once. Until the legacy path was deleted in 7.0, `alloc_fs_context()` carried Howells' original comment on the fallback:

```c
/* TODO: Make all filesystems support this unconditionally */
init_fs_context = fc->fs_type->init_fs_context;
if (!init_fs_context)
    init_fs_context = legacy_init_fs_context;
```

For every filesystem that had not implemented `init_fs_context` — ext4 among them, from 5.1 until its conversion in 5.17 — parameters flowed into `legacy_parse_param()` in `fs/fs_context.c`, whose job was to rebuild the comma-separated option string the old `->mount()` hook still expects. It accumulated that string in a single `kmalloc(PAGE_SIZE)` buffer, tracking how much it had written in `ctx->data_size`:

```c
static int legacy_parse_param(struct fs_context *fc, struct fs_parameter *param)
{
	struct legacy_fs_context *ctx = fc->fs_private;
	unsigned int size = ctx->data_size;
	size_t len = 0;
	...
	if (len > PAGE_SIZE - 2 - size)
		return invalf(fc, "VFS: Legacy: Cumulative options too large");
	...
	if (!ctx->legacy_data) {
		ctx->legacy_data = kmalloc(PAGE_SIZE, GFP_KERNEL);
		...
	}
	ctx->legacy_data[size++] = ',';
	len = strlen(param->key);
	memcpy(ctx->legacy_data + size, param->key, len);
	size += len;
	if (param->type == fs_value_is_string) {
		ctx->legacy_data[size++] = '=';
		memcpy(ctx->legacy_data + size, param->string, param->size);
		size += param->size;
	}
	ctx->legacy_data[size] = '\0';
	ctx->data_size = size;
```

The `- 2` reserves room for the separating comma and the trailing NUL (the `=` is already folded into `len` itself for string-valued params). `size` is an `unsigned int`; `PAGE_SIZE` is an unsigned long; `len` is a `size_t`. Every operand is converted to unsigned long before the subtraction runs, so the result can never be negative.

## The trigger

Each successful append advances `size` by `len + 1`, and the check permits `len <= PAGE_SIZE - 2 - size`. Run that arithmetic to its limit and `size` is allowed to reach exactly **4095** — one byte short of the buffer, with the NUL landing on the last valid byte. That is a legal, in-bounds state the check itself produces.

On the next call, `PAGE_SIZE - 2 - size` evaluates to `4096 - 2 - 4095`. In unsigned arithmetic that is not `-1`; it is `ULONG_MAX`. No `len` can exceed it, the guard never fires, the comma store at `legacy_data[4095]` still lands in bounds, and the very next byte written — the `'='` at offset 4096 — is the first out-of-bounds write. Because `size` keeps growing, every subsequent `fsconfig()` call writes further past the end — a repeatable, attacker-positioned, attacker-contented heap write, bounded per call only by `fs/fsopen.c`'s `strndup_user(_key, 256)` and `strndup_user(_value, 256)` limits on key and value length respectively.

Landing on 4095 exactly takes arithmetic, not luck. The discoverers' proof of concept uses an empty key and a 33-byte value, so each call adds `1 + 0 + 1 + 33 = 35` bytes; 117 calls put `data_size` at precisely `35 × 117 = 4095`:

```c
fd = fsopen("ext4", 0);
for (int i = 0; i < 117; i++)
	fsconfig(fd, FSCONFIG_SET_STRING, "\x00", pat, 0);
/* the 118th call writes out of bounds */
```

Reaching `fsopen()` at all requires `CAP_SYS_ADMIN` — but only in the user namespace that owns the caller's mount namespace (`ns_capable(current->nsproxy->mnt_ns->user_ns, CAP_SYS_ADMIN)`). As the [oss-security announcement](https://www.openwall.com/lists/oss-security/2022/01/18/7) put it: "An unprivileged user can use `unshare(CLONE_NEWNS|CLONE_NEWUSER)` to enter a namespace with the CAP_SYS_ADMIN permission, and then proceed with exploitation to root the system." On any distribution shipping unprivileged user namespaces — Ubuntu, Debian, and every container runtime that relies on them — the practical privilege requirement is none, which is why NVD scores this `PR:N` despite it being a local bug.

## Observed behavior

The kernel-visible symptom is a KASAN slab-out-of-bounds write in the `kmalloc-4k` cache, as seen in the Crusaders of Rust fuzzing run that led to public disclosure:

```
BUG: KASAN: slab-out-of-bounds in legacy_parse_param+0x450/0x640 fs/fs_context.c:569
Write of size 1 at addr ffff88802d7d9000 by task syz-executor.12/386100
...
 vfs_parse_fs_param+0x1fd/0x390 fs/fs_context.c:146
 vfs_fsconfig_locked+0x177/0x340 fs/fsopen.c:265
 __x64_sys_fsconfig+0x6a6/0x7a0 fs/fsopen.c:314
The buggy address is located 0 bytes to the right of
 4096-byte region [ffff88802d7d8000, ffff88802d7d9000)
```

What made it a privilege-escalation bug rather than a crash is where that write lands. In [their writeup](https://www.willsroot.io/2022/01/cve-2022-0185.html), William Liu and the Crusaders of Rust describe placing a `msg_msg` object immediately after the legacy-data allocation, corrupting its size field, and using `MSG_COPY` to read out of bounds — leaking `seq_operations` pointers sprayed via `open("/proc/self/stat")` to defeat KASLR. For the arbitrary write in their Ubuntu exploit they needed to stall a `usercopy` mid-flight; with unprivileged `userfaultfd` disabled by default since 5.11, they used a FUSE filesystem of their own instead, whose read handler simply hangs, and finished by overwriting `modprobe_path`. Google's kCTF containers had a stripped `/dev` with no FUSE and no `userfaultfd`, so the escape exploit used `msg_msg`'s unlink primitive instead: it points a `pipe_buffer`'s operations pointer at a sprayed fake table and ROPs through `prepare_kernel_cred()`/`commit_creds()` and `switch_task_namespaces(find_task_by_vpid(1), init_nsproxy)` — the last of which is what converts root-in-a-container into root on the host.

The writeup notes an irony worth recording: an anti-exploitation hardening change made the exploit *more* reliable. Because SLUB has stored its freelist pointer in the middle of each object rather than at its start since 5.7, a string-shaped overflow through the first `0x30` bytes of the following chunk — exactly the region `msg_msg` cares about — no longer corrupts slab metadata, so the overflow could be repeated with a fresh `fsopen()` context until it succeeded.

They used it to escape Google's hardened kCTF Kubernetes containers and read another pod's flag, earning a $31,337 bounty — reduced from the maximum because a researcher going by n0psledbyte had found the same bug earlier without properly reporting or disclosing it, a collision Crusaders of Rust learned about only after their own report. A week later, Alejandro Guerrero [published an independent exploit](https://www.openwall.com/lists/oss-security/2022/01/25/14) on oss-security targeting Ubuntu 21.04 with kernel 5.11. Two and a half years after that, CISA added CVE-2022-0185 to its [Known Exploited Vulnerabilities catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) (21 August 2024), and NVD's SSVC data records its exploitation status as **active**. There is no Exploit-DB entry and no Metasploit module; the [Crusaders of Rust repository](https://github.com/Crusaders-of-Rust/CVE-2022-0185) — created 19 January 2022, with the working exploits published 25 January — is the exploit distribution channel, and NVD tags it as such.

## Why it happened

The check is not missing. It is the right check, computed in the wrong direction. `len > PAGE_SIZE - 2 - size` asks "does this parameter fit in the remaining space?" by first computing the remaining space — and *computing the remainder* is precisely the step that can go wrong when the types are unsigned. `size + len + 2 > PAGE_SIZE` asks the same question without ever forming a value that could underflow.

What makes it more than a textbook underflow is that the guard's own success condition walks `size` to the value at which the guard breaks. There is no illegal input needed to set up the bug: 117 perfectly valid `fsconfig()` calls, each of which the check correctly accepts, leave the context in the one state where the 118th call is unchecked. The invariant the check actually maintained (`size <= PAGE_SIZE - 1`) and the invariant its own arithmetic needed (`size <= PAGE_SIZE - 2`) were off by exactly one reachable step.

The exposure was also much wider than "one legacy code path." `legacy_parse_param()` dates from 2018 as a compatibility shim, written when the only way to reach it was `mount()` with a monolithic option string. The 5.2 mount-API syscalls gave userspace a way to drive that shim one parameter at a time, with byte-level control over the accumulated length — a granularity the original code was never designed to be fed. Three years passed with nobody noticing; then two fuzzers found it six days apart. As Liu observed in his own comments, "It was interesting to see how both of our fuzzer and syzbot's found this bug a few days apart in 2022 while the bug existed since 2019 — perhaps some recent change in either the kernel or syzkaller made it easier to trigger."

A separate, earlier find is the uncomfortable part. [syzbot reported it on 31 December 2021](https://groups.google.com/g/syzkaller-android-bugs/c/hWixpJ22kc8/m/MrIgyhQvEAAJ) — subject "KASAN: slab-out-of-bounds Write in legacy_parse_param", bug ID `02b637bea12b3944b0b9`, a distinct crash in the same function (`fs/fs_context.c:603` on the `android12-5.4` tree, rather than the CoR run's `fs/fs_context.c:569` on 5.14) and with syz and C reproducers that syzbot posted to the same thread fifteen minutes later. It landed on `syzkaller-android-bugs`, not on a VFS list, and no human replied until Lee Jones posted the already-public upstream fix to the thread on 26 January 2022 — eight days after the CVE was announced.

## Resolution

[`722d94847de2`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=722d94847de29310e8aa03fcbdb41fc92c521756) ("vfs: fs_context: fix up param length parsing in legacy_parse_param"), authored by Jamie Hill-Daniel on 18 January 2022, is a one-line change:

```c
-	if (len > PAGE_SIZE - 2 - size)
+	if (size + len + 2 > PAGE_SIZE)
		return invalf(fc, "VFS: Legacy: Cumulative options too large");
```

Its commit message states the rule plainly: "The 'PAGE_SIZE - 2 - size' calculation in legacy_parse_param() is an unsigned type so a large value of 'size' results in a high positive value instead of a negative value as expected. Fix this by getting rid of the subtraction."

The trailers are the interesting part. The patch carries `Signed-off-by` from Hill-Daniel and William Liu, `Tested-by` from Salvatore Bonaccorso (Debian) and Thadeu Lima de Souza Cascardo (Canonical), and `Acked-by` from both Dan Carpenter and Al Viro, before Greg Kroah-Hartman's and Linus Torvalds' sign-offs. That is a distribution-security review chain, not a public mailing-list one — and it shows: **there is no pre-merge upstream submission or review thread for this patch.** The commit has no `Link:` trailer, and it was never posted to linux-fsdevel or LKML for design discussion before landing. The bug was reported privately (Red Hat's [Bugzilla 2040358](https://bugzilla.redhat.com/show_bug.cgi?id=2040358) was filed on 13 January 2022), reviewed under embargo, and pushed straight to mainline on the day of public disclosure. The public discussion happened elsewhere: the [oss-security announcement](https://www.openwall.com/lists/oss-security/2022/01/18/7) on 18 January, John Haxby's reply the same hour assigning CVE-2022-0185, and Guerrero's exploit post a week later. The only place the fix itself later surfaces on a mailing list is downstream: as one of twenty-eight patches in Greg Kroah-Hartman's 5.16.2-rc1 stable-review series. Anyone reconstructing this fix's *design* history from lore alone will find only that stable-review posting and its sibling backports.

Those backports were fast: 5.4.173, 5.10.93, 5.15.16 and 5.16.2 were all released on 20 January 2022, two days after disclosure, all four carrying the fix. Operators who could not reboot immediately had one real mitigation, since the bug is unreachable without a namespace granting `CAP_SYS_ADMIN`:

```bash
# Debian/Ubuntu-style knob: 0 blocks unprivileged user namespace creation
sysctl kernel.unprivileged_userns_clone
# Upstream since 4.9; a hard cap on how many userns any user may create
sysctl user.max_user_namespaces
```

Both break rootless containers and anything else that legitimately unshares a user namespace, which is exactly the trade-off container platforms spent early 2022 arguing about.

## What it taught us

**Write bounds checks as sums, never as differences.** `a + b > LIMIT` and `b > LIMIT - a` are equivalent in mathematics and are not equivalent in C. Any check whose left-hand side subtracts an attacker-influenced quantity from a constant is one large input away from being a no-op, and no amount of care about the *comparison* helps if the *subtraction* is where the truth is lost.

**A guard that lets its own precondition be reached is not a guard.** The check permitted `size` to grow to exactly the value at which it stopped working. Bugs of this shape survive review because every individual step looks correct — the failure only exists in the sequence, and reviewers read functions, not sequences.

**A new syscall can weaponize old code without changing a line of it.** `legacy_parse_param()` was as correct in 5.1 as in 5.2; what changed was that `fsconfig()` let an attacker drive it 35 bytes at a time instead of handing it one string. When you add a finer-grained interface to an existing subsystem, the compatibility shim behind it is now reachable in ways its author never modelled.

**"Requires CAP_SYS_ADMIN" stopped being a mitigating factor around 2013.** NVD scored this bug `PR:N` — privileges required, none — for a code path explicitly gated on the most powerful capability Linux has, because `unshare -Urm` hands that capability to any user on a default Ubuntu install. Severity triage that reads capability checks as trust boundaries will systematically under-rate this whole class of bug.

!!! warning "Pattern to watch for"
    Grep your own code for bounds checks of the form `LIMIT - x - y` where any operand is unsigned and attacker-influenced — `PAGE_SIZE - hdr - len`, `sizeof(buf) - offset`, `count - consumed`. Each is a candidate for the same rewrite. Then check the second half of the pattern: whether repeated *valid* operations can walk the accumulator to the boundary value. On the operational side, treat every `fsopen()`/`fsconfig()`-reachable path, and every `CAP_SYS_ADMIN`-gated one, as unprivileged-reachable unless you have explicitly disabled unprivileged user namespaces.

## See also

- [User Namespaces and Credential Mapping](../user-namespaces.md) — how `unshare(CLONE_NEWUSER)` grants a full capability set inside the new namespace, the mechanism this exploit depends on entirely
- [Linux Capabilities](../capabilities.md) — including why `CAP_SYS_ADMIN` in particular is the capability that keeps showing up in escalation chains
- [Filesystem Registration and Mounting](../../vfs/mounting.md) — `struct fs_context`, `init_fs_context()`, and the mount path this bug lives in
- [Kernel Hardening](../kernel-hardening.md) — KASLR, hardened usercopy and SMAP/SMEP, all of which the published exploits had to work around

## External references

- [NVD: CVE-2022-0185](https://nvd.nist.gov/vuln/detail/CVE-2022-0185) — CVSS 8.4 HIGH, affected ranges, and the references NVD tags as `Exploit`
- [git.kernel.org: 722d94847de2](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=722d94847de29310e8aa03fcbdb41fc92c521756) — "vfs: fs_context: fix up param length parsing in legacy_parse_param", the one-line fix and its review trailers
- [git.kernel.org: 3e1aeb00e6d1](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=3e1aeb00e6d132efc151dacc062b38269bc9eccc) — David Howells' filesystem-context series, which introduced `legacy_parse_param()` in 5.1-rc1
- [oss-security: Linux kernel: Heap buffer overflow in fs_context.c since version 5.1](https://www.openwall.com/lists/oss-security/2022/01/18/7) — the 18 January 2022 disclosure by William Liu, with the underflow analysis and the `unshare` requirement
- [oss-security: CVE-2022-0185: Linux kernel slab out-of-bounds write: exploit and writeup](https://www.openwall.com/lists/oss-security/2022/01/25/14) — Alejandro Guerrero's independent exploit for Ubuntu 21.04, and the full credit list for the discovery
- [Will's Root: CVE-2022-0185 — Winning a $31337 Bounty after Pwning Ubuntu and Escaping Google's KCTF Containers](https://www.willsroot.io/2022/01/cve-2022-0185.html) — the discoverers' primary writeup: syzkaller setup, `msg_msg` and FUSE technique, and the kCTF container escape
- [GitHub: Crusaders-of-Rust/CVE-2022-0185](https://github.com/Crusaders-of-Rust/CVE-2022-0185) — the published exploits, including `exploit_kctf.c`
- [syzkaller-android-bugs: KASAN: slab-out-of-bounds Write in legacy_parse_param](https://groups.google.com/g/syzkaller-android-bugs/c/hWixpJ22kc8/m/MrIgyhQvEAAJ) — syzbot's 31 December 2021 report against `android12-5.4`, unanswered until after public disclosure
- [Red Hat Bugzilla 2040358](https://bugzilla.redhat.com/show_bug.cgi?id=2040358) — the private vendor report, filed 13 January 2022
- [CISA: Known Exploited Vulnerabilities Catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) — CVE-2022-0185 added 21 August 2024, CWE-190, with a 11 September 2024 remediation due date for federal agencies
