import urllib.request, urllib.parse, html.parser, time, sys

ENDPOINTS = [
    "https://erogamescape.dyndns.org/~ap2/ero/toukei_kaiseki/sql_for_erogamer_form.php",
    "https://erogamescape.dmm.co.jp/~ap2/ero/toukei_kaiseki/sql_for_erogamer_form.php",
]

class TableParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_main=False; self.depth=0
        self.cols=[]; self.rows=[]; self.cur=[]; self.cap=False; self.buf=''
        self.in_th=False; self.in_td=False; self.in_tr=False
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if tag=='div' and a.get('id')=='query_result_main': self.in_main=True
        if not self.in_main: return
        if tag=='tr': self.cur=[]; self.in_tr=True
        if tag=='th': self.in_th=True; self.buf=''
        if tag=='td': self.in_td=True; self.buf=''
    def handle_endtag(self,tag):
        if tag=='div' and self.in_main and self.depth==0:
            pass
        if not self.in_main: return
        if tag=='th': self.cols.append(self.buf.strip()); self.in_th=False
        if tag=='td': self.cur.append(self.buf.strip()); self.in_td=False
        if tag=='tr' and self.in_tr:
            if self.cur: self.rows.append(self.cur)
            self.in_tr=False
        if tag=='div' and self.in_main: self.in_main=False
    def handle_data(self,d):
        if self.in_th or self.in_td: self.buf+=d

def query(sql, retries=3):
    body=urllib.parse.urlencode({"sql":sql}).encode()
    last=None
    for ep in ENDPOINTS:
        for attempt in range(retries):
            try:
                req=urllib.request.Request(ep, data=body, headers={
                    "Content-Type":"application/x-www-form-urlencoded",
                    "User-Agent":"research-join/1.0"})
                with urllib.request.urlopen(req, timeout=60) as r:
                    htmltext=r.read().decode('utf-8','replace')
                p=TableParser(); p.feed(htmltext)
                if not p.cols and 'エラー' in htmltext:
                    raise RuntimeError("SQL error: "+htmltext[:300])
                return p.cols, p.rows
            except Exception as e:
                last=e; time.sleep(2)
    raise last

if __name__=='__main__':
    cols,rows=query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='gamelist' ORDER BY ordinal_position")
    print("gamelist columns:", cols)
    for r in rows: print("  ", r)
