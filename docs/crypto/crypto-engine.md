# crypto_engine: Hardware Offload Framework

> How hardware crypto accelerators plug into the kernel

## The problem crypto_engine solves

Hardware crypto accelerators — STM32 CRYP, Allwinner CE, Marvell CESA, Intel QAT — all share
the same fundamental I/O model: you program a DMA descriptor, the hardware processes it
asynchronously, and you get an interrupt when it's done. Writing a driver that satisfies the
kernel crypto API's `do_one_request()` contract correctly while managing hardware queuing,
fallbacks, and error recovery requires a lot of boilerplate.

`crypto_engine` (introduced in kernel 3.19) provides a generic work-queue layer that sits between
the crypto API and a hardware driver. It:

- Serializes requests to hardware that can only process one at a time
- Handles retry when hardware is busy (enabled via `engine->retry_support = true`)
- Calls driver callbacks at the right points (prepare → do → finalize)
- Integrates with the async request completion path

Without crypto_engine, each driver implements its own queue, its own retry logic, and its own
locking — duplicating hundreds of lines of error-prone code.

```
Caller (IPsec, dm-crypt, TLS)
        │
        │ crypto_skcipher_encrypt(req)  ← async request
        ▼
  Kernel Crypto API (crypto/skcipher.c)
        │
        │ alg->encrypt(req)
        ▼
  crypto_engine work queue
  (crypto/engine.c)
        │  ← serialized, one request at a time
        │  1. driver->do_one_request(engine, req)
        │     ↓ programs DMA, returns -EINPROGRESS
        │
  Hardware DMA + interrupt
        │
        │ IRQ handler calls:
        │  crypto_finalize_skcipher_request(engine, req, err)
        ▼
  Caller's completion callback
```

## struct crypto_engine

Defined in the driver-internal header `include/crypto/internal/engine.h` (not the public
`include/crypto/engine.h`):

```c
/* include/crypto/internal/engine.h */
struct crypto_engine {
    char                    name[ENGINE_NAME_LEN];
    bool                    busy;         /* request pump is busy */
    bool                    running;

    bool                    retry_support;
    bool                    rt;           /* run the pump as a realtime task */

    struct list_head        list;
    spinlock_t              queue_lock;
    struct crypto_queue     queue;              /* pending requests */
    struct device           *dev;

    struct kthread_worker   *kworker;
    struct kthread_work     pump_requests;      /* work item pumping the queue */

    void                    *priv_data;
    struct crypto_async_request *cur_req;
};
```

A dedicated kthread worker (`kworker`) runs `pump_requests` to dequeue and dispatch requests
to hardware — not a generic workqueue. Most drivers allocate one engine per hardware channel,
or one per device if the hardware is single-channel. There is no batching callback on this
struct; see "Batching" below.

## Driver callbacks: crypto_engine_op

Each algorithm registered with crypto_engine provides a `struct crypto_engine_op`:

```c
/* include/crypto/engine.h (kernel 5.13+) */
struct crypto_engine_op {
    int (*do_one_request)(struct crypto_engine *engine,
                          void *areq);
};
```

| Callback | Called when | Typical work |
|---|---|---|
| `do_one_request` | Hardware is idle, request at head of queue | Start DMA, return `-EINPROGRESS` |

`do_one_request` is required and is the only callback in modern kernels (5.13+).

> **Note**: Before kernel ~5.13, the equivalent per-request-type structs also contained
> `prepare_cipher_request`/`unprepare_cipher_request` (and the `hash`-suffixed equivalents),
> removed in the engine refactor.

## Algorithm registration: skcipher_engine_alg

The engine op is embedded in the algorithm descriptor struct, not in a per-transform context
struct. For example, `struct skcipher_engine_alg` wraps `struct skcipher_alg` with an
appended `struct crypto_engine_op op`:

```c
/* include/crypto/engine.h */
struct skcipher_engine_alg {
    struct skcipher_alg     base;
    struct crypto_engine_op op;
};
```

The same pattern applies for AEAD (`struct aead_engine_alg`), ahash
(`struct ahash_engine_alg`), and akcipher (`struct akcipher_engine_alg`). Drivers embed the
engine op inside the algorithm descriptor and register with the engine-aware helpers (e.g.,
`crypto_engine_register_skcipher()`) rather than the plain crypto API helpers.

## How a driver uses crypto_engine

### Step 1: allocate and start the engine in probe

