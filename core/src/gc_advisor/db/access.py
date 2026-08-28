import json
from pathlib import Path
from gc_advisor.db.connection import get_connection
from gc_advisor.db import advisor as _advisor
from gc_advisor.audit.rule_semantics import is_bogus_rule

def refresh_bogus_flags(con) -> int:
    """Recompute the materialized `bogus` flag for every requirement_rule row,
    using the SAME rule_semantics.is_bogus_rule the access layer applies at
    read time (advisor merge included). Returns the number of rows flagged
    bogus. Every writer calls this — backfill_requirements, apply_pack,
    manage_advisor_list — so direct SQL readers of requirement_rule_effective
    always agree with CatalogAccess. test_rule_flags's agreement test makes a
    missed refresh loud."""
    import json as _json
    from gc_advisor.db import advisor as _adv
    flagged = 0
    for p in con.execute(
            "SELECT p.id, p.name, cy.id AS cyid, cy.label FROM program p "
            "JOIN catalog_year cy ON p.catalog_year_id=cy.id").fetchall():
        gen_ed = [{"name": g["name"],
                   "allowed_courses": _json.loads(g["allowed_courses"] or "[]")}
                  for g in con.execute(
                      "SELECT name, allowed_courses FROM gen_ed_category "
                      "WHERE catalog_year_id=?", (p["cyid"],))]
        for r in con.execute(
                "SELECT id, slot_type, rule FROM requirement_rule WHERE program_id=?",
                (p["id"],)).fetchall():
            rule = _json.loads(r["rule"])
            allow, deny = _adv.advisor_sets(con, r["slot_type"], p["label"], program=p["name"])
            rule["advisor_courses"] = sorted(allow)
            rule["advisor_denies"] = sorted(deny)
            bogus = 1 if is_bogus_rule(r["slot_type"], rule, gen_ed) else 0
            con.execute("UPDATE requirement_rule SET bogus=? WHERE id=?", (bogus, r["id"]))
            flagged += bogus
    con.commit()
    return flagged


