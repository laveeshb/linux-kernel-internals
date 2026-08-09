# Block Cgroup: Controlling I/O

> How the kernel divides a device's bandwidth between cgroups — by hard limit, by proportional weight, or by latency target

When several workloads share one disk, the default is a free-for-all: a batch job doing heavy writes can starve an interactive service on the same device. The block I/O controller (`blkcg`) is how cgroup v2 imposes order — and it offers three genuinely different policies, because "fairness" means different things to different people.

## Three knobs, three policies

The cgroup v2 `io` controller exposes several interface files, each backed by a different in-kernel policy:

### `io.max` — hard limits ([blk-throttle](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/block/blk-throttle.c))

Absolute ceilings per device: `rbps`, `wbps`, `riops`, `wiops`. A cgroup that exceeds its cap has its I/O delayed until it's back under budget.

```
# 10 MB/s write cap on device 259:0
echo "259:0 wbps=10485760" > io.max
```

Simple and predictable — but it **wastes capacity**: a capped cgroup can't borrow idle bandwidth even when the device is otherwise doing nothing. Good for hard multi-tenant isolation or billing; poor for utilization.

### `io.weight` — proportional sharing ([blk-iocost](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/block/blk-iocost.c) / BFQ)

A weight from 1 to 10000 (default 100). Bandwidth is divided *in proportion* to weights among the cgroups that are actually competing — a weight-200 cgroup gets roughly twice the share of a weight-100 one — but idle capacity is still used. There are two implementations:

- **BFQ**, the [I/O scheduler](io-schedulers.md), honors `io.weight` directly through its proportional-share algorithm. Accurate, but its per-request bookkeeping is too costly for the fastest devices.
- **blk-iocost** (introduced in [`7caa47151ab2`](https://git.kernel.org/linus/7caa47151ab2), "blkcg: implement blk-iocost") works with *any* scheduler, including `none`. Instead of scheduling, it builds a **cost model** of the device — estimating how much of the device's capacity each I/O consumes — and paces each cgroup to its fair share. This is what makes proportional control practical on fast NVMe, where BFQ's overhead would dominate.

### `io.latency` — latency protection ([blk-iolatency](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/block/blk-iolatency.c))

Set a target latency for a cgroup; when its *observed* latency drifts above the target, the controller throttles the **other**, lower-priority cgroups until the protected one recovers. This is not "divide the bandwidth" — it's "keep this one workload fast, at everyone else's expense," which is exactly what a latency-sensitive service on a shared device wants.

## `io.stat`

Per-cgroup counters — bytes and I/Os read and written per device (plus cost accounting when iocost is active) — which is where you look to see whether the policy is doing what you think.

## Choosing a policy

| You want… | Use | Backed by |
|---|---|---|
| Hard caps / tenant isolation | `io.max` | blk-throttle |
| Proportional fairness on fast devices | `io.weight` | blk-iocost |
| One workload kept latency-stable | `io.latency` | blk-iolatency |

## The hard part: charging writeback to the right cgroup

The subtlety that makes block cgroup control genuinely difficult is **writeback**. A dirty page is written to disk later, by a kernel flusher thread — not by the process that dirtied it. If the block controller charged that I/O to the flusher, cgroup accounting would be meaningless. So the block controller is wired to the [memory controller](../mm/memcg.md): the cgroup that dirtied a page is remembered, and its writeback I/O is charged back to it when the flush finally happens. Block I/O control and memory control are, for this reason, inseparable — see [cgroup I/O](../cgroups/io-cgroup.md).

## Further reading

- [Kernel docs: cgroup v2 — IO controller](https://docs.kernel.org/admin-guide/cgroup-v2.html#io)
- [`7caa47151ab2`](https://git.kernel.org/linus/7caa47151ab2) — the introduction of blk-iocost, the device cost model behind `io.weight`
- [`block/blk-throttle.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/block/blk-throttle.c), [`blk-iolatency.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/block/blk-iolatency.c), [`blk-iocost.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/block/blk-iocost.c) — the three policy implementations
