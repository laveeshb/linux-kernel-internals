# Serial Core: One Abstraction Over Every UART

> `drivers/tty/serial/serial_core.c` is the layer that lets a 1970s-vintage 16550 register set and a modern SoC's memory-mapped UART both show up as `/dev/ttyS0`

## The problem: a UART is not a UART

Every UART chip moves bytes over a wire one bit at a time, but "every UART" is not one chip — it's a sprawl of them. The venerable 8250/16550 family (and its many register-compatible descendants) is still the most common thing to find behind a PC-style serial port or a PCIe multiport card. But almost every SoC vendor also ships its own UART IP block: Broadcom's, Freescale/NXP's `lpuart`, Qualcomm's `msm_serial`/`geni`, Samsung's, ARM's PL011, Xilinx's `uartlite`, and dozens more, each with its own register layout, its own FIFO depth, its own quirks for how modem control lines are wired (or not wired at all, on something with no RS-232 signaling at all). `drivers/tty/serial/` currently holds on the order of 70 individual per-chip driver source files (not counting the shared core files or the further ~45 files under `drivers/tty/serial/8250/` for 8250-family variants and add-in cards) for exactly this reason.

None of that variety should be the generic TTY layer's problem. `drivers/tty/tty_io.c` and friends know about line disciplines, `termios`, job control, `/dev/ttyS0` as a character device — concepts that apply identically whether the bytes underneath came off an 8250 or a Bluetooth RFCOMM channel or a virtual console. What the TTY layer should not have to know is how to twiddle an `IER` register or decode a chip-specific FIFO-trigger-level encoding.

`serial_core.c` is the layer in between. It defines one hardware-facing contract — `struct uart_ops`, a table of callbacks every UART driver fills in — and one registration model — `struct uart_driver` for a chip family, `struct uart_port` for one physical instance of it. Every one of those 60-odd drivers implements the same handful of callbacks; `serial_core.c` is what turns those callbacks into a generic `tty_operations` table the TTY core drives, and turns TTY-core calls (open, write, set_termios, ioctl) into the right `uart_ops` callback on the right port. A driver author who implements `.startup`, `.shutdown`, `.set_termios`, `.start_tx`, and a small handful of others gets `/dev/ttyS*` for free — line discipline handling, `termios` negotiation, `poll()`, `TIOCM*` modem-control ioctls, magic SysRq, kernel console support, all of it, without writing a line of TTY-layer code.

## Core structures

### `struct uart_ops`: the hardware contract

`struct uart_ops` (`include/linux/serial_core.h`) is the vtable every UART driver builds and hands to `serial_core` via `uart_port.ops`. It is the entire surface a driver has to implement to plug into the generic layer:

```c
// include/linux/serial_core.h
struct uart_ops {
	unsigned int	(*tx_empty)(struct uart_port *);
	void		(*set_mctrl)(struct uart_port *, unsigned int mctrl);
	unsigned int	(*get_mctrl)(struct uart_port *);
	void		(*stop_tx)(struct uart_port *);
	void		(*start_tx)(struct uart_port *);
	void		(*throttle)(struct uart_port *);
	void		(*unthrottle)(struct uart_port *);
	void		(*send_xchar)(struct uart_port *, char ch);
	void		(*stop_rx)(struct uart_port *);
	void		(*start_rx)(struct uart_port *);
	void		(*enable_ms)(struct uart_port *);
	void		(*break_ctl)(struct uart_port *, int ctl);
	int		(*startup)(struct uart_port *);
	void		(*shutdown)(struct uart_port *);
	void		(*flush_buffer)(struct uart_port *);
	void		(*set_termios)(struct uart_port *, struct ktermios *new,
				       const struct ktermios *old);
	void		(*set_ldisc)(struct uart_port *, struct ktermios *);
	void		(*pm)(struct uart_port *, unsigned int state,
			      unsigned int oldstate);
	const char	*(*type)(struct uart_port *);
	void		(*release_port)(struct uart_port *);
	int		(*request_port)(struct uart_port *);
	void		(*config_port)(struct uart_port *, int);
	int		(*verify_port)(struct uart_port *, struct serial_struct *);
	int		(*ioctl)(struct uart_port *, unsigned int, unsigned long);
#ifdef CONFIG_CONSOLE_POLL
	int		(*poll_init)(struct uart_port *);
	void		(*poll_put_char)(struct uart_port *, unsigned char);
	int		(*poll_get_char)(struct uart_port *);
#endif
};
```

A few of these carry almost all of the day-to-day weight:

- **`.startup`/`.shutdown`** — called when the port's first `open()` and last `close()` happen: request the IRQ, reset and enable the hardware FIFOs, program the interrupt-enable register; and undo all of that.
- **`.set_termios`** — called whenever userspace changes baud rate, parity, stop bits, or flow control (`stty`, or a `termios` struct passed to `tcsetattr()`). This is where a driver computes and programs a baud-rate divisor.
- **`.start_tx`/`.stop_tx`** — start or stop the transmit side. For an interrupt-driven driver, `.start_tx` typically just unmasks the "THR empty" interrupt and lets the interrupt handler feed the FIFO; `.stop_tx` masks it back off.
- **`.stop_rx`** — stop delivering received data upward (used for `!CREAD` and for throttling).
- **`.set_mctrl`/`.get_mctrl`** — program and read back the modem control lines (RTS, DTR) and status lines (CTS, DSR, DCD, RI), each as `TIOCM_*` bits.
- **`.tx_empty`** — report whether the transmit path (FIFO plus shift register) has fully drained; backs `TIOCSER_TEMT`/`tcdrain()`.
- **`.type`/`.request_port`/`.release_port`/`.config_port`/`.verify_port`** — the `setserial`-era port-configuration and autodetection machinery: report a human-readable chip name, claim/release the I/O or MMIO region, autoprobe the exact chip variant, and validate a user-requested `struct serial_struct` change.

