# Cgroup v2 Architecture

> The unified resource control hierarchy

## Why cgroup v2 exists

### Cgroup v1: one hierarchy per controller

Cgroups v1 (Linux 2.6.24, 2008) [(LWN)](https://lwn.net/Articles/236437/) let each resource controller (`cpu`, `memory`, `blkio`, `cpuset`, etc.) have its own independent hierarchy. You could put process 1234 in `/sys/fs/cgroup/cpu/webserver/` for CPU accounting and `/sys/fs/cgroup/memory/tier-a/` for memory limits — they were completely independent trees.

This sounded flexible but created a fundamental problem: **the controllers had no shared definition of "what group a process belongs to."** The `cpu` controller thought about tasks one way; `memory` thought about them differently; `blkio` had its own view. When systemd or a container runtime wanted to create a coherent "unit" (a container, a service) with CPU *and* memory *and* I/O limits, it had to maintain parallel positions in multiple hierarchies and keep them synchronized manually.

The writeback attribution problem crystallized the issue: when a process writes to a file, the actual I/O to disk happens later from a kernel worker thread (`kworker`). In v1, the `blkio` controller charged this I/O to the `kworker`, not the process that dirtied the page. There was no way to fix this without a unified notion of group membership — the `memory` controller and `blkio` controller needed to agree on which cgroup owns a dirty page.

### Cgroup v2: unified hierarchy

Tejun Heo designed cgroup v2 (merged in Linux 4.5, 2016) [(commit)](https://git.kernel.org/linus/34a9304a96d6351c2d35dcdc9293258378fc0bd8) [(LWN)](https://lwn.net/Articles/679786/) around a single tree. All controllers operate on the same hierarchy. A process is in exactly one cgroup, and all controllers apply to that cgroup.

This made proper writeback attribution possible: since both `memory` and `io` controllers share the same hierarchy, a dirty page can be attributed to the correct cgroup even when flushed by a `kworker`.

The "no internal process" rule (a cgroup cannot hold both processes and child cgroups) enforces clean delegation semantics. A container runtime owns a subtree; it can create child cgroups within that subtree. A process in the parent cgroup can't accidentally interfere with the resource accounting of children.

## Cgroup v1 vs v2

| Feature | v1 | v2 |
|---------|----|----|
| Hierarchy | One per controller | Single unified hierarchy |
| Controller attachment | Any cgroup | Must be enabled at parent |
| Thread vs process | Per-thread control | Per-process (thread mode opt-in) |
| Delegation | Complex ACLs | Clean subtree delegation |
| BPF integration | Limited | cgroup BPF programs |

Cgroup v2 (unified hierarchy) was merged in 4.5 [(commit)](https://git.kernel.org/linus/34a9304a96d6351c2d35dcdc9293258378fc0bd8) and is now the default on modern distros. Most subsystems support only v2.

## The single hierarchy

All cgroup v2 resources hang off a single filesystem at `/sys/fs/cgroup`:

```
/sys/fs/cgroup/                    ← root cgroup
├── cgroup.controllers             ← available controllers
├── cgroup.subtree_control         ← controllers delegated to children
├── cpu.stat
├── memory.current
├── system.slice/                  ← systemd service cgroup
│   ├── nginx.service/
│   │   ├── cgroup.procs           ← PIDs in this cgroup
│   │   ├── cpu.max                ← CPU quota
│   │   ├── memory.max             ← memory limit
│   │   └── io.max                 ← I/O bandwidth limit
│   └── sshd.service/
└── user.slice/
    └── user-1000.slice/
        └── session-1.scope/
```

## Key data structures

### struct cgroup

```c
/* kernel/cgroup/cgroup-internal.h */
struct cgroup {
    struct cgroup_subsys_state self;  /* CSS for cgroup_subsys itself */
    unsigned long   flags;
    int             level;            /* depth from root (root=0) */
    int             max_depth;        /* subtree depth limit */
    int             nr_descendants;   /* non-empty descendant count */

    struct cgroup  *dom_cgrp;         /* domain cgroup (for v2) */
    struct cgroup  *old_dom_cgrp;

    struct kernfs_node *kn;           /* cgroup's kernfs directory node */
    struct cgroup_file  procs_file;   /* handle for cgroup.procs */
    struct cgroup_file  events_file;  /* handle for cgroup.events */

    u16 subtree_control;              /* controllers enabled for children */
    u16 subtree_ss_mask;

    struct list_head    self_css_set_list;
    struct cgroup       **ancestors;   /* ancestor array for fast lookup */

    struct cgroup_bpf   bpf;          /* BPF programs attached here */

    atomic_t            nr_dying_descendants;
    struct cgroup_rstat_cpu __percpu *rstat_cpu;

    /* Active per-subsystem state: */
    struct cgroup_subsys_state *subsys[CGROUP_SUBSYS_COUNT];
};
```

### struct cgroup_subsys_state (CSS)

Each controller attaches per-cgroup state via a CSS:

```c
struct cgroup_subsys_state {
    struct cgroup        *cgroup;     /* the cgroup this CSS belongs to */
    struct cgroup_subsys *ss;         /* the controller subsystem */
    struct percpu_ref     refcnt;     /* reference count */
    struct list_head      sibling;    /* list of sibling CSS under parent */
    struct list_head      children;   /* list of child CSS */
    struct list_head      rstat_css_node;

    u64     id;                       /* unique ID */
    unsigned int flags;               /* CSS_NO_REF, CSS_ONLINE, CSS_DYING */
    struct work_struct destroy_work;
    struct rcu_work destroy_rwork;
    struct cgroup_subsys_state *parent;
};
```

Controllers (cpu, memory, io, etc.) embed a `cgroup_subsys_state` as their first field:

```c
/* mm/memcontrol.c */
struct mem_cgroup {
    struct cgroup_subsys_state css;  /* MUST be first */
    /* ... memory controller state ... */
    struct page_counter memory;
    struct page_counter swap;
    unsigned long       soft_limit;
    /* ... */
};

/* Access pattern: CSS → mem_cgroup */
struct mem_cgroup *memcg = container_of(css, struct mem_cgroup, css);
```

### struct cgroup_subsys

Each controller registers itself:

```c
struct cgroup_subsys {
    struct cgroup_subsys_state *(*css_alloc)(struct cgroup_subsys_state *parent);
    int (*css_online)(struct cgroup_subsys_state *css);
    void (*css_offline)(struct cgroup_subsys_state *css);
    void (*css_free)(struct cgroup_subsys_state *css);
    void (*css_reset)(struct cgroup_subsys_state *css);

    int (*can_attach)(struct cgroup_taskset *tset);
    void (*attach)(struct cgroup_taskset *tset);  /* task moved here */
    void (*post_attach)(void);
    int (*can_fork)(struct task_struct *task, struct css_set *cset);
    void (*cancel_fork)(struct task_struct *task, struct css_set *cset);
    void (*fork)(struct task_struct *task);        /* new process */
    void (*exit)(struct task_struct *task);
    void (*release)(struct task_struct *task);
    void (*bind)(struct cgroup_subsys_state *root_css);

    bool        early_init:1;
    bool        implicit_on_dfl:1;
    bool        threaded:1;
    int         id;
    const char  *name;
    const char  *legacy_name;
    struct cgroupfs_root *root;
    struct idr  css_idr;
    struct list_head cfts;           /* cftypes (interface files) */
    struct cftype *dfl_cftypes;      /* default v2 files */
    struct cftype *legacy_cftypes;   /* v1 files */
    unsigned int depends_on;
};
```

## Enabling controllers

Controllers must be explicitly enabled in the subtree:

```bash
# See what's available at root
cat /sys/fs/cgroup/cgroup.controllers
# cpuset cpu io memory hugetlb pids rdma misc

# Enable controllers for children of root
echo "+cpu +memory +io +pids" > /sys/fs/cgroup/cgroup.subtree_control

# Create a cgroup
mkdir /sys/fs/cgroup/myapp

# Enable controllers for myapp's children
echo "+cpu +memory" > /sys/fs/cgroup/myapp/cgroup.subtree_control

# Add a process (moves it and all threads atomically)
echo $$ > /sys/fs/cgroup/myapp/cgroup.procs
```

**No Internal Process Constraint**: in v2, a cgroup cannot hold both processes and child cgroups. Only leaf cgroups (cgroups with no children) and the root cgroup can hold processes directly.

## css_set: the task-to-cgroup link

Each task has a pointer to a `css_set`, which holds references to one CSS per active controller:

```c
struct css_set {
    struct cgroup_subsys_state *subsys[CGROUP_SUBSYS_COUNT];
    refcount_t   refcount;          /* shared when tasks have same CSS combination */
    struct hlist_node hlist;        /* hash table of all css_sets */
    struct list_head tasks;         /* tasks in this set */
    struct list_head mg_tasks;      /* tasks being migrated */
    struct list_head dying_tasks;
    struct list_head task_iters;
    struct list_head e_cset_node[CGROUP_SUBSYS_COUNT]; /* for each subsystem */
    struct list_head threaded_csets;
    struct list_head threaded_csets_node;
    struct rcu_head  rcu_head;
    struct list_head mg_preload_node;
    struct list_head mg_node;
    struct cgroup   *mg_src_cgrp;
    struct cgroup   *mg_dst_cgrp;
    struct css_set  *mg_dst_cset;
    bool             dead;
    struct work_struct release_work;
};
```

CSS sets are shared: if two tasks are in exactly the same set of cgroups (one per controller), they share a `css_set`. This keeps the number of css_set objects small.

## Moving processes between cgroups

```bash
# Move process PID to a cgroup
echo <pid> > /sys/fs/cgroup/myapp/cgroup.procs
```

Internally:
```c
/* kernel/cgroup/cgroup.c: cgroup_procs_write() */
cgroup_attach_task()
  → cgroup_taskset_migrate()
      → for each controller:
          css->ss->can_attach(tset)    /* permission check */
      → move task to new css_set
      → for each controller:
          css->ss->attach(tset)        /* notify controller */
```

## cgroup.events and notifications

```bash
# Monitor cgroup for empty/non-empty transitions
cat /sys/fs/cgroup/myapp/cgroup.events
# populated 1
# frozen 0

# Watch for changes (inotify or poll on the file)
inotifywait -e modify /sys/fs/cgroup/myapp/cgroup.events
```

## BPF programs on cgroups

```bash
# Attach a BPF program to a cgroup (e.g., network filter)
bpftool cgroup attach /sys/fs/cgroup/myapp/ ingress id <prog_id>
bpftool cgroup show /sys/fs/cgroup/myapp/
```

```c
/* BPF program attached to cgroup for socket filtering */
SEC("cgroup/skb")
int cgroup_filter(struct __sk_buff *skb)
{
    /* Allow or deny based on socket/connection properties */
    return 1;  /* 1=allow, 0=deny */
}
```

Supported BPF attach types on cgroups:
- `BPF_CGROUP_INET_INGRESS` / `BPF_CGROUP_INET_EGRESS`
- `BPF_CGROUP_INET_SOCK_CREATE` / `BPF_CGROUP_SOCK_OPS`
- `BPF_CGROUP_DEVICE` — device access control
- `BPF_CGROUP_SYSCTL` — sysctl read/write control
- `BPF_CGROUP_INET4_CONNECT` / `BPF_CGROUP_INET6_CONNECT`
- `BPF_CGROUP_INET4_BIND` / `BPF_CGROUP_INET6_BIND`

## Further reading

- [Resource Controllers](cgroup-controllers.md) — cpu, memory, io, pids in detail
- [Container Isolation](container-isolation.md) — How cgroups combine with namespaces
- `Documentation/admin-guide/cgroup-v2.rst` — comprehensive kernel documentation
