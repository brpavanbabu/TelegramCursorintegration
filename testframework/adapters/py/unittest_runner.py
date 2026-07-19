#!/usr/bin/env python3
"""Sentinel Test Framework - stdlib unittest runner with JSON output.

Used when pytest is not available. Discovers test*.py under the given start
directory and prints one JSON document with per-test results, so Sentinel can
merge Python test results into its unified report and traceability matrix.

Usage: python3 unittest_runner.py <start_dir> [top_level_dir]
"""

import contextlib
import io
import json
import sys
import time
import traceback
import unittest


class JsonResult(unittest.TestResult):
    def __init__(self):
        super().__init__()
        self.records = []
        self._start = {}

    def startTest(self, test):  # noqa: N802 (unittest API)
        super().startTest(test)
        self._start[test.id()] = time.time()

    def _record(self, test, status, err=None):
        duration = int((time.time() - self._start.get(test.id(), time.time())) * 1000)
        message = ""
        trace = ""
        if err is not None:
            exc_type, exc_value, _tb = err
            message = "%s: %s" % (getattr(exc_type, "__name__", "Error"), exc_value)
            trace = "".join(traceback.format_exception(*err))[-2000:]
        parts = test.id().rsplit(".", 1)
        self.records.append({
            "classname": parts[0] if len(parts) > 1 else "",
            "name": parts[-1],
            "status": status,
            "message": message[:500],
            "stack": trace,
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

    def addExpectedFailure(self, test, err):  # noqa: N802
        super().addExpectedFailure(test, err)
        self._record(test, "passed")

    def addUnexpectedSuccess(self, test):  # noqa: N802
        super().addUnexpectedSuccess(test)
        self._record(test, "failed")


def main():
    start_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    top_level = sys.argv[2] if len(sys.argv) > 2 else None
    loader = unittest.TestLoader()
    suite = loader.discover(start_dir, top_level_dir=top_level)
    result = JsonResult()
    sink = io.StringIO()
    with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        suite.run(result)
    json.dump({"tests": result.records}, sys.stdout)


if __name__ == "__main__":
    main()
