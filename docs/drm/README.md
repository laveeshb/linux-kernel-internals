# DRM: the Direct Rendering Manager

> How Linux shares one GPU between many processes — privileged display and memory-management operations live in the kernel, while userspace builds the command buffers the hardware actually executes

## Getting Started

A GPU is a single, expensive, stateful piece of hardware that many unrelated processes need to touch at once: a compositor scanning out a desktop, a browser tab rendering WebGL, a game submitting draw calls, a media player decoding video on a fixed-function block. **DRM (Direct Rendering Manager)**, living under `drivers/gpu/drm/`, is the kernel subsystem that arbitrates this sharing. It splits cleanly into two halves:

- **KMS (Kernel Mode Setting)** — the *output* side: choosing a display mode, wiring a frame buffer to a physical connector, and pushing pixels out over HDMI/DisplayPort/eDP.
- **Rendering and acceleration** — the *compute/draw* side: allocating GPU-visible memory, submitting command buffers, and synchronizing that work with the rest of the system.

### The problem DRM solves

In the pre-DRM world, X servers (XFree86) drove graphics hardware directly from userspace, running as root and poking hardware registers itself. That meant every process wanting graphics either went through one privileged, crash-prone server, or — worse — every driver duplicated its own root-level hardware access. A bug in a userspace graphics driver could hang or corrupt the whole machine, and there was no kernel arbiter to stop two clients from fighting over the same display or GPU memory.

DRM's answer is a familiar kernel pattern: put the parts that require trust in the kernel, keep the parts that don't in userspace. The kernel side validates and owns modesetting, GPU memory management, and command-submission bookkeeping (which buffers a job touches, when it's safe to reclaim them). The userspace driver — largely **Mesa** — is the part that actually knows how to translate OpenGL/Vulkan calls into the hardware's native command-buffer format; it builds those buffers in unprivileged userspace and hands them to the kernel through an ioctl, where the kernel checks them before letting the GPU touch memory it shouldn't.

### Architecture: core + drivers, kernel + userspace

```
  Application (game, browser, compositor)
          │  OpenGL / Vulkan calls
          ▼
  Mesa (userspace GPU driver)   ← builds command buffers, talks to libdrm
          │  ioctls via libdrm
          ▼
  DRM core (drivers/gpu/drm/)  ← generic KMS objects, GEM, dma-buf, scheduler
          │
          ▼
  Per-hardware DRM driver       ← i915 / xe (Intel), amdgpu (AMD),
          │                        nouveau (NVIDIA), many SoC display drivers
          ▼
  GPU hardware
```

The **DRM core** provides the shared machinery — the KMS object model, GEM buffer lifecycle, dma-buf/fence plumbing, a generic GPU scheduler — so that each hardware driver only has to implement the hardware-specific pieces underneath a common ioctl and uAPI surface. On top, `libdrm` wraps the raw ioctls in a stable C API, and Mesa is the userspace driver stack that consumes it.

### Two device nodes, two privilege levels

DRM exposes each GPU as (at least) two character devices with different trust levels:

- **`/dev/dri/card0`** — the **primary node**. This is the privileged interface: modesetting, and historically all rendering too. A display server or compositor opens this to configure outputs.
- **`/dev/dri/renderD128`** — the **render node**. Introduced so that offscreen renderers and GPGPU clients — a headless compute job, a video transcoder — can submit rendering work *without* authenticating to a display server and without any modesetting access. Render nodes drop the DRM-Master concept entirely: no global or privileged ioctls are permitted, only non-global rendering commands and PRIME (dma-buf) buffer sharing. Access control is just filesystem permissions on the node.

### The rest of this section

The pages that follow go deeper on each piece summarized above:

- **KMS modesetting** — the object model (CRTC, plane, connector, encoder) and how atomic modesetting commits a whole display configuration as one indivisible transaction instead of the old per-property, get-it-wrong-and-flicker interface.
- **GEM buffer objects and dma-buf** — how GPU memory is allocated and refcounted (GEM), and how buffers are shared *across* devices and subsystems — GPU to display, GPU to V4L2 capture — via dma-buf.
- **Command submission, fences, and the scheduler** — how a batch of GPU work gets from an ioctl to hardware execution, and how fences let the kernel track "is this buffer still in use" across asynchronous, pipelined GPU work.

### Prerequisites and neighbors

GPUs are almost always [PCIe devices](../drivers/pci-driver.md), so the PCI driver-binding model underneath applies here too. Buffer objects that the GPU reads or writes are subject to the same [DMA](../mm/dma.md) coherency rules as any other DMA-capable device. Reading order: this page, then KMS, then GEM/dma-buf, then command submission — each builds on device/memory-management concepts from the one before.

## Further reading

- [Kernel docs: GPU driver developer's guide](https://docs.kernel.org/gpu/index.html) — the top-level index for all DRM kernel documentation
- [Kernel docs: introduction](https://docs.kernel.org/gpu/introduction.html) — scope of the DRM layer and documentation conventions
- [Kernel docs: kernel mode setting (KMS)](https://docs.kernel.org/gpu/drm-kms.html) — the CRTC/plane/connector/encoder object model and atomic modesetting
- [Kernel docs: memory management](https://docs.kernel.org/gpu/drm-mm.html) — GEM, TTM, and buffer object lifecycle
- [Kernel docs: DRM internals](https://docs.kernel.org/gpu/drm-internals.html) — driver-facing internals of the DRM core
- [Kernel docs: DRM uAPI](https://docs.kernel.org/gpu/drm-uapi.html) — the userspace-facing ioctl surface, including the primary/render node split
- [PCI Drivers](../drivers/pci-driver.md) · [DMA](../mm/dma.md) — the bus and memory layers most DRM drivers sit on
