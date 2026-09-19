# Threaded IRQs

> Moving interrupt work into process context for longer processing

## The problem with hardirq handlers

Hardware interrupt handlers (hardirq) run with interrupts disabled on the current CPU. This means:

- They cannot sleep
- They cannot acquire sleeping locks (mutex, semaphore)
- They block other interrupts on the same CPU
- Latency for other high-priority interrupts is added

For complex devices (I2C buses, SPI controllers, touchscreens), the interrupt handler needs to do I2C/SPI register reads that can take milliseconds. That's far too long for a hardirq handler.

**Threaded IRQs** were introduced in Linux 2.6.30 by Thomas Gleixner [(commit)](https://git.kernel.org/linus/3aa551c9b4c40018f0e261a178e3d25478dc04a9) [(LWN)](https://lwn.net/Articles/302043/) and solve this by moving the heavy lifting to a dedicated kernel thread that runs in process context.

## Where this actually came from

Mainline didn't invent threaded interrupt handling from scratch in 2009 — it imported an idea the out-of-tree [PREEMPT_RT](../locking/preempt-rt.md) patch set had already been relying on for years. LWN's coverage of the original proposal is explicit about this: *"In the realtime tree, nearly all drivers were mass converted to use threads"* — because PREEMPT_RT's whole premise depends on nothing running with interrupts fully disabled for long, so RT builds had no choice but to move hardirq work into schedulable, preemptible threads ([LWN](https://lwn.net/Articles/302043/), Jake Edge, October 8 2008).

What Gleixner proposed for mainline was narrower and more conservative than the RT tree's approach: instead of force-converting every driver, `request_threaded_irq()` made threading *opt-in*, one driver at a time. That design choice traces to a specific constraint — as LWN reports, *"as requested by Linus Torvalds at this year's Kernel Summit, a new function was introduced rather than changing countless drivers to use a new `request_irq()`"*. Gleixner was also candid that automatic, mechanical conversion wasn't the goal: *"Converting an interrupt to threaded makes only sense when the handler code takes advantage of it by integrating tasklet/softirq functionality and simplifying the locking."* A driver gains nothing from threading just for its own sake — the benefit only shows up when threading lets the driver delete a tasklet or softirq it would otherwise need alongside the hardirq handler.

The same article notes the anticipated payoff went beyond latency: *"Threaded handlers will also help the debuggability of the kernel and may eventually lead to the removal of tasklets from Linux."* That connection is exactly why [tasklets are now deprecated in favor of threaded IRQs](tasklets.md#the-deprecation-nobody-planned-to-start-then-couldnt-finish) — the 2008 proposal was already naming the mechanism that would eventually make tasklets removable, over a decade before the removal push actually started.

## request_threaded_irq

```c
int request_threaded_irq(unsigned int irq,
                         irq_handler_t handler,     /* hardirq handler (primary) */
                         irq_handler_t thread_fn,   /* threaded handler (secondary) */
                         unsigned long irqflags,
                         const char *devname,
                         void *dev_id);
```

When a threaded IRQ fires:
1. `handler` (the primary) runs in hardirq context
   - Must return `IRQ_WAKE_THREAD` to wake the thread, or `IRQ_HANDLED` / `IRQ_NONE`
2. The IRQ thread (named `irq/N-name`) runs `thread_fn` in process context
   - May sleep, take mutexes, do I2C reads, etc.
   - `IRQF_ONESHOT` keeps the IRQ line masked until `thread_fn` returns

## The IRQF_ONESHOT requirement

For threaded IRQs with level-triggered interrupts, you **must** use `IRQF_ONESHOT`. Here's why:

Without `IRQF_ONESHOT`:
1. Interrupt fires → hardirq runs → IRQ line unmasked → interrupt fires again
2. The thread is woken, but the interrupt fires again before the thread reads the register
3. The IRQ line never quiets → interrupt storm

With `IRQF_ONESHOT`:
1. Interrupt fires → hardirq runs → IRQ line **remains masked**
2. Thread runs → reads register, clears interrupt source
3. Thread completes → IRQ line is **unmasked** by the kernel
4. Now the line is quiet

```c
/* Always use IRQF_ONESHOT with level-triggered threaded IRQs */
request_threaded_irq(irq, primary_handler, thread_fn,
                     IRQF_ONESHOT | IRQF_TRIGGER_LOW, "my-device", dev);
```

## A complete threaded IRQ example

```c
/* Primary handler: runs in hardirq context */
static irqreturn_t my_primary_handler(int irq, void *dev_id)
{
    struct my_device *dev = dev_id;

    /* Minimal work: check it's our interrupt */
    if (!(readl(dev->regs + STATUS) & MY_BIT))
        return IRQ_NONE;

    /* Disable the interrupt source (device-side) to prevent re-firing */
    writel(0, dev->regs + IRQ_ENABLE);

    /* Wake the thread to do the real work */
    return IRQ_WAKE_THREAD;
}

/* Thread handler: runs in process context */
static irqreturn_t my_thread_handler(int irq, void *dev_id)
{
    struct my_device *dev = dev_id;

    /* Can sleep, take mutexes, do I2C reads, etc. */
    i2c_smbus_read_byte_data(dev->client, REG_DATA);

    /* Process data */
    input_report_key(dev->input, KEY_ENTER, 1);
    input_sync(dev->input);

    /* Re-enable device-side interrupt */
    writel(MY_BIT, dev->regs + IRQ_ENABLE);

    return IRQ_HANDLED;
}

static int my_probe(struct i2c_client *client)
{
    /* ... */
    return devm_request_threaded_irq(&client->dev, client->irq,
                                     my_primary_handler,
                                     my_thread_handler,
                                     IRQF_ONESHOT | IRQF_TRIGGER_LOW,
                                     "my-touchscreen", dev);
}
```

## NULL primary handler

If all the work can go to the thread and you don't need to make a "is this my interrupt?" decision in hardirq context, you can pass `NULL` as the primary handler:

```c
/* NULL primary: kernel provides a default that always returns IRQ_WAKE_THREAD */
request_threaded_irq(irq, NULL, my_thread_fn,
                     IRQF_ONESHOT | IRQF_TRIGGER_RISING, "my-sensor", dev);
```

The kernel's default primary handler acknowledges the interrupt and wakes the thread.

## The IRQ thread

The kernel creates one kernel thread per threaded IRQ, named `irq/N-name` where N is the IRQ number:

```bash
# List IRQ threads
ps aux | grep "irq/"
# root     1234  0.0  0.0      0     0 ?   S    10:00   0:00 [irq/45-eth0]
# root     1235  0.0  0.0      0     0 ?   S    10:00   0:00 [irq/46-spi0]

# IRQ threads run at SCHED_FIFO priority 50 by default
chrt -p 1234  # shows scheduling policy and priority
```

IRQ threads can have their priority adjusted:

```bash
# Set IRQ 45 thread to SCHED_FIFO priority 90 (for RT workloads)
chrt -f -p 90 $(pgrep -f "irq/45")
```

## When to use threaded IRQs

```
Use threaded IRQs when:
  ✓ Handler needs to do I2C/SPI communication (sleeps)
  ✓ Handler needs to acquire a mutex
  ✓ Handler does complex processing that takes > a few µs
  ✓ Level-triggered interrupt (IRQF_ONESHOT prevents storm)

Keep in hardirq when:
  ✓ Very simple: read register, copy data, ack
  ✓ Network packet receive (NAPI handles deferral differently)
  ✓ Hard real-time requirements (avoid thread scheduling latency)
```

## Further reading

- [request_irq and free_irq](request-irq.md) — The non-threaded version
- [Workqueues](workqueues.md) — Another way to defer work to process context
- [Softirqs](softirq.md) — For deferred work that must stay in softirq context
