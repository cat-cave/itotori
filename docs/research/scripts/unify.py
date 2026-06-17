import pickle
from collections import Counter, defaultdict

egs=pickle.load(open('egs_games.pkl','rb'))            # egs id(str)-> dict
m=pickle.load(open('vndb_egs_map.pkl','rb'))
egs2vn=m['egs2vn']                                      # egs id -> [vn ids]
van=pickle.load(open('/tmp/vndb/analysis.pkl','rb'))   # results, vn, vtitle
results,vn,vtitle=van['results'],van['vn'],van['vtitle']

def egs_score(g):
    try: return int(g['median']) if g['median'] not in (None,'','\\N') else None
    except: return None
def egs_votes(g):
    try: return int(g['count2']) if g['count2'] not in (None,'') else 0
    except: return 0
def has_dlsite(g): return bool(g.get('dlsite_id'))

linked=set(egs2vn)                                      # egs ids known to VNDB
egs_ids=set(egs.keys())
only_egs = egs_ids - linked

print("=== CATALOG OVERLAP ===")
print(f"EGS total games:            {len(egs_ids)}")
print(f"  linked to a VNDB release: {len(egs_ids & linked)}")
print(f"  EGS-ONLY (no VNDB link):  {len(only_egs)}")
print(f"VNDB VNs total:             {len(vn)}  (JP-origin {sum(1 for v in vn.values() if v['olang']=='ja')})")

def dl(ids): return sum(1 for i in ids if has_dlsite(egs[i]))
print("\n=== THE VNDB-MISSING POOL (EGS-only) ===")
print(f"EGS-only games:                 {len(only_egs)}")
print(f"  with DLsite id:               {dl(only_egs)}")
print(f"  with >=1 EGS score (count2>0): {sum(1 for i in only_egs if egs_votes(egs[i])>0)}")
# dlsite_domain split for EGS-only
dom=Counter(egs[i].get('dlsite_domain') or '(none)' for i in only_egs if has_dlsite(egs[i]))
print("  dlsite_domain of EGS-only DLsite games:", dict(dom.most_common(8)))

print("\n=== DLsite coverage: who has the RJ codes? ===")
egs_dl=set(i for i in egs_ids if has_dlsite(egs[i]))
print(f"EGS games with dlsite_id:       {len(egs_dl)}")
print(f"  of those, EGS-only:           {len(egs_dl & only_egs)}  <- DLsite indie pool invisible to VNDB")
print(f"  of those, also in VNDB:       {len(egs_dl & linked)}")

# Attach EGS score to VNDB engine/TL universe (JP VNs)
print("\n=== ENGINE x EGS-SCORE (JP VNs linked to EGS) — does EGS corroborate engine ranks? ===")
eng_scores=defaultdict(list)
for g,vns in egs2vn.items():
    if g not in egs: continue
    s=egs_score(egs[g])
    if s is None: continue
    for vid in vns:
        v=vn.get(vid)
        if not v or v['olang']!='ja': continue
        en,st=results[vid]
        if en: eng_scores[en].append(s)
print(f"{'engine':<20}{'n(scored)':>10}{'medianEGS':>10}")
import statistics
for en,ss in sorted(eng_scores.items(), key=lambda kv:-len(kv[1]))[:14]:
    print(f"{en:<20}{len(ss):>10}{statistics.median(ss):>10.0f}")

# Candidate upgrade: high EGS-score UNTRANSLATED JP VNs (EGS = JP-audience signal)
print("\n=== HIGH JP-AUDIENCE (EGS median) UNTRANSLATED JP VNs, engine known ===")
cands=[]
for g,vns in egs2vn.items():
    if g not in egs: continue
    s=egs_score(egs[g]); nv=egs_votes(egs[g])
    if s is None or nv<30: continue
    for vid in vns:
        v=vn.get(vid)
        if not v or v['olang']!='ja': continue
        en,st=results[vid]
        if st=='UNTRANSLATED' and en:
            cands.append((s,nv,en,vid,vtitle.get(vid,'?')[:42]))
seen=set();out=[]
for c in sorted(cands,reverse=True):
    if c[3] in seen: continue
    seen.add(c[3]); out.append(c)
print(f"{'egsMed':>6}{'votes':>6}  {'engine':<16} title")
for s,nv,en,vid,t in out[:25]:
    print(f"{s:>6}{nv:>6}  {en:<16.16} {t}")