```c
/* drivers/crypto/mydrv.c */
struct mydrv_dev {
    struct device           *dev;
    void __iomem            *base;
    struct crypto_engine    *engine;
    struct clk              *clk;
    /* ... */
};

static int mydrv_probe(struct platform_device *pdev)
{
    struct mydrv_dev *dd;

    dd = devm_kzalloc(&pdev->dev, sizeof(*dd), GFP_KERNEL);
    dd->dev = &pdev->dev;

    /* Allocate and initialize the engine */
    dd->engine = crypto_engine_alloc_init(&pdev->dev, true);
    if (!dd->engine)
        return -ENOMEM;

    /* Optional: enable retry support (engine will re-queue if hardware busy) */
    dd->engine->retry_support = true;

    /* Start the engine's work queue */
    ret = crypto_engine_start(dd->engine);
    if (ret)
        goto err_engine;

    /* Register algorithms ... */
    return 0;

err_engine:
    crypto_engine_exit(dd->engine);
    return ret;
}

static int mydrv_remove(struct platform_device *pdev)
{
    struct mydrv_dev *dd = platform_get_drvdata(pdev);
    crypto_engine_stop(dd->engine);
    crypto_engine_exit(dd->engine);
    return 0;
}
```

### Step 2: register algorithms via crypto_engine helpers

Instead of `crypto_register_skcipher()`, use the engine-aware wrapper:

```c
static struct skcipher_engine_alg mydrv_aes_algs[] = {
    {
        .base = {
            .base = {
                .cra_name        = "cbc(aes)",
                .cra_driver_name = "mydrv-cbc-aes",
                .cra_priority    = 300,
                .cra_flags       = CRYPTO_ALG_ASYNC | CRYPTO_ALG_KERN_DRIVER_ONLY,
                .cra_blocksize   = AES_BLOCK_SIZE,
                .cra_ctxsize     = sizeof(struct mydrv_ctx),
                .cra_module      = THIS_MODULE,
            },
            .min_keysize = AES_MIN_KEY_SIZE,
            .max_keysize = AES_MAX_KEY_SIZE,
            .ivsize      = AES_BLOCK_SIZE,
            .setkey      = mydrv_aes_setkey,
            .encrypt     = mydrv_aes_encrypt,   /* enqueues via crypto_transfer_skcipher_request_to_engine() */
            .decrypt     = mydrv_aes_decrypt,
            .init        = mydrv_aes_init,
            .exit        = mydrv_aes_exit,
        },
        .op = {
            .do_one_request    = mydrv_do_one_request,
        },
    },
};

/* In probe, after engine is started (register each algorithm individually): */
ret = crypto_engine_register_skcipher(&mydrv_aes_algs[0]);
```

### Step 3: the encrypt/decrypt entry points enqueue the request

```c
/* Called by the crypto API when a caller does crypto_skcipher_encrypt() */
static int mydrv_aes_encrypt(struct skcipher_request *req)
{
    struct mydrv_ctx *ctx = crypto_skcipher_ctx(
                                crypto_skcipher_reqtfm(req));
    /*
     * Hand the request off to the engine queue.
     * Returns -EINPROGRESS immediately if queued.
     * Returns 0 if completed synchronously (unusual for hardware).
     */
    return crypto_transfer_skcipher_request_to_engine(ctx->dd->engine, req);
}

static int mydrv_aes_decrypt(struct skcipher_request *req)
{
    struct mydrv_ctx *ctx = crypto_skcipher_ctx(
                                crypto_skcipher_reqtfm(req));
    return crypto_transfer_skcipher_request_to_engine(ctx->dd->engine, req);
}
```

### Step 4: do_one_request programs the hardware

```c
static int mydrv_do_one_request(struct crypto_engine *engine, void *areq)
{
    struct skcipher_request *req = skcipher_request_cast(areq);
    struct mydrv_ctx *ctx = crypto_skcipher_ctx(
                                crypto_skcipher_reqtfm(req));
    struct mydrv_dev *dd = ctx->dd;

    /* Set up DMA: scatter-gather to/from hardware FIFO */
    ret = dma_map_sg(dd->dev, req->src, sg_nents(req->src), DMA_TO_DEVICE);
    ret = dma_map_sg(dd->dev, req->dst, sg_nents(req->dst), DMA_FROM_DEVICE);

    /* Program hardware registers */
    /* Note: req->iv is a virtual pointer; obtain a DMA address via dma_map_single() */
    dma_addr_t iv_dma = dma_map_single(dd->dev, req->iv, crypto_skcipher_ivsize(...),
                                        DMA_TO_DEVICE);
    writel(MYDRV_CTRL_START | MYDRV_CTRL_CBC, dd->base + MYDRV_CTRL);
    writel(ctx->key_phys, dd->base + MYDRV_KEY_ADDR);
    writel(iv_dma,        dd->base + MYDRV_IV_ADDR);

    /* Start DMA */
    mydrv_start_dma(dd, req->src, req->dst, req->cryptlen);

    /* Hardware is now running asynchronously.
     * Return -EINPROGRESS to indicate that the caller's completion
     * callback will be called from interrupt context later. */
    return -EINPROGRESS;
}
```