### `struct uart_port`: one physical port

`struct uart_port` is the per-instance object — one per physical UART, allocated and filled in by the driver, one for each ttyS/ttyUL/ttyAMA/... minor number. It carries the register-access strategy, the negotiated hardware state, and a back-pointer into the generic layer:

```c
// include/linux/serial_core.h
struct uart_port {
	spinlock_t		lock;			/* port lock */
	unsigned long		iobase;			/* in/out[bwl] */
	unsigned char __iomem	*membase;		/* read/write[bwl] */
	u32			(*serial_in)(struct uart_port *, unsigned int offset);
	void			(*serial_out)(struct uart_port *, unsigned int offset, u32 val);
	void			(*set_termios)(struct uart_port *,
				               struct ktermios *new,
				               const struct ktermios *old);
	void			(*set_ldisc)(struct uart_port *,
					     struct ktermios *);
	unsigned int		(*get_mctrl)(struct uart_port *);
	void			(*set_mctrl)(struct uart_port *, unsigned int);
	unsigned int		(*get_divisor)(struct uart_port *,
					       unsigned int baud,
					       unsigned int *frac);
	void			(*set_divisor)(struct uart_port *,
					       unsigned int baud,
					       unsigned int quot,
					       unsigned int quot_frac);
	int			(*startup)(struct uart_port *port);
	void			(*shutdown)(struct uart_port *port);
	void			(*throttle)(struct uart_port *port);
	void			(*unthrottle)(struct uart_port *port);
	int			(*handle_irq)(struct uart_port *);
	void			(*pm)(struct uart_port *, unsigned int state,
				      unsigned int old);
	void			(*handle_break)(struct uart_port *);
	int			(*rs485_config)(struct uart_port *,
						struct ktermios *termios,
						struct serial_rs485 *rs485);
	int			(*iso7816_config)(struct uart_port *,
						  struct serial_iso7816 *iso7816);
	unsigned int		ctrl_id;		/* optional serial core controller id */
	unsigned int		port_id;		/* optional serial core port id */
	unsigned int		irq;			/* irq number */
	unsigned long		irqflags;		/* irq flags  */
	unsigned int		uartclk;		/* base uart clock */
	unsigned int		fifosize;		/* tx fifo size */
	unsigned char		x_char;			/* xon/xoff char */
	unsigned char		regshift;		/* reg offset shift */
	unsigned char		quirks;			/* internal quirks */
	enum uart_iotype	iotype;			/* io access style */
	unsigned int		read_status_mask;	/* driver specific */
	unsigned int		ignore_status_mask;	/* driver specific */
	struct uart_state	*state;			/* pointer to parent state */
	struct uart_icount	icount;			/* statistics */
	struct console		*cons;			/* struct console, if any */
	upf_t			flags;
	upstat_t		status;
	bool			hw_stopped;		/* sw-assisted CTS flow state */
	bool			cons_flow;		/* user specified console flow control */
	unsigned int		mctrl;			/* current modem ctrl settings */
	unsigned int		frame_time;		/* frame timing in ns */
	unsigned int		type;			/* port type */
	const struct uart_ops	*ops;
	unsigned int		custom_divisor;
	unsigned int		line;			/* port index */
	unsigned int		minor;
	resource_size_t		mapbase;		/* for ioremap */
	resource_size_t		mapsize;
	struct device		*dev;			/* serial port physical parent device */
	struct serial_port_device *port_dev;		/* serial core port device */
	unsigned long		sysrq;			/* sysrq timeout */
	u8			sysrq_ch;		/* char for sysrq */
	unsigned char		has_sysrq;
	unsigned char		sysrq_seq;		/* index in sysrq_toggle_seq */
	unsigned char		hub6;			/* this should be in the 8250 driver */
	unsigned char		suspended;
	unsigned char		console_reinit;
	const char		*name;			/* port name */
	struct attribute_group	*attr_group;		/* port specific attributes */
	const struct attribute_group **tty_groups;	/* all attributes (serial core use only) */
	struct serial_rs485     rs485;
	struct serial_rs485	rs485_supported;	/* Supported mask for serial_rs485 */
	struct gpio_desc	*rs485_term_gpio;	/* enable RS485 bus termination */
	struct gpio_desc	*rs485_rx_during_tx_gpio; /* Output GPIO that sets the state of RS485 RX during TX */
	struct serial_iso7816   iso7816;
	void			*private_data;		/* generic platform data pointer */
};
```

A few fields worth calling out:

- **`serial_in`/`serial_out`** — the register-access indirection that lets one driver support several bus widths/endiannesses (8/16/32-bit, big/little-endian MMIO, or legacy port I/O) by swapping these function pointers rather than `#ifdef`-ing every register access.
- **`iotype`** (`enum uart_iotype`: `UPIO_PORT`, `UPIO_MEM`, `UPIO_MEM32`, `UPIO_MEM32BE`, `UPIO_MEM16`, plus a couple of chip-specific variants) — which access style `serial_in`/`serial_out` implement.
- **`line`** — this port's index; it's what ties a `uart_port` back to a specific slot in its `uart_driver`'s state array (below).
- **`state`** — the back-pointer to `struct uart_state`, the object that ties this hardware port to a live `tty_port`.
- **`ops`** — the `uart_ops` vtable described above.
- **`private_data`** — a driver-owned pointer for whatever per-instance state the callbacks need (clock handles, DMA channel, chip-specific config parsed from the device tree).

### `struct uart_driver`: the registration-level object

Where `uart_port` is one physical port, `struct uart_driver` is the registration for an entire chip family — one per driver module, not one per instance:

```c
// include/linux/serial_core.h
struct uart_driver {
	struct module		*owner;
	const char		*driver_name;
	const char		*dev_name;
	int			 major;
	int			 minor;
	int			 nr;
	struct console		*cons;

	/*
	 * these are private; the low level driver should not
	 * touch these; they should be initialised to NULL
	 */
	struct uart_state	*state;
	struct tty_driver	*tty_driver;
};
```

`driver_name`/`dev_name` are the `setserial`-visible name and the `/dev` name stem (`"ttyS"`, `"ttyUL"`, ...); `nr` is the maximum number of ports this driver family will ever register — it sizes the `state` array `uart_register_driver()` allocates. `cons`, if set, wires up this driver as a kernel console (`console=ttyS0` on the kernel command line). `state` and `tty_driver` are exactly what the comment says: filled in by `serial_core`, not touched by the driver.

## Bridging to the TTY layer

### `struct uart_state`: the persistent-across-opens object

`struct uart_state` is the small object that survives across an individual `open()`/`close()` cycle — the thing `uart_driver.state[]` is an array of, one per possible port:

```c
// include/linux/serial_core.h
struct uart_state {
	struct tty_port		port;

	enum uart_pm_state	pm_state;

	atomic_t		refcount;
	wait_queue_head_t	remove_wait;
	struct uart_port	*uart_port;
};
```

