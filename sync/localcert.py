"""Makes the home-made HTTPS certificates for the Whoop sync, with Python only.

Why this exists
---------------
The planner app on the iPhone is a secure (https) page. A secure page is not
allowed to download anything from a plain http address, like the laptop on the
home Wi-Fi. So the laptop has to answer over https too, and for that it needs a
certificate the iPhone trusts.

We make our own small "certificate authority" (CA) once:
  - ca.crt  : the public part. You install it on the iPhone ONCE and trust it.
  - ca.key  : the private part. Stays on the laptop (sync/certs/, never committed).
Then the CA signs a "server" certificate for the laptop's Wi-Fi address
(server.crt + server.key). If the laptop's address changes, a new server
certificate is made automatically and the iPhone still trusts it, because it
trusts the CA.

Normally you'd use the `openssl` program or the `cryptography` package for this.
To avoid installing anything, this file does the (small) maths itself with
Python's standard library: RSA keys, SHA-256 signatures and the DER/PEM file
format. Nothing here is secret sauce: it follows RFC 5280 (certificates) and
RFC 8017 (RSA).
"""

import base64
import datetime as dt
import hashlib
import ipaddress
import secrets

# ---------------------------------------------------------------- RSA keys

_SMALL_PRIMES = [p for p in range(3, 2000) if all(p % q for q in range(2, int(p ** 0.5) + 1))]


