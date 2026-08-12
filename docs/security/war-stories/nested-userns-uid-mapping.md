# Nested User Namespace UID/GID Mapping

> CVE-2018-18955 — a performance optimization kept two sorted copies of the ID map, the kernel translated only one of them, and a desktop user could read `/etc/shadow`

Disclosed
:   November 16, 2018 (fix authored November 5, 2018; mainline in v4.20-rc2)

Reported by
:   Jann Horn, Google Project Zero (issue 1712)

CVSS
:   7.0 HIGH (NVD primary, `CVSS:3.0/AV:L/AC:H/PR:L/UI:N/S:U/C:H/I:H/A:H`)

Bug present since
:   4.15 (commit `6397fac4915a`, October 2017)

Fixed in
:   4.18.19, 4.19.2 (mainline `d2f007dbe7e4`)

Exploit tool
:   yes — Exploit-DB 45886 (Project Zero PoC) and 45915 (Metasploit module)

Actively exploited
:   no confirmed cases (not on CISA KEV)

*Part of [War Stories: Linux Security Bugs and CVEs](../war-stories.md).*

## Before state

A user namespace's identity mapping is a small array of extents. Each extent is a triple — a starting ID inside the namespace, the corresponding starting ID in the *parent* namespace, and a count — and every `make_kuid()`/`from_kuid()` conversion walks that array. [User Namespaces and uid Mapping](../user-namespaces.md) covers how `/proc/<pid>/uid_map` is written and what the two directions mean; [Credentials and User Namespaces](../credentials.md) covers where `kuid_t` sits in `struct cred`. The short version is that there are two lookups, in opposite directions:

- `map_id_down()` — namespaced ID → kernel ID, matching against `extent->first`, used by `make_kuid()`.
- `map_id_up()` — kernel ID → namespaced ID, matching against `extent->lower_first`, used by `from_kuid()` and, critically, by `kuid_has_mapping()`.

