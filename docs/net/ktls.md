# Kernel TLS (kTLS)

> In-kernel TLS record layer for zero-copy HTTPS

## The problem kTLS solves

Traditionally, TLS runs entirely in userspace (OpenSSL):

```
Application → plaintext → OpenSSL encrypt → ciphertext → write() syscall → kernel → NIC
```

This means:
- Every TLS record copy: user buffer → kernel socket buffer
- `sendfile()` doesn't work: data must pass through userspace for encryption
- TLS offload to NIC requires kernel involvement anyway

kTLS moves the TLS record layer into the kernel:

```
Application → plaintext → write()/sendfile() → kernel TLS encrypt → NIC
```

Benefits:
- `sendfile()` works for TLS: zero-copy file → TLS → NIC
- NIC TLS offload: kernel can push crypto to hardware
- Lower CPU usage for TLS-heavy workloads (nginx, envoy)

## ULP: Upper Layer Protocol

kTLS is implemented as a ULP (Upper Layer Protocol) — a socket layer that intercepts send/receive between the application and TCP:

```
Application
    │ write()/sendmsg()
    ▼
[ULP layer: TLS record framing + encryption]
    │
    ▼
TCP layer
    │
    ▼
NIC
```

## Setting up kTLS

kTLS setup is done after the TLS handshake completes (e.g., via OpenSSL):

```c
#include <linux/tls.h>

/* After SSL_accept()/SSL_connect() completes: */

/* Step 1: Enable kTLS ULP on the socket */
setsockopt(sockfd, SOL_TCP, TCP_ULP, "tls", sizeof("tls"));

/* Step 2: Get the symmetric keys negotiated by the handshake
   (OpenSSL exposes these via SSL_get_current_cipher, SSL_CTX_set_keylog_callback,
    or via the ktls OpenSSL engine) */

/* Step 3: Configure TX crypto info */
struct tls12_crypto_info_aes_gcm_128 crypto_info;
crypto_info.info.version     = TLS_1_3_VERSION;  /* or TLS_1_2_VERSION */
crypto_info.info.cipher_type = TLS_CIPHER_AES_GCM_128;
memcpy(crypto_info.iv,  tx_iv,  sizeof(crypto_info.iv));
memcpy(crypto_info.key, tx_key, sizeof(crypto_info.key));
memcpy(crypto_info.salt, tx_salt, sizeof(crypto_info.salt));
memcpy(crypto_info.rec_seq, tx_seq, sizeof(crypto_info.rec_seq));

setsockopt(sockfd, SOL_TLS, TLS_TX, &crypto_info, sizeof(crypto_info));

/* Step 4: Configure RX crypto info (optional — for in-kernel decrypt) */
/* ... similar with rx_key/iv/seq ... */
setsockopt(sockfd, SOL_TLS, TLS_RX, &crypto_info, sizeof(crypto_info));

/* Now: write()/sendfile() automatically encrypts as TLS records */
sendfile(sockfd, file_fd, NULL, file_size);
/* ↑ Zero-copy: file pages → NIC with TLS encryption, no userspace copy */
```

## Supported cipher suites

```c
/* include/uapi/linux/tls.h */
TLS_CIPHER_AES_GCM_128
TLS_CIPHER_AES_GCM_256
TLS_CIPHER_AES_CCM_128
TLS_CIPHER_CHACHA20_POLY1305

TLS_1_2_VERSION
TLS_1_3_VERSION
```

## kTLS in the kernel

```c
/* net/tls/tls_sw.c: TLS software implementation */

/* TX path: intercept sendmsg */
static int tls_sw_sendmsg(struct sock *sk, struct msghdr *msg, size_t size)
{
    struct tls_context *tls_ctx = tls_get_ctx(sk);
    struct tls_sw_context_tx *ctx = tls_sw_ctx_tx(tls_ctx);

    /* Gather plaintext into a TLS record (up to 16KB) */
    while (msg_data_left(msg)) {
        /* Copy plaintext into record buffer */
        copied = sk_msg_memcopy_from_iter(sk, &msg->msg_iter,
                                           msg, try_to_copy);

        /* When record is full or MSG_EOM: encrypt and send */
        if (full_record || eor) {
            rc = tls_push_record(sk, msg->msg_flags, record_type);
        }
    }
    return copied;
}

static int tls_push_record(struct sock *sk, int flags, unsigned char record_type)
{
    struct tls_context *ctx = tls_get_ctx(sk);

    /* Build TLS record header */
    /* Encrypt with AEAD: plaintext → ciphertext + auth tag */
    rc = tls_do_encryption(sk, ctx, ctx->sw_tx, aead_req, data_len, i);

    /* Hand encrypted record to TCP */
    return tls_push_sg(sk, ctx, &sg_array[0], 0, flags);
}
```