### Step 5: complete from the interrupt handler

```c
static irqreturn_t mydrv_irq(int irq, void *dev_id)
{
    struct mydrv_dev *dd = dev_id;
    u32 status = readl(dd->base + MYDRV_STATUS);

    if (!(status & MYDRV_STATUS_DONE))
        return IRQ_NONE;

    /* Acknowledge interrupt */
    writel(MYDRV_STATUS_DONE, dd->base + MYDRV_STATUS);

    /* Unmap DMA */
    dma_unmap_sg(dd->dev, dd->cur_req->src, ...);
    dma_unmap_sg(dd->dev, dd->cur_req->dst, ...);

    /* Tell the engine this request is done.
     * err = 0 on success, negative errno on hardware error.
     * This will call the original requester's completion callback
     * and then pump the next request from the queue. */
    crypto_finalize_skcipher_request(dd->engine, dd->cur_req,
                                      (status & MYDRV_STATUS_ERR) ? -EIO : 0);

    return IRQ_HANDLED;
}
```

`crypto_finalize_skcipher_request()` (and equivalents for AEAD, ahash, akcipher) invokes
the request's completion callback, then kicks the engine to pump the next queued request.

## The fallback pattern

Hardware accelerators often have limitations: they may not support all key sizes, all modes,
or may be unavailable (e.g., during suspend). The standard pattern is to keep a software
`fallback` transform and use it when the hardware can't handle a request.

```c
struct mydrv_ctx {
    struct mydrv_dev        *dd;
    struct crypto_skcipher  *fallback;  /* software AES-CBC */
    u8                       key[AES_MAX_KEY_SIZE];
    unsigned int             keylen;
};

static int mydrv_aes_init(struct crypto_skcipher *tfm)
{
    struct mydrv_ctx *ctx = crypto_skcipher_ctx(tfm);

    /* Allocate a software fallback for unsupported requests */
    ctx->fallback = crypto_alloc_skcipher("cbc(aes)", 0,
                                           CRYPTO_ALG_NEED_FALLBACK);
    if (IS_ERR(ctx->fallback))
        return PTR_ERR(ctx->fallback);

    /* Ensure the request size accounts for the fallback's request size */
    crypto_skcipher_set_reqsize(tfm, sizeof(struct mydrv_req) +
                                 crypto_skcipher_reqsize(ctx->fallback));
    return 0;
}

static void mydrv_aes_exit(struct crypto_skcipher *tfm)
{
    struct mydrv_ctx *ctx = crypto_skcipher_ctx(tfm);
    crypto_free_skcipher(ctx->fallback);
}

static int mydrv_aes_setkey(struct crypto_skcipher *tfm,
                             const u8 *key, unsigned int keylen)
{
    struct mydrv_ctx *ctx = crypto_skcipher_ctx(tfm);
    int ret;

    /* Some hardware only supports 128-bit keys */
    if (keylen != AES_KEYSIZE_128)
        ctx->use_fallback = true;
    else
        ctx->use_fallback = false;

    memcpy(ctx->key, key, keylen);
    ctx->keylen = keylen;

    /* Always set the key on the fallback too */
    crypto_skcipher_clear_flags(ctx->fallback, CRYPTO_TFM_REQ_MASK);
    crypto_skcipher_set_flags(ctx->fallback,
        crypto_skcipher_get_flags(tfm) & CRYPTO_TFM_REQ_MASK);
    return crypto_skcipher_setkey(ctx->fallback, key, keylen);
}

static int mydrv_aes_encrypt(struct skcipher_request *req)
{
    struct mydrv_ctx *ctx = crypto_skcipher_ctx(
                                crypto_skcipher_reqtfm(req));

    if (ctx->use_fallback) {
        /* Use the fallback's subrequest, stored after our own req data */
        struct skcipher_request *subreq = skcipher_request_ctx(req);
        skcipher_request_set_tfm(subreq, ctx->fallback);
        skcipher_request_set_callback(subreq, req->base.flags,
                                       req->base.complete, req->base.data);
        skcipher_request_set_crypt(subreq, req->src, req->dst,
                                    req->cryptlen, req->iv);
        return crypto_skcipher_encrypt(subreq);
    }

    return crypto_transfer_skcipher_request_to_engine(ctx->dd->engine, req);
}
```

The same pattern applies to AEAD (`struct aead_engine_alg`, `crypto_finalize_aead_request()`),
ahash, and akcipher.

## Retry support

When `engine->retry_support = true`, `crypto_pump_requests()` in `crypto/crypto_engine.c`
handles a `do_one_request()` failure differently depending on the error:

