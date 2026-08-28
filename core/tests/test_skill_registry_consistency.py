"""Skill-doc <-> MCP-registry consistency (consolidation spec, Phase 2).

The advising skills in core/ are served IN PLACE to the advisor
(GC_ADVISOR_SKILLS points here), while the tools they name are defined in
the TypeScript service at the repo root. On 2026-08-14 CUassistant renamed its tool surface and
four names in skills/gc-advisor/SKILL.md went stale — served live to the
advising model for ten days. This test makes that drift a failing build.

Static layer (default suite): parses the tool registrations out of
CUassistant's src/mcp-tools/*.ts, applies the runtime rename layer
(gc-skill-renames.ts, which renames the catalog server's skill tools), and
asserts every tool name referenced in this repo's skill docs is actually
served. Also asserts every MCP operation id has a policy entry — the surface
the 2026-08-25 final review found unguarded.

Live layer (integration marker): if MCP_PUBLIC_AUTH_TOKEN and
MCP_CATALOG_AUTH_TOKEN are set (the servers use DIFFERENT bearer tokens —
8766 public, 8767 catalog; a single shared token can never probe both, which
is why this test had never passed before 2026-08-25), probes the running
8766/8767 servers via CUassistant's scripts/mcp-tools-probe.mjs and asserts
the static model matches runtime truth.

Since the Phase 1 merge (2026-08-25) this tree is core/ of the same repo
as the TypeScript service, so the test reads the service at the repo root
(ROOT.parent). CUASSISTANT_ROOT still overrides the default — for the
red-proof and for any future layout move — but a missing layout is a
FAILURE, not a skip: this guards a runtime contract, and a guard that
quietly stands down is worse than none.
"""
import os
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent            # core/
# The TypeScript service lives at the repo root (core/ is a subtree of it).
# CUASSISTANT_ROOT stays as an override so the test can be pointed elsewhere
# (its red-proof, or a future service/ move) — but the DEFAULT is in-repo,
# and a missing layout is a FAILURE, not a skip: this test guards a runtime
# contract (skill docs served verbatim to the advising model), and a guard
# that quietly stands down is worse than none.
CU = Path(os.environ.get("CUASSISTANT_ROOT", str(ROOT.parent)))

REQUIRED_CU_PATHS = (
    CU / "src" / "mcp-tools",
    CU / "src" / "mcp-tools" / "gc-skill-renames.ts",
    CU / "policy" / "action-policy.yaml",
)
_MISSING_CU_PATHS = [str(p) for p in REQUIRED_CU_PATHS if not p.exists()]


def test_service_layout_present():
    assert not _MISSING_CU_PATHS, (
        f"service layout at {CU} is missing {', '.join(_MISSING_CU_PATHS)} "
        "— core/ must sit directly under the repo root (or set CUASSISTANT_ROOT)"
    )

# Backticked kebab-case identifiers in skill docs that are NOT tool names.
# Each entry needs a justification; an unexplained entry defeats the test.
NON_TOOL_REFS = {
    "program-plan",  # scripts/query.py subcommand (gc-curriculum-lookup drives the CLI, not MCP)
}

NAME_RE = re.compile(r'^\s*name: "([a-z][a-z0-9-]*)"', re.M)
RENAME_RE = re.compile(r'from: "([a-z0-9-]+)",\s*to: "([a-z0-9-]+)"')
OP_RE = re.compile(r'operation: "([a-z_.]+)"')
POLICY_ID_RE = re.compile(r"^\s*- id:\s*([a-z_.]+)", re.M)
DOC_REF_RE = re.compile(r"`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`")


def registered_names() -> set[str]:
    """Tool names statically registered across CUassistant's MCP modules."""
    names: set[str] = set()
    for f in (CU / "src" / "mcp-tools").glob("*.ts"):
        names.update(NAME_RE.findall(f.read_text()))
    return names


def rename_pairs() -> list[tuple[str, str]]:
    text = (CU / "src" / "mcp-tools" / "gc-skill-renames.ts").read_text()
    return [(m.group(1), m.group(2)) for m in RENAME_RE.finditer(text)]