## NIC TLS offload

For hardware that supports TLS offload, kTLS can push crypto to the NIC:

```
Without NIC offload:    CPU encrypts → NIC sends ciphertext
With NIC offload:       CPU sends plaintext → NIC encrypts and sends
```

```c
/* net/tls/tls_device.c */
static int tls_device_push_pending_record(struct sock *sk, int flags)
{
    struct tls_context *ctx = tls_get_ctx(sk);
    struct tls_offload_context_tx *offload_ctx = tls_offload_ctx_tx(ctx);

    /* The NIC driver registers tls_dev_add/del operations */
    /* TCP segment is sent with TLS metadata (seqno, record seq) */
    /* NIC encrypts in hardware */
    return tls_push_sg(sk, ctx, NULL, 0, flags);
}
```

NIC TLS offload support: Mellanox ConnectX-5/6, Intel E810, some Chelsio NICs.

```bash
# Enable NIC TLS offload (requires driver support)
ethtool -K eth0 tls-hw-tx-offload on
ethtool -K eth0 tls-hw-rx-offload on

# Check offload status
ethtool -k eth0 | grep tls
# tls-hw-tx-offload: on
# tls-hw-rx-offload: on
```

## Zero-copy sendfile for HTTPS

The primary use case for kTLS is zero-copy file serving:

```c
/* HTTPS server serving static files with kTLS */
int setup_ktls_server(int sockfd, SSL *ssl)
{
    /* After handshake: install kTLS */
    setsockopt(sockfd, SOL_TCP, TCP_ULP, "tls", sizeof("tls"));
    /* ... install TX crypto info from SSL ... */
}

void serve_file(int sockfd, const char *path)
{
    int fd = open(path, O_RDONLY);
    struct stat st;
    fstat(fd, &st);

    /* Zero-copy: page cache → TLS encryption → NIC */
    /* No copy to userspace buffer needed */
    sendfile(sockfd, fd, NULL, st.st_size);
    close(fd);
}
```

Traditional HTTPS flow:
```
disk → page cache → read() → user buffer → SSL_write() → OpenSSL encrypt → write() → kernel → NIC
        (4 copies)
```

kTLS + sendfile flow:
```
disk → page cache → sendfile() → kTLS encrypt → NIC
        (1 copy, or 0 with DMA)
```

## RX path: in-kernel decrypt

When `TLS_RX` is configured, reads are decrypted in the kernel:

```c
/* Application: */
char buf[4096];
int n = read(sockfd, buf, sizeof(buf));
/* buf contains decrypted plaintext — TLS record layer handled by kernel */

/* Optionally: control messages for record type */
struct msghdr msg;
char cmsg_buf[CMSG_SPACE(sizeof(unsigned char))];
/* ... */
recvmsg(sockfd, &msg, 0);
/* CMSG with SOL_TLS, TLS_GET_RECORD_TYPE: check for alerts, handshake msgs */
```

## Observing kTLS

```bash
# Check if kTLS is active on a socket
ss -tinHp | grep -i tls

# TLS statistics
cat /proc/net/tls_stat
# TlsCurrTxSw        5       # sockets using SW TX
# TlsCurrRxSw        3       # sockets using SW RX
# TlsCurrTxDevice    2       # sockets using NIC TX offload
# TlsTxSoftware      12345   # total SW TX records
# TlsDecryptError    0       # authentication failures

# Per-socket TLS info (requires ss from iproute2 >= 5.9)
ss -tinH --tcp state established

# nginx kTLS config
# nginx.conf: ssl_sendfile on;  (uses sendfile with kTLS)
```

## Further reading

- [TCP Implementation](tcp.md) — socket layer kTLS integrates with
- [Network Device and NAPI](napi.md) — NIC TLS offload reception
- [Crypto: Kernel Crypto API](../crypto/crypto-api.md) — AEAD used for TLS records
- [io_uring: Operations](../io-uring/io-uring-ops.md) — io_uring send_zc with kTLS
- `net/tls/` in the kernel tree — kTLS implementation
- `Documentation/networking/tls.rst` in the kernel tree
