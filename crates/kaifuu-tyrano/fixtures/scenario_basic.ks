; tyranoscript synthetic scenario fixture (CC0) — authored for itotori KAIFUU-016
*start|オープニング
[eval exp="f.count=0"]
#アリス
[fadein time=500]こんにちは、世界。[l][r]
これは&f.count回目の挑戦です。[p]
[chara_ptext text="ボブ先生"]
やあ、アリス。準備はいい？[l]
どうしますか。
[link target=*yes]はい、始めます[endlink]
[glink text="いいえ、まだです" target=*no]
[button text="あとで決める" target=*maybe]
[jump target=*start storage=next.ks]
[if exp="f.count>0"]
もう一度挑戦しますか。[p]
[endif]
[[これは括弧のリテラル]] とテキスト。[cm]
