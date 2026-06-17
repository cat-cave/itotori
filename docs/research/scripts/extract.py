import pickle
d=pickle.load(open('/tmp/vndb/analysis.pkl','rb'))
results,vn,vtitle=d['results'],d['vn'],d['vtitle']

def title(vid): return (vtitle.get(vid,'?') or '?')[:46]
# devstatus 0=finished
def finished(vid): return vn[vid]['devstatus']=='0'

rows=[]
for vid,(en,st) in results.items():
    v=vn[vid]
    if v['olang']!='ja': continue
    rows.append((vid,en,st,v['votes'],v['rating']))

def show(title_str, items, n=20):
    print(f"\n=== {title_str} ===")
    print(f"{'vid':<8}{'rating':>6}{'votes':>7}  {'engine':<16} title")
    for vid,en,st,votes,rating in items[:n]:
        print(f"{vid:<8}{rating/100:>6.2f}{votes:>7}  {str(en):<16.16} {title(vid)}")

# 1. Most-wanted UNTRANSLATED (by popularity = votecount), finished
untl=[r for r in rows if r[2]=='UNTRANSLATED' and finished(r[0])]
show("TOP UNTRANSLATED JP VNs by popularity (votecount)", sorted(untl,key=lambda r:-r[3]))

# 2. High-rated UNTRANSLATED hidden gems (rating>=750 i.e 7.5, votes>=80)
gems=[r for r in untl if r[4]>=750 and r[3]>=80]
show("HIGH-RATED UNTRANSLATED gems (rating>=7.5, votes>=80) by rating", sorted(gems,key=lambda r:-r[4]), 25)

# 3. MTL_ONLY benchmark candidates (have machine TL we can compare against), by popularity
mtl=[r for r in rows if r[2]=='MTL_ONLY' and finished(r[0])]
show("MTL-ONLY (benchmark targets — existing machine TL) by votes", sorted(mtl,key=lambda r:-r[3]))

# 4. PARTIAL benchmark candidates (incomplete human TL)
part=[r for r in rows if r[2]=='PARTIAL' and finished(r[0])]
show("PARTIAL human TL (incomplete — benchmark/finish candidates) by votes", sorted(part,key=lambda r:-r[3]))

# 5. Per-engine top untranslated for Kaifuu-relevant engines
for target in ['KiriKiri','TyranoScript','NScripter','LiveMaker','RPG Maker','Wolf RPG Editor','SiglusEngine','BGI/Ethornell','Majiro','CatSystem2','YU-RIS','Artemis Engine']:
    items=sorted([r for r in untl if r[1]==target],key=lambda r:-r[3])
    show(f"TOP UNTRANSLATED — {target}", items, 8)