- **`-ENOSPC`**: only the single request that just failed is re-queued, at the *head* of the
  engine queue (`crypto_enqueue_request_head()`) to preserve ordering, and the pump is
  rescheduled to retry it on the next cycle. This handles drivers whose hardware command
  FIFOs can fill up under sustained load (e.g., Marvell CESA, Allwinner CE).
- **Any other error**: the request fails immediately (`crypto_request_complete()`) regardless
  of retry support. The `CRYPTO_TFM_REQ_MAY_BACKLOG` flag is unrelated to this retry path —
  it governs backlog behavior when a request is first submitted to an already-full queue, not
  what happens after `do_one_request()` fails.

Without retry support (or on any non-`-ENOSPC` error), a hardware failure causes the request
to fail immediately with an error back to the caller.

## Batching

There is no batching callback in `crypto_engine` — `struct crypto_engine` has no
`do_batch_requests`-style hook, and `crypto_pump_requests()` always dispatches exactly one
request per `do_one_request()` call. Hardware capable of submitting several requests in a
single DMA pass (e.g., QAT) implements its own batching outside of `crypto_engine`, or
processes requests one at a time through it regardless.

## crypto_engine vs. writing directly to the crypto API

| Scenario | Use crypto_engine | Write directly |
|---|---|---|
| Hardware is DMA-based, async completion via IRQ | Yes | — |
| Hardware can only do one operation at a time | Yes | — |
| Hardware has a deep command queue (e.g., 64 slots) | Optional | Driver can manage its own queue instead |
| Pure software algorithm (no DMA) | No | Yes (`crypto_register_skcipher`) |
| SIMD-accelerated (AES-NI, ARM CE) | No | Yes (use kernel_fpu_begin) |
| PCIe offload card with its own scheduler | Optional | Sometimes better |

## Real driver examples

| Driver | Source | Notable pattern |
|---|---|---|
| stm32-cryp | `drivers/crypto/stm32/stm32-cryp.c` | Single-channel, full fallback, rotate IV in CBC |
| sun8i-ce | `drivers/crypto/allwinner/sun8i-ce/` | Multi-algorithm crypto_engine user, scatter-gather |
| marvell/cesa | `drivers/crypto/marvell/cesa/` | Does *not* use `crypto_engine` — its own TDMA-chain-based queueing |
| bcm2835 | `drivers/crypto/bcm/cipher.c` | Does *not* use `crypto_engine` — submits via the mailbox (mbox) framework to the SPU coprocessor |

## Observing crypto_engine

```bash
# See which algorithms are ASYNC (hardware-backed)
cat /proc/crypto | grep -E "^(name|type|async)"
# async        : yes   ← hardware-accelerated

# Kernel tracepoints for crypto operations
perf trace -e crypto:*

# For specific drivers, check debugfs
ls /sys/kernel/debug/
# Some drivers export counters here (e.g., number of requests, fallback count)

# Run the crypto test suite against hardware algorithms
# Note: mode=1 tests MD5 only. To run all algorithm tests, use mode=0.
modprobe tcrypt mode=0
# This exercises all registered algorithms including hardware ones
```

## Further reading

### Kernel source

- [crypto/crypto_engine.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/crypto/crypto_engine.c) — the engine implementation: `crypto_pump_requests()`, the retry/backlog logic, and the `crypto_engine_register_*()` helpers
- [include/crypto/engine.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/crypto/engine.h) — the public API: `struct crypto_engine_op`, the `*_engine_alg` wrapper structs, `crypto_transfer_*_request_to_engine()`, `crypto_finalize_*_request()`
- [include/crypto/internal/engine.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/crypto/internal/engine.h) — the actual `struct crypto_engine` definition (driver-internal header)
- [Documentation/crypto/crypto_engine.rst](https://docs.kernel.org/crypto/crypto_engine.html) — kernel documentation; note it still describes the older `enginectx`/`prepare_cipher_request` design and has not been updated for the `crypto_engine_op`/`do_one_request` model in current code

### Related pages

- [Kernel Crypto API](crypto-api.md) — SKCIPHER, AEAD, ahash interfaces that `crypto_engine` sits underneath
- [dm-crypt and fscrypt](encryption.md) — consumers of hardware crypto
- [Crypto War Stories](war-stories.md) — incident 5 covers a hardware accelerator silently corrupting ciphertext and the fallback pattern used to work around it
- [Memory Management: DMA](../mm/dma.md) — scatter-gather and DMA mapping used by `do_one_request()` implementations

### LWN articles

- [LWN: Asynchronous crypto](https://lwn.net/Articles/109475/) (November 3, 2004) — the original design discussion for queueing crypto requests to hardware accelerators with async completion callbacks; the conceptual ancestor of the `-EINPROGRESS` / completion-callback model `crypto_engine` implements