`port` is a generic `struct tty_port` — the TTY-core-side object every character device with open/close/hangup semantics embeds. `uart_port` is the live hardware port currently attached to this state slot (it can be `NULL` if the driver has registered the state array via `uart_register_driver()` but a specific instance hasn't shown up yet — common on a platform where a UART is a hot-pluggable add-in card).

### Registration: `uart_register_driver()` and `uart_add_one_port()`

Two calls wire everything up, and every UART driver's module init does both:

`uart_register_driver()` (`drivers/tty/serial/serial_core.c`) allocates `drv->state` (`drv->nr` entries), allocates a generic `struct tty_driver`, and — this is the key line — points that generic `tty_driver` at a single, shared `tty_operations` table:

```c
// drivers/tty/serial/serial_core.c — uart_register_driver(), abridged
drv->state = kzalloc_objs(struct uart_state, drv->nr);
...
normal = tty_alloc_driver(drv->nr, TTY_DRIVER_REAL_RAW | TTY_DRIVER_DYNAMIC_DEV);
...
drv->tty_driver = normal;
normal->driver_name	= drv->driver_name;
normal->name		= drv->dev_name;
...
tty_set_operations(normal, &uart_ops);

for (i = 0; i < drv->nr; i++) {
	struct uart_state *state = drv->state + i;
	struct tty_port *port = &state->port;

	tty_port_init(port);
	port->ops = &uart_port_ops;
}
```

That `uart_ops` is *not* the same type as the `struct uart_ops` hardware vtable above — it's a file-local `static const struct tty_operations` in `serial_core.c` that every UART driver family shares, unmodified, regardless of chip:

```c
// drivers/tty/serial/serial_core.c
static const struct tty_operations uart_ops = {
	.install	= uart_install,
	.open		= uart_open,
	.close		= uart_close,
	.write		= uart_write,
	.put_char	= uart_put_char,
	.flush_chars	= uart_flush_chars,
	.write_room	= uart_write_room,
	.chars_in_buffer= uart_chars_in_buffer,
	.flush_buffer	= uart_flush_buffer,
	.ioctl		= uart_ioctl,
	.throttle	= uart_throttle,
	.unthrottle	= uart_unthrottle,
	.send_xchar	= uart_send_xchar,
	.set_termios	= uart_set_termios,
	.set_ldisc	= uart_set_ldisc,
	.stop		= uart_stop,
	.start		= uart_start,
	.hangup		= uart_hangup,
	.break_ctl	= uart_break_ctl,
	.wait_until_sent= uart_wait_until_sent,
	...
	.tiocmget	= uart_tiocmget,
	.tiocmset	= uart_tiocmset,
	.set_serial	= uart_set_info_user,
	.get_serial	= uart_get_info_user,
	.get_icount	= uart_get_icount,
	...
};
```

Two structs, same identifier `uart_ops`, two different types — one is the per-driver hardware callback table (`struct uart_ops` from `serial_core.h`, chosen by each individual UART driver), the other is the single generic `struct tty_operations` table every serial-core-based `tty_driver` shares (defined once, privately, inside `serial_core.c`). It's a small but real naming collision worth being deliberate about when reading the source.

`uart_add_one_port()` is the second call, made once per physical port a driver finds (in a DT-enumerated platform driver, from `.probe()`; for a multi-port card driver, once per port on the card):

```c
// include/linux/serial_core.h
int uart_add_one_port(struct uart_driver *reg, struct uart_port *port);
void uart_remove_one_port(struct uart_driver *reg, struct uart_port *port);
```

It associates the `uart_port` the driver just filled in with `drv->state[port->line]` — the indexing convention used throughout `serial_core.c` is literally `state = drv->state + uport->line` — and, if a `tty_port_register_device()`-equivalent registration is needed, brings up the `/dev` node. (Recent kernels route the internal plumbing through a small serial-core "controller"/"port" sub-device model in `serial_ctrl.c`/`serial_port.c`, layered under `uart_add_one_port()` for power-management and device-model integration; the entry points and the `drv->state[port->line]` association a driver author needs to know are unchanged.)

### How a TTY-core call reaches hardware

Once registration is done, every `tty_operations` callback in the shared `uart_ops` table is generic serial-core logic that, at the point it needs to actually touch hardware, calls through `uport->ops`. A few concrete chains, taken directly from `serial_core.c`:

- Opening a port ultimately calls `uart_port_startup()`, which calls `uport->ops->startup(uport)` — the driver's `.startup`.
- `tcsetattr()`/`stty` reaches the shared `.set_termios = uart_set_termios`, which (holding the port's `termios_rwsem`) calls `uart_change_line_settings()`, which calls `uport->ops->set_termios(uport, termios, old_termios)` — the driver's `.set_termios`.
- Writing data eventually calls `uart_start()` → `__uart_start()`, which calls `port->ops->start_tx(port)` — the driver's `.start_tx`, which is where an interrupt-driven driver typically just unmasks the transmit-empty interrupt and lets the ISR do the rest (below).
- Setting RTS/DTR (`TIOCMSET`, or `CLOCAL`/`HUPCL` handling on open/close) calls `uart_update_mctrl()`, which calls `port->ops->set_mctrl(port, port->mctrl)`.

None of that logic is chip-specific; it's identical for an 8250 and for `uartlite`. Only the four calls above ever leave `serial_core.c` and land in driver code.

## The 8250/16550 driver: the reference UART

`drivers/tty/serial/8250/` is the 8250/16550-compatible family driver, and it's the one every other serial driver gets measured against, for a simple historical reason: the 16550 (and its UART-compatible successors) is the register model the original PC serial port used, so it's the oldest, most heavily used, and most thoroughly hardened UART driver in the tree. New chip-specific drivers routinely reuse pieces of it — `8250_omap.c`, `8250_dw.c`, `8250_pci1xxxx.c` and similar files under `drivers/tty/serial/8250/` are all thin wrappers around the shared 8250 core (`8250_port.c`) that add chip-specific DMA, clocking, or errata handling on top, rather than reimplementing the FIFO/register logic from scratch.

### The register model, briefly

A 16550-compatible UART exposes a small bank of byte-wide registers, several of which are *aliased* — the same offset means something different depending on direction and on the state of a control bit — which is exactly the sort of gnarly, chip-specific detail `struct uart_ops` exists to hide from everything above it:

| Offset | Read | Write | Purpose |
|---|---|---|---|
| 0 | RBR (Receive Buffer) | THR (Transmit Holding) | one byte in/out of the FIFO |
| 1 | IER (Interrupt Enable) | IER | which interrupt sources are unmasked |
| 2 | IIR (Interrupt ID) | FCR (FIFO Control) | why an interrupt fired / FIFO reset & trigger level |
| 3 | LCR (Line Control) | LCR | data bits, stop bits, parity, and the DLAB latch bit |
| 4 | MCR (Modem Control) | MCR | drive RTS/DTR (and loopback mode) |
| 5 | LSR (Line Status) | — | data-ready, overrun/parity/framing-error, THR-empty, break flags |
| 6 | MSR (Modem Status) | — | CTS/DSR/DCD/RI current state and delta bits |

Offsets 0 and 1 mean something else entirely — the low and high byte of the baud-rate divisor latch (DLL/DLM) — while `LCR`'s DLAB bit is set, which is why `.set_termios` has to briefly toggle DLAB, program the divisor, then restore LCR to its normal meaning. This is the kind of bit-banging `struct uart_port.serial_in`/`serial_out` and the offset constants in `include/uapi/linux/serial_reg.h` exist to keep contained to one driver; nothing above `uart_ops` ever needs to know an `IIR` read and an `FCR` write share the same address.

### `struct uart_8250_port`: 8250's `uart_port` subclass

The 8250 driver's per-port object embeds a plain `uart_port` as its first member and adds 8250-specific state around it — the classic Linux "subclassing by embedding" pattern:

```c
// include/linux/serial_8250.h
struct uart_8250_port {
	struct uart_port	port;
	struct timer_list	timer;		/* "no irq" timer */
	struct list_head	list;		/* ports on this IRQ */
	u32			capabilities;	/* port capabilities */
	u16			bugs;		/* port bugs */
	unsigned int		tx_loadsz;	/* transmit fifo load size */
	unsigned char		acr;
	unsigned char		fcr;
	unsigned char		ier;
	unsigned char		lcr;
	unsigned char		mcr;
	unsigned char		cur_iotype;	/* Running I/O type */
	unsigned int		rpm_tx_active;
	unsigned char		canary;		/* non-zero during system sleep
						 *   if no_console_suspend
						 */
	unsigned char		probe;
	struct mctrl_gpios	*gpios;
#define UART_PROBE_RSA	(1 << 0)

	u16			lsr_saved_flags;
	u16			lsr_save_mask;
	unsigned char		msr_saved_flags;

	struct uart_8250_dma	*dma;
	const struct uart_8250_ops *ops;

	/* 8250 specific callbacks */
	u32			(*dl_read)(struct uart_8250_port *up);
	void			(*dl_write)(struct uart_8250_port *up, u32 value);

	struct uart_8250_em485 *em485;
	void			(*rs485_start_tx)(struct uart_8250_port *up, bool toggle_ier);
	void			(*rs485_stop_tx)(struct uart_8250_port *up, bool toggle_ier);

	/* Serial port overrun backoff */
	struct delayed_work overrun_backoff;
	u32 overrun_backoff_time_ms;
};
```

`ier`/`fcr`/`lcr`/`mcr` are shadow copies of the hardware registers — several of the 8250-family registers are write-only, so the driver keeps its own idea of what it last programmed rather than reading it back. `serial8250_init_port()` (`drivers/tty/serial/8250/8250_port.c`) is what plugs this into `serial_core`: it sets `port->ops = &serial8250_pops`, the driver's `struct uart_ops` implementation:

```c
// drivers/tty/serial/8250/8250_port.c
static const struct uart_ops serial8250_pops = {
	.tx_empty	= serial8250_tx_empty,
	.set_mctrl	= serial8250_set_mctrl,
	.get_mctrl	= serial8250_get_mctrl,
	.stop_tx	= serial8250_stop_tx,
	.start_tx	= serial8250_start_tx,
	.throttle	= serial8250_throttle,
	.unthrottle	= serial8250_unthrottle,
	.stop_rx	= serial8250_stop_rx,
	.enable_ms	= serial8250_enable_ms,
	.break_ctl	= serial8250_break_ctl,
	.startup	= serial8250_startup,
	.shutdown	= serial8250_shutdown,
	.flush_buffer	= serial8250_flush_buffer,
	.set_termios	= serial8250_set_termios,
	.set_ldisc	= serial8250_set_ldisc,
	.pm		= serial8250_pm,
	.type		= serial8250_type,
	.release_port	= serial8250_release_port,
	.request_port	= serial8250_request_port,
	.config_port	= serial8250_config_port,
	.verify_port	= serial8250_verify_port,
#ifdef CONFIG_CONSOLE_POLL
	.poll_get_char = serial8250_get_poll_char,
	.poll_put_char = serial8250_put_poll_char,
#endif
};
```

## The interrupt-driven TX/RX path

This is where the abstraction pays off end to end: an interrupt fires, and a fixed, generic sequence turns raw register reads into bytes the line discipline (and eventually userspace) can read, or turns buffered write() data into register writes.

### RX: hardware → `uart_insert_char()` → `tty_flip_buffer_push()`

`serial8250_handle_irq_locked()` (`drivers/tty/serial/8250/8250_port.c`) is the top of the 8250 ISR chain. On the receive side, it reads `LSR`, and if data is ready calls `serial8250_rx_chars()`:

```c
// drivers/tty/serial/8250/8250_port.c — serial8250_handle_irq_locked(), abridged
status = serial_lsr_in(up);
...
if (status & (UART_LSR_DR | UART_LSR_BI) && !skip_rx) {
	...
	if (!up->dma || handle_rx_dma(up, iir))
		status = serial8250_rx_chars(up, status);
}
```

`serial8250_rx_chars()` drains the FIFO byte-by-byte via `serial8250_read_char()`, then pushes the whole batch to the line discipline in one call:

```c
// drivers/tty/serial/8250/8250_port.c
u16 serial8250_rx_chars(struct uart_8250_port *up, u16 lsr)
{
	struct uart_port *port = &up->port;
	int max_count = 256;

	do {
		serial8250_read_char(up, lsr);
		if (--max_count == 0)
			break;
		lsr = serial_in(up, UART_LSR);
	} while (lsr & (UART_LSR_DR | UART_LSR_BI));

	tty_flip_buffer_push(&port->state->port);
	return lsr;
}
```

And `serial8250_read_char()` is where a raw register byte becomes a properly flagged (`TTY_NORMAL`/`TTY_BREAK`/`TTY_PARITY`/`TTY_FRAME`) character handed to the generic layer:

```c
// drivers/tty/serial/8250/8250_port.c — serial8250_read_char(), abridged
if (likely(lsr & UART_LSR_DR))
	ch = serial_in(up, UART_RX);
else
	ch = 0;

port->icount.rx++;
...
uart_insert_char(port, lsr, UART_LSR_OE, ch, flag);
```

`uart_insert_char()` (`drivers/tty/serial/serial_core.c`) is `serial_core`'s generic RX entry point — every driver that doesn't need something more specialized calls it once per received byte:

```c
// drivers/tty/serial/serial_core.c
void uart_insert_char(struct uart_port *port, unsigned int status,
		      unsigned int overrun, u8 ch, u8 flag)
{
	struct tty_port *tport = &port->state->port;

	if ((status & port->ignore_status_mask & ~overrun) == 0)
		if (tty_insert_flip_char(tport, ch, flag) == 0)
			++port->icount.buf_overrun;

	if (status & ~port->ignore_status_mask & overrun)
		if (tty_insert_flip_char(tport, 0, TTY_OVERRUN) == 0)
			++port->icount.buf_overrun;
}
```

It checks the port's `ignore_status_mask` (set by `.set_termios`, from `termios` flags like `IGNPAR`/`IGNBRK`) before deciding whether the byte is worth keeping, then calls `tty_insert_flip_char()` — the generic TTY flip-buffer insert, which just queues the byte and its flag without waking anyone up yet. The driver's own loop keeps calling `uart_insert_char()` for every byte in the hardware FIFO; only once the batch is drained does it call `tty_flip_buffer_push(&port->state->port)` (`include/linux/tty_flip.h`) to hand the whole batch to the line discipline in one shot and wake any reader. Batching the wakeup this way — one `tty_flip_buffer_push()` per interrupt instead of one per byte — is a deliberate throughput choice, not an incidental one.

### TX: buffered data → `uart_fifo_get()` → hardware

The transmit half of the same handler runs when `LSR`'s THR-empty bit is set and the transmit-empty interrupt is enabled:

```c
// drivers/tty/serial/8250/8250_port.c — serial8250_handle_irq_locked(), abridged
if ((status & UART_LSR_THRE) && (up->ier & UART_IER_THRI)) {
	if (!up->dma || up->dma->tx_err)
		serial8250_tx_chars(up);
	else if (!up->dma->tx_running)
		__stop_tx(up);
}
```

`serial8250_tx_chars()` pulls bytes out of the port's transmit `kfifo` (the buffer `write()`/`tty_write()` filled) one at a time via `uart_fifo_get()` and writes them straight to the `THR` register, up to the FIFO's load size, until either the buffer empties or the load size is reached:

```c
// drivers/tty/serial/8250/8250_port.c — serial8250_tx_chars(), abridged
if (kfifo_is_empty(&tport->xmit_fifo)) {
	__stop_tx(up);
	return;
}

count = up->tx_loadsz;
do {
	unsigned char c;

	if (!uart_fifo_get(port, &c))
		break;

	serial_out(up, UART_TX, c);
	...
} while (--count > 0);

if (kfifo_len(&tport->xmit_fifo) < WAKEUP_CHARS)
	uart_write_wakeup(port);
```

`uart_fifo_get()` (`include/linux/serial_core.h`) is the generic counterpart to `uart_insert_char()` on the TX side — pull one character out of `port->state->port.xmit_fifo` and bump `port->icount.tx`:

```c
// include/linux/serial_core.h
static inline unsigned int uart_fifo_get(struct uart_port *up,
		unsigned char *ch)
{
	struct tty_port *tport = &up->state->port;
	unsigned int chars;

	chars = kfifo_get(&tport->xmit_fifo, ch);
	up->icount.tx += chars;

	return chars;
}
```

Once the FIFO empties, `.stop_tx` masks `UART_IER_THRI` back off, and the port goes idle until the next `write()` calls `uart_start()` → `.start_tx` to unmask it again. This start/feed/stop cycle — not a byte-at-a-time round trip through the TTY core — is what lets a 16-byte-deep 16550 FIFO sustain high baud rates without an interrupt per byte.

## Enumeration: how a UART gets probed

A UART is, from the device model's point of view, just another platform (or PCI, or USB, or I2C/SPI-attached) device, matched to its driver the same way any other platform driver is. For a memory-mapped SoC UART described in the device tree, that's a `struct platform_driver` with an `of_device_id` match table:

```c
// drivers/tty/serial/uartlite.c
static const struct of_device_id ulite_of_match[] = {
	{ .compatible = "xlnx,opb-uartlite-1.00.b", },
	{ .compatible = "xlnx,xps-uartlite-1.00.a", },
	{}
};
MODULE_DEVICE_TABLE(of, ulite_of_match);

static struct platform_driver ulite_platform_driver = {
	.probe = ulite_probe,
	.remove = ulite_remove,
	.driver = {
		.name  = "uartlite",
		.of_match_table = of_match_ptr(ulite_of_match),
		.pm = &ulite_pm_ops,
	},
};
```

When the kernel walks the device tree and finds a node whose `compatible` property matches one of these strings, the driver core calls `.probe()` with a `struct platform_device` carrying that node's resources — MMIO range, IRQ number, clock reference, and any vendor-specific properties (baud rate, parity, data bits, in `uartlite`'s case). ACPI-described UARTs follow the same shape with an `acpi_device_id` table instead of (or alongside) `of_device_id` — the DesignWare 8250 wrapper (`drivers/tty/serial/8250/8250_dw.c`) registers both `dw8250_of_match[]` and `dw8250_acpi_match[]` against the same `platform_driver`, so the identical driver binds whether firmware describes the port via devicetree or ACPI. There's also a separate, simpler 8250 platform driver for legacy ISA-style ports (`drivers/tty/serial/8250/8250_platform.c`, matched via its own `acpi_platform_serial_table[]`) and a devicetree-only one (`8250_of.c`) — several distinct platform drivers, all funneling into the same `serial8250_pops`/`uart_add_one_port()` core underneath. `.probe()`'s job is always the same regardless of firmware interface or which of these front-end drivers is involved: read the resources, fill in a `uart_port`, and call `uart_add_one_port()`.

## Worked example: `drivers/tty/serial/uartlite.c`

Xilinx's `uartlite` driver is a good worked example precisely because it *isn't* 8250-compatible — no FIFO trigger levels, no aliased registers, no divisor latch (baud rate is fixed at synthesis time for this soft IP core) — just four registers (RX, TX, a status register, a control register) and a minimal `uart_ops` implementation, which makes the `serial_core` plumbing easier to see without 8250's register quirks in the way.

### `.startup`/`.shutdown`

```c
// drivers/tty/serial/uartlite.c
static int ulite_startup(struct uart_port *port)
{
	struct uartlite_data *pdata = port->private_data;
	int ret;

	ret = clk_enable(pdata->clk);
	if (ret) {
		dev_err(port->dev, "Failed to enable clock\n");
		return ret;
	}

	ret = request_irq(port->irq, ulite_isr, IRQF_SHARED | IRQF_TRIGGER_RISING,
			  "uartlite", port);
	if (ret)
		return ret;

	uart_out32(ULITE_CONTROL_RST_RX | ULITE_CONTROL_RST_TX,
		ULITE_CONTROL, port);
	uart_out32(ULITE_CONTROL_IE, ULITE_CONTROL, port);

	return 0;
}

static void ulite_shutdown(struct uart_port *port)
{
	struct uartlite_data *pdata = port->private_data;

	uart_out32(0, ULITE_CONTROL, port);
	uart_in32(ULITE_CONTROL, port); /* dummy */
	free_irq(port->irq, port);
	clk_disable(pdata->clk);
}
```

`.startup` is the entire hardware bring-up: enable the clock, request the IRQ, reset both FIFOs, then enable the "interrupt enable" bit in the control register. `.shutdown` is the exact mirror. Note what's absent compared to an 8250-style driver: no baud-rate programming here, because `uartlite`'s baud rate is fixed hardware — this device's `.set_termios` (next) only ever *reports* the fixed rate back, never programs one.

### `.set_termios`

```c
// drivers/tty/serial/uartlite.c — ulite_set_termios(), abridged
static void ulite_set_termios(struct uart_port *port,
			      struct ktermios *termios,
			      const struct ktermios *old)
{
	unsigned long flags;
	struct uartlite_data *pdata = port->private_data;

	/* Set termios to what the hardware supports */
	termios->c_iflag &= ~BRKINT;
	termios->c_cflag &= ~(CSTOPB | PARENB | PARODD | CSIZE);
	termios->c_cflag |= pdata->cflags & (PARENB | PARODD | CSIZE);
	tty_termios_encode_baud_rate(termios, pdata->baud, pdata->baud);

	uart_port_lock_irqsave(port, &flags);

	port->read_status_mask = ULITE_STATUS_RXVALID | ULITE_STATUS_OVERRUN
		| ULITE_STATUS_TXFULL;
	...
```

Rather than negotiate, `.set_termios` here *overwrites* whatever the caller asked for with what the hardware actually is (`pdata->baud`, and whatever parity/data-bits this synthesized core was built with), then calls `tty_termios_encode_baud_rate()` to report that back through the generic `ktermios`. `port->read_status_mask` is exactly the mask `uart_insert_char()` (or here, the driver's own direct `tty_insert_flip_char()` calls) consults to decide which status bits matter.

### Interrupt handler and the RX/TX callbacks

```c
// drivers/tty/serial/uartlite.c
static irqreturn_t ulite_isr(int irq, void *dev_id)
{
	struct uart_port *port = dev_id;
	int stat, busy, n = 0;
	unsigned long flags;

	do {
		uart_port_lock_irqsave(port, &flags);
		stat = uart_in32(ULITE_STATUS, port);
		busy  = ulite_receive(port, stat);
		busy |= ulite_transmit(port, stat);
		uart_port_unlock_irqrestore(port, flags);
		n++;
	} while (busy);

	/* work done? */
	if (n > 1) {
		tty_flip_buffer_push(&port->state->port);
		return IRQ_HANDLED;
	} else {
		return IRQ_NONE;
	}
}
```

Where the 8250 ISR branches on which status bits are set, `uartlite`'s ISR just calls both `ulite_receive()` and `ulite_transmit()` every time it wakes up and loops until neither reports more work — a simpler, less register-count-sensitive shape that a single-byte-at-a-time (no deep FIFO) UART can afford. `ulite_receive()` reaches the TTY layer directly with `tty_insert_flip_char()` rather than going through `uart_insert_char()`:

```c
// drivers/tty/serial/uartlite.c — ulite_receive(), abridged
if (stat & ULITE_STATUS_RXVALID) {
	port->icount.rx++;
	ch = uart_in32(ULITE_RX, port);
	...
}
...
if (stat & ULITE_STATUS_RXVALID)
	tty_insert_flip_char(tport, ch, flag);
```

and `ulite_transmit()` mirrors 8250's `uart_fifo_get()` pattern exactly, just against a one-byte-wide hardware "FIFO":

```c
// drivers/tty/serial/uartlite.c — ulite_transmit(), abridged
if (!uart_fifo_get(port, &ch))
	return 0;

uart_out32(ch, ULITE_TX, port);

/* wake up */
if (kfifo_len(&tport->xmit_fifo) < WAKEUP_CHARS)
	uart_write_wakeup(port);
```

Both `uart_insert_char()` and a driver's own direct `tty_insert_flip_char()` calls are legitimate, real, in-tree patterns — `uart_insert_char()` adds the `ignore_status_mask`/overrun bookkeeping most drivers want for free; a driver with simpler status semantics, like this one, sometimes just calls the TTY-layer primitive directly.

### Registration

```c
// drivers/tty/serial/uartlite.c
static struct uart_driver ulite_uart_driver = {
	.owner		= THIS_MODULE,
	.driver_name	= "uartlite",
	.dev_name	= ULITE_NAME,
	.major		= ULITE_MAJOR,
	.minor		= ULITE_MINOR,
	.nr		= ULITE_NR_UARTS,
#ifdef CONFIG_SERIAL_UARTLITE_CONSOLE
	.cons		= &ulite_console,
#endif
};
```

and, inside `ulite_assign()` (called from `.probe()`), the two calls that tie a specific `uart_port` to that driver:

```c
// drivers/tty/serial/uartlite.c — ulite_assign(), abridged
port = &ulite_ports[id];

spin_lock_init(&port->lock);
port->fifosize = 16;
port->regshift = 2;
port->iotype = UPIO_MEM;
port->iobase = 1; /* mark port in use */
port->mapbase = base;
port->ops = &ulite_ops;
port->irq = irq;
port->flags = UPF_BOOT_AUTOCONF;
port->dev = dev;
port->type = PORT_UNKNOWN;
port->line = id;
port->private_data = pdata;

/* Register the port */
rc = uart_add_one_port(&ulite_uart_driver, port);
```

`uart_register_driver(&ulite_uart_driver)` runs once, from module init, before any port shows up; `uart_add_one_port()` runs once per physical port `.probe()` finds — for `uartlite`, that means once per device-tree node, since each synthesized `uartlite` core is a separate device.

## The full path, hardware to userspace

```
 UART hardware (8250, uartlite, PL011, ...)
        │  RBR/THR, LSR, IER, ... registers  ▲
        │  RX byte ready (IRQ)               │  TX register write
        ▼                                     │
 ┌─────────────────────────────────────────────┐
 │  driver interrupt handler                     │
 │  (serial8250_handle_irq_locked / ulite_isr)   │
 │                                                │
 │  RX: serial8250_read_char() / ulite_receive() │
 │        → uart_insert_char() or                │
 │          tty_insert_flip_char() directly       │
 │        → tty_flip_buffer_push()                │
 │                                                │
 │  TX: uart_fifo_get() drains xmit_fifo          │
 │        → serial_out()/uart_out32() to hw        │
 └───────────────────┬────────────────────────────┘
                      │  both directions go through struct uart_ops
                      │  (.startup/.shutdown/.set_termios/.start_tx/
                      │   .stop_tx/.set_mctrl/.get_mctrl/.tx_empty/...)
                      ▼
        serial_core.c (drivers/tty/serial/serial_core.c)
        ┌─────────────────────────────────────────┐
        │ struct uart_port  ←──ops──→ struct uart_ops (driver's table) │
        │      │ state                                                 │
        │      ▼                                                       │
        │ struct uart_state { tty_port, uart_port }                    │
        └───────────────────────┬───────────────────────────────────────┘
                                 │  drv->state[port->line], shared
                                 │  static const struct tty_operations uart_ops
                                 ▼
              generic tty_operations (.open/.close/.write/.set_termios/
              .ioctl/.throttle/.tiocmget/.tiocmset/...)
                                 ▼
                    TTY core (drivers/tty/tty_io.c)
                                 ▼
                  line discipline (n_tty by default —
                  see line-disciplines.md)
                                 ▼
                    userspace: read()/write() on
                    /dev/ttyS0, /dev/ttyUL0, ...
```

## Further reading

### Kernel source

- [`include/linux/serial_core.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/serial_core.h) — `struct uart_ops`, `struct uart_port`, `struct uart_driver`, `struct uart_state`, `uart_insert_char()`, `uart_fifo_get()`
- [`drivers/tty/serial/serial_core.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/tty/serial/serial_core.c) — `uart_register_driver()`, the shared `tty_operations`, `uart_start()`/`uart_port_startup()`/`uart_change_line_settings()`, `uart_insert_char()`
- [`drivers/tty/serial/serial_port.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/tty/serial/serial_port.c) — `uart_add_one_port()`/`uart_remove_one_port()`
- [`include/linux/serial_8250.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/serial_8250.h) — `struct uart_8250_port`
- [`drivers/tty/serial/8250/8250_port.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/tty/serial/8250/8250_port.c) — `serial8250_pops`, `serial8250_handle_irq_locked()`, `serial8250_rx_chars()`/`serial8250_read_char()`, `serial8250_tx_chars()`
- [`include/uapi/linux/serial_reg.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/serial_reg.h) — 8250/16550 register offsets and bit definitions (`UART_IER`, `UART_FCR`, `UART_LCR`, `UART_MCR`, `UART_LSR`, `UART_MSR`, ...)
- [`drivers/tty/serial/uartlite.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/tty/serial/uartlite.c) — the worked-example driver above
- [`include/linux/tty_flip.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/tty_flip.h) — `tty_insert_flip_char()`, `tty_flip_buffer_push()`

### Related pages

- [TTY Subsystem](README.md) — the generic TTY core, `tty_struct`, and where line disciplines and drivers each fit
- [Line Disciplines](line-disciplines.md) — what happens to a byte after `tty_flip_buffer_push()` hands it to `n_tty` or another ldisc
- [TTY/Serial War Stories](war-stories.md) — real incidents from the layer this page describes

### External

- [Serial drivers](https://docs.kernel.org/driver-api/serial/driver.html) — the kernel's own driver-API reference for `uart_ops`, `uart_port`, and the helper functions serial drivers use
