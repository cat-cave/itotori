import pickle
from collections import Counter, defaultdict
d=pickle.load(open('/tmp/vndb/analysis.pkl','rb'))
results,vn=d['results'],d['vn']
agg=defaultdict(Counter)
overall=Counter(); known=0; unknown=0
for vid,(en,st) in results.items():
    v=vn[vid]
    if v['olang']!='ja': continue
    overall[st]+=1
    if en: known+=1; agg[en][st]+=1; agg[en]['TOTAL']+=1
    else: unknown+=1

print("=== OVERALL Japanese-origin VN opportunity sizing ===")
tot=sum(overall.values())
print(f"Total JP-origin VNs: {tot}")
for k in ['UNTRANSLATED','MTL_ONLY','PARTIAL','TL_TRIAL','TL_FAN','TL_OFFICIAL']:
    print(f"  {k:<14}{overall[k]:>6}  ({100*overall[k]/tot:.1f}%)")
print(f"engine known: {known}  unknown/null: {unknown}")
opp=overall['UNTRANSLATED']+overall['MTL_ONLY']+overall['PARTIAL']+overall['TL_TRIAL']
print(f"TOTAL OPPORTUNITY (no complete human EN): {opp} ({100*opp/tot:.1f}%)")

print("\n=== TOOLING-MATURITY PROXY: already-translated rate per engine ===")
print(f"{'engine':<20}{'total':>6}{'transl':>7}{'tl%':>6}  (TL = fan-complete + official)")
for en,c in sorted(agg.items(),key=lambda kv:-kv[1]['TOTAL'])[:24]:
    tl=c['TL_FAN']+c['TL_OFFICIAL']
    print(f"{en:<20}{c['TOTAL']:>6}{tl:>7}{100*tl/c['TOTAL']:>5.0f}%")
