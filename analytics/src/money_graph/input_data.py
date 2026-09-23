"""Validate the three organizer Parquet tables before any graph calculations.

Money is normalized once, at the input boundary, to integer tiyn (1/100 KZT).
No float arithmetic, implicit ID/date coercion, or transaction deduplication is
performed. The resulting records are sorted independently of Parquet row order.
"""

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time
from decimal import Decimal
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq


class InputError(ValueError):
    """The input cannot safely be interpreted as the agreed transaction graph."""


@dataclass
class InputData:
    nodes: list[dict]
    edges: list[dict]
    transactions: list[dict]
    warnings: list[str]


_COLUMNS = {
    "nodes": ("gid", "depth", "is_seed"),
    "edges": ("src", "dst", "sum_kzt", "n_tx", "depth"),
    "transactions": ("src", "dst", "date", "sum_kzt"),
}
_INT64_MIN = -(2**63)
_INT64_MAX = 2**63 - 1


def money_text(amount_minor: int) -> str:
    """Format exact integer tiyn as a KZT string with exactly two decimals."""
    if type(amount_minor) is not int:
        raise TypeError("amount_minor должен быть целым числом тиынов")
    whole, fraction = divmod(abs(amount_minor), 100)
    return f"{'-' if amount_minor < 0 else ''}{whole}.{fraction:02d}"


def _valid_type(column: str, dtype: pa.DataType) -> bool:
    if column in ("gid", "src", "dst", "n_tx"):
        return dtype == pa.int64()
    if column == "depth":
        return pa.types.is_signed_integer(dtype)
    if column == "is_seed":
        return pa.types.is_boolean(dtype)
    if column == "sum_kzt":
        # Integer/decimal inputs are safe compatible alternatives to the
        # organizer's float64; float32 is rejected because precision is lost.
        return (pa.types.is_integer(dtype) or pa.types.is_decimal(dtype)
                or dtype == pa.float64())
    if column == "date":
        return (pa.types.is_date(dtype)
                or (pa.types.is_timestamp(dtype) and dtype.tz is None))
    return False


def _read_table(directory: Path, name: str) -> list[dict]:
    filename = f"{name}.parquet"
    path = directory / filename
    if not path.is_file():
        raise InputError(f"Отсутствует обязательный файл {filename}")
    expected = _COLUMNS[name]
    try:
        # ParquetFile reads exactly this file, not a partitioned dataset whose
        # directory names could introduce inferred columns or types.
        with pq.ParquetFile(path) as parquet:
            schema = parquet.schema_arrow
            if len(schema.names) != len(set(schema.names)):
                raise InputError(f"{filename}: повторяющиеся имена колонок")
            missing = [column for column in expected if column not in schema.names]
            if missing:
                raise InputError(f"{filename}: отсутствуют колонки {', '.join(missing)}")
            for column in expected:
                dtype = schema.field(column).type
                if not _valid_type(column, dtype):
                    hint = "int64" if column in ("gid", "src", "dst", "n_tx") else {
                        "depth": "signed integer", "is_seed": "bool",
                        "sum_kzt": "float64, integer или decimal",
                        "date": "date или timestamp без часового пояса",
                    }[column]
                    raise InputError(f"{filename}: {column} имеет тип {dtype}; ожидается {hint}")
            table = parquet.read(columns=list(expected))
        for column in expected:
            if table.column(column).null_count:
                raise InputError(f"{filename}: {column} содержит null")
        return table.to_pylist()
    except InputError:
        raise
    except (OSError, ValueError, TypeError, OverflowError, pa.ArrowException) as exc:
        raise InputError(f"Не удалось прочитать {filename}: {exc}") from exc


def _integer(value: object, label: str) -> int:
    if type(value) is not int or not _INT64_MIN <= value <= _INT64_MAX:
        raise InputError(f"{label}: ожидается целое число в диапазоне int64")
    return value


def _minor(value: object, label: str) -> int:
    # Decimal(str(float)) preserves the decimal representation supplied in the
    # file. Decimal.as_integer_ratio avoids dependence on context precision;
    # even a decimal128 amount with >28 digits remains exact.
    amount = Decimal(str(value))
    if not amount.is_finite() or amount <= 0:
        raise InputError(f"{label}: сумма должна быть конечной и строго положительной")
    numerator, denominator = amount.as_integer_ratio()
    minor, remainder = divmod(numerator * 100, denominator)
    if remainder:
        raise InputError(f"{label}: более двух дробных знаков KZT; округление запрещено")
    return minor


def _date(value: object, label: str) -> date:
    if isinstance(value, datetime):
        # Reject sub-day information instead of silently throwing it away.
        if value.tzinfo is not None or value.time() != time.min or getattr(value, "nanosecond", 0):
            raise InputError(f"{label}: содержит время или часовой пояс; ожидается дата")
        return value.date()
    if isinstance(value, date):
        return value
    raise InputError(f"{label}: ожидается календарная дата, без угадывания формата")


