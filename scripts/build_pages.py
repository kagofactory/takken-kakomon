#!/usr/bin/env python3
"""
data/*.json から、問題1件ごとに静的HTMLページを生成するビルドスクリプト。

目的: 今までは1枚のindex.html内でJavaScriptがデータを読み込む方式だったため、
検索エンジンから見ると「どの年度・どの問題を検索しても同じURL」という状態だった。
これでは「宅建 過去問 令和7年 権利関係 問1」のようなロングテール検索から
個別の問題ページへ直接誘導できない。

このスクリプトは、各問題を検索エンジンがそのままインデックスできる実体のある
HTMLファイルとして書き出す（問題文・選択肢・正解・解説・法改正ステータスを
サーバーサイドで完結した形で埋め込み、JavaScriptなしで内容が読める）。
あわせて演習アプリ（index.html）への導線も張る。

sample.json（デモ用）はnoindexにして、実データのみを検索対象にする。

`C:\\Users\\allin\\sharoushi-kakomon`（社労士過去問ラボ）をベースに複製・改修。

使い方:
    python build_pages.py
    (data/exams.json を読み、data/*.json を全て処理して q/ 以下に出力する)
"""
import json
import re
import glob
import os
import sys
from collections import defaultdict

sys.stdout.reconfigure(encoding="utf-8")

SITE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(SITE_ROOT, "data")
OUT_DIR = os.path.join(SITE_ROOT, "q")
SUBJECTS_OUT_DIR = os.path.join(SITE_ROOT, "subjects")
SITE_URL = "https://takken-kakomon.com"
SITE_NAME = "宅建過去問ラボ"

# 科目インデックス（rYYYY-sN の N）は宅建試験の4分野に対応
SUBJECT_META = [
    ("s0", "権利関係（民法・借地借家法・区分所有法・不動産登記法等）"),
    ("s1", "宅建業法"),
    ("s2", "法令上の制限（都市計画法・建築基準法・国土利用計画法等）"),
    ("s3", "税・その他（税法・地価公示法・需給関係・土地建物）"),
]

# 「valid」（現行法で有効、多数派）は毎回表示すると埋没するため描画しない。
# 長年受からない受験者が最も見落としやすい「法改正で答えが変わった／成立しない」設問を
# 一目で分かるようにする（ユーザー指示、2026年9月13日）ため、例外だけをアイコン付きで強調する。
LAW_STATUS_LABEL = {
    "amended": "⚠ 法改正により内容が変更されています",
    "repealed": "⚠ 法改正により現在は成立しない設問です",
    "unverified": "現行法との照合が未確認",
}

REVIEW_STATUS_LABEL = {
    "ai_unreviewed": "AI生成・専門家未レビュー",
    "expert_reviewed": "宅建士レビュー済み",
}

CONTACT_EMAIL = "kagofactory@gmail.com"


def esc(s):
    if s is None:
        return ""
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def short_exam_label(exam_label):
    """タイトルタグ用に、末尾の（完全収録・50肢）等の収録状況注記を取り除いた短い表記を作る"""
    return re.sub(r"（[^（）]*）\s*$", "", exam_label).strip()


def exam_round_year(exam_label):
    """「第◯回（令和◯年度）」部分だけを取り出す（科目名を含む部分と重複させたくない場面用）"""
    m = re.match(r"^(第\d+回（[^）]+）)", exam_label)
    return m.group(1) if m else exam_label


def slug_of(item_id, exam_id):
    """id から exam_id の接頭辞を取り除いたものをファイル名に使う"""
    if item_id.startswith(exam_id + "-"):
        return item_id[len(exam_id) + 1:]
    return item_id


def render_choice(c, answer_num):
    is_correct = answer_num is not None and c["num"] == answer_num
    cls = "choice correct" if is_correct else "choice"
    mark = " ✓" if is_correct else ""
    return f'<li class="{cls}">{esc(c["text"])}{mark}</li>'


