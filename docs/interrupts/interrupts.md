# Interrupt Handling Overview

> From hardware signal to kernel handler: the complete path

## What happens when hardware sends an interrupt

On x86, the interrupt flow:

```
Hardware device asserts IRQ line
    ↓
Interrupt Controller (APIC/PIC)
  Identifies interrupt source, routes to CPU
    ↓
CPU finishes current instruction
  Saves: RIP, RFLAGS, RSP, CS, SS to kernel stack
  Clears IF (disables hardware interrupts)
  Looks up handler in IDT (Interrupt Descriptor Table)
    ↓
common_interrupt() (arch/x86/kernel/irq.c)
  irq_enter_rcu()    ← marks hardirq context
  handle_irq()       ← calls the high-level handler
  irq_exit_rcu()     ← exits hardirq context, runs pending softirqs
    ↓
irq_exit_rcu() checks if softirqs are pending
  If yes: invoke_softirq() → __do_softirq()
```

## The IDT and interrupt vectors

The x86 Interrupt Descriptor Table (IDT) has 256 entries, each pointing to a handler:

```
Vectors 0-31:   CPU exceptions (divide by zero, page fault, etc.)
Vectors 32-127: Hardware IRQs (mapped by APIC)
Vector 128:     System call (int 0x80, legacy)
Vectors 129-255: Other IPIs, local APIC, MSI
```

Each IDT entry specifies privilege level, segment, and handler address. When an interrupt fires, the CPU indexes into the IDT to find the handler.

## Interrupt entry: irq_enter and irq_exit

The kernel tracks whether it's in interrupt context with per-CPU counters in `preempt_count`:

```c
/* include/linux/preempt.h */
#define SOFTIRQ_SHIFT   (PREEMPT_SHIFT + PREEMPT_BITS)
#define HARDIRQ_SHIFT   (SOFTIRQ_SHIFT + SOFTIRQ_BITS)

/* preempt_count layout:
   bits 0-7:  preempt count
   bits 8-15: softirq count
   bits 16-19: hardirq count
   bit 20+: NMI count
*/

#define in_irq()      (hardirq_count())  /* in hardirq handler */
#define in_softirq()  (softirq_count())  /* in softirq handler */
#define in_interrupt() (irq_count())     /* in any interrupt context */
```

`irq_enter()` increments the hardirq count; `irq_exit()` decrements it and runs pending softirqs if we're returning to process context:

```c
/* kernel/softirq.c (simplified) */
void irq_exit_rcu(void)
{
    /* Decrement hardirq nesting count */
    preempt_count_sub(HARDIRQ_OFFSET);

    /* Run softirqs if we're back in process context */
    if (!in_interrupt() && local_softirq_pending())
        invoke_softirq();

    tick_irq_exit();
    /* Note: rcu_irq_exit() and trace_hardirq_exit() are NOT called here —
     * the _rcu suffix means the caller manages RCU idle-state transitions */
}
```

## The irq_desc lookup

From the interrupt vector, the kernel finds the `irq_desc` (interrupt descriptor):

```c
/* arch/x86/kernel/irq.c (simplified) */
__visible void __irq_entry common_interrupt(struct pt_regs *regs, u64 vector)
{
    struct irq_desc *desc;

    irq_enter_rcu();

    /* Convert CPU vector → Linux IRQ number → irq_desc */
    desc = __this_cpu_read(vector_irq[vector]);
    if (likely(!IS_ERR_OR_NULL(desc)))
        handle_irq(desc, regs);

    irq_exit_rcu();
}
```

## Interrupt context restrictions

Code running in hardirq context must follow strict rules:

```c
/* DON'T: sleep in interrupt context */
irqreturn_t my_handler(int irq, void *dev)
{
    msleep(1);           /* BUG: may sleep */
    kmalloc(sz, GFP_KERNEL);  /* BUG: may sleep */
    mutex_lock(&m);      /* BUG: may sleep */
    return IRQ_HANDLED;
}

/* DO: use non-sleeping alternatives */
irqreturn_t my_handler(int irq, void *dev)
{
    kmalloc(sz, GFP_ATOMIC);  /* never sleeps */
    spin_lock(&s);             /* doesn't sleep */
    /* ... */
    spin_unlock(&s);
    return IRQ_HANDLED;
}
```

Hardware interrupts are disabled on the current CPU for the duration of the hardirq handler (the CPU cleared `IF` on entry). Interrupts on other CPUs are not affected.

## /proc/interrupts

```bash
cat /proc/interrupts
#            CPU0       CPU1       CPU2       CPU3
#   0:         21          0          0          0  IR-IO-APIC    2-edge      timer
#   1:          2          0          0          1  IR-IO-APIC    1-edge      i8042
#  16:          0          0          0          0  IR-IO-APIC   16-level     uhci_hcd:usb3
#  24:          0          0          0          0  IR-PCI-MSI 524288-edge      xhci_hcd
# LOC:     198432     197654     196543     198123   Local timer interrupts
# SPU:          0          0          0          0   Spurious interrupts
# PMI:          0          0          0          0   Performance monitoring interrupts
# RES:       1234       1567       1234       1345   Rescheduling interrupts
# CAL:        234        234        234        234   Function call interrupts
```

- First column: IRQ number (or name for special interrupts)
- CPU columns: per-CPU interrupt count since boot
- Controller: interrupt controller and routing
- Name: driver name from `request_irq()`

```bash
# Watch interrupt rates
watch -d -n 1 'cat /proc/interrupts'

# IRQs per second
awk 'NR>1 {for(i=2;i<=NF-2;i++) if($i+0>0) {print $0; next}}' /proc/interrupts
```

## IRQ affinity

Each IRQ can be steered to specific CPUs:

```bash
# Show IRQ affinity (bitmask)
cat /proc/irq/24/smp_affinity      # hex bitmask
cat /proc/irq/24/smp_affinity_list # human-readable CPU list

# Pin IRQ 24 to CPUs 0-3
echo "f" > /proc/irq/24/smp_affinity   # hex f = CPUs 0-3
echo "0-3" > /proc/irq/24/smp_affinity_list

# irqbalance daemon automatically balances IRQ affinity
systemctl status irqbalance
```

## Further reading

- [IRQ Descriptor and irq_chip](irq-desc.md) — The irq_desc data structures
- [request_irq and free_irq](request-irq.md) — Registering handlers
- [Softirqs](softirq.md) — What irq_exit runs when pending
- `Documentation/core-api/genericirq.rst` — Generic IRQ subsystem docs
