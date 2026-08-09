# Tracing War Stories

> Real bugs from the observability stack — where "let users safely watch the kernel" turned out to be much harder than it sounds

Tracing is a strange corner of the kernel: it exists to let code *outside* the core reach *inside* it — read arguments, run at arbitrary functions, sometimes even run user-supplied programs. That reach is exactly what makes it powerful, and exactly what makes it dangerous. Each of these stories is a place where the reach cut the wrong way.

## 1. The profiler that handed out root

**Symptom.** On essentially every distro kernel of its day, an unprivileged user could become root with a short, reliable exploit — through the performance-monitoring syscall.

**Root cause.** `perf_event_open()` accepts an event configuration from user space. In the software-event setup path, one field was handled as a signed value where it should have been an unsigned 64-bit index, so a crafted `config` indexed *before* the start of an array — an out-of-bounds write into kernel memory, fully controlled by the caller. This became **CVE-2013-2094**, one of the most widely used local privilege escalations of its era.

**Fix.** Treat the field as the `u64` it is, so the index can't go negative ([`8176cced706b`](https://git.kernel.org/linus/8176cced706b), "perf: Treat attr.config as u64 in perf_swevent_init()").

**Lesson.** Tracing infrastructure is *privileged kernel attack surface fed by user input*. A single sign-extension slip in code meant to *observe* the system became a total compromise of it. Every value that crosses the tracing boundary is untrusted.

## 2. When "provably safe" stopped being safe

**Symptom.** BPF programs — which the kernel's **verifier** proves cannot crash or read out of bounds before they're allowed to run — could nonetheless be made to leak arbitrary kernel memory.

**Root cause.** [Spectre v1](../bpf/README.md). The verifier proved that *architecturally* a program never accessed memory outside a map's bounds. But a CPU **speculatively** executes past a bounds check before resolving it, briefly touching out-of-bounds memory and leaving a measurable cache footprint — a side channel the program's owner could read back. The program was safe as written and still leaked; the threat model itself had changed underneath the verifier.

**Fix.** Teach the verifier to *mask* array indices so that even speculative accesses are clamped within bounds, closing the window the CPU could run through ([`b2157399cc98`](https://git.kernel.org/linus/b2157399cc98), "bpf: prevent out-of-bounds speculation").

**Lesson.** "Provably safe" is only as strong as the machine model you prove against. When speculative execution entered the threat model, a whole class of *formally verified* programs became unsafe overnight — and the safety proof had to grow to cover the hardware's guesses, not just its commitments.

## 3. Tracing the tracer

**Symptom.** Enabling a tracer could lock up the machine — the tracing code, while recording an event, called a function that was *itself* being traced, which recorded another event, which called it again.

**Root cause.** Instrumentation shares the kernel with what it instruments. If any function on the trace-recording path is also a traced function, you get unbounded recursion. The kernel guards against this pervasively — hot tracing paths are marked `notrace`, and tracers keep per-CPU recursion flags — but a gap in that armor, such as the function-graph *return* handler re-entering itself, reintroduces the loop.

**Fix.** Add explicit recursion protection to the affected path ([`0db0934e7f9b`](https://git.kernel.org/linus/0db0934e7f9b), "tracing: fgraph: Protect return handler from recursion loop").

**Lesson.** Observation is not free of the system it observes. A tracer must be scrupulous about never tracing itself — a discipline that has to be maintained at every entry point, because a single un-guarded one turns "watch this function" into a hang.

## The recurring theme

All three come from the same tension: tracing must reach deep into the kernel, from a less-trusted context, without becoming a weapon or a foot-gun.

- **Everything crossing the boundary is untrusted input** (story 1).
- **Safety proofs must match the real machine, speculation included** (story 2).
- **The observer is part of the system and must not perturb — or recurse into — itself** (story 3).

## Further reading

- [`8176cced706b`](https://git.kernel.org/linus/8176cced706b) — the CVE-2013-2094 perf fix
- [`b2157399cc98`](https://git.kernel.org/linus/b2157399cc98) — the BPF anti-speculation change
- [BPF](../bpf/README.md) — the verifier that these speculation defenses live in