Until 4.15 this array was five entries long and both lookups were linear scans over the same unsorted array. Five turned out to be too few for real container tooling: Christian Brauner [posted a patch](https://lore.kernel.org/all/20171004112009.22642-1-christian.brauner@ubuntu.com/) in October 2017 opening with a concrete LXD case — a user asking to map "everything but 999, and 1001 for a given range of 1000000000" — that consumes exactly the five available extents and leaves no room.

Raising the limit was constrained by a performance promise: `struct uid_gid_map` had to stay one cache line, because `map_id_up()` is on the `stat()` path. Brauner's first attempt used indirect and double-indirect pointers, filesystem-style, and kept lookups linear. Eric Biederman pushed back on the asymptotics in [his October 11 reply](https://lore.kernel.org/all/87d15t1klz.fsf@xmission.com/) — "I am concerned about an implementation that scales linearly with the number of mappings in the large. When it is know we should be able to scale at log(N) of the number of mappings" — and sketched the alternative himself: a union, one `kmalloc` of extents, and binary search. Brauner asked what "forward" and "reverse" were supposed to mean, and Biederman [answered plainly](https://lore.kernel.org/all/87lgkgz43i.fsf@xmission.com/):

> No. Intricacies missed. The sort for forward and reverse is different so we need two different arrays. One sorted on first the other sorted on lower_first.

That design shipped as [`6397fac4915a`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=6397fac4915ab3002dc15aae751455da1a852f25) ("userns: bump idmap limits to 340") in v4.15:

```c
/* include/linux/user_namespace.h */
#define UID_GID_MAP_MAX_BASE_EXTENTS 5
#define UID_GID_MAP_MAX_EXTENTS 340

struct uid_gid_map { /* 64 bytes -- 1 cache line */
	u32 nr_extents;
	union {
		struct uid_gid_extent extent[UID_GID_MAP_MAX_BASE_EXTENTS];
		struct {
			struct uid_gid_extent *forward;
			struct uid_gid_extent *reverse;
		};
	};
};
```

At five extents or fewer, `extent[]` is used and both directions scan the same entries. Past five, the union switches to two heap arrays holding the *same* extents in two different sort orders, and both lookups become `bsearch()`. `sort_idmaps()` built the second array by copying the first:

```c
/* kernel/user_namespace.c, pre-fix */
static int sort_idmaps(struct uid_gid_map *map)
{
	if (map->nr_extents <= UID_GID_MAP_MAX_BASE_EXTENTS)
		return 0;

	/* Sort forward array. */
	sort(map->forward, map->nr_extents, sizeof(struct uid_gid_extent),
	     cmp_extents_forward, NULL);

	/* Only copy the memory from forward we actually need. */
	map->reverse = kmemdup(map->forward, ...);
	...
	/* Sort reverse array. */
	sort(map->reverse, map->nr_extents, sizeof(struct uid_gid_extent),
	     cmp_extents_reverse, NULL);
	return 0;
}
```

The other thing to know about `map_write()` is that `lower_first` means two different things at two different times. While the map is being parsed out of the buffer the user wrote to `/proc/<pid>/uid_map`, `lower_first` holds an ID *in the parent namespace*. Only afterwards does a loop translate each one through the parent's map into a kernel-global ID:

```c
	/* Map the lower ids from the parent user namespace to the
	 * kernel global id space.
	 */
	for (idx = 0; idx < new_map.nr_extents; idx++) {
		...
		lower_first = map_id_range_down(parent_map, e->lower_first, e->count);
		...
		e->lower_first = lower_first;
	}
```

Pre-fix, `sort_idmaps()` ran **before** that loop, and the loop walked only `new_map.forward`.

## The trigger

Because `map->reverse` was a `kmemdup()` of `map->forward` taken before translation, and the translation loop only rewrote the forward copy, the reverse array kept parent-namespace IDs in its `lower_first` fields forever. `map_id_up()` — the kernel-ID-to-namespaced-ID direction — searches that array and compares kernel IDs against those stale parent-namespace values.

In a top-level namespace this is invisible: the parent is `init_user_ns`, so parent IDs *are* kernel IDs and the missing translation is the identity. The bug only appears one level down, and only past five extents. Jann Horn's [report](https://project-zero.issues.chromium.org/issues/42450783) gives the minimal recipe — a first namespace `NS1` with

```
0 100000 1000
```

then, from inside `NS1`, a nested `NS2` with six extents:

```
0 0 1
1 1 1
2 2 1
3 3 1
4 4 1
5 5 995
```

`NS2` crosses the five-extent threshold, so it uses the two-array path. Its `lower_first` values are `0..999` — IDs in `NS1` — which should translate to kernel IDs `100000..100999`. The forward array gets that translation; the reverse array does not. As Horn put it:

> then make_kuid(NS2, ...) will work properly, but from_kuid(NS2) will be an identity mapping for UIDs in the range 0..1000.

Reaching this needs a namespace with more than one ID mapped, which is exactly what `/etc/subuid`, `/etc/subgid` and the setuid `newuidmap`/`newgidmap` helpers hand any desktop user who has the `uidmap` package installed — a package Horn installed explicitly for his Ubuntu 18.04 test, and one the Metasploit module lists as a prerequisite. Horn's proof of concept used `newuidmap` for the first level, then wrote the six-extent map directly from inside `NS1`, where it already held namespaced `CAP_SYS_ADMIN`. NVD scores the vector `AC:H`, but the difficulty is in *finding* the shape, not in reproducing it.

## Observed behavior

Most callers of `from_kuid()` are display code — a wrong number in `ls -l` output is a bug, not a vulnerability. `kuid_has_mapping()` is not display code. It answers "does this kernel ID exist in that namespace at all," and two access checks are built on it: `inode_owner_or_capable()` and `privileged_wrt_inode_uidgid()`. Horn's summary of the consequence:

> Most users of from_kuid() are relatively boring, but kuid_has_mapping() is used in inode_owner_or_capable() and privileged_wrt_inode_uidgid(); so you can abuse this to gain the ability to override DAC security controls on files whose IDs aren't mapped in your namespace.

An unmapped kernel UID is supposed to be one your namespaced root has no authority over — that is the entire basis for letting unprivileged users hold `CAP_DAC_OVERRIDE` inside a namespace at all. With the reverse map untranslated, host UIDs `0..999` all appeared to be mapped in `NS2`, so its namespaced root looked capable with respect to files owned by real host root.

Horn's transcript makes the outcome concrete. Inside `NS1`, `/etc/shadow` shows up as owned by `nobody`/`nogroup` and reading it fails. Inside `NS2` — a *less* privileged namespace by construction — the same file shows as `root shadow`, and:

```
nobody@ubuntu-18-04-vm:~/userns_4_15$ head -n1 /etc/shadow
root:!:17696:0:99999:7:::
```

That is an unprivileged local user reading the shadow file on a stock Ubuntu 18.04 kernel, from a normal account with `uidmap` installed and subuid ranges allocated. The CVE affects every kernel from 4.15 through 4.19.1 — roughly a year of releases, covering the kernels shipped in Ubuntu 18.04 LTS, Kubuntu 18.04, Linux Mint 19 and Fedora Workstation 28, all of which the [Metasploit module](https://www.rapid7.com/db/modules/exploit/linux/local/nested_namespace_idmap_limit_priv_esc/) lists as tested targets.

Public tooling followed within two weeks: the Project Zero PoC was mirrored as [Exploit-DB 45886](https://www.exploit-db.com/exploits/45886) on the disclosure date, and `exploit/linux/local/nested_namespace_idmap_limit_priv_esc` (credited to Jann Horn and bcoles) landed as [Exploit-DB 45915](https://www.exploit-db.com/exploits/45915) on November 29, 2018. Despite that, the CVE has never been added to CISA's Known Exploited Vulnerabilities catalog — [NVD's record](https://nvd.nist.gov/vuln/detail/CVE-2018-18955) shows no KEV listing — no in-the-wild use has been confirmed.

## Why it happened

The root cause is a **derived copy taken before the source was finished**. `map->reverse` was correct at the instant `kmemdup()` ran and became wrong a few lines later, when the translation loop mutated the original. Nothing in the code expressed the relationship between the two arrays, so nothing flagged that one of them had gone stale.

Underneath that sits a subtler hazard: `lower_first` is a single `u32` field that holds a parent-namespace ID during parsing and a kernel-global ID after installation. It is the same type, the same name, and the same struct member throughout — a temporal type change with no compiler-visible marker. The forward array crossed that boundary; the reverse array never did.

It is worth being clear that this was not unreviewed code. The 340-extent series went through multiple revisions across three weeks with Serge Hallyn and Eric Biederman replying on the thread (Tycho Andersen was Cc'd but didn't post), plus a [five-patch follow-up series](https://lore.kernel.org/all/871sliubhj.fsf_-_@xmission.com/) from Biederman — where Peter Zijlstra, Nikolay Borisov and Joe Perches did review — that found a genuine correctness bug of a different kind — `nr_extents` being read twice while the map was being written, so that "it could be 0 the first time and > 5 the second time, which would lead to misinterpreting the union fields." That review was attentive; it was attentive to concurrency, cache lines and memory barriers, which is where the danger looked like it was. A one-time initialization ordering mistake in the write path was not the risk class anyone was scanning for.

Finally, the buggy path was almost unreachable by accident. Six or more extents is unusual; six or more extents *in a nested namespace* is unusual squared. Container runtimes that use many extents typically do so at the outermost namespace, where the parent is `init_user_ns` and the missing translation is a no-op. The bug therefore produced no functional complaints for a year — no wrong `ls` output, no broken container, nothing to bisect — until someone went looking for it deliberately.

## Resolution

[`d2f007dbe7e4`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=d2f007dbe7e4c9583eea6eb04d60001e85c6f1bd) ("userns: also map extents in the reverse map to kernel IDs"), authored by Jann Horn on November 5, 2018, is eight lines added and four removed. It moves `sort_idmaps()` from before the translation loop to after it:

```diff
-	ret = sort_idmaps(&new_map);
-	if (ret < 0)
-		goto out;
-
 	ret = -EPERM;
 	/* Map the lower ids from the parent user namespace to the
 	 * kernel global id space.
 	 */
 	for (idx = 0; idx < new_map.nr_extents; idx++) {
 		...
 		e->lower_first = lower_first;
 	}

+	/*
+	 * If we want to use binary search for lookup, this clones the extent
+	 * array and sorts both copies.
+	 */
+	ret = sort_idmaps(&new_map);
+	if (ret < 0)
+		goto out;
```

The ordering is load-bearing in both directions, and the commit message says why:

> To fix it, we have to make sure that the "lower_first" members of extents in both arrays are translated; and we have to make sure that the reverse map is sorted *after* the translation (since otherwise the translation can break the sorting).

Sorting first and translating second cannot work, because the reverse array's sort key *is* `lower_first`. Translating in place after sorting would silently destroy the ordering that `bsearch()` depends on. Cloning after translation gets both properties at once: the copy inherits already-translated values, and each array is then sorted on a key that will not change again. The forward array is unaffected either way — it sorts on `first`, which translation never touches.

The commit carries `Fixes: 6397fac4915a`, `Cc: stable@vger.kernel.org`, and both `Tested-by:` and `Reviewed-by:` from Eric Biederman, who also applied it. It shipped in the 4.18.19 and 4.19.2 stable releases, tagged November 13, 2018, with distribution updates following ([USN-3832-1](https://usn.ubuntu.com/3832-1/), 3833-1, 3835-1, 3836-1/-2 for Ubuntu).

**On the discussion: there wasn't one, publicly.** This is worth stating plainly rather than papering over. The patch has no `Link:` trailer, and a search of the mailing-list archives turns up no posting of it to LKML, `linux-security-module` or the containers list before it was applied — it went through `security@kernel.org` under embargo and was merged directly. Its first public appearance was a day earlier than the stable postings below: Biederman's [`[GIT PULL] namespace fixes for v4.20-rc2`](https://lore.kernel.org/lkml/87pnvcls3n.fsf@xmission.com/), November 10, 2018, whose shortlog credits "Jann Horn (1): userns: also map extents in the reverse map to kernel IDs" and whose body calls it one of several "simple obviously correct bug fixes." The only replies are two automated merge-tracker acknowledgments and an apology from kernel.org's Konstantin Ryabitsev for duplicate bot mail — no human review. It then appeared in Greg Kroah-Hartman's stable-review postings on November 11, 2018 ([`[PATCH 4.18 349/350]`](https://lore.kernel.org/all/20181111221722.721113385@linuxfoundation.org/) and [`[PATCH 4.19 359/361]`](https://lore.kernel.org/all/20181111221702.182204786@linuxfoundation.org/)), neither of which drew a reply on this patch either. Public discussion of record consists of Horn's [oss-security post](https://www.openwall.com/lists/oss-security/2018/11/16/1) three days after the stable releases and the Project Zero issue it links to — not a review thread. Anyone reconstructing this bug's history from mailing lists alone will find the 2017 thread that introduced it and nothing substantive about the fix.

There is one genuine follow-up thread, and it is a late one. In July 2021 — two years and eight months after the fix — Richard Palethorpe of SUSE [posted a reproducer to LTP](https://lore.kernel.org/all/20210712162208.2396-1-rpalethorpe@suse.com/), `userns08`, tagged `{"linux-git", "d2f007dbe7e4"}` and `{"CVE", "CVE-2018-18955"}`, building the same two-level namespace with a six-extent inner map and asserting that opening a restricted file fails with `EACCES`. Cyril Hrubis reviewed it with routine style notes (use `TST_CHECKPOINT_WAKE_AND_WAIT()`, number checkpoints from zero, `SAFE_OPEN(..., O_CREAT, 0700)` was missing `O_WRONLY`) and a v2 addressed them. The interesting part is the timing: for nearly three years the only executable artifact that would have caught a regression here was Horn's exploit.

```bash
# Is this kernel on the two-array path for a given process?
wc -l < /proc/self/uid_map     # more than 5 lines => forward/reverse bsearch arrays in use

# Reachability knobs (names vary by distro)
sysctl kernel.unprivileged_userns_clone   # if present, 0 blocks unprivileged userns creation
cat /proc/sys/user/max_user_namespaces    # 0 blocks it generically
ls -l /usr/bin/newuidmap                  # the setuid helper that grants a >1-ID first-level map
```

## What it taught us

**A copy is a promise you have to keep.** `kmemdup()` produced a second array that was correct for exactly the few lines before the original changed. Any time performance work introduces a derived representation — a sorted duplicate, a cached index, a reverse map — the invariant "these two agree" becomes a maintenance obligation that the type system will not help you with. Deriving *last*, after the source is final, is cheaper than keeping two things in sync.

**A field that changes meaning mid-function is an unlabeled type change.** `lower_first` held a parent-namespace ID on the way in and a kernel-global ID on the way out. Both are `u32`, both are spelled the same, and the only thing separating them is one loop. When the same storage carries two incompatible interpretations, every code path has to be checked for which side of the transition it lives on — and the reverse array's path was the one nobody checked.

**Review catches the risk class it is looking for.** The series that introduced this bug got multiple revisions and a dedicated follow-up series from the subsystem maintainer, which found a real read-twice race that could have misinterpreted the union. The reviewers were thinking about concurrency and cache-line layout because that is what the patch was *about*. Initialization order in the write path was not on anyone's list, and being reviewed hard along one axis says very little about the others.

**"Only reachable by nesting" means "only reachable by an attacker."** The unmapped-reverse bug was inert in a top-level namespace, silent in every normal container configuration, and produced no user-visible symptom for a year. Configurations that legitimate software never generates do not get bug reports — they get security researchers. Depth of nesting, unusual counts, and boundary configurations deserve deliberate tests precisely because nothing else will exercise them.

!!! warning "Pattern to watch for"
    Look for two things together: a data structure duplicated for lookup speed, and a field that is rewritten in place after that duplicate is made. Either alone is fine; combined, they mean one copy silently holds pre-transformation values. Grep for `kmemdup()`/`memcpy()` of a structure that is subsequently mutated in the same function, and ask which copy each later reader consults. On the operational side: any kernel where unprivileged user namespaces can be nested is a kernel where namespace-scoped access checks — `kuid_has_mapping()`, `inode_owner_or_capable()`, `privileged_wrt_inode_uidgid()` — are security boundaries reachable by any local user.

## See also

- [User Namespaces and uid Mapping](../user-namespaces.md) — `uid_map`/`gid_map`, `make_kuid()`/`from_kuid()`, and the nesting model this bug exploited
- [Credentials and User Namespaces](../credentials.md) — where `kuid_t` lives in `struct cred` and how ID translation reaches access checks
- [Capabilities](../capabilities.md) — the capability model behind `CAP_DAC_OVERRIDE` and `CAP_SYS_ADMIN`, and how `capable()`/`ns_capable()` checks are written
- [Netfilter x_tables Heap Overflow](../../net/war-stories/netfilter-xtables.md) — another bug whose severity came from being reachable inside an unprivileged user namespace

## External references

- [NVD: CVE-2018-18955](https://nvd.nist.gov/vuln/detail/CVE-2018-18955) — CVSS 3.0 base score 7.0 HIGH, `AV:L/AC:H/PR:L/UI:N/S:U/C:H/I:H/A:H`, published November 16, 2018
- [git.kernel.org: d2f007dbe7e4](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=d2f007dbe7e4c9583eea6eb04d60001e85c6f1bd) — "userns: also map extents in the reverse map to kernel IDs", the fix, which self-identifies as CVE-2018-18955
- [lore.kernel.org: [GIT PULL] namespace fixes for v4.20-rc2](https://lore.kernel.org/lkml/87pnvcls3n.fsf@xmission.com/) — the fix's actual first public appearance, one day before the stable-review postings
- [git.kernel.org: 6397fac4915a](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=6397fac4915ab3002dc15aae751455da1a852f25) — "userns: bump idmap limits to 340", the commit named in the `Fixes:` trailer
- [Project Zero issue 1712](https://project-zero.issues.chromium.org/issues/42450783) — Jann Horn's original report, analysis and reproducer (formerly `bugs.chromium.org/p/project-zero/issues/detail?id=1712`)
- [oss-security: broken uid/gid mapping for nested user namespaces with >5 ranges](https://www.openwall.com/lists/oss-security/2018/11/16/1) — Horn's public disclosure post, November 16, 2018
- [lore.kernel.org: user namespaces: bump idmap limits](https://lore.kernel.org/all/20171004112009.22642-1-christian.brauner@ubuntu.com/) — the October 2017 review thread where the forward/reverse two-array design was proposed and agreed
- [lore.kernel.org: userns: bump idmap limits, fixes & tweaks](https://lore.kernel.org/all/871sliubhj.fsf_-_@xmission.com/) — Eric Biederman's follow-up series, including the `nr_extents` read-twice fix
- [lore.kernel.org: userns08, CVE-2018-18955: Broken id mappings in nested namespaces](https://lore.kernel.org/all/20210712162208.2396-1-rpalethorpe@suse.com/) — the LTP regression test added in July 2021, with Cyril Hrubis's review
- [Exploit-DB 45886](https://www.exploit-db.com/exploits/45886) and [45915](https://www.exploit-db.com/exploits/45915) — the Project Zero proof of concept and the Metasploit module derived from it
- [Rapid7: exploit/linux/local/nested_namespace_idmap_limit_priv_esc](https://www.rapid7.com/db/modules/exploit/linux/local/nested_namespace_idmap_limit_priv_esc/) — module documentation, including the tested distributions and the `uidmap`-package prerequisite
- [Ubuntu: USN-3832-1](https://usn.ubuntu.com/3832-1/) — one of five Ubuntu advisories issued for this CVE
