from gc_advisor.audit.wildcards import SlotContext, counts, capped_depts

SPECIALTY_WC = [
    {"type": "dept_any", "dept": "ENGR"},
    {"type": "dept_level_min", "dept": "CPSC", "min": 2000},
    {"type": "dept_capped", "depts": ["BIOL", "CH", "PHYS"], "cap_credits": 4},
    {"type": "subject_pattern", "subject": "GC", "number_glob": "37XX", "allow": True},
]
TECH_WC = [
    {"type": "subject_nonrequired", "subject": "GC", "number_exclude": "37XX",
     "deny": ["GC 3610"], "allow_except": ["GC 3720"]},
]

def _ctx(explicit=(), wildcards=(), allow=(), deny=(), required=()):
    return SlotContext(set(explicit), list(wildcards), set(allow), set(deny), set(required))

def test_explicit_counts():
    assert counts("ART 1030", _ctx(explicit=["ART 1030"]))

def test_dept_any_counts():
    assert counts("ENGR 1410", _ctx(wildcards=SPECIALTY_WC))

def test_dept_level_min_boundary():
    ctx = _ctx(wildcards=SPECIALTY_WC)
    assert counts("CPSC 2120", ctx)
    assert not counts("CPSC 1010", ctx)

def test_capped_dept_counts_membership():
    assert counts("BIOL 1030", _ctx(wildcards=SPECIALTY_WC))
    assert capped_depts(_ctx(wildcards=SPECIALTY_WC)) == ({"BIOL", "CH", "PHYS"}, 4)

def test_subject_pattern_allow():
    assert counts("GC 3730", _ctx(wildcards=SPECIALTY_WC))

def test_glob_boundaries():
    ctx = _ctx(wildcards=SPECIALTY_WC)   # subject_pattern GC 37XX allow
    assert counts("GC 3700", ctx)        # lower edge of 37XX
    assert counts("GC 3799", ctx)        # upper edge of 37XX
    assert not counts("GC 3699", ctx)    # just below
    assert not counts("GC 3800", ctx)    # just above
    assert not counts("GC 370", ctx)     # length mismatch (3 digits vs 4-char glob)

def test_dept_level_min_exact_boundary():
    ctx = _ctx(wildcards=SPECIALTY_WC)   # dept_level_min CPSC 2000
    assert counts("CPSC 2000", ctx)      # exactly at the minimum counts
    assert not counts("CPSC 1999", ctx)  # one below does not

def test_advisor_allow_and_deny():
    assert counts("MKT 4290", _ctx(allow=["MKT 4290"]))
    # deny wins even over explicit
    assert not counts("ART 1030", _ctx(explicit=["ART 1030"], deny=["ART 1030"]))

def test_tech_nonrequired_counts_non_required_gc():
    ctx = _ctx(wildcards=TECH_WC, required=["GC 1040", "GC 2040"])
    assert counts("GC 4080", ctx)          # a non-required GC course
    assert not counts("GC 1040", ctx)      # plan-required → excluded

def test_tech_excludes_37xx_but_allows_3720():
    ctx = _ctx(wildcards=TECH_WC)
    assert not counts("GC 3700", ctx)      # 37XX excluded
    assert counts("GC 3720", ctx)          # allow_except re-includes
    assert not counts("GC 3610", ctx)      # explicit deny


def test_level_min_matches_any_department_at_or_above_the_level():
    """Management's Support Area (all four years) is `@ 3000:4999` — ANY
    subject at 3000+. dept_level_min needs a specific department; level_min
    is the any-department form."""
    ctx = SlotContext(explicit=set(),
                      wildcards=[{"type": "level_min", "min": 3000}])
    assert counts("PHIL 3010", ctx)
    assert counts("WFB 4990", ctx)
    assert not counts("PHIL 2990", ctx)
    assert not counts("MGT 1010", ctx)