def render_no_correct_answer_notice(item):
    """没問（出題ミスにより正解肢がなく、実施団体が受験者全員を正解として扱った設問）の注記。
    平成2年問17・平成3年問9・平成24年問48・令和4年問48等、宅建試験では数年おきに実例がある
    （CLAUDE.md参照）。本アプリでも実施団体の扱いに合わせ、どの選択肢を選んでも正解として採点する
    （js/app.js の no_correct_answer 分岐）。静的ページ側は特定の選択肢に✓を付けず、この注記のみで示す。"""
    if not item.get("no_correct_answer"):
        return ""
    note = item.get("no_correct_answer_note", "")
    return f'''
    <div class="law-status law-status--repealed">
      <strong>⚠ この問題は出題ミス等により正解肢がなく、実施団体により受験者全員が正解として扱われました</strong>{("　" + esc(note)) if note else ""}
    </div>'''


def render_law_status(item):
    status = item.get("law_status")
    if not status or status == "valid" or status not in LAW_STATUS_LABEL:
        return ""
    label = LAW_STATUS_LABEL[status]
    note = item.get("law_status_note", "")
    return f'''
    <div class="law-status law-status--{esc(status)}">
      <strong>{esc(label)}</strong>{("　" + esc(note)) if note else ""}
    </div>'''


def render_review_status(item):
    status = item.get("review_status")
    if not status:
        return ""
    label = REVIEW_STATUS_LABEL.get(status, status)
    verified = item.get("last_verified", "")
    subject = f"誤りの報告：{item['id']}"
    body = f"問題ID: {item['id']}%0A指摘内容:%0A"
    mailto = f"mailto:{CONTACT_EMAIL}?subject={subject}&body={body}"
    return f'''
    <div class="review-status">
      <span class="review-badge review-badge--{esc(status)}">{esc(label)}{f"（{esc(verified)}時点）" if verified else ""}</span>
      <a class="report-link" href="{mailto}">誤りを報告する</a>
    </div>'''


def parse_explanation_text(text):
    """解説文の先頭「正しい。」「誤り。」と、末尾の「（確度中）」を本文から切り出す
    （js/app.js の parseExplanationText と同じ規約）"""
    body = text
    verdict = None
    m = re.match(r"^(正しい|誤り)[。.]?\s*", body)
    if m:
        verdict = m.group(1)
        body = body[m.end():]
    is_uncertain = False
    m = re.search(r"\s*（確度中）\s*$", body)
    if m:
        is_uncertain = True
        body = body[:m.start()]
    return verdict, is_uncertain, body


def render_explanation(item):
    exp = item.get("explanation")
    if not exp:
        return '<p class="q-pending">解説は準備中です。</p>'
    verdict, is_uncertain, body = parse_explanation_text(exp)

    head_html = ""
    if verdict or is_uncertain:
        parts = []
        if verdict:
            cls = "is-correct" if verdict == "正しい" else "is-wrong"
            label = "○ 正しい" if verdict == "正しい" else "× 誤り"
            parts.append(f'<span class="explanation-verdict {cls}">{label}</span>')
        if is_uncertain:
            parts.append('<span class="confidence-badge">確度中</span>')
        head_html = f'<div class="explanation-head">{"".join(parts)}</div>'

    ref_date = item.get("law_reference_date")
    exp_text = esc(body) + (f"<br><small>（法令基準日: {esc(ref_date)}）</small>" if ref_date else "")

    articles = item.get("related_articles") or []
    lis = "".join(f"<li>{esc(a)}</li>" for a in articles)
    note = item.get("verification_note")
    if note:
        lis += f'<li class="verification-note">{esc(note)}</li>'
    articles_html = f'<ul class="articles">{lis}</ul>' if lis else ""

    return f'{head_html}<p>{exp_text}</p>{articles_html}'


