# -*- coding: utf-8 -*-
"""law_status が valid の肢のうち、法改正で前提が変わっている可能性が高いものを候補として洗い出す。
使い方: python scripts/check_law_status.py [年度接頭辞 例: h20 h19] （省略時は全データ）
候補は「要確認」であり、amended確定ではない。人が読んで判断する。"""
import json, re, sys, glob, os

# (名称, パターン, この年より前の試験年度にのみ適用) 試験年度は法令基準日（その年の4月1日）で判定する
RULES = [
    ("債権法改正(令2.4施行)", r"瑕疵担保|時効の中断|時効が中断|中断する|連帯債務|連帯保証|保証債務|法定利率|債権譲渡|錯誤|詐害行為|敷金|原状回復|危険負担|代物弁済|第三者の弁済|存続期間|20年を超え", 2020),
    ("相続法・遺留分(令1.7/令2.4施行)", r"遺留分|減殺|配偶者居住|自筆証書|寄与分|特別受益|相続放棄", 2020),
    ("成年年齢・婚姻(令4.4施行)", r"未成年|成年に達|婚姻|成年被後見人|20歳|二十歳|18歳", 2022),
    ("盛土規制法(令5.5施行)", r"宅地造成等規制法|宅地造成工事規制区域|造成宅地防災区域", 2024),
    ("IT重説・電子契約(令4.5施行)", r"押印|記名押印|電磁的|IT重説", 2022),
    ("名称変更・登録(平27)", r"取引主任者証|専任の取引主任者", 1),  # 名称のみは対象外（参考表示せず）
]

def exam_year(base):
    m = re.match(r"h(\d+)-", base)
    if m:
        return 1988 + int(m.group(1))
    m = re.match(r"r(\d{4})-", base)
    return int(m.group(1)) if m else 9999

def main():
    prefixes = sys.argv[1:]
    files = sorted(glob.glob(os.path.join(os.path.dirname(__file__), "..", "data", "*.json")))
    total = 0
    per_year = {}
    for f in files:
        base = os.path.basename(f)
        if base in ("exams.json", "sample.json"):
            continue
        if prefixes and not any(base.startswith(p) for p in prefixes):
            continue
        year = base.split("-")[0]
        for d in json.load(open(f, encoding="utf-8")):
            if d.get("law_status", "valid") != "valid":
                continue
            body = d["text"] + d.get("explanation", "") + d.get("law_tag", "")
            hits = [name for name, pat, cut in RULES if exam_year(base) < cut and re.search(pat, body)]
            if not hits:
                continue
            total += 1
            per_year.setdefault(year, []).append((d["id"], hits))
    for y in sorted(per_year):
        print(f"{y}: {len(per_year[y])}件")
        if prefixes:
            for i, h in per_year[y]:
                print("   ", i, "/".join(h))
    print("合計候補:", total)

if __name__ == "__main__":
    main()
