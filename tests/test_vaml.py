import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sdk" / "python"))

from vaml import (  # noqa: E402
    TYPE_F64,
    TYPE_REF,
    TYPE_U64,
    Registry,
    decode_frame,
    debug,
    make_frame,
    semantic_field,
)


class VAMLTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.registry = Registry.load(ROOT / "registry" / "vaml-core-0.1.json")

    def test_registry_known_codes(self):
        self.assertEqual(self.registry.code("communication", "TASK"), 0x0101)
        self.assertEqual(self.registry.code("action", "SEARCH"), 0x0307)
        self.assertEqual(self.registry.code("evidence", "LOG"), 0x1104)
        self.assertEqual(self.registry.code("protocol_control", "BEGIN"), 0xFF01)
        self.assertEqual(self.registry.label(0x0F1D), "security:ANOMALY")

    def test_roundtrip_task_frame(self):
        r = self.registry
        frame = make_frame(
            [
                semantic_field(r, "protocol_control", "BEGIN"),
                semantic_field(r, "communication", "TASK"),
                semantic_field(r, "identity", "SOURCE", TYPE_U64, 14),
                semantic_field(r, "identity", "TARGET", TYPE_U64, 27),
                semantic_field(r, "action", "SEARCH"),
                semantic_field(r, "evidence", "LOG"),
                semantic_field(r, "protocol_control", "END"),
            ],
            frame_id=42,
        )
        decoded = decode_frame(frame.encode())
        self.assertEqual(decoded, frame)
        self.assertEqual(decoded.frame_id, 42)

    def test_roundtrip_belief(self):
        r = self.registry
        frame = make_frame(
            [
                semantic_field(r, "truth_belief", "CLAIM", TYPE_REF, "claim://server-under-attack"),
                semantic_field(r, "truth_belief", "CONFIDENCE", TYPE_F64, 0.82),
                semantic_field(r, "evidence", "SOURCE", TYPE_REF, "log://8281"),
            ]
        )
        decoded = decode_frame(frame.encode())
        view = debug(decoded, r)
        self.assertEqual(view[0]["semantic"], "truth_belief:CLAIM")
        self.assertAlmostEqual(view[1]["value"], 0.82)
        self.assertEqual(view[2]["value"], "log://8281")

    def test_training_jsonl_is_valid(self):
        path = ROOT / "examples" / "training.jsonl"
        lines = path.read_text(encoding="utf-8").splitlines()
        self.assertGreaterEqual(len(lines), 10)
        for line in lines:
            obj = json.loads(line)
            self.assertIn("sequence", obj)
            self.assertIn("concepts", obj)


if __name__ == "__main__":
    unittest.main()
