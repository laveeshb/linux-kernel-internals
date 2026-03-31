# Threaded IRQs

> Moving interrupt work into process context for longer processing

## The problem with hardirq handlers

Hardware interrupt handlers (hardirq) run with interrupts disabled on the current CPU. This means:
- They cannot sleep
- They cannot acquire sleeping locks (mutex, semaphore)
- They block other interrupts on the same CPU
- Latency for other high-priority interrupts is added

For complex devices (I2C buses, SPI controllers, touchscreens), the interrupt handler needs to do I2C/SPI register reads that can take milliseconds. That's far too long for a hardirq handler.

**Threaded IRQs** solve this by moving the heavy lifting to a dedicated kernel thread that runs in process context.

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
