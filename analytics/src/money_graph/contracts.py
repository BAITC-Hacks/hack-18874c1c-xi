"""Fixed output contracts; these constants are not computed analysis results."""

SCHEMA_VERSION = "1.0"

INPUT_FILENAMES = ("nodes.parquet", "edges.parquet", "transactions.parquet")

ROLES = (
    "consolidator",
    "transit",
    "distributor",
    "terminal",
    "coordinator",
    "peripheral",
)

CSV_COLUMNS = {
    "nodes_roles.csv": (
        "gid", "role", "role_score", "cluster_id", "priority_score", "evidence",
    ),
    "clusters.csv": (
        "cluster_id", "n_nodes", "n_seed", "sum_kzt_internal", "top_gids", "hypothesis",
    ),
    "top_nodes.csv": ("rank", "gid", "role", "priority_score", "why"),
}
