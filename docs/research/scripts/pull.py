import egs, pickle, time, sys
COLS=['id','gamename','brandname','sellday','median','count2','dlsite_id','dlsite_domain','model','okazu','erogame']
games={}
MAXID=41000; STEP=3000
for lo in range(1, MAXID, STEP):
    hi=lo+STEP-1
    sql=f"SELECT {','.join(COLS)} FROM gamelist WHERE id BETWEEN {lo} AND {hi} ORDER BY id"
    c,rows=egs.query(sql)
    for r in rows:
        d=dict(zip(c,r)); games[d['id']]=d
    print(f"  {lo}-{hi}: +{len(rows)} (total {len(games)})", flush=True)
    time.sleep(1.0)
pickle.dump(games, open('/tmp/egs/egs_games.pkl','wb'))
print("TOTAL EGS games pulled:", len(games))