class CatalogAccess:
    """The ONLY module skills use to read curriculum data. Keep engine details here."""

    def __init__(self, db_path: str | Path):
        self.db_path = str(db_path)

    def _con(self):
        return get_connection(self.db_path)

    def list_catalog_years(self) -> list[str]:
        con = self._con()
        try:
            return [r["label"] for r in con.execute(
                "SELECT label FROM catalog_year ORDER BY label DESC")]
        finally:
            con.close()

    def _year_id(self, con, year: str) -> int:
        row = con.execute("SELECT id FROM catalog_year WHERE label=?", (year,)).fetchone()
        if not row:
            raise KeyError(f"Unknown catalog year: {year}")
        return row["id"]

    def get_program_plan(self, year: str, name: str) -> dict:
        con = self._con()
        try:
            cy = self._year_id(con, year)
            prog = con.execute(
                "SELECT * FROM program WHERE catalog_year_id=? AND name=?",
                (cy, name)).fetchone()
            if not prog:
                raise KeyError(f"No program {name!r} in {year}")
            groups = []
            for g in con.execute(
                "SELECT * FROM requirement_group WHERE program_id=? ORDER BY ordering",
                (prog["id"],)):
                items = []
                for it in con.execute(
                    "SELECT * FROM plan_item WHERE group_id=? ORDER BY ordering", (g["id"],)):
                    items.append({
                        "kind": it["kind"], "course_code": it["course_code"],
                        "one_of": json.loads(it["one_of"]) if it["one_of"] else [],
                        "slot_type": it["slot_type"], "credits": it["credits"],
                        "footnote_refs": json.loads(it["footnote_refs"] or "[]"),
                    })
                groups.append({"label": g["label"], "kind": g["kind"],
                               "credit_total": g["credit_total"], "items": items})
            footnotes = [{"number": f["number"], "text": f["text"]} for f in con.execute(
                "SELECT * FROM footnote WHERE program_id=? ORDER BY number", (prog["id"],))]
            return {"name": prog["name"], "total_credits": prog["total_credits"],
                    "description": prog["description"], "groups": groups,
                    "footnotes": footnotes, "source_url": prog["source_url"]}
        finally:
            con.close()

    def get_requirement_rules(self, year: str, name: str = "Graphic Communications, BS") -> list[dict]:
        """Requirement rules for a program-year, with advisor allow/deny sets
        merged in and BOGUS rules dropped.

        The filter lives here, at the access layer, rather than in
        `audit.engine`, because this method is the single consumer surface:
        `run_audit`, `scripts/query.py req-rules`, and CUassistant's MCP tools
        all read it. With the filter in the engine, `query.py` and the MCP
        tools reported requirements the audit itself refused to honour — two
        entry points disagreeing about what a program requires.

        Dropped are rules `rule_semantics.is_bogus_rule` identifies as
        catalog footnote mis-association: the unsatisfiable (no courses, no
        wildcards, no advisor entries) and the gen-ed-shadowing (explicit
        courses wholly disjoint from the gen-ed category the slot maps onto,
        e.g. Management 2025-2026's `Natural Science Requirement` =
        `["MGT 4150"]`). Dropping them lets the slot fall through to gen-ed
        matching in the engine, and stops this method from reporting a
        requirement the registrar never stated.
        """
        con = self._con()
        try:
            cy = self._year_id(con, year)
            prog = con.execute("SELECT id FROM program WHERE catalog_year_id=? AND name=?",
                               (cy, name)).fetchone()
            if not prog:
                raise KeyError(f"No program {name!r} in {year}")
            # The gen-ed-shadow tier needs this year's categories. Loaded on
            # the connection already open rather than via get_gen_ed(), which
            # would open a second one per call.
            gen_ed = [{"name": g["name"],
                       "allowed_courses": json.loads(g["allowed_courses"] or "[]")}
                      for g in con.execute(
                          "SELECT name, allowed_courses FROM gen_ed_category "
                          "WHERE catalog_year_id=?", (cy,))]
            out = []
            for r in con.execute(
                    "SELECT slot_type, rule FROM requirement_rule WHERE program_id=?",
                    (prog["id"],)):
                rule = json.loads(r["rule"])
                allow, deny = _advisor.advisor_sets(con, r["slot_type"], year, program=name)
                rule["advisor_courses"] = sorted(allow)
                rule["advisor_denies"] = sorted(deny)
                # AFTER the advisor merge: a curated advisor course is exactly
                # what rescues an otherwise-empty rule from being bogus.
                if is_bogus_rule(r["slot_type"], rule, gen_ed):
                    continue
                out.append({"slot_type": r["slot_type"], "rule": rule})
            return out
        finally:
            con.close()

    def get_gen_ed(self, year: str) -> list[dict]:
        con = self._con()
        try:
            cy = self._year_id(con, year)
            return [{"name": r["name"], "min_credits": r["min_credits"],
                     "rules": r["rules"],
                     "allowed_courses": json.loads(r["allowed_courses"] or "[]")}
                    for r in con.execute(
                        "SELECT name, min_credits, rules, allowed_courses FROM gen_ed_category "
                        "WHERE catalog_year_id=?", (cy,))]
        finally:
            con.close()

    def get_minors(self, year: str) -> list[str]:
        con = self._con()
        try:
            cy = self._year_id(con, year)
            return [r["name"] for r in con.execute(
                "SELECT name FROM program WHERE catalog_year_id=? AND kind='minor' ORDER BY name",
                (cy,))]
        finally:
            con.close()

    def get_course(self, code: str) -> dict | None:
        con = self._con()
        try:
            row = con.execute("SELECT * FROM course WHERE code=?", (code,)).fetchone()
            return dict(row) if row else None
        finally:
            con.close()
