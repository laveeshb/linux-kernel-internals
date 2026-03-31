# IRQ Descriptor and irq_chip

> The kernel's abstraction over interrupt hardware

## The three-layer interrupt abstraction

The Linux interrupt subsystem uses three structures to abstract over wildly different interrupt controllers (APIC, GIC, IOAPIC, MSI, GPIO controllers...):

```
Linux IRQ number
    ↓
struct irq_desc        ← per-IRQ kernel state (handlers, counters, flags)
    │
    ├── struct irq_data      ← chip-level data (controller, chip-specific)
    │       │
    │       └── struct irq_chip   ← controller operations (mask, unmask, ack, eoi)
    │
    └── struct irqaction     ← linked list of registered handlers
```

## struct irq_desc

One `irq_desc` exists for each Linux IRQ number. It's the central object that ties together the hardware abstraction and the software handlers:

```c
/* include/linux/irqdesc.h */
struct irq_desc {
    struct irq_common_data irq_common_data;  /* shared irq/chip data */
    struct irq_data        irq_data;         /* chip-level data */
    struct irqstat __percpu *kstat_irqs;     /* per-CPU interrupt count */
    irq_flow_handler_t     handle_irq;       /* high-level handler */
    struct irqaction       *action;          /* handler chain */
    unsigned int           depth;            /* nested disable count */
    unsigned int           irq_count;        /* for stall detection */
    unsigned int           irqs_unhandled;   /* spurious count */
    raw_spinlock_t         lock;             /* protects this struct */
    struct cpumask         *percpu_enabled;  /* per-CPU enable state */
    const char             *name;
};
```

Key fields:
- `handle_irq`: the **flow handler** — decides how to run the action chain (edge-triggered, level-triggered, per-CPU, etc.)
- `action`: linked list of `irqaction` structs, one per registered handler
- `depth`: incremented by `disable_irq()`, decremented by `enable_irq()` — only 0 means actually enabled

## struct irqaction

One `irqaction` per `request_irq()` call. Multiple drivers can share an IRQ line, each with its own `irqaction`:

```c
/* include/linux/interrupt.h */
struct irqaction {
    irq_handler_t    handler;     /* the interrupt handler function */
    void             *dev_id;     /* passed to handler, identifies the device */
    struct irqaction *next;       /* next handler sharing this IRQ */
    irq_handler_t    thread_fn;   /* threaded handler (if IRQF_ONESHOT) */
    struct task_struct *thread;   /* kernel thread for threaded handler */
    unsigned int     irq;         /* IRQ number */
    unsigned int     flags;       /* IRQF_* flags */
    const char       *name;       /* appears in /proc/interrupts */
};
```

When a shared IRQ fires, the kernel walks the `irqaction` chain calling each handler in turn. Each handler returns `IRQ_HANDLED` if it handled the interrupt, or `IRQ_NONE` if it wasn't its device.

## struct irq_chip

The `irq_chip` provides operations for controlling the interrupt controller hardware. Each controller (APIC, ARM GIC, etc.) implements this interface:

```c
/* include/linux/irq.h */
struct irq_chip {
    const char *name;           /* appears in /proc/interrupts */

    /* Basic control */
    void (*irq_mask)(struct irq_data *data);    /* disable at controller */
    void (*irq_unmask)(struct irq_data *data);  /* enable at controller */
    void (*irq_enable)(struct irq_data *data);  /* enable (may = unmask) */
    void (*irq_disable)(struct irq_data *data); /* disable */
    void (*irq_ack)(struct irq_data *data);     /* acknowledge (edge) */
    void (*irq_eoi)(struct irq_data *data);     /* end-of-interrupt (level) */

    /* Affinity */
    int  (*irq_set_affinity)(struct irq_data *data,
                              const struct cpumask *dest, bool force);

    /* Trigger type */
    int  (*irq_set_type)(struct irq_data *data, unsigned int flow_type);

    /* Wakeup */
    int  (*irq_set_wake)(struct irq_data *data, unsigned int on);
};
```

Drivers typically don't call `irq_chip` operations directly — the generic IRQ layer calls them at the right time.

## IRQ domains

Modern systems have hierarchical interrupt controllers (e.g., GPIO expander → GIC → CPU). **IRQ domains** map hardware interrupt numbers to Linux IRQ numbers:

```
Hardware interrupt 47 (on GPIO expander)
    ↓ irq_domain (gpio chip)
Linux IRQ 234
    ↓ irq_domain (GIC)
Hardware interrupt 58 (at GIC)
    ↓
CPU interrupt vector
```

```c
/* Creating an IRQ domain (driver code) */
struct irq_domain *domain = irq_domain_add_linear(
    node,           /* device tree node */
    num_irqs,       /* number of hardware IRQs */
    &my_domain_ops, /* translate hw → linux IRQ */
    host_data       /* driver private data */
);

/* In the domain ops: map HW IRQ to Linux IRQ */
static int my_irq_domain_map(struct irq_domain *d,
                              unsigned int virq, irq_hw_number_t hwirq)
{
    irq_set_chip_and_handler(virq, &my_chip, handle_level_irq);
    irq_set_chip_data(virq, d->host_data);
    return 0;
}
```

## Flow handlers

The flow handler (`handle_irq` in `irq_desc`) determines how interrupt delivery works:

| Handler | Usage |
|---------|-------|
| `handle_edge_irq` | Edge-triggered: ack before calling action chain |
| `handle_level_irq` | Level-triggered: mask, run actions, unmask |
| `handle_fasteoi_irq` | Modern level (with EOI): most ARM/x86 MSI |
| `handle_percpu_irq` | Per-CPU interrupts (local timer, IPI) |
| `handle_simple_irq` | No mask/ack, just run actions |

The difference between edge and level matters:
- **Edge**: interrupt fires once when signal transitions. If missed, it won't fire again.
- **Level**: interrupt fires as long as signal is asserted. Must be masked during handling.

## Observing IRQ state

```bash
# Full IRQ table with controller info
cat /proc/interrupts

# Per-IRQ information
ls /proc/irq/24/
# affinity_hint  node  smp_affinity  smp_affinity_list  spread_affinity

# Current affinity
cat /proc/irq/24/smp_affinity_list  # e.g., "0-3"

# IRQ chip name and handler
cat /sys/kernel/debug/irq/irqs/24  # (requires debugfs)
```

## Further reading

- [Interrupt Handling Overview](interrupts.md) — The hardware interrupt flow
- [request_irq and free_irq](request-irq.md) — Registering irqactions
- `Documentation/core-api/genericirq.rst` — Generic IRQ subsystem design
