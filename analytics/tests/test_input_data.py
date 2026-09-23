"""Synthetic, small fixtures for the Parquet input boundary; no private data."""

from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
import tempfile
import unittest

import pyarrow as pa
import pyarrow.parquet as pq

from money_graph.input_data import InputError, load_inputs, money_text


GID = 9_007_199_254_740_993
SCHEMAS = {
    "nodes": pa.schema([
        ("gid", pa.int64()), ("depth", pa.int64()), ("is_seed", pa.bool_()),
    ]),
    "edges": pa.schema([
        ("src", pa.int64()), ("dst", pa.int64()), ("sum_kzt", pa.float64()),
        ("n_tx", pa.int64()), ("depth", pa.int8()),
    ]),
    "transactions": pa.schema([
        ("src", pa.int64()), ("dst", pa.int64()), ("date", pa.date32()),
        ("sum_kzt", pa.float64()),
    ]),
}


class InputDataTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.rows = {
            "nodes": [
                {"gid": GID + 2, "depth": 0, "is_seed": True},  # isolated seed
                {"gid": GID + 1, "depth": 1, "is_seed": False},
                {"gid": GID, "depth": 0, "is_seed": True},
            ],
            "edges": [{"src": GID, "dst": GID + 1, "sum_kzt": 0.30,
                       "n_tx": 2, "depth": 1}],
            "transactions": [
                {"src": GID, "dst": GID + 1, "date": date(2026, 7, 2),
                 "sum_kzt": 0.20},
                {"src": GID, "dst": GID + 1, "date": date(2026, 7, 1),
                 "sum_kzt": 0.10},
            ],
        }

    def write(self, schemas=None):
        for name, rows in self.rows.items():
            pq.write_table(pa.Table.from_pylist(rows, schema=(schemas or SCHEMAS)[name]),
                           self.directory / f"{name}.parquet")

    def assert_invalid(self, pattern):
        self.write()
        with self.assertRaisesRegex(InputError, pattern):
            load_inputs(self.directory)

    def test_exact_money_large_gid_isolated_seed_and_stable_order(self):
        self.write()
        data = load_inputs(self.directory)
        self.assertEqual([node["gid"] for node in data.nodes], [GID, GID + 1, GID + 2])
        self.assertEqual(data.nodes[0], {"gid": GID, "depth": 0, "is_seed": True})
        self.assertEqual(data.edges[0]["amount_minor"], 30)
        self.assertEqual([tx["amount_minor"] for tx in data.transactions], [10, 20])
        self.assertEqual(data.transactions[0]["date"], date(2026, 7, 1))
        self.assertEqual(data.warnings, [])
        for rows in self.rows.values():
            rows.reverse()
        self.write()
        self.assertEqual(load_inputs(self.directory), data)

    def test_duplicate_transactions_are_not_removed(self):
        self.rows["transactions"] = [self.rows["transactions"][0]] * 2
        self.rows["edges"][0]["sum_kzt"] = 0.40
        self.write()
        data = load_inputs(self.directory)
        self.assertEqual(len(data.transactions), 2)
        self.assertEqual(data.edges[0]["amount_minor"], 40)
        self.assertEqual(len(data.warnings), 1)
        self.assertIn("1 повтор", data.warnings[0])

    def test_isolates_only_are_valid(self):
        self.rows["nodes"] = [self.rows["nodes"][0]]
        self.rows["edges"] = []
        self.rows["transactions"] = []
        self.write()
        data = load_inputs(self.directory)
        self.assertEqual(len(data.nodes), 1)
        self.assertEqual(data.edges, [])
        self.assertEqual(data.transactions, [])

    def test_missing_input_and_invalid_parquet(self):
        with self.assertRaisesRegex(InputError, "nodes.parquet"):
            load_inputs(self.directory)
        self.write()
        (self.directory / "edges.parquet").write_bytes(b"not parquet")
        with self.assertRaisesRegex(InputError, "edges.parquet"):
            load_inputs(self.directory)

    def test_missing_and_duplicate_columns(self):
        self.write()
        pq.write_table(pa.table({"gid": pa.array([GID], type=pa.int64())}),
                       self.directory / "nodes.parquet")
        with self.assertRaisesRegex(InputError, "depth.*is_seed"):
            load_inputs(self.directory)
        table = pa.Table.from_arrays([
            pa.array([GID]), pa.array([GID]), pa.array([0]), pa.array([True]),
        ], names=["gid", "gid", "depth", "is_seed"])
        pq.write_table(table, self.directory / "nodes.parquet")
        with self.assertRaisesRegex(InputError, "повтор.*колон"):
            load_inputs(self.directory)

    def test_wrong_identifier_type_is_not_silently_coerced(self):
        for arrow_type in (pa.float64(), pa.string(), pa.uint64()):
            with self.subTest(arrow_type=arrow_type):
                schemas = dict(SCHEMAS)
                schemas["nodes"] = pa.schema([
                    ("gid", arrow_type), ("depth", pa.int64()), ("is_seed", pa.bool_()),
                ])
                value = str(GID) if pa.types.is_string(arrow_type) else (
                    float(GID) if pa.types.is_floating(arrow_type) else GID
                )
                self.rows["nodes"] = [{"gid": value, "depth": 0, "is_seed": True}]
                self.write(schemas)
                with self.assertRaisesRegex(InputError, "nodes.parquet.*gid.*int64"):
                    load_inputs(self.directory)

    def test_null_is_rejected_in_every_required_column(self):
        for table_name, schema in SCHEMAS.items():
            for field in schema:
                with self.subTest(table=table_name, field=field.name):
                    previous = self.rows[table_name][0][field.name]
                    self.rows[table_name][0][field.name] = None
                    self.assert_invalid("null")
                    self.rows[table_name][0][field.name] = previous

    def test_exact_int64_boundary_identifiers_are_accepted(self):
        self.rows["nodes"] = [
            {"gid": -(2**63), "depth": 0, "is_seed": True},
            {"gid": 2**63 - 1, "depth": 0, "is_seed": True},
        ]
        self.rows["edges"] = []
        self.rows["transactions"] = []
        self.write()
        self.assertEqual([n["gid"] for n in load_inputs(self.directory).nodes],
                         [-(2**63), 2**63 - 1])

    def test_schema_rejects_float32_money_and_coerced_flags_counts_depth(self):
        for name, field_name, bad_type, value in (
            ("edges", "sum_kzt", pa.float32(), 0.3),
            ("edges", "n_tx", pa.float64(), 2.0),
            ("nodes", "depth", pa.float64(), 0.0),
            ("nodes", "is_seed", pa.int64(), 1),
        ):
            with self.subTest(table=name, field=field_name):
                previous = self.rows[name][0][field_name]
                self.rows[name][0][field_name] = value
                schemas = dict(SCHEMAS)
                schemas[name] = pa.schema([
                    pa.field(f.name, bad_type if f.name == field_name else f.type)
                    for f in SCHEMAS[name]
                ])
                # Arrow's strict bool/int conversion needs every flag supplied
                # as the intentionally malformed input type for this fixture.
                if field_name == "is_seed":
                    for row in self.rows[name]:
                        row[field_name] = int(row[field_name])
                self.write(schemas)
                with self.assertRaisesRegex(InputError, field_name):
                    load_inputs(self.directory)
                self.rows[name][0][field_name] = previous
                if field_name == "is_seed":
                    for row in self.rows[name]:
                        row[field_name] = bool(row[field_name])

    def test_no_nodes_duplicate_nodes_and_duplicate_pairs(self):
        original = self.rows["nodes"]
        self.rows["nodes"] = []
        self.assert_invalid("не содержит узлов")
        self.rows["nodes"] = original + [original[0]]
        self.assert_invalid("повтор.*gid")
        self.rows["nodes"] = original
        self.rows["edges"] *= 2
        self.assert_invalid("повтор.*пара")

    def test_unknown_nodes_in_edges_and_transactions(self):
        self.rows["edges"][0]["dst"] = GID + 100
        self.assert_invalid("edges.parquet.*неизвестный gid")
        self.rows["edges"][0]["dst"] = GID + 1
        self.rows["transactions"][0]["src"] = GID + 100
        self.assert_invalid("transactions.parquet.*неизвестный gid")

    def test_depth_seed_and_discovery_consistency(self):
        for invalid_depth in (-1, 5):
            self.rows["nodes"][1]["depth"] = invalid_depth
            self.assert_invalid("depth")
        self.rows["nodes"][1]["depth"] = 1
        self.rows["nodes"][1]["is_seed"] = True
        self.assert_invalid("is_seed.*depth")
        self.rows["nodes"][1]["is_seed"] = False
        for invalid_depth in (0, 5, 2):
            self.rows["edges"][0]["depth"] = invalid_depth
            self.assert_invalid("depth")
        self.rows["edges"][0]["depth"] = 1
        self.rows["nodes"][1]["depth"] = 2
        self.assert_invalid("depth")

    def test_nonpositive_nonfinite_and_fractional_minor_amounts(self):
        for name in ("edges", "transactions"):
            original = self.rows[name][0]["sum_kzt"]
            for value in (0.0, -0.01, float("inf"), float("-inf"), float("nan"), 0.001):
                with self.subTest(table=name, value=value):
                    self.rows[name][0]["sum_kzt"] = value
                    self.assert_invalid("sum_kzt")
            self.rows[name][0]["sum_kzt"] = original

    def test_positive_transaction_count_and_exact_aggregate_match(self):
        for count in (0, -1):
            self.rows["edges"][0]["n_tx"] = count
            self.assert_invalid("n_tx")
        self.rows["edges"][0]["n_tx"] = 3
        self.assert_invalid("n_tx.*не совпадает")
        self.rows["edges"][0]["n_tx"] = 2
        self.rows["edges"][0]["sum_kzt"] = 0.31
        self.assert_invalid("сумма.*не совпадает")

    def test_missing_or_extra_transaction_pairs(self):
        self.rows["transactions"] = []
        self.assert_invalid("пары.*не совпадают")
        self.rows["transactions"] = [{"src": GID + 1, "dst": GID,
                                     "date": date(2026, 7, 1), "sum_kzt": 0.30}]
        self.assert_invalid("пары.*не совпадают")

    def test_money_supports_exact_integer_and_decimal_arrow_types(self):
        for arrow_type, values, expected in (
            (pa.int64(), [9_007_199_254_740_993, 1], 900_719_925_474_099_400),
            (pa.decimal128(20, 2), [Decimal("900719925474.99"), Decimal("0.01")],
             90_071_992_547_500),
        ):
            with self.subTest(arrow_type=arrow_type):
                schemas = dict(SCHEMAS)
                for name in ("edges", "transactions"):
                    schemas[name] = pa.schema([
                        pa.field(field.name, arrow_type if field.name == "sum_kzt" else field.type)
                        for field in SCHEMAS[name]
                    ])
                self.rows["edges"][0]["sum_kzt"] = sum(values)
                for row, amount in zip(self.rows["transactions"], values):
                    row["sum_kzt"] = amount
                self.write(schemas)
                self.assertEqual(load_inputs(self.directory).edges[0]["amount_minor"], expected)

    def test_money_decimal_normalization_does_not_use_context_rounding(self):
        huge = Decimal("123456789012345678901234567890.12")
        schemas = dict(SCHEMAS)
        for name in ("edges", "transactions"):
            schemas[name] = pa.schema([
                pa.field(f.name, pa.decimal128(38, 2) if f.name == "sum_kzt" else f.type)
                for f in SCHEMAS[name]
            ])
        self.rows["transactions"] = [self.rows["transactions"][0]]
        self.rows["transactions"][0]["sum_kzt"] = huge
        self.rows["edges"][0].update(sum_kzt=huge, n_tx=1)
        self.write(schemas)
        self.assertEqual(load_inputs(self.directory).edges[0]["amount_minor"],
                         12_345_678_901_234_567_890_123_456_789_012)

    def test_date_types_without_string_guessing_or_time_truncation(self):
        for arrow_type in (pa.date64(), pa.timestamp("us")):
            schemas = dict(SCHEMAS)
            schemas["transactions"] = pa.schema([
                pa.field(f.name, arrow_type if f.name == "date" else f.type)
                for f in SCHEMAS["transactions"]
            ])
            for row in self.rows["transactions"]:
                row["date"] = datetime(2026, 7, 1)
            self.write(schemas)
            self.assertEqual(load_inputs(self.directory).transactions[0]["date"], date(2026, 7, 1))
        self.rows["transactions"][0]["date"] = datetime(2026, 7, 1, 12, 30)
        self.write(schemas)
        with self.assertRaisesRegex(InputError, "date.*время"):
            load_inputs(self.directory)
        for arrow_type, value in ((pa.string(), "2026-07-01"),
                                  (pa.timestamp("us", tz="UTC"), datetime(2026, 7, 1, tzinfo=timezone.utc))):
            schemas["transactions"] = pa.schema([
                pa.field(f.name, arrow_type if f.name == "date" else f.type)
                for f in SCHEMAS["transactions"]
            ])
            for row in self.rows["transactions"]:
                row["date"] = value
            self.write(schemas)
            with self.assertRaisesRegex(InputError, "date"):
                load_inputs(self.directory)

    def test_money_formatting_uses_no_float(self):
        for value, expected in ((0, "0.00"), (1, "0.01"), (123, "1.23"),
                                (-123, "-1.23"), (900719925474099301, "9007199254740993.01")):
            self.assertEqual(money_text(value), expected)
        with self.assertRaises(TypeError):
            money_text(1.2)


if __name__ == "__main__":
    unittest.main()
