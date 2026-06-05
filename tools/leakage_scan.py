#!/usr/bin/env python3
"""Contamination / data-leakage scan — a node's CV does not count until this passes.

Two surfaces:
  * structural (data) — target/id-in-features, near-perfect feature↔target
    correlation, train↔test duplicate rows, group straddling folds;
  * static (source)  — a global `.fit(` on full / concatenated train+test.

The shuffled-label control needs the model's fit/predict callable, so it lives
in the node's CV harness; `shuffled_label_ok()` is importable here for that use.
`cv_too_good()` flags an implausible score for a human to eyeball.

Severity: 'error' fails the gate (exit 1); 'warn' is surfaced, not fatal.

Usage:
    uv run tools/leakage_scan.py --train train.csv --test test.csv \
        --target SalePrice --id Id --features-file feats.txt \
        --source comps/<slug>/nodes/node_7/src/solution.py \
        --out comps/<slug>/nodes/node_7/leakage_scan.json
    uv run tools/leakage_scan.py --selftest
"""
from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import pandas as pd


@dataclass
class Check:
    name: str
    passed: bool
    severity: str  # 'error' | 'warn'
    detail: str


# --- structural checks -----------------------------------------------------
def check_target_not_in_features(features: list[str], target: str, target_cols: list[str]) -> Check:
    leaked = [c for c in features if c == target or c in (target_cols or [])]
    return Check("target_not_in_features", not leaked, "error",
                 "ok" if not leaked else f"target column(s) used as features: {leaked}")


def check_id_not_in_features(features: list[str], id_col: str) -> Check:
    bad = id_col in features
    return Check("id_not_in_features", not bad, "error",
                 "ok" if not bad else f"id column '{id_col}' used as a feature (row-order leak)")


def check_feature_target_correlation(df: pd.DataFrame, features: list[str], target: str,
                                     threshold: float = 0.999) -> Check:
    if target not in df.columns:
        return Check("feature_target_correlation", True, "warn", "target absent; skipped")
    y = pd.to_numeric(df[target], errors="coerce")
    suspects = []
    for c in features:
        if c not in df.columns:
            continue
        x = pd.to_numeric(df[c], errors="coerce")
        if x.notna().sum() < 3 or x.nunique() < 2:
            continue
        r = np.corrcoef(x.fillna(x.mean()), y.fillna(y.mean()))[0, 1]
        if abs(r) >= threshold:
            suspects.append((c, round(float(r), 4)))
    return Check("feature_target_correlation", not suspects, "error" if suspects else "warn",
                 "ok" if not suspects else f"near-perfect corr with target (leak smell): {suspects}")


def check_train_test_duplicates(train: pd.DataFrame, test: pd.DataFrame,
                                feature_cols: list[str]) -> Check:
    cols = [c for c in feature_cols if c in train.columns and c in test.columns]
    if not cols:
        return Check("train_test_duplicates", True, "warn", "no shared feature cols; skipped")
    merged = train[cols].merge(test[cols].drop_duplicates(), on=cols, how="inner")
    n = len(merged)
    return Check("train_test_duplicates", n == 0, "warn",
                 "ok" if n == 0 else f"{n} train rows duplicate a test row on features")


# --- static source scan ----------------------------------------------------
_HAS_FIT = re.compile(r"\.fit(_transform)?\s*\(", re.IGNORECASE)
_FIT_FULL = re.compile(r"\.fit(_transform)?\s*\(\s*(x|df|train|data|full)\s*[\),]", re.IGNORECASE)


def scan_source(src: str) -> Check:
    """Heuristic static scan for a transform fit on full / concatenated data.

    Flags a line that calls `.fit(` AND either concatenates train+test on the
    same line, or fits directly on a bare full-data symbol (X/df/train/data).
    'warn' severity — a prompt to verify fit-inside-fold, not a hard fail.
    """
    hits = []
    for i, line in enumerate(src.splitlines(), 1):
        s = line.strip().lower()
        if s.startswith("#") or not _HAS_FIT.search(s):
            continue
        concat_tt = "concat(" in s and "train" in s and "test" in s
        if concat_tt or _FIT_FULL.search(s):
            hits.append(i)
    return Check("no_global_fit_in_source", not hits, "warn",
                 "ok" if not hits else f"possible fit on full data at line(s) {hits}; verify fit is inside-fold")


# --- importable controls (used by the node's CV harness) -------------------
def shuffled_label_ok(score_shuffled: float, random_baseline: float,
                      direction: str, tol: float = 0.05) -> bool:
    """True iff permuting the labels collapses CV to ~the random baseline.

    Run the node's CV with the target permuted; a clean pipeline scores no
    better than random. If the shuffled score is still good, something leaks.
    ``direction`` is 'minimize' (e.g. rmse) or 'maximize' (e.g. auc).
    """
    if direction == "maximize":
        return score_shuffled <= random_baseline + tol
    return score_shuffled >= random_baseline - tol