def _is_probable_prime(n, rounds=40):
    if n < 2:
        return False
    for p in _SMALL_PRIMES:
        if n % p == 0:
            return n == p
    d, s = n - 1, 0
    while d % 2 == 0:
        d //= 2
        s += 1
    for _ in range(rounds):
        a = secrets.randbelow(n - 3) + 2
        x = pow(a, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(s - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _random_prime(bits):
    while True:
        # top two bits set (so p*q has the full key size), odd
        n = secrets.randbits(bits) | (3 << (bits - 2)) | 1
        if _is_probable_prime(n):
            return n


def generate_rsa_key(bits=2048):
    """Returns a dict with n, e, d, p, q, dp, dq, qinv."""
    e = 65537
    while True:
        p = _random_prime(bits // 2)
        q = _random_prime(bits // 2)
        if p == q:
            continue
        phi = (p - 1) * (q - 1)
        if phi % e == 0:
            continue
        n = p * q
        if n.bit_length() != bits:
            continue
        d = pow(e, -1, phi)
        return {"n": n, "e": e, "d": d, "p": p, "q": q,
                "dp": d % (p - 1), "dq": d % (q - 1), "qinv": pow(q, -1, p)}


# ---------------------------------------------------------------- DER encoding

def _len(n):
    if n < 0x80:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(b)]) + b


def _tlv(tag, content):
    return bytes([tag]) + _len(len(content)) + content


def der_int(n):
    b = n.to_bytes(max(1, (n.bit_length() + 8) // 8), "big")  # +8: room for a sign bit
    return _tlv(0x02, b)


def der_seq(*items):
    return _tlv(0x30, b"".join(items))


def der_set(*items):
    return _tlv(0x31, b"".join(items))


def der_oid(dotted):
    parts = [int(x) for x in dotted.split(".")]
    out = bytes([40 * parts[0] + parts[1]])
    for p in parts[2:]:
        chunk = [p & 0x7F]
        p >>= 7
        while p:
            chunk.insert(0, 0x80 | (p & 0x7F))
            p >>= 7
        out += bytes(chunk)
    return _tlv(0x06, out)


DER_NULL = b"\x05\x00"
DER_TRUE = b"\x01\x01\xff"


def der_bits(b):
    return _tlv(0x03, b"\x00" + b)


def der_octets(b):
    return _tlv(0x04, b)


def der_utf8(s):
    return _tlv(0x0C, s.encode("utf-8"))


def der_time(t):
    t = t.astimezone(dt.timezone.utc)
    if t.year < 2050:
        return _tlv(0x17, t.strftime("%y%m%d%H%M%SZ").encode())
    return _tlv(0x18, t.strftime("%Y%m%d%H%M%SZ").encode())


def der_explicit(n, content):
    return _tlv(0xA0 + n, content)


OID_RSA = "1.2.840.113549.1.1.1"
OID_SHA256_RSA = "1.2.840.113549.1.1.11"
OID_SHA256 = "2.16.840.1.101.3.4.2.1"
OID_CN = "2.5.4.3"
OID_ORG = "2.5.4.10"
OID_BASIC = "2.5.29.19"
OID_KEY_USAGE = "2.5.29.15"
OID_EXT_KEY_USAGE = "2.5.29.37"
OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1"
OID_SAN = "2.5.29.17"
OID_SKI = "2.5.29.14"
OID_AKI = "2.5.29.35"


def _name(cn, org="Daily Planner (home)"):
    return der_seq(
        der_set(der_seq(der_oid(OID_ORG), der_utf8(org))),
        der_set(der_seq(der_oid(OID_CN), der_utf8(cn))),
    )


def _public_key_der(key):
    return der_seq(der_int(key["n"]), der_int(key["e"]))


def _spki(key):
    return der_seq(der_seq(der_oid(OID_RSA), DER_NULL), der_bits(_public_key_der(key)))


def _key_id(key):
    return hashlib.sha1(_public_key_der(key)).digest()


def _ext(oid, value, critical=False):
    parts = [der_oid(oid)]
    if critical:
        parts.append(DER_TRUE)
    parts.append(der_octets(value))
    return der_seq(*parts)


def _key_usage(*bits):
    # bits: 0=digitalSignature 2=keyEncipherment 5=keyCertSign 6=cRLSign
    value = 0
    for b in bits:
        value |= 0x80 >> b
    unused = 0
    while unused < 7 and not value & (1 << unused):
        unused += 1
    return _tlv(0x03, bytes([unused, value]))


def rsa_sign_sha256(key, data):
    """PKCS#1 v1.5 signature (RFC 8017, section 8.2)."""
    digest_info = der_seq(der_seq(der_oid(OID_SHA256), DER_NULL), der_octets(hashlib.sha256(data).digest()))
    k = (key["n"].bit_length() + 7) // 8
    em = b"\x00\x01" + b"\xff" * (k - len(digest_info) - 3) + b"\x00" + digest_info
    m = int.from_bytes(em, "big")
    # Chinese remainder theorem: same result as pow(m, d, n), but faster.
    m1 = pow(m, key["dp"], key["p"])
    m2 = pow(m, key["dq"], key["q"])
    h = (key["qinv"] * (m1 - m2)) % key["p"]
    s = m2 + h * key["q"]
    return s.to_bytes(k, "big")


def _certificate(subject_cn, subject_key, issuer_cn, issuer_key, days, extensions, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    sig_alg = der_seq(der_oid(OID_SHA256_RSA), DER_NULL)
    tbs = der_seq(
        der_explicit(0, der_int(2)),                         # version 3
        der_int(secrets.randbits(120) | (1 << 120)),         # positive random serial
        sig_alg,
        _name(issuer_cn),
        der_seq(der_time(now - dt.timedelta(hours=1)), der_time(now + dt.timedelta(days=days))),
        _name(subject_cn),
        _spki(subject_key),
        der_explicit(3, der_seq(*extensions)),
    )
    return der_seq(tbs, sig_alg, der_bits(rsa_sign_sha256(issuer_key, tbs)))


CA_NAME = "Daily Planner home sync CA"


def make_ca(key, days=3650, now=None):
    exts = [
        _ext(OID_BASIC, der_seq(DER_TRUE), critical=True),
        _ext(OID_KEY_USAGE, _key_usage(5, 6), critical=True),
        _ext(OID_SKI, der_octets(_key_id(key))),
    ]
    return _certificate(CA_NAME, key, CA_NAME, key, days, exts, now)


def make_server_cert(server_key, ca_key, ips, dns_names, days=397, now=None):
    """Server certificate for the laptop. iPhones require: a SAN list,
    'server authentication' usage, 2048-bit RSA, SHA-256 and at most 825 days."""
    san = []
    for name in dns_names:
        san.append(_tlv(0x82, name.encode("ascii")))
    for ip in ips:
        san.append(_tlv(0x87, ipaddress.ip_address(ip).packed))
    exts = [
        _ext(OID_BASIC, der_seq(), critical=True),
        _ext(OID_KEY_USAGE, _key_usage(0, 2), critical=True),
        _ext(OID_EXT_KEY_USAGE, der_seq(der_oid(OID_SERVER_AUTH))),
        _ext(OID_SAN, der_seq(*san)),
        _ext(OID_SKI, der_octets(_key_id(server_key))),
        _ext(OID_AKI, der_seq(_tlv(0x80, _key_id(ca_key)))),
    ]
    cn = (list(ips) + list(dns_names) + ["laptop"])[0]
    return _certificate(cn, server_key, CA_NAME, ca_key, days, exts, now)


# ---------------------------------------------------------------- PEM files

def pem(der, label):
    b64 = base64.b64encode(der).decode()
    lines = [b64[i:i + 64] for i in range(0, len(b64), 64)]
    return "-----BEGIN %s-----\n%s\n-----END %s-----\n" % (label, "\n".join(lines), label)


def cert_pem(der):
    return pem(der, "CERTIFICATE")


def key_pem(key):
    der = der_seq(*[der_int(x) for x in (0, key["n"], key["e"], key["d"], key["p"],
                                         key["q"], key["dp"], key["dq"], key["qinv"])])
    return pem(der, "RSA PRIVATE KEY")


def read_key_pem(text):
    """Reads back a key written by key_pem()."""
    body = "".join(l for l in text.strip().splitlines() if not l.startswith("-----"))
    der = base64.b64decode(body)
    nums, i = [], 0
    # skip the outer SEQUENCE header
    i = 1
    first = der[i]
    i += 1 + (first & 0x7F if first & 0x80 else 0)
    while i < len(der):
        assert der[i] == 0x02, "not an RSA key file"
        i += 1
        ln = der[i]
        i += 1
        if ln & 0x80:
            nb = ln & 0x7F
            ln = int.from_bytes(der[i:i + nb], "big")
            i += nb
        nums.append(int.from_bytes(der[i:i + ln], "big"))
        i += ln
    keys = ["version", "n", "e", "d", "p", "q", "dp", "dq", "qinv"]
    out = dict(zip(keys, nums))
    out.pop("version")
    return out