PAGE_TMPL = """<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{description}">
<link rel="canonical" href="{canonical}">
{robots_tag}
<meta property="og:type" content="article">
<meta property="og:site_name" content="宅建過去問ラボ">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:url" content="{canonical}">
<meta property="og:image" content="{og_image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="ja_JP">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{description}">
<meta name="twitter:image" content="{og_image}">
<link rel="stylesheet" href="{css_path}">
<script type="application/ld+json">
{jsonld}
</script>
<script type="application/ld+json">
{breadcrumb_jsonld}
</script>
</head>
<body>

<header class="site-header">
  <h1><a href="{root_path}index.html">宅建過去問ラボ</a></h1>
</header>

<main>
  <nav class="breadcrumb">
    <a href="{root_path}index.html">トップ</a> &gt;
    <a href="{exam_index}">{exam_label}</a> &gt;
    {number}
  </nav>

  <div class="card">
    <div class="q-meta">
      <span class="badge">{subject}</span>
      <span class="q-number-label">{number}</span>
    </div>
    <p class="q-text">{text}</p>

    <ul class="choices-static">
      {choices_html}
    </ul>
{law_status_html}
    <div class="explanation">
      <h3>解説</h3>
      {explanation_html}
    </div>
{review_status_html}
    <p class="source-note">出典: {source}</p>
  </div>

  <div class="card note-card">
    <p>
      解説は<b>AI（生成AI）が条文・通達等をもとに作成した下書きで、宅地建物取引士など専門家によるレビューを
      経ていません。</b>内容の正確性を保証するものではなく、法的助言でもありません。
      誤りに気づいた場合は上の「誤りを報告する」からご連絡ください。
      <b>本サイトは受験対策のための学習教材であり、個別の不動産取引・法律相談を行うものではありません。</b>
      実際の不動産取引・法律問題については、宅地建物取引士・弁護士等の専門家にご相談ください。
    </p>
  </div>

  <p class="q-actions">
    <a class="btn-primary" href="{root_path}index.html">この年度・分野を演習する →</a>
  </p>
</main>

<footer class="site-footer">
  <p>出典: 宅地建物取引士資格試験（<a href="https://www.retio.or.jp/exam/" target="_blank" rel="noopener">一般財団法人不動産適正取引推進機構</a>）／ 非公式の個人学習用サイトです。解説は独自作成・専門家未レビュー。</p>
  <p class="footer-links"><a href="{root_path}terms.html">利用規約</a> ・ <a href="{root_path}privacy.html">プライバシーポリシー</a> ・ <a href="{root_path}updates.html">更新履歴</a></p>
</footer>

</body>
</html>
"""


def build_question_page(item, exam_label, noindex=False):
    answer_num = None if item.get("no_correct_answer") else item["answer"]
    choices_html = "\n      ".join(
        render_choice(c, answer_num) for c in item["choices"]
    )
    plain_text = re.sub(r"\s+", " ", item["text"]).strip()
    description = (plain_text[:110] + "…") if len(plain_text) > 110 else plain_text

    canonical = f"{SITE_URL}/q/{item['exam']}/{slug_of(item['id'], item['exam'])}.html"
    exam_id = item["exam"]
    round_year = exam_round_year(exam_label)

    jsonld = {
        "@context": "https://schema.org",
        "@type": "QAPage",
        "mainEntity": {
            "@type": "Question",
            "name": plain_text,
            "text": plain_text,
            "acceptedAnswer": {
                "@type": "Answer",
                "text": item.get("explanation") or "解説準備中",
            },
        },
    }

    breadcrumb_jsonld = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "トップ", "item": f"{SITE_URL}/index.html"},
            {"@type": "ListItem", "position": 2, "name": exam_label, "item": f"{SITE_URL}/q/{exam_id}/index.html"},
            {"@type": "ListItem", "position": 3, "name": item["number"]},
        ],
    }

    return PAGE_TMPL.format(
        title=f"{esc(item['subject'])} {esc(item['number'])}の過去問・解説｜{esc(round_year)} - 宅建過去問ラボ",
        description=esc(description),
        canonical=canonical,
        robots_tag='<meta name="robots" content="noindex">' if noindex else "",
        og_image=f"{SITE_URL}/images/og-image.png",
        css_path="../../css/style.css",
        jsonld=json.dumps(jsonld, ensure_ascii=False, indent=2),
        breadcrumb_jsonld=json.dumps(breadcrumb_jsonld, ensure_ascii=False, indent=2),
        root_path="../../",
        exam_index="index.html",
        exam_label=esc(exam_label),
        number=esc(item["number"]),
        subject=esc(item["subject"]),
        text=esc(item["text"]),
        choices_html=choices_html,
        law_status_html=render_no_correct_answer_notice(item) + render_law_status(item),
        explanation_html=render_explanation(item),
        review_status_html=render_review_status(item),
        source=esc(item.get("source", "")),
    )


