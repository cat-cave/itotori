# Build VNDB<->EGS id mapping from the VNDB dump.
# EGS links live on RELEASES (releases_extlinks -> extlinks site='egs'), not VNs.
# Path: EGS game id <-> VNDB release <-> VN (releases_vn).
import pickle
from collections import defaultdict
DB='/tmp/vndb/db/'
egs_ext={}
for line in open(DB+'extlinks',encoding='utf-8'):
    p=line.rstrip('\n').split('\t')
    if len(p)>=3 and p[1]=='egs': egs_ext[p[0]]=p[2]
rel2egs=defaultdict(set)
for line in open(DB+'releases_extlinks',encoding='utf-8'):
    p=line.rstrip('\n').split('\t')
    if len(p)>=2 and p[1] in egs_ext: rel2egs[p[0]].add(egs_ext[p[1]])
egs2vn=defaultdict(set); vn2egs=defaultdict(set)
for line in open(DB+'releases_vn',encoding='utf-8'):
    p=line.rstrip('\n').split('\t')
    if len(p)>=2 and p[0] in rel2egs:
        for g in rel2egs[p[0]]: egs2vn[g].add(p[1]); vn2egs[p[1]].add(g)
pickle.dump({'egs2vn':{k:list(v) for k,v in egs2vn.items()},
            'vn2egs':{k:list(v) for k,v in vn2egs.items()}}, open('/tmp/egs/vndb_egs_map.pkl','wb'))
print("egs ids linked:",len(egs2vn)," vns linked:",len(vn2egs))