def served_names() -> set[str]:
    """The union of names actually servable across both servers: static
    registrations plus the runtime-renamed copies (the originals stay served
    on the public server, so both sides of each rename are valid)."""
    names = registered_names()
    names.update(to for _, to in rename_pairs())
    return names


def doc_tool_refs() -> dict[str, set[Path]]:
    """kebab-case backticked identifiers in every skill doc we serve,
    mapped to the files that reference them."""
    refs: dict[str, set[Path]] = {}
    roots = [ROOT / "skills"]
    roots.extend((ROOT / "packs").glob("*/skill"))  # empty until skills move
    for root in roots:
        for f in root.rglob("*.md"):
            for name in DOC_REF_RE.findall(f.read_text()):
                refs.setdefault(name, set()).add(f.relative_to(ROOT))
    return refs


def test_every_tool_name_in_skill_docs_is_actually_served():
    served = served_names()
    unknown = {
        name: sorted(str(p) for p in files)
        for name, files in doc_tool_refs().items()
        if name not in served and name not in NON_TOOL_REFS
    }
    assert not unknown, (
        "Skill docs reference tool names no CUassistant server registers "
        "(renamed? removed?). Fix the doc or, for a genuine non-tool "
        f"identifier, add it to NON_TOOL_REFS with a justification: {unknown}"
    )


def test_rename_layer_sources_are_still_registered():
    """gc-skill-renames.ts renames EXISTING registrations at startup; if the
    source name disappears the rename layer breaks at server start."""
    registered = registered_names()
    missing = [frm for frm, _ in rename_pairs() if frm not in registered]
    assert rename_pairs(), "no rename pairs parsed — regex or file moved?"
    assert not missing, f"rename layer renames unregistered tools: {missing}"


def test_every_mcp_operation_id_has_a_policy_entry():
    """assertMcpOperation fails closed on ids missing from the allow-list;
    a rename that touches operation ids but not action-policy.yaml bricks
    the tool at runtime. This is the surface the Phase-4 rename would break
    invisibly (2026-08-25 final review, service-layer finding)."""
    ops: set[str] = set()
    for f in (CU / "src" / "mcp-tools").glob("*.ts"):
        ops.update(OP_RE.findall(f.read_text()))
    policy = set(POLICY_ID_RE.findall((CU / "policy" / "action-policy.yaml").read_text()))
    assert ops, "no operation ids parsed — regex or layout changed?"
    missing = sorted(ops - policy)
    assert not missing, f"operation ids with no action-policy.yaml entry: {missing}"


@pytest.mark.integration
def test_static_model_matches_live_servers():
    """Probes the running servers; needs node and BOTH per-port tokens —
    8766 authenticates with MCP_PUBLIC_AUTH_TOKEN, 8767 with
    MCP_CATALOG_AUTH_TOKEN. (The original single-MCP_AUTH_TOKEN version could
    never pass: one server always rejected the other's token. Found live by
    the cuassistant session during the Phase 1 merge, 2026-08-25;
    red-proofed against the running servers before this fix.)"""
    tokens = {8766: os.environ.get("MCP_PUBLIC_AUTH_TOKEN"),
              8767: os.environ.get("MCP_CATALOG_AUTH_TOKEN")}
    missing = [str(p) for p, tok in tokens.items() if not tok]
    if missing:
        pytest.skip(f"per-port token(s) not set for {', '.join(missing)} "
                    "(MCP_PUBLIC_AUTH_TOKEN / MCP_CATALOG_AUTH_TOKEN)")
    live: set[str] = set()
    for port, token in tokens.items():
        out = subprocess.run(
            ["node", str(CU / "scripts" / "mcp-tools-probe.mjs"), str(port), token],
            capture_output=True, text=True, timeout=30, cwd=CU, check=True)
        live.update(out.stdout.split())
    assert live == served_names(), (
        f"static model diverges from runtime: only-live={sorted(live - served_names())} "
        f"only-static={sorted(served_names() - live)}"
    )