INDEX_TMPL = """<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{short_label}の過去問一覧・解説｜宅建過去問ラボ</title>
<meta name="description" content="{exam_label}の過去問一覧。問題ごとに解説・法改正ステータス付きで確認できます。">
<link rel="stylesheet" href="../../css/style.css">
</head>
<body>
<header class="site-header">
  <h1><a href="../../index.html">宅建過去問ラボ</a></h1>
</header>
<main>
  <div class="card">
    <h2>{exam_label}</h2>
    <ul class="question-list">
      {items_html}
    </ul>
  </div>
</main>
<footer class="site-footer">
  <p>非公式の個人学習用サイトです。</p>
  <p class="footer-links"><a href="../../terms.html">利用規約</a> ・ <a href="../../privacy.html">プライバシーポリシー</a> ・ <a href="../../updates.html">更新履歴</a></p>
</footer>
</body>
</html>
"""


def build_exam_index(exam_id, exam_label, items):
    lis = "\n      ".join(
        f'<li><a href="{slug_of(it["id"], exam_id)}.html">{esc(it["number"])} {esc(it["subject"])}</a></li>'
        for it in items
    )
    return INDEX_TMPL.format(exam_label=esc(exam_label), short_label=esc(short_exam_label(exam_label)), items_html=lis)


SUBJECT_TMPL = """<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{subject_name}の過去問一覧・解説｜宅建過去問ラボ</title>
<meta name="description" content="宅建試験「{subject_name}」の過去問を年度別に一覧。{year_count}年度分・{total_items}肢を収録。年度ごとに問題を見る、または演習を始めることができます。">
<link rel="canonical" href="{canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="宅建過去問ラボ">
<meta property="og:title" content="{subject_name}の過去問一覧・解説｜宅建過去問ラボ">
<meta property="og:description" content="宅建試験「{subject_name}」の過去問を年度別に一覧。{year_count}年度分・{total_items}肢を収録。">
<meta property="og:url" content="{canonical}">
<meta property="og:image" content="{og_image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="ja_JP">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{subject_name}の過去問一覧・解説｜宅建過去問ラボ">
<meta name="twitter:description" content="宅建試験「{subject_name}」の過去問を年度別に一覧。{year_count}年度分・{total_items}肢を収録。">
<meta name="twitter:image" content="{og_image}">
<link rel="stylesheet" href="../css/style.css">
<script type="application/ld+json">
{breadcrumb_jsonld}
</script>
</head>
<body>
<header class="site-header">
  <h1><a href="../index.html">宅建過去問ラボ</a></h1>
</header>
<main>
  <nav class="breadcrumb"><a href="../index.html">トップ</a> &gt; {subject_name}</nav>
  <div class="card">
    <h2>{subject_name}</h2>
    <p class="source-note">{year_count}年度分・{total_items}肢を収録</p>
    <ul class="question-list subject-year-list">
      {rows_html}
    </ul>
  </div>
</main>
<footer class="site-footer">
  <p>非公式の個人学習用サイトです。</p>
  <p class="footer-links"><a href="../terms.html">利用規約</a> ・ <a href="../privacy.html">プライバシーポリシー</a> ・ <a href="../updates.html">更新履歴</a></p>
</footer>
</body>
</html>
"""


