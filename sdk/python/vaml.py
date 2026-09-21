"""VAML 0.1 reference encoder/decoder.

This module intentionally keeps policy and execution outside the codec. A valid
VAML frame is data, not authorization to execute a command.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

MAGIC = b"VA"
MAJOR = 0
MINOR = 1
HEADER = struct.Struct(">2sBBBBIQ")
TLV = struct.Struct(">HBI")

TYPE_NONE = 0x00
TYPE_U64 = 0x01
TYPE_I64 = 0x02
TYPE_F64 = 0x03
TYPE_BOOL = 0x04
TYPE_BYTES = 0x05
TYPE_UTF8 = 0x06
TYPE_CODE = 0x07
TYPE_ID128 = 0x08
TYPE_REF = 0x09
TYPE_VECTOR_F32 = 0x0A
TYPE_NESTED = 0x0B

TYPE_NAMES = {
    TYPE_NONE: "NONE",
    TYPE_U64: "U64",
    TYPE_I64: "I64",
    TYPE_F64: "F64",
    TYPE_BOOL: "BOOL",
    TYPE_BYTES: "BYTES",
    TYPE_UTF8: "UTF8",
    TYPE_CODE: "CODE",
    TYPE_ID128: "ID128",
    TYPE_REF: "REF",
    TYPE_VECTOR_F32: "VECTOR_F32",
    TYPE_NESTED: "NESTED",
}


class VAMLError(ValueError):
    pass


class Registry:
    def __init__(self, data: dict[str, Any]):
        self.data = data
        self.by_code: dict[int, tuple[str, str]] = {}
        self.by_name: dict[tuple[str, str], int] = {}
        for ns_hex, ns in data["namespaces"].items():
            namespace = ns["name"]
            ns_id = int(ns_hex, 16)
            for term_hex, term in ns["terms"].items():
                code = (ns_id << 8) | int(term_hex, 16)
                self.by_code[code] = (namespace, term)
                self.by_name[(namespace, term)] = code

    @classmethod
    def load(cls, path: str | Path | None = None) -> "Registry":
        if path is None:
            path = Path(__file__).resolve().parents[2] / "registry" / "vaml-core-0.1.json"
        with Path(path).open("r", encoding="utf-8") as handle:
            return cls(json.load(handle))

    def code(self, namespace: str, term: str) -> int:
        try:
            return self.by_name[(namespace, term)]
        except KeyError as exc:
            raise VAMLError(f"Unknown VAML semantic name: {namespace}:{term}") from exc

    def resolve(self, code: int) -> tuple[str, str]:
        try:
            return self.by_code[code]
        except KeyError as exc:
            raise VAMLError(f"Unknown VAML semantic code: 0x{code:04X}") from exc

    def label(self, code: int) -> str:
        namespace, term = self.resolve(code)
        return f"{namespace}:{term}"


@dataclass(frozen=True)
class Field:
    semantic: int
    value_type: int = TYPE_NONE
    value: Any = None

    def encode(self) -> bytes:
        payload = encode_value(self.value_type, self.value)
        return TLV.pack(self.semantic, self.value_type, len(payload)) + payload


@dataclass(frozen=True)
class Frame:
    fields: tuple[Field, ...]
    frame_id: int = 0
    flags: int = 0
    major: int = MAJOR
    minor: int = MINOR

    def encode(self) -> bytes:
        payload = b"".join(field.encode() for field in self.fields)
        header = HEADER.pack(
            MAGIC,
            self.major,
            self.minor,
            self.flags,
            0,
            len(payload),
            self.frame_id,
        )
        return header + payload

    def hex(self) -> str:
        return self.encode().hex().upper()


def encode_value(value_type: int, value: Any) -> bytes:
    if value_type == TYPE_NONE:
        if value not in (None, b""):
            raise VAMLError("NONE fields cannot carry a value")
        return b""
    if value_type == TYPE_U64:
        return struct.pack(">Q", int(value))
    if value_type == TYPE_I64:
        return struct.pack(">q", int(value))
    if value_type == TYPE_F64:
        return struct.pack(">d", float(value))
    if value_type == TYPE_BOOL:
        return b"\x01" if bool(value) else b"\x00"
    if value_type == TYPE_BYTES:
        return bytes(value)
    if value_type in (TYPE_UTF8, TYPE_REF):
        return str(value).encode("utf-8")
    if value_type == TYPE_CODE:
        code = int(value)
        if not 0 <= code <= 0xFFFF:
            raise VAMLError("CODE value must fit in 16 bits")
        return struct.pack(">H", code)
    if value_type == TYPE_ID128:
        raw = bytes(value)
        if len(raw) != 16:
            raise VAMLError("ID128 must be exactly 16 bytes")
        return raw
    if value_type == TYPE_VECTOR_F32:
        values = [float(item) for item in value]
        return b"".join(struct.pack(">f", item) for item in values)
    if value_type == TYPE_NESTED:
        return b"".join(field.encode() for field in value)
    raise VAMLError(f"Unsupported value type: 0x{value_type:02X}")


def decode_value(value_type: int, payload: bytes) -> Any:
    if value_type == TYPE_NONE:
        if payload:
            raise VAMLError("NONE field has non-empty payload")
        return None
    if value_type == TYPE_U64:
        require_length(payload, 8, "U64")
        return struct.unpack(">Q", payload)[0]
    if value_type == TYPE_I64:
        require_length(payload, 8, "I64")
        return struct.unpack(">q", payload)[0]
    if value_type == TYPE_F64:
        require_length(payload, 8, "F64")
        return struct.unpack(">d", payload)[0]
    if value_type == TYPE_BOOL:
        require_length(payload, 1, "BOOL")
        if payload[0] not in (0, 1):
            raise VAMLError("BOOL must be 0x00 or 0x01")
        return bool(payload[0])
    if value_type == TYPE_BYTES:
        return payload
    if value_type in (TYPE_UTF8, TYPE_REF):
        return payload.decode("utf-8")
    if value_type == TYPE_CODE:
        require_length(payload, 2, "CODE")
        return struct.unpack(">H", payload)[0]
    if value_type == TYPE_ID128:
        require_length(payload, 16, "ID128")
        return payload
    if value_type == TYPE_VECTOR_F32:
        if len(payload) % 4:
            raise VAMLError("VECTOR_F32 length must be divisible by 4")
        return [struct.unpack(">f", payload[i:i+4])[0] for i in range(0, len(payload), 4)]
    if value_type == TYPE_NESTED:
        return tuple(decode_fields(payload))
    raise VAMLError(f"Unsupported value type: 0x{value_type:02X}")


def require_length(payload: bytes, expected: int, name: str) -> None:
    if len(payload) != expected:
        raise VAMLError(f"{name} must be {expected} bytes, got {len(payload)}")


def decode_fields(payload: bytes) -> list[Field]:
    fields: list[Field] = []
    offset = 0
    while offset < len(payload):
        if len(payload) - offset < TLV.size:
            raise VAMLError("Truncated TLV header")
        semantic, value_type, length = TLV.unpack_from(payload, offset)
        offset += TLV.size
        end = offset + length
        if end > len(payload):
            raise VAMLError("TLV length exceeds frame payload")
        value = decode_value(value_type, payload[offset:end])
        fields.append(Field(semantic, value_type, value))
        offset = end
    return fields


def decode_frame(data: bytes, *, require_version: tuple[int, int] | None = (MAJOR, MINOR)) -> Frame:
    if len(data) < HEADER.size:
        raise VAMLError("Frame shorter than VAML header")
    magic, major, minor, flags, reserved, payload_length, frame_id = HEADER.unpack_from(data, 0)
    if magic != MAGIC:
        raise VAMLError("Invalid VAML magic")
    if reserved != 0:
        raise VAMLError("Reserved header byte must be zero in VAML 0.1")
    if require_version is not None and (major, minor) != require_version:
        raise VAMLError(f"Unsupported VAML version {major}.{minor}")
    payload = data[HEADER.size:]
    if len(payload) != payload_length:
        raise VAMLError(f"Payload length mismatch: header={payload_length}, actual={len(payload)}")
    return Frame(tuple(decode_fields(payload)), frame_id, flags, major, minor)


def semantic_field(registry: Registry, namespace: str, term: str, value_type: int = TYPE_NONE, value: Any = None) -> Field:
    return Field(registry.code(namespace, term), value_type, value)


def debug(frame: Frame, registry: Registry) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for field in frame.fields:
        try:
            label = registry.label(field.semantic)
        except VAMLError:
            label = f"unknown:0x{field.semantic:04X}"
        value = field.value
        if isinstance(value, bytes):
            value = value.hex()
        output.append({
            "code": f"{field.semantic:04X}",
            "semantic": label,
            "type": TYPE_NAMES.get(field.value_type, f"0x{field.value_type:02X}"),
            "value": value,
        })
    return output


def make_frame(fields: Iterable[Field], *, frame_id: int = 0, flags: int = 0) -> Frame:
    return Frame(tuple(fields), frame_id=frame_id, flags=flags)


if __name__ == "__main__":
    registry = Registry.load()
    demo = make_frame(
        [
            semantic_field(registry, "protocol_control", "BEGIN"),
            semantic_field(registry, "communication", "TASK"),
            semantic_field(registry, "identity", "SOURCE", TYPE_U64, 14),
            semantic_field(registry, "identity", "TARGET", TYPE_U64, 27),
            semantic_field(registry, "action", "SEARCH"),
            semantic_field(registry, "evidence", "LOG"),
            semantic_field(registry, "protocol_control", "END"),
        ],
        frame_id=1,
    )
    encoded = demo.encode()
    print(demo.hex())
    print(json.dumps(debug(decode_frame(encoded), registry), indent=2))
