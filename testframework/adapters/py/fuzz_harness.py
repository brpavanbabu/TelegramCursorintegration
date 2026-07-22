#!/usr/bin/env python3
"""Sentinel Test Framework - autonomous Python fuzz harness (stdlib only).

Reads a JSON config file (argv[1]):
    { "root": "...", "files": ["mymath.py", ...], "seed": 42, "iterations": 120 }

For every module that is SAFE to import (only stdlib imports, no top-level
side effects), reflects its module-level functions and attacks every
parameter with adversarial edge cases plus seeded random combinations.

Emits a JSON report on stdout matching the Sentinel fuzz report shape.
"""

import ast
import contextlib
import importlib.util
import inspect
import io
import json
import os
import random
import signal
import sys
import traceback

CALL_TIMEOUT_SEC = 0.25

EDGE_VALUES = [
    ("None", lambda: None),
    ("0", lambda: 0),
    ("-1", lambda: -1),
    ("2**63", lambda: 2 ** 63),
    ("NaN", lambda: float("nan")),
    ("Infinity", lambda: float("inf")),
    ("empty string", lambda: ""),
    ("short string", lambda: "a"),
    ("10k-char string", lambda: "A" * 10000),
    ("unicode/emoji", lambda: "\U0001F600\U0001F525 ля"),
    ("format string", lambda: "%s%s%n{0}{1}"),
    ("sql injection", lambda: "' OR 1=1; DROP TABLE users;--"),
    ("xss payload", lambda: "<script>alert(1)</script>"),
    ("shell injection", lambda: "$(rm -rf /tmp/x); `id`"),
    ("path traversal", lambda: "../../../../etc/passwd"),
    ("dunder key", lambda: "__class__"),
    ("empty dict", lambda: {}),
    ("empty list", lambda: []),
    ("nested object", lambda: {"a": {"b": [1, 2, None]}}),
    ("empty tuple", lambda: ()),
    ("bytes", lambda: b"\x00\xff bytes"),
    ("True", lambda: True),
    ("False", lambda: False),
    ("float", lambda: 3.14159),
    ("negative float", lambda: -0.0001),
]


class CallTimeout(Exception):
    pass


def _alarm_handler(signum, frame):
    raise CallTimeout("hang")


def import_safety(path):
    """Return (safe, reason). Safe = stdlib-only imports, no top-level side effects."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            tree = ast.parse(fh.read())
    except SyntaxError as exc:
        return False, "syntax error: %s" % exc
    std = set(getattr(sys, "stdlib_module_names", ()))
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] not in std:
                    return False, "external import: %s" % alias.name
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module and node.module.split(".")[0] not in std:
                return False, "external import: %s" % node.module
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef,
                               ast.Assign, ast.AnnAssign, ast.AugAssign)):
            continue
        elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant):
            continue  # docstring
        elif isinstance(node, ast.If):
            test = node.test
            is_main_guard = (
                isinstance(test, ast.Compare)
                and isinstance(test.left, ast.Name)
                and test.left.id == "__name__"
            )
            if not is_main_guard:
                return False, "top-level conditional logic"
        elif isinstance(node, (ast.Try,)):
            return False, "top-level try block (side effects possible)"
        else:
            return False, "top-level statement: %s" % type(node).__name__
    return True, None


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sink = io.StringIO()
    with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        spec.loader.exec_module(module)
    return module


def positional_params(func):
    try:
        sig = inspect.signature(func)
    except (TypeError, ValueError):
        return ["arg0"]
    names = []
    for param in sig.parameters.values():
        if param.kind in (param.POSITIONAL_ONLY, param.POSITIONAL_OR_KEYWORD):
            names.append(param.name)
        elif param.kind == param.VAR_POSITIONAL:
            names.append("*" + param.name)
            break
        elif param.kind == param.KEYWORD_ONLY and param.default is param.empty:
            # cannot satisfy positionally; caller will likely TypeError - fine,
            # but we still fuzz the positional prefix.
            break
    return names or ["arg0"]


def fuzz_function(name, func, rng, iterations):
    params = positional_params(func)
    arity = max(1, len([p for p in params if not p.startswith("*")]))
    crashes = {}
    invocations = 0
    hangs = 0

    def invoke(specs):
        nonlocal invocations, hangs
        labels = ["%s=%s" % (params[i] if i < len(params) else "arg%d" % i, specs[i][0])
                  for i in range(arity)]
        args = [spec[1]() for spec in specs]
        invocations += 1
        sink = io.StringIO()
        old_handler = signal.signal(signal.SIGALRM, _alarm_handler)
        signal.setitimer(signal.ITIMER_REAL, CALL_TIMEOUT_SEC)
        try:
            with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                func(*args)
        except CallTimeout:
            hangs += 1
            sig = "HANG"
            entry = crashes.setdefault(sig, {"signature": sig, "count": 0,
                                             "exampleArgs": ", ".join(labels)})
            entry["count"] += 1
        except Exception as exc:  # noqa: BLE001 - the whole point is catching everything
            sig = "%s: %s" % (type(exc).__name__, str(exc)[:120])
            entry = crashes.setdefault(sig, {"signature": sig, "count": 0,
                                             "exampleArgs": ", ".join(labels)})
            entry["count"] += 1
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, old_handler)

    # Two systematic sweeps with different fillers so both string-typed and
    # numeric-typed code paths are reached in the non-fuzzed positions.
    for benign in (("'value'", lambda: "value"), ("7", lambda: 7)):
        for pos in range(arity):
            for edge in EDGE_VALUES:
                invoke([edge if i == pos else benign for i in range(arity)])
    for _ in range(iterations):
        invoke([EDGE_VALUES[rng.randrange(len(EDGE_VALUES))] for _ in range(arity)])

    return {
        "fn": name,
        "arity": arity,
        "params": [p for p in params],
        "invocations": invocations,
        "hangs": hangs,
        "crashSignatures": sorted(crashes.values(), key=lambda c: -c["count"]),
    }


def main():
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        config = json.load(fh)
    root = config["root"]
    seed = int(config.get("seed", 42))
    iterations = int(config.get("iterations", 120))

    reports = []
    skipped = []

    for index, rel in enumerate(config["files"]):
        path = os.path.join(root, rel)
        safe, reason = import_safety(path)
        if not safe:
            skipped.append({"file": rel, "reason": reason})
            continue
        try:
            module = load_module(path, "sentinel_fuzz_target_%d" % index)
        except Exception as exc:  # noqa: BLE001
            skipped.append({"file": rel, "reason": "import failed: %s" %
                            "".join(traceback.format_exception_only(type(exc), exc)).strip()})
            continue

        functions = [
            (name, obj) for name, obj in inspect.getmembers(module, inspect.isfunction)
            if obj.__module__ == module.__name__ and not name.startswith("_")
        ]
        if not functions:
            skipped.append({"file": rel, "reason": "no public module-level functions"})
            continue

        rng = random.Random(seed)
        fn_reports = [fuzz_function(name, func, rng, iterations) for name, func in functions]
        reports.append({
            "module": "py:" + rel,
            "seed": seed,
            "functions": fn_reports,
            "prototypePolluted": False,
            "totalInvocations": sum(f["invocations"] for f in fn_reports),
            "totalCrashSignatures": sum(len(f["crashSignatures"]) for f in fn_reports),
            "totalHangs": sum(f["hangs"] for f in fn_reports),
        })

    json.dump({"reports": reports, "skipped": skipped, "seed": seed}, sys.stdout)


if __name__ == "__main__":
    main()