def load_inputs(input_dir: Path) -> InputData:
    """Read and validate inputs; never write outputs or discard input records."""
    input_dir = Path(input_dir)
    raw_nodes = _read_table(input_dir, "nodes")
    raw_edges = _read_table(input_dir, "edges")
    raw_transactions = _read_table(input_dir, "transactions")
    if not raw_nodes:
        raise InputError("nodes.parquet не содержит узлов")

    nodes_by_gid: dict[int, dict] = {}
    for index, row in enumerate(raw_nodes, start=1):
        label = f"nodes.parquet, строка {index}"
        gid = _integer(row["gid"], f"{label}, gid")
        if gid in nodes_by_gid:
            raise InputError(f"{label}: повторяющийся gid {gid}")
        depth = _integer(row["depth"], f"{label}, depth")
        if not 0 <= depth <= 4:
            raise InputError(f"{label}: depth должен быть в диапазоне 0..4")
        if row["is_seed"] != (depth == 0):
            raise InputError(f"{label}: is_seed должен соответствовать depth == 0")
        nodes_by_gid[gid] = {"gid": gid, "depth": depth, "is_seed": row["is_seed"]}

    def endpoints(row: dict, label: str) -> tuple[int, int]:
        src = _integer(row["src"], f"{label}, src")
        dst = _integer(row["dst"], f"{label}, dst")
        for gid in (src, dst):
            if gid not in nodes_by_gid:
                raise InputError(f"{label}: неизвестный gid {gid}, отсутствует в nodes.parquet")
        return src, dst

    edges_by_pair: dict[tuple[int, int], dict] = {}
    for index, row in enumerate(raw_edges, start=1):
        label = f"edges.parquet, строка {index}"
        src, dst = endpoints(row, label)
        if (src, dst) in edges_by_pair:
            raise InputError(f"{label}: повторяющаяся пара src/dst ({src}, {dst})")
        depth = _integer(row["depth"], f"{label}, depth")
        if not 1 <= depth <= 4:
            raise InputError(f"{label}: depth должен быть в диапазоне 1..4")
        if depth != nodes_by_gid[src]["depth"] + 1 or nodes_by_gid[dst]["depth"] > depth:
            raise InputError(f"{label}: depth ребра не согласован с глубиной src/dst")
        count = _integer(row["n_tx"], f"{label}, n_tx")
        if count <= 0:
            raise InputError(f"{label}: n_tx должен быть строго положительным")
        edges_by_pair[(src, dst)] = {
            "src": src, "dst": dst, "amount_minor": _minor(row["sum_kzt"], f"{label}, sum_kzt"),
            "n_tx": count, "depth": depth,
        }

    transactions: list[dict] = []
    tx_amounts: dict[tuple[int, int], int] = defaultdict(int)
    tx_counts: Counter = Counter()
    seen_transactions: set[tuple] = set()
    duplicate_count = 0
    for index, row in enumerate(raw_transactions, start=1):
        label = f"transactions.parquet, строка {index}"
        src, dst = endpoints(row, label)
        amount_minor = _minor(row["sum_kzt"], f"{label}, sum_kzt")
        transaction_date = _date(row["date"], f"{label}, date")
        key = (src, dst, transaction_date, amount_minor)
        if key in seen_transactions:
            duplicate_count += 1
        seen_transactions.add(key)
        transactions.append({"src": src, "dst": dst, "date": transaction_date,
                             "amount_minor": amount_minor})
        tx_amounts[(src, dst)] += amount_minor
        tx_counts[(src, dst)] += 1

    if set(tx_counts) != set(edges_by_pair):
        raise InputError("edges.parquet и transactions.parquet: пары src/dst не совпадают")
    for pair in sorted(edges_by_pair):
        edge = edges_by_pair[pair]
        if edge["n_tx"] != tx_counts[pair]:
            raise InputError(f"Пара {pair}: n_tx в edges.parquet не совпадает с transactions.parquet")
        if edge["amount_minor"] != tx_amounts[pair]:
            raise InputError(f"Пара {pair}: точная сумма в edges.parquet не совпадает с transactions.parquet")

    warnings = []
    if duplicate_count:
        warnings.append(f"Обнаружено {duplicate_count} повторных строк транзакций после первого "
                        "вхождения; все сохранены и учтены в агрегатах.")
    return InputData(
        nodes=[nodes_by_gid[gid] for gid in sorted(nodes_by_gid)],
        edges=[edges_by_pair[pair] for pair in sorted(edges_by_pair)],
        transactions=sorted(transactions, key=lambda row: (
            row["src"], row["dst"], row["date"], row["amount_minor"],
        )),
        warnings=warnings,
    )