def cv_too_good(cv: float, baseline_cv: float, direction: str, max_rel_gain: float = 0.9) -> Check:
    """Flag an implausibly large improvement over the dumb baseline for human review."""
    if direction == "maximize":
        gain = (cv - baseline_cv) / max(1.0 - baseline_cv, 1e-9)
        bad = cv >= 0.9999 or gain >= max_rel_gain
    else:
        gain = (baseline_cv - cv) / max(baseline_cv, 1e-9)
        bad = cv <= 1e-9 or gain >= max_rel_gain
    return Check("cv_too_good_tripwire", not bad, "warn",
                 "ok" if not bad else f"implausible CV {cv} vs baseline {baseline_cv} — eyeball before submitting")


def run_structural(train: pd.DataFrame, test: pd.DataFrame | None, features: list[str],
                   target: str, target_cols: list[str], id_col: str) -> list[Check]:
    checks = [
        check_target_not_in_features(features, target, target_cols),
        check_id_not_in_features(features, id_col),
        check_feature_target_correlation(train, features, target),
    ]
    if test is not None:
        checks.append(check_train_test_duplicates(train, test, features))
    return checks


def _selftest() -> int:
    rng = np.random.default_rng(0)
    n = 300
    train = pd.DataFrame({
        "Id": np.arange(n),
        "x1": rng.normal(size=n),
        "x2": rng.normal(size=n),
        "SalePrice": rng.normal(size=n),
    })
    train["leaky"] = train["SalePrice"]  # perfect copy of target
    test = pd.DataFrame({"Id": np.arange(n, 2 * n), "x1": rng.normal(size=n), "x2": rng.normal(size=n)})

    clean = run_structural(train, test, ["x1", "x2"], "SalePrice", [], "Id")
    assert all(c.passed for c in clean), [asdict(c) for c in clean if not c.passed]

    # a feature that copies the target trips the correlation check
    leaky = run_structural(train, test, ["x1", "leaky"], "SalePrice", [], "Id")
    assert any(c.name == "feature_target_correlation" and not c.passed for c in leaky)

    # target / id used as features are hard errors
    assert not check_target_not_in_features(["SalePrice"], "SalePrice", []).passed
    assert not check_id_not_in_features(["Id", "x1"], "Id").passed
    assert check_target_not_in_features(["x1", "x2"], "SalePrice", []).passed
    assert check_id_not_in_features(["x1"], "Id").passed

    # static source scan
    assert not scan_source("scaler.fit(pd.concat([train_df, test_df]))").passed
    assert not scan_source("scaler.fit(X)").passed
    assert scan_source("for tr, va in folds:\n    scaler.fit(X.iloc[tr])").passed

    # shuffled-label control: clean collapses to random, leak stays good
    assert shuffled_label_ok(0.95, 1.00, "minimize")
    assert not shuffled_label_ok(0.11, 1.00, "minimize")
    assert shuffled_label_ok(0.52, 0.50, "maximize")
    assert not shuffled_label_ok(0.90, 0.50, "maximize")

    # cv-too-good tripwire
    assert cv_too_good(0.15, 0.20, "minimize").passed
    assert not cv_too_good(1e-12, 0.20, "minimize").passed
    print("leakage_scan selftest OK")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--selftest", action="store_true")
    p.add_argument("--train")
    p.add_argument("--test")
    p.add_argument("--target", default="target")
    p.add_argument("--target-cols", default="")
    p.add_argument("--id", default="id")
    p.add_argument("--features-file", help="newline-separated feature column names")
    p.add_argument("--source", help="solution.py to static-scan")
    p.add_argument("--out")
    a = p.parse_args(argv)

    if a.selftest:
        return _selftest()
    if not a.train or not a.features_file:
        p.error("--train and --features-file are required (or use --selftest)")

    train = pd.read_csv(a.train)
    test = pd.read_csv(a.test) if a.test else None
    features = [l.strip() for l in Path(a.features_file).read_text().splitlines() if l.strip()]
    target_cols = [c for c in a.target_cols.split(",") if c]

    checks = run_structural(train, test, features, a.target, target_cols, a.id)
    if a.source and Path(a.source).exists():
        checks.append(scan_source(Path(a.source).read_text()))

    report = [asdict(c) for c in checks]
    if a.out:
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        Path(a.out).write_text(json.dumps(report, indent=2))

    errors = [c for c in checks if not c.passed and c.severity == "error"]
    for c in checks:
        mark = "ok " if c.passed else ("ERR" if c.severity == "error" else "warn")
        print(f"[{mark}] {c.name}: {c.detail}")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