def build_subject_page(subject_key, subject_name, rows):
    total_items = sum(r["item_count"] for r in rows)
    row_lis = "\n      ".join(
        f'<li class="subject-year-row">'
        f'<span class="subject-year-label">{esc(r["year_label"])}（{r["item_count"]}肢）</span>'
        f'<a class="btn-secondary" href="../q/{r["exam_id"]}/index.html">問題を見る</a>'
        f'<a class="btn-primary" href="../index.html?exam={r["file"]}&mode=single&autostart=1">肢別で解く →</a>'
        f'<a class="btn-primary" href="../index.html?exam={r["file"]}&mode=group&autostart=1">4択で解く →</a>'
        f'</li>'
        for r in rows
    )
    breadcrumb_jsonld = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "トップ", "item": f"{SITE_URL}/index.html"},
            {"@type": "ListItem", "position": 2, "name": subject_name},
        ],
    }
    return SUBJECT_TMPL.format(
        subject_name=esc(subject_name),
        year_count=len(rows),
        total_items=total_items,
        breadcrumb_jsonld=json.dumps(breadcrumb_jsonld, ensure_ascii=False, indent=2),
        canonical=f"{SITE_URL}/subjects/{subject_key}.html",
        og_image=f"{SITE_URL}/images/og-image.png",
        rows_html=row_lis,
    )


def main():
    exams_path = os.path.join(DATA_DIR, "exams.json")
    with open(exams_path, encoding="utf-8") as f:
        exams = json.load(f)

    sitemap_urls = [f"{SITE_URL}/index.html"]
    subject_rows = defaultdict(list)  # "sN" -> [{exam_id, year_label, item_count, file}]

    for exam in exams:
        exam_id = exam["id"]
        is_sample = exam_id == "sample"
        data_path = os.path.join(SITE_ROOT, exam["file"])
        with open(data_path, encoding="utf-8") as f:
            items = json.load(f)

        exam_out_dir = os.path.join(OUT_DIR, exam_id)
        os.makedirs(exam_out_dir, exist_ok=True)

        for item in items:
            html = build_question_page(item, exam["label"], noindex=is_sample)
            out_path = os.path.join(exam_out_dir, f"{slug_of(item['id'], exam_id)}.html")
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(html)
            if not is_sample:
                sitemap_urls.append(f"{SITE_URL}/q/{exam_id}/{slug_of(item['id'], exam_id)}.html")

        index_html = build_exam_index(exam_id, exam["label"], items)
        with open(os.path.join(exam_out_dir, "index.html"), "w", encoding="utf-8") as f:
            f.write(index_html)
        if not is_sample:
            sitemap_urls.append(f"{SITE_URL}/q/{exam_id}/index.html")

        print(f"{exam_id}: {len(items)}ページ生成{'（noindex）' if is_sample else ''}")

        if not is_sample:
            m_round = re.match(r"^(第\d+回（[^）]+）)", exam["label"])
            year_label = m_round.group(1) if m_round else exam_id
            m_s = re.search(r"-(s\d)$", exam_id)
            if m_s:
                subject_rows[m_s.group(1)].append({
                    "exam_id": exam_id,
                    "year_label": year_label,
                    "item_count": len(items),
                    "file": exam["file"],
                })

    # 分野別カテゴリページ（subjects/sN.html）
    os.makedirs(SUBJECTS_OUT_DIR, exist_ok=True)
    for subject_key, subject_name in SUBJECT_META:
        rows = sorted(subject_rows.get(subject_key, []), key=lambda r: r["exam_id"], reverse=True)
        html = build_subject_page(subject_key, subject_name, rows)
        with open(os.path.join(SUBJECTS_OUT_DIR, f"{subject_key}.html"), "w", encoding="utf-8") as f:
            f.write(html)
        sitemap_urls.append(f"{SITE_URL}/subjects/{subject_key}.html")
        total_items = sum(r["item_count"] for r in rows)
        print(f"subjects/{subject_key}.html: {subject_name}（{len(rows)}年度・{total_items}肢）")

    # sitemap.xml
    urlset = "\n".join(f"  <url><loc>{u}</loc></url>" for u in sitemap_urls)
    sitemap = f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{urlset}\n</urlset>\n'
    with open(os.path.join(SITE_ROOT, "sitemap.xml"), "w", encoding="utf-8") as f:
        f.write(sitemap)

    # robots.txt
    robots = f"User-agent: *\nAllow: /\nSitemap: {SITE_URL}/sitemap.xml\n"
    with open(os.path.join(SITE_ROOT, "robots.txt"), "w", encoding="utf-8") as f:
        f.write(robots)

    print(f"\nsitemap.xml: {len(sitemap_urls)}件のURL")
    print("robots.txt を書き出しました")


if __name__ == "__main__":
    main()
