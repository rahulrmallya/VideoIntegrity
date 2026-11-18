"""Golden vectors from FrameSeal CONTRACT §3.9."""

import numpy as np
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from app import crypto


def test_chain_and_checkpoint_vectors() -> None:
    """Match the public key and every digest and signature in the chain."""
    sk = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
    pk_raw = sk.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    session_id = "00000000-0000-4000-8000-000000000000"
    checkpoint_interval = 2

    assert pk_raw.hex() == "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8"
    assert crypto.device_id(pk_raw) == "56475aa75463474c"
    genesis = crypto.genesis(session_id, pk_raw)
    assert genesis.hex() == "6a75375daf786e83a0ee0a71865a45b3f9d3593793fdc4fed4c289a7694e0b25"

    frame_hash_0 = crypto.sha256(b"FRAMESEAL-TEST-FRAME-0")
    assert frame_hash_0.hex() == "8efd46fc5305bce23ec70fbea7dcc95da5926254566d87ee55f03e91ec89bbd6"
    chain_hash_0 = crypto.link(
        genesis, frame_hash_0, bytes.fromhex("0123456789abcdef"), 0, 1700000000000000000
    )
    assert chain_hash_0.hex() == "bb2024f02c75f2543ff03a27d968d0ef7f789423ac4f5ef87e66763a68e0e1a8"

    seq = checkpoint_interval - 1
    frame_hash_1 = crypto.sha256(b"FRAMESEAL-TEST-FRAME-1")
    assert frame_hash_1.hex() == "b1321fed1afd4c4d85ccf39826f280e2f541bbd7e5adf8d4d9c26e6772730fb3"
    chain_hash_1 = crypto.link(
        chain_hash_0,
        frame_hash_1,
        bytes.fromhex("fedcba9876543210"),
        seq,
        1700000000066666667,
    )
    assert chain_hash_1.hex() == "afa92d71ea51bceedde7a5a4607adf18da7154f482d14b2ef1e2dfa1d4798584"
    message = crypto.checkpoint_message(session_id, seq, chain_hash_1)
    signature = bytes.fromhex(
        "a2db8ebae297d0833415eb8e53081ce2dca24e05106bee1fc065a540eaef55231c8"
        "670554deb4d9c1e41083bd9bcfd0696490f4066f2679d116c65d14af7b601"
    )
    assert crypto.sign(sk, message) == signature
    assert crypto.verify(pk_raw, signature, message)


def test_dhash_vector() -> None:
    """Match the dHash of the contract's 8×9 grayscale image."""
    rows, columns = np.indices((8, 9))
    gray = ((rows * 37 + columns * 53) % 256).astype(np.uint8)
    assert crypto.dhash_from_gray(gray) == bytes.fromhex("f7f7efdeddbd7bf7")
