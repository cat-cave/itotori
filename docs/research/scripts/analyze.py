import json
from collections import defaultdict, Counter

DB='/tmp/vndb/db/'
def rows(t):
    for line in open(DB+t,encoding='utf-8'):
        yield line.rstrip('\n').split('\t')
N='\\N'

# engines id->name
eng={r[0]:r[1] for r in rows('engines') if len(r)>=2}

# releases: id -> dict
rel={}
for r in rows('releases'):
    if len(r)<25: continue
    rid=r[0]
    rel[rid]=dict(olang=r[2], released=r[3], minage=r[7], has_ero=r[16]=='t',
                  patch=r[17]=='t', official=r[20]=='t', engine=r[24])

# releases_titles: rid -> {lang: mtl_bool}
rlang=defaultdict(dict)
for r in rows('releases_titles'):
    if len(r)<3: continue
    rlang[r[0]][r[1]] = (r[2]=='t')

# releases_vn: vid -> list of (rid, rtype)
vrel=defaultdict(list)
for r in rows('releases_vn'):
    if len(r)<3: continue
    vrel[r[1]].append((r[0], r[2]))

# vn: id -> dict
vn={}
for r in rows('vn'):
    if len(r)<12: continue
    try: votes=int(r[4]); rating=int(r[5]) if r[5]!=N else 0
    except: votes,rating=0,0
    vn[r[0]]=dict(olang=r[3], votes=votes, rating=rating, devstatus=r[9])

# vn_titles: pick display title (prefer en latin/title, else romaji latin, else any)
vtitle={}
vtitle_alt=defaultdict(dict)
for r in rows('vn_titles'):
    if len(r)<5: continue
    vid,lang,official,title,latin=r[0],r[1],r[2],r[3],r[4]
    disp = latin if latin!=N else title
    vtitle_alt[vid][lang]=disp
for vid,d in vtitle_alt.items():
    vtitle[vid]= d.get('en') or d.get('ja') or next(iter(d.values()))

# ---- classify each VN ----
def classify(vid):
    rels=vrel.get(vid,[])
    # engine: most common non-null engine among releases (prefer non-patch)
    ecnt=Counter(); ecnt_all=Counter()
    en_entries=[]  # (mtl, rtype, patch, official)
    langs_any=set()
    for rid,rtype in rels:
        rr=rel.get(rid)
        if not rr: continue
        e=rr['engine']
        if e!=N:
            ecnt_all[e]+=1
            if not rr['patch']: ecnt[e]+=1
        ls=rlang.get(rid,{})
        langs_any.update(ls.keys())
        if 'en' in ls:
            en_entries.append((ls['en'], rtype, rr['patch'], rr['official']))
    engine = (ecnt.most_common(1) or ecnt_all.most_common(1) or [(None,0)])[0][0]
    engine_name = eng.get(engine) if engine else None
    # EN status
    if not en_entries:
        status='UNTRANSLATED'
    else:
        human=[e for e in en_entries if not e[0]]
        has_off_complete=any((not m) and rt=='complete' and off for (m,rt,pa,off) in en_entries)
        has_complete=any((not m) and rt=='complete' for (m,rt,pa,off) in en_entries)
        has_partial=any((not m) and rt=='partial' for (m,rt,pa,off) in en_entries)
        if has_off_complete: status='TL_OFFICIAL'
        elif has_complete: status='TL_FAN'
        elif not human: status='MTL_ONLY'      # every EN release is MTL
        elif has_partial: status='PARTIAL'
        else: status='TL_TRIAL'                 # EN only in trial
    return engine_name, status

results={}
for vid in vn:
    results[vid]=classify(vid)

# ---- aggregate by engine (Japanese-origin VNs only) ----
STAT=['UNTRANSLATED','MTL_ONLY','PARTIAL','TL_TRIAL','TL_FAN','TL_OFFICIAL']
agg=defaultdict(lambda: Counter())
for vid,(en,st) in results.items():
    v=vn[vid]
    if v['olang']!='ja': continue
    if not en: continue
    agg[en][st]+=1
    agg[en]['TOTAL']+=1

def opp(c):  # opportunity = untranslated + mtl_only + partial + trial
    return c['UNTRANSLATED']+c['MTL_ONLY']+c['PARTIAL']+c['TL_TRIAL']

print("=== ENGINE PREVALENCE & EN-LOCALIZATION GAP (Japanese-origin VNs, engine known) ===")
print(f"{'engine':<22}{'total':>6}{'untl':>6}{'mtl':>5}{'part':>5}{'trial':>6}{'fanTL':>6}{'offTL':>6}{'opp%':>6}")
for en,c in sorted(agg.items(), key=lambda kv: -kv[1]['TOTAL'])[:28]:
    o=opp(c)
    print(f"{en:<22}{c['TOTAL']:>6}{c['UNTRANSLATED']:>6}{c['MTL_ONLY']:>5}{c['PARTIAL']:>5}{c['TL_TRIAL']:>6}{c['TL_FAN']:>6}{c['TL_OFFICIAL']:>6}{100*o/c['TOTAL']:>5.0f}%")

# overall totals
tot=Counter()
for c in agg.values():
    for k,v in c.items(): tot[k]+=v
print("\n=== TOTAL (ja VNs, engine known) ===")
print({k:tot[k] for k in ['TOTAL']+STAT})

# save full results for candidate extraction
import pickle
pickle.dump(dict(results=results, vn=vn, vtitle=vtitle, agg=dict(agg)), open('/tmp/vndb/analysis.pkl','wb'))
print("\nsaved /tmp/vndb/analysis.pkl")
