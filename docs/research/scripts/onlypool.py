import pickle, statistics
from collections import Counter
egs=pickle.load(open('egs_games.pkl','rb'))
m=pickle.load(open('vndb_egs_map.pkl','rb')); egs2vn=m['egs2vn']
only=set(egs)-set(egs2vn)
def sc(g):
    try:return int(g['median']) if g['median'] not in (None,'','\\N') else None
    except:return None
def vt(g):
    try:return int(g['count2']) if g['count2'] not in (None,'') else 0
    except:return 0

# Top EGS-only DLsite games by JP audience (score, min votes)
rows=[]
for i in only:
    g=egs[i]
    if not g.get('dlsite_id'): continue
    s=sc(g); v=vt(g)
    if s is None or v<20: continue
    rows.append((s,v,g['dlsite_id'],g.get('dlsite_domain'),g['gamename'][:40]))
rows.sort(reverse=True)
print(f"=== TOP EGS-ONLY (VNDB-missing) DLsite games by JP median score (votes>=20): {len(rows)} qualify ===")
print(f"{'med':>4}{'votes':>6}  {'RJ':<12}{'dom':<8} title")
for s,v,rj,dom,t in rows[:30]:
    print(f"{s:>4}{v:>6}  {('RJ'+rj):<12}{str(dom):<8} {t}")

# size of EGS-only DLsite pool by score availability
scored=[r for r in rows]
allonlydl=[i for i in only if egs[i].get('dlsite_id')]
print(f"\nEGS-only DLsite total: {len(allonlydl)} ; with median & >=20 votes: {len(rows)}")
yr=Counter((egs[i]['sellday'] or '?')[:4] for i in allonlydl)
print("EGS-only DLsite by release year (top):", dict(sorted(yr.items(),reverse=True)[:8]))
