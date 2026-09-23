"""Reviewed heuristic thresholds, not fitted labels or client identifiers."""

from dataclasses import dataclass


@dataclass(frozen=True)
class RulesConfig:
    coordinator_in: int = 5
    coordinator_out: int = 5
    coordinator_external_clusters: int = 2
    consolidator_in: int = 3
    distributor_out: int = 5
    fan_dominance: int = 2
    transit_ratio_low: float = 0.8
    transit_ratio_high: float = 1.2
    boundary_depth: int = 4
    louvain_seed: int = 42
    louvain_resolution: float = 1.0
    louvain_threshold: float = 1e-7
    priority_volume_weight: float = 0.35
    priority_in_weight: float = 0.35
    priority_out_weight: float = 0.10
    priority_role_weight: float = 0.20
    top_count: int = 20
    cluster_top_count: int = 3


DEFAULT_CONFIG = RulesConfig()
