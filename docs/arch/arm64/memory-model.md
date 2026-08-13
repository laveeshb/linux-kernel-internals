# ARM64 Memory Model

> Weak ordering, barriers, and atomic operations on ARM64

## ARM64 is weakly ordered

Unlike x86 (which has TSO — Total Store Order, nearly sequentially consistent), ARM64 has a **weakly ordered** memory model. The hardware may reorder loads and stores for performance:

```
// ARM64: these operations may be REORDERED by hardware:
STR x1, [x2]     // store to address x2
LDR x3, [x4]     // load from address x4
// CPU may execute the load before the store
```

This matters for lock-free algorithms and any code that synchronizes between threads without using explicit atomic operations.

## What ARM64 guarantees

1. **Single-copy atomicity**: A naturally-aligned load or store of a single register is atomic (the value is either fully written or not written).

2. **Program order for dependent accesses**: If load A is used to compute the address of load B, B observes the effects of A (data-dependent ordering).

3. **No guarantees for independent accesses**: Stores and loads to unrelated addresses can be observed in any order by other CPUs.

## Memory barrier instructions

ARM64 provides three barrier instructions:

### DMB: Data Memory Barrier

Ensures memory accesses before the barrier are visible before accesses after it:

```asm
DMB SY      /* full system, all types: LD after LD, LD after ST, ST after LD, ST after ST */
DMB ST      /* only STores after STores */
DMB LD      /* LoaDs and STores after LoaDs */
DMB ISH     /* inner shareable: affects all CPUs in the same shareability domain */
DMB ISHST   /* inner shareable, stores only */
DMB ISHLD   /* inner shareable, loads only */
DMB NSH     /* non-shareable: only this PE */
DMB OSH     /* outer shareable */
```

`SY` (full system) is most conservative. `ISH` is typical for SMP kernels.

### DSB: Data Synchronization Barrier

Stronger than DMB: not only are memory accesses ordered, but **the barrier stalls the pipeline** until all prior memory accesses are complete:

```asm
DSB SY      /* wait until all memory accesses complete, full system */
DSB ISH     /* same but inner shareable only */
DSB ST      /* wait until all stores complete */
```

Use DSB when you need to know memory accesses have *completed* (not just ordered) — e.g., before modifying page tables that the MMU might be walking, or before a cache maintenance operation takes effect.

### ISB: Instruction Synchronization Barrier

Flushes the instruction pipeline:

```asm
ISB
```

Use ISB after:
- Writing to system registers that affect instruction execution (e.g., SCTLR_EL1)
- Self-modifying code
- Changing the instruction cache attributes

Without ISB, the CPU might have already fetched and decoded instructions past the system register write.

## Load-acquire and Store-release

ARM64 provides special atomic load/store variants that include ordering semantics:

```asm
LDAR x0, [x1]    /* Load-Acquire: no loads or stores after this can be
                    reordered before it */

STLR x0, [x1]    /* Store-Release: no loads or stores before this can be
                    reordered after it */

LDAPR x0, [x1]   /* Load-Acquire RCpc: weaker acquire — allows reordering
                    with prior STLR to different addresses (unlike LDAR) */
```

These implement the C11/C++11 `memory_order_acquire` and `memory_order_release` semantics efficiently — no explicit DMB needed.

```c
/* C equivalent of LDAR/STLR */
/* LDAR x0, [x1] == */  atomic_load_explicit(ptr, memory_order_acquire);
/* STLR x0, [x1] == */  atomic_store_explicit(ptr, val, memory_order_release);
```

## Exclusive load/store (atomics)

ARM64 atomics use a load-link/store-conditional (LL/SC) mechanism:

```asm
/* Compare-and-swap loop: old_val → new_val at [addr] */
.loop:
    LDXR  w0, [x1]        /* Load eXclusive: mark addr as exclusive */
    CMP   w0, w3           /* compare with expected */
    B.NE  .fail
    STXR  w4, w2, [x1]    /* Store eXclusive: write new value */
    CBNZ  w4, .loop        /* if store failed (exclusive lost), retry */
    /* success */
.fail:
    /* w0 has the actual value */
```

ARMv8.1 adds **Large System Extensions (LSE)** — single-instruction atomics that avoid the retry loop:

```asm
/* ARMv8.1 LSE: atomic compare-and-swap */
CAS  w0, w2, [x1]    /* if [x1]==w0, write w2; w0 = old value */
CASAL w0, w2, [x1]   /* CAS with acquire-release semantics */

/* Atomic add */
LDADD x0, x1, [x2]  /* [x2] += x0; x1 = old [x2] */
STADD x0, [x1]       /* [x1] += x0; no return value */

/* Atomic swap */
SWP x0, x1, [x2]    /* [x2] = x0; x1 = old [x2] */
```

LSE atomics are preferred on systems with many cores — they generate a single bus transaction rather than potentially many retry loops.

## Linux kernel barrier macros on ARM64

The kernel provides architecture-independent macros that map to ARM64 instructions:

