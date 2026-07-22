#!/usr/bin/env python3
"""Sentinel Test Framework - dependency-free Python test+coverage runner.

Runs stdlib unittest discovery under sys.settrace to record executed lines,
then reports per-file line coverage for the project's product modules. No
coverage.py / pytest-cov required.

Usage: python3 coverage_runner.py <config.json>
    config = { "root": ".", "start_dir": ".", "product_files": ["calc.py", ...] }

Emits JSON: { "tests": [...], "coverage": { files:[...], overall:{...} } }
"""

import ast
import contextlib
import io
import json
import os
import sys
import time
import traceback
import unittest


def executable_lines(path):
    """Return the set of line numbers that carry executable statements.

    Uses the AST so blank lines, comments, docstrings and pure structural
    lines are excluded from the denominator (a standard coverage convention).
    """
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        source = fh.read()
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return set()
    lines = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.stmt):
            # Skip module/function/class docstring expression statements.
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) \
                    and isinstance(node.value.value, str):
                continue
            lines.add(node.lineno)
    return lines


class JsonResult(unittest.TestResult):
    def __init__(self):
        super().__init__()
        self.records = []
        self._start = {}

    def startTest(self, test):  # noqa: N802
        super().startTest(test)
        self._start[test.id()] = time.time()

    def _record(self, test, status, err=None):
        duration = int((time.time() - self._start.get(test.id(), time.time())) * 1000)
        message = ""
        stack = ""
        if err is not None:
            message = "%s: %s" % (getattr(err[0], "__name__", "Error"), err[1])
            stack = "".join(traceback.format_exception(*err))[-2000:]
        parts = test.id().rsplit(".", 1)
        self.records.append({
            "classname": parts[0] if len(parts) > 1 else "",
            "name": parts[-1],
            "status": status,
            "message": message[:500],
            "stack": stack,
            "time": duration,
        })

    def addSuccess(self, test):  # noqa: N802
        super().addSuccess(test)
        self._record(test, "passed")

    def addFailure(self, test, err):  # noqa: N802
        super().addFailure(test, err)
        self._record(test, "failed", err)

    def addError(self, test, err):  # noqa: N802
        super().addError(test, err)
        self._record(test, "failed", err)

    def addSkip(self, test, reason):  # noqa: N802
        super().addSkip(test, reason)
        self._record(test, "skipped")


def main():
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        config = json.load(fh)
    root = config["root"]
    start_dir = config.get("start_dir", root)
    product_files = [os.path.abspath(os.path.join(root, p)) for p in config.get("product_files", [])]
    tracked = {p: executable_lines(p) for p in product_files if os.path.isfile(p)}
    executed = {p: set() for p in tracked}
    tracked_set = set(tracked)

    def tracer(frame, event, arg):
        if event == "call":
            return tracer
        if event == "line":
            filename = frame.f_code.co_filename
            if filename in tracked_set:
                executed[filename].add(frame.f_lineno)
        return tracer

    loader = unittest.TestLoader()
    suite = loader.discover(start_dir, top_level_dir=root)
    result = JsonResult()

    sink = io.StringIO()
    sys.settrace(tracer)
    try:
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            suite.run(result)
    finally:
        sys.settrace(None)

    cov_files = []
    total_exec = 0
    total_hit = 0
    for path, lines in tracked.items():
        hit = executed[path] & lines
        total_exec += len(lines)
        total_hit += len(hit)
        missed = sorted(lines - hit)
        cov_files.append({
            "file": os.path.relpath(path, root),
            "linePct": round(len(hit) / len(lines) * 1000) / 10 if lines else 100.0,
            "linesCovered": len(hit),
            "linesTotal": len(lines),
            "uncoveredLines": missed[:25],
        })

    json.dump({
        "tests": result.records,
        "coverage": {
            "files": sorted(cov_files, key=lambda c: c["file"]),
            "overall": {
                "linePct": round(total_hit / total_exec * 1000) / 10 if total_exec else 0.0,
                "linesCovered": total_hit,
                "linesTotal": total_exec,
            },
        },
    }, sys.stdout)


if __name__ == "__main__":
    main()
