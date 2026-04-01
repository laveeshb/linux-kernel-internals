# crypto_engine: Hardware Offload Framework

> How hardware crypto accelerators plug into the kernel

## The problem crypto_engine solves

Hardware crypto accelerators — STM32 CRYP, Allwinner CE, Marvell CESA, Intel QAT — all share
the same fundamental I/O model: you program a DMA descriptor, the hardware processes it
asynchronously, and you get an interrupt when it's done. Writing a driver that satisfies the
kernel crypto API's `do_one_request()` contract correctly while managing hardware queuing,
fallbacks, and error recovery requires a lot of boilerplate.

`crypto_engine` (introduced in kernel 4.0) provides a generic work-queue layer that sits between
the crypto API and a hardware driver. It:

- Serializes requests to hardware that can only process one at a time
- Handles retry when hardware is busy (`ENGINE_FLAG_RETRY`)
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
        │  1. driver->prepare_request(engine, req)
        │  2. driver->do_one_request(engine, req)
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

Defined in `include/crypto/engine.h`:

```c
struct crypto_engine {
    char                    name[ENGINE_NAME_LEN];
    bool                    idling;
    bool                    retry_support;      /* ENGINE_FLAG_RETRY */

    struct list_head        cur_req_list;
    struct crypto_async_request *cur_req;

    bool                    running;
    int                     cur_req_prepared;

    struct list_head        list;
    spinlock_t              queue_lock;
    struct crypto_queue     queue;              /* pending requests */

    bool                    busy;
    bool                    first_tr_started;

    struct work_struct      pump_requests;      /* kthread pumping the queue */
    struct workqueue_struct *wq;

    int (*prepare_crypt_hardware)(struct crypto_engine *engine);
    int (*unprepare_crypt_hardware)(struct crypto_engine *engine);
    int (*do_batch_requests)(struct crypto_engine *engine);
};
```

The `wq` workqueue runs `pump_requests` to dequeue and dispatch requests to hardware. Most
drivers allocate one engine per hardware channel, or one per device if the hardware is
single-channel.

## Driver callbacks: crypto_engine_op

Each algorithm registered with crypto_engine provides a `struct crypto_engine_op`:

```c
/* include/crypto/engine.h */
struct crypto_engine_op {
    int (*prepare_request)(struct crypto_engine *engine,
                           void *areq);
    int (*unprepare_request)(struct crypto_engine *engine,
                             void *areq);
    int (*do_one_request)(struct crypto_engine *engine,
                          void *areq);
};
```

| Callback | Called when | Typical work |
|---|---|---|
| `prepare_request` | Before dispatching to hardware | Map scatter-gather, derive IV, set up DMA descriptors |
| `do_one_request` | Hardware is idle, request at head of queue | Start DMA, return `-EINPROGRESS` |
| `unprepare_request` | After completion (success or error) | Unmap DMA, free temporary buffers |

`prepare_request` and `unprepare_request` are optional. `do_one_request` is required.

## Per-request context: skcipher_engine_ctx and aead_engine_ctx

Each transform context embeds a `struct crypto_engine_op` so the engine can find the callbacks:

```c
/* include/crypto/engine.h */
struct skcipher_engine_ctx {
    struct crypto_engine_op op;
};

struct aead_engine_ctx {
    struct crypto_engine_op op;
};

struct ahash_engine_ctx {
    bool                    used;
    struct crypto_engine_op op;
};

struct akcipher_engine_ctx {
    struct crypto_engine_op op;
};
```

A driver's private transform context must start with one of these structs (or embed it as the
first member), so that `crypto_engine` can cast to it generically.

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
            .prepare_request   = mydrv_prepare_request,
            .unprepare_request = mydrv_unprepare_request,
            .do_one_request    = mydrv_do_one_request,
        },
    },
};

/* In probe, after engine is started: */
ret = crypto_engine_register_skciphers(mydrv_aes_algs,
                                        ARRAY_SIZE(mydrv_aes_algs));
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
    writel(MYDRV_CTRL_START | MYDRV_CTRL_CBC, dd->base + MYDRV_CTRL);
    writel(ctx->key_phys, dd->base + MYDRV_KEY_ADDR);
    writel(req->iv_phys,  dd->base + MYDRV_IV_ADDR);

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

`crypto_finalize_skcipher_request()` (and equivalents for AEAD, ahash, akcipher) calls
`unprepare_request` if registered, then invokes the request's completion callback, then
kicks the engine to pump the next queued request.

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

The same pattern applies to AEAD (`aead_engine_ctx`, `crypto_finalize_aead_request()`), ahash,
and akcipher.

## Retry support: ENGINE_FLAG_RETRY

When `engine->retry_support = true`, if `do_one_request()` returns `-ENOSPC` or `-EBUSY`, the
engine re-queues the request and tries again after a delay. This is used by drivers whose
hardware command FIFOs can fill up under sustained load (e.g., Marvell CESA, Allwinner CE).

Without retry support, a busy hardware return causes the request to fail immediately with an
error back to the caller.

## Batching: do_batch_requests

Some hardware (like QAT) can process a batch of requests in one DMA pass. The engine
supports this via the optional `do_batch_requests` callback on the engine itself:

```c
dd->engine->do_batch_requests = mydrv_do_batch;
```

When set, the engine calls `do_batch_requests` instead of `do_one_request` for each pump
cycle. The driver can then dequeue multiple requests from `engine->queue` and program them
all in a single hardware submission.

## crypto_engine vs. writing directly to the crypto API

| Scenario | Use crypto_engine | Write directly |
|---|---|---|
| Hardware is DMA-based, async completion via IRQ | Yes | — |
| Hardware can only do one operation at a time | Yes | — |
| Hardware has a deep command queue (e.g., 64 slots) | Use do_batch_requests | — |
| Pure software algorithm (no DMA) | No | Yes (`crypto_register_skcipher`) |
| SIMD-accelerated (AES-NI, ARM CE) | No | Yes (use kernel_fpu_begin) |
| PCIe offload card with its own scheduler | Optional | Sometimes better |

## Real driver examples

| Driver | Source | Notable pattern |
|---|---|---|
| stm32-cryp | `drivers/crypto/stm32/stm32-cryp.c` | Single-channel, full fallback, rotate IV in CBC |
| sun8i-ce | `drivers/crypto/allwinner/sun8i-ce/` | Multi-algorithm, retry support, scatter-gather |
| marvell/cesa | `drivers/crypto/marvell/cesa/` | Batching via chain descriptors |
| bcm2835 | `drivers/crypto/bcm/cipher.c` | Broadcom scatter-gather DMA engine |

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
modprobe tcrypt mode=1
# This exercises registered algorithms including hardware ones
```

## Relevant source

- `crypto/engine.c` — the engine implementation
- `include/crypto/engine.h` — structs and prototypes
- `drivers/crypto/` — all upstream hardware crypto drivers
- `Documentation/crypto/crypto_engine.rst` — kernel documentation

## Further reading

- [Kernel Crypto API](crypto-api.md) — SKCIPHER, AEAD, ahash interfaces
- [dm-crypt and fscrypt](encryption.md) — consumers of hardware crypto
- [Memory Management: DMA](../mm/dma.md) — scatter-gather and DMA mapping
