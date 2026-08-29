"""gc-progress-v1: the sanitized student-progress contract (spec §3.2).
This is the ONLY record-derived data the server side ever sees — it is
produced by the browser-side whitelist sanitizer and contains no grades,
names, or IDs by construction."""
from dataclasses import dataclass, field


@dataclass
class PassedCourse:
    code: str
    term: str = ""
    credits: float | None = None


@dataclass
class Progress:
    version: str
    catalog_year: str
    program: str = "Graphic Communications, BS"
    passed: list[PassedCourse] = field(default_factory=list)
    in_progress: list[str] = field(default_factory=list)
    minor: dict | None = None            # {"name": str, "complete": bool}
    grade_checks: dict = field(default_factory=dict)  # {"c_or_better": [codes]}
    warnings: list[str] = field(default_factory=list)

    KNOWN_KEYS = frozenset({
        "version", "catalog_year", "program", "passed", "in_progress",
        "minor", "grade_checks", "warnings",
    })

    @classmethod
    def from_dict(cls, d: dict) -> "Progress":
        if d.get("version") != "gc-progress-v1":
            raise ValueError(f"unsupported progress version: {d.get('version')!r}")
        if not d.get("catalog_year"):
            raise ValueError("catalog_year is required")
        # An unknown top-level key is an ERROR, not something to ignore. Found
        # 2026-08-29: a payload with `completed` instead of `passed` was accepted
        # and audited as "this student has completed nothing" — a confident,
        # well-formed answer meaning "I did not understand your input", from
        # the tool that reports a student's degree progress. The sub-keys were
        # already strict (a bad entry inside `passed` raises); the top level
        # was not. `completed` is the more natural word, so a model WILL send it.
        unknown = sorted(set(d) - cls.KNOWN_KEYS)
        if unknown:
            raise ValueError(
                f"unknown progress field(s) {unknown}; "
                f"expected only {sorted(cls.KNOWN_KEYS)}"
            )
        return cls(
            version=d["version"],
            catalog_year=d["catalog_year"],
            program=d.get("program", "Graphic Communications, BS"),
            passed=[PassedCourse(p["code"], p.get("term", ""), p.get("credits"))
                    for p in d.get("passed", [])],
            in_progress=list(d.get("in_progress", [])),
            minor=d.get("minor"),
            grade_checks=dict(d.get("grade_checks", {})),
            warnings=list(d.get("warnings", [])),
        )