```c
/* include/asm-generic/barrier.h (mapped to arch/arm64 in asm/barrier.h) */

smp_mb()    /* full memory barrier:   DMB ISH  */
smp_rmb()   /* read memory barrier:   DMB ISHLD */
smp_wmb()   /* write memory barrier:  DMB ISHST */

smp_store_release(p, v)   /* STLR: store + release */
smp_load_acquire(p)        /* LDAR: load + acquire */

/* Data dependency barrier (weaker — relies on data dependency ordering) */
smp_read_barrier_depends()  /* no-op on ARM64: data dep ordering is guaranteed */

/* Compiler barriers (prevent compiler reordering, no CPU barrier) */
barrier()   /* asm volatile("" ::: "memory") */
READ_ONCE(x)    /* load, prevent compiler optimizations */
WRITE_ONCE(x,v) /* store, prevent compiler optimizations */
```

### When to use which

```c
/* Lock: acquire semantics — nothing after the lock can move before it */
spin_lock() → smp_load_acquire or DMB ISH + LDAR

/* Unlock: release semantics — nothing before the unlock can move after it */
spin_unlock() → STLR or DMB ISH + STR

/* RCU read side: data dependency is sufficient on ARM64 */
rcu_dereference(p)  /* READ_ONCE + smp_read_barrier_depends (noop on ARM64) */

/* Producer/consumer lockless queue */
/* Producer: */
WRITE_ONCE(item->data, value);
smp_wmb();                     /* ensure data visible before index */
WRITE_ONCE(queue->tail, new_tail);

/* Consumer: */
tail = smp_load_acquire(&queue->tail);  /* load tail with acquire */
data = READ_ONCE(item->data);           /* data visible after acquire load */
```

## Page table barriers

A common ARM64 specific need: after modifying a page table entry, you must ensure the store is visible to the MMU before the TLB invalidation instruction:

```asm
/* Write new PTE */
STR x0, [x1]          /* store new page table entry */
DSB ISH                /* wait for store to complete */
/* TLB invalidate */
TLBI VAE1IS, x2        /* invalidate TLB entry, inner shareable */
DSB ISH                /* wait for TLB invalidation */
ISB                    /* ensure subsequent instructions use new mappings */
```

In the kernel:

```c
/* arch/arm64/include/asm/tlbflush.h */
static inline void flush_tlb_page(struct vm_area_struct *vma,
                                    unsigned long uaddr)
{
    unsigned long addr = __TLBI_VADDR(uaddr, ASID(vma->vm_mm));
    dsb(ishst);             /* DSB ISH ST — wait for page table stores */
    __tlbi(vale1is, addr);  /* TLBI by address, inner shareable */
    dsb(ish);               /* DSB ISH — wait for TLB invalidation */
}
```

## Acquire/Release in the kernel: spinlock

```asm
/* arch/arm64/include/asm/spinlock.h */
/* Ticket spinlock acquire: */
arch_spin_lock:
    PRFM    PSTL1KEEP, [x0]   /* prefetch for write */
.again:
    LDAXR   w2, [x0]          /* load-exclusive + acquire */
    /* Check if our ticket == serving number */
    ...
    CBNZ    w3, .wait
    STXR    w3, w1, [x0]      /* store-exclusive */
    CBNZ    w3, .again
    RET

/* Spinlock release: just store, store-release ordering */
arch_spin_unlock:
    STLR    w1, [x0]          /* store-release: all prior accesses visible */
    RET
```

## Weak memory model bugs

Common patterns that work on x86 (TSO) but **fail on ARM64**:

### Missing barrier in producer/consumer

```c
/* WRONG on ARM64: */
struct item {
    int ready;    /* offset 0 */
    int data;     /* offset 4 */
};

/* Thread A (producer): */
item->data  = 42;
item->ready = 1;    /* ARM64 may reorder: ready=1 visible before data=42 */

/* Thread B (consumer): */
while (!item->ready);   /* spin */
use(item->data);        /* may see data=0 because no barrier! */

/* RIGHT: */
WRITE_ONCE(item->data, 42);
smp_wmb();              /* DMB ISHST: ensure data visible before ready */
WRITE_ONCE(item->ready, 1);

/* Consumer: */
while (!smp_load_acquire(&item->ready)); /* LDAR: acquire ordering */
use(READ_ONCE(item->data));
```

### Missing dsb after page table update

```c
/* WRONG: CPU may start walking old page tables after set_pte */
set_pte(ptep, new_pte);
flush_tlb_page(vma, addr);  /* TLB flush without DSB — MMU might not see new PTE */

/* RIGHT (done by the kernel automatically): */
set_pte(ptep, new_pte);
dsb(ishst);                 /* ensure PTE store visible */
flush_tlb_page(vma, addr);
```

## Observing memory ordering issues

```bash
# Run litmus tests (memory model validation)
# ARM provides litmus7 tool for testing actual hardware behavior

# LKMM (Linux Kernel Memory Model) verification
# https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/tools/memory-model

# Enable CONFIG_KCSAN for compile-time race detection
# KCSAN instruments memory accesses and checks for data races

# Detect issues with lockdep + KCSAN
dmesg | grep "data-race"
```

## Further reading

- [Exception Model](exception-model.md) — ARM64 exception levels and GIC
- [Locking: Atomic Operations and Memory Barriers](../../locking/atomics.md) — kernel atomic API
- [Locking: RCU](../../locking/rcu.md) — how RCU uses barriers
- [Memory Management: page tables](../../mm/page-tables.md) — page table barrier requirements
- ARM Architecture Reference Manual — B2: The AArch64 Application Level Memory Model
- [Documentation/memory-barriers.txt](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/memory-barriers.txt) — the kernel's memory-ordering bible
