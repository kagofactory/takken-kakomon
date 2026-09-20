(() => {
  "use strict";

  const el = (id) => document.getElementById(id);

  const view = {
    setup: el("view-setup"),
    quiz: el("view-quiz"),
    result: el("view-result"),
  };

  const examSelect = el("exam-select");
  const subjectSelect = el("subject-select");
  const startBtn = el("start-btn");
  const nextBtn = el("next-btn");
  const retryWrongBtn = el("retry-wrong-btn");
  const backSetupBtn = el("back-setup-btn");

  const quizSingle = el("quiz-single");
  const quizGroup = el("quiz-group");
  const nextGroupBtn = el("next-group-btn");

  let currentExamQuestions = [];
  let queue = [];          // 出題予定の問題（単問モード）またはグループ（4択実戦モード）配列
  let quizMode = "single";  // "single" | "group"
  let qIndex = 0;
  let score = 0;
  let history = [];        // 単問: {question, chosen, correct} / グループ: {group:true, g, spec, selected, correct}

  let currentGroupDivs = []; // 現在のグループ問題のDOM参照 [{item, div, label}]

  // ===== 続きから再開（localStorage） =====
  // この端末のブラウザだけに保存される。隙間時間に少しずつ進める人向けに、
  // 出題設定画面に「前回の続きから始める」を出す。
  const PROGRESS_KEY = "takken_progress_v1";

  function saveProgress() {
    try {
      const data = {
        examFile: examSelect.value,
        mode: quizMode,
        qIndex,
        score,
        queueIds: quizMode === "group"
          ? queue.map((g) => g.subject + "::" + g.baseNumber)
          : queue.map((q) => q.id),
        history: history.map((h) => (h.group
          ? { type: "group", groupKey: h.g.subject + "::" + h.g.baseNumber, selected: serializeSelected(h.selected), correct: h.correct }
          : { type: "single", questionId: h.question.id, chosen: h.chosen, correct: h.correct })),
        savedAt: Date.now(),
      };
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(data));
    } catch (e) {
      // localStorageが使えない環境（プライベートモード等）では黙って諦める
    }
  }

  function clearProgress() {
    try {
      localStorage.removeItem(PROGRESS_KEY);
    } catch (e) {}
  }

  function loadSavedProgress() {
    try {
      const raw = localStorage.getItem(PROGRESS_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function serializeSelected(selected) {
    if (selected && typeof selected === "object") return { itemId: selected.id };
    return { count: selected };
  }

  function showView(name) {
    Object.values(view).forEach((v) => v.classList.add("hidden"));
    view[name].classList.remove("hidden");
  }

  // 新しい年度を先頭に、同一年度内は 権利関係→宅建業法→法令上の制限→税・その他 の順に並べる
  function sortExamsNewestFirst(exams) {
    const key = (e) => {
      const m = e.id.match(/^(?:h(\d+)|r(\d{4}))-s(\d)$/);
      if (!m) return [0, 9];
      const year = m[1] ? 1988 + Number(m[1]) : Number(m[2]);
      return [year, Number(m[3])];
    };
    return exams.slice().sort((a, b) => {
      const [ya, sa] = key(a);
      const [yb, sb] = key(b);
      return yb - ya || sa - sb;
    });
  }

  async function loadExamList() {
    const res = await fetch("data/exams.json");
    const exams = sortExamsNewestFirst(await res.json());
    examSelect.innerHTML = exams
      .map((e) => `<option value="${e.file}">${e.label}</option>`)
      .join("");

    const params = new URLSearchParams(location.search);
    const requestedExam = params.get("exam");
    const requestedMode = params.get("mode") === "group" ? "group" : "single";
    const requestedScope = params.get("scope") === "all" ? "all" : "current";
    const autostart = params.get("autostart") === "1";
    const validExam = requestedExam && exams.some((e) => e.file === requestedExam);
    if (validExam) {
      examSelect.value = requestedExam;
    }
    document.querySelector(`input[name="scope"][value="${requestedScope}"]`).checked = true;

    await loadExamQuestions(examSelect.value);

    if (validExam && autostart) {
      document.querySelector(`input[name="mode"][value="${requestedMode}"]`).checked = true;
      const { mode, list } = buildQueue();
      if (list.length > 0) {
        startQuiz(mode, list);
        return;
      }
    }

    if (validExam) {
      el("setup-range-card").scrollIntoView({ behavior: "smooth", block: "start" });
    }

    const saved = loadSavedProgress();
    if (saved && saved.qIndex < saved.queueIds.length) {
      const savedExam = exams.find((e) => e.file === saved.examFile);
      if (savedExam) renderResumeCard(saved, savedExam);
    }
  }

  function renderResumeCard(saved, savedExam) {
    el("resume-card-text").textContent =
      `${savedExam.label}（${saved.qIndex}/${saved.queueIds.length}問まで進行中、正解${saved.score}問）`;
    const pct = saved.queueIds.length > 0 ? Math.round((saved.qIndex / saved.queueIds.length) * 100) : 0;
    el("resume-progress-bar-fill").style.width = `${pct}%`;
    el("resume-card").classList.remove("hidden");
    el("resume-btn").onclick = () => resumeQuiz(saved);
  }

  async function resumeQuiz(saved) {
    examSelect.value = saved.examFile;
    await loadExamQuestions(saved.examFile);
    const groups = buildGroups(currentExamQuestions);
    const byId = new Map(currentExamQuestions.map((q) => [q.id, q]));

    queue = saved.mode === "group"
      ? saved.queueIds.map((k) => groups.find((g) => g.subject + "::" + g.baseNumber === k)).filter(Boolean)
      : saved.queueIds.map((id) => byId.get(id)).filter(Boolean);

    if (queue.length === 0 || saved.qIndex >= queue.length) {
      clearProgress();
      return;
    }

    quizMode = saved.mode;
    qIndex = saved.qIndex;
    score = saved.score;
    history = saved.history.map((h) => {
      if (h.type === "group") {
        const g = groups.find((x) => x.subject + "::" + x.baseNumber === h.groupKey);
        const spec = deriveQuestionSpec(g.items);
        const selected = h.selected.itemId
          ? g.items.find((it) => it.id === h.selected.itemId)
          : h.selected.count;
        return { group: true, g, spec, selected, correct: h.correct };
      }
      return { question: byId.get(h.questionId), chosen: h.chosen, correct: h.correct };
    });

    showView("quiz");
    quizSingle.classList.toggle("hidden", quizMode !== "single");
    quizGroup.classList.toggle("hidden", quizMode !== "group");
    renderQuestion();
  }

  async function loadExamQuestions(file) {
    const res = await fetch(file);
    currentExamQuestions = await res.json();
    populateSubjects(currentExamQuestions);
  }

  function populateSubjects(questions) {
    const seen = [];
    for (const q of questions) {
      if (!seen.includes(q.subject)) seen.push(q.subject);
    }
    const options = ['<option value="__all__">すべての科目（' + questions.length + '問）</option>']
      .concat(
        seen.map((s) => {
          const count = questions.filter((q) => q.subject === s).length;
          return `<option value="${s}">${s}（${count}問）</option>`;
        })
      );
    subjectSelect.innerHTML = options.join("");
  }

  examSelect.addEventListener("change", () => loadExamQuestions(examSelect.value));

  async function loadProgressStats() {
    try {
      const res = await fetch("data/exams.json");
      const exams = await res.json();
      let total = 0;
      for (const e of exams) {
        const r = await fetch(e.file);
        const items = await r.json();
        total += items.length;
      }
      el("progress-count").textContent = `収録問題数: ${total}問`;
    } catch (e) {
      el("progress-count").textContent = "";
    }
  }

  // 「問12-C」のようなnumberを [12, "C"] に分解して自然順ソートするためのキー抽出
  function numberSortKey(numberStr) {
    const m = String(numberStr).match(/^問(\d+)(?:-([A-E]))?/);
    if (!m) return [Number.MAX_SAFE_INTEGER, numberStr];
    return [Number(m[1]), m[2] || ""];
  }

  function compareByNumber(a, b) {
    const [an, al] = numberSortKey(a.number);
    const [bn, bl] = numberSortKey(b.number);
    if (an !== bn) return an - bn;
    return al < bl ? -1 : al > bl ? 1 : 0;
  }

  function updateQuizProgressBar() {
    const pct = queue.length > 0 ? Math.round((qIndex / queue.length) * 100) : 0;
    el("quiz-progress-bar-fill").style.width = `${pct}%`;
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function buildGroups(list) {
    const groups = new Map();
    const order = [];
    for (const q of list) {
      const m = q.number.match(/^(問\d+)-([A-Eａ-ｅ])$/);
      if (!m) continue; // A〜E形式でない問題（例外的なデータ）はグループ化対象外
      const key = q.subject + "::" + m[1];
      if (!groups.has(key)) {
        groups.set(key, { subject: q.subject, baseNumber: m[1], items: [] });
        order.push(key);
      }
      groups.get(key).items.push(q);
    }
    return order
      .map((k) => groups.get(k))
      .filter((g) => g.items.length >= 2)
      .map((g) => {
        g.items.sort((a, b) => a.number.localeCompare(b.number, "ja"));
        return g;
      });
  }

  function buildQueue() {
    const subject = subjectSelect.value;
    const order = document.querySelector('input[name="order"]:checked').value;
    const mode = document.querySelector('input[name="mode"]:checked').value;

    const currentOnly = document.querySelector('input[name="scope"]:checked').value === "current";
    const isCurrentLaw = (q) => !q.law_status || q.law_status === "valid";

    let list = subject === "__all__"
      ? currentExamQuestions.slice()
      : currentExamQuestions.filter((q) => q.subject === subject);

    if (mode === "group") {
      let groupList = buildGroups(list);
      // 4択実戦は4肢の正誤の組合せで形式を判定するため、1肢でも改正済みなら問全体を除外する
      if (currentOnly) groupList = groupList.filter((g) => g.items.every(isCurrentLaw));
      if (order === "random") {
        groupList = shuffle(groupList);
      } else {
        groupList = groupList.slice().sort((a, b) => numberSortKey(a.items[0].number)[0] - numberSortKey(b.items[0].number)[0]);
      }
      return { mode, list: groupList };
    }

    if (currentOnly) list = list.filter(isCurrentLaw);

    if (order === "random") {
      list = shuffle(list);
    } else {
      list = list.slice().sort(compareByNumber);
    }
    return { mode, list };
  }

  function startQuiz(mode, list) {
    quizMode = mode;
    queue = list;
    qIndex = 0;
    score = 0;
    history = [];
    showView("quiz");
    quizSingle.classList.toggle("hidden", mode !== "single");
    quizGroup.classList.toggle("hidden", mode !== "group");
    saveProgress();
    renderQuestion();
  }

  startBtn.addEventListener("click", () => {
    const { mode, list } = buildQueue();
    if (list.length === 0) {
      alert("この条件に当てはまる問題がありません。範囲や出題する肢の設定を変えてください。");
      return;
    }
    startQuiz(mode, list);
  });

  function renderQuestion() {
    if (quizMode === "group") {
      renderGroupQuestion();
    } else {
      renderSingleQuestion();
    }
  }

  function renderSingleQuestion() {
    const q = queue[qIndex];
    el("quiz-progress").textContent = `${qIndex + 1} / ${queue.length} 問`;
    updateQuizProgressBar();
    el("quiz-score").textContent = `正解 ${score} 問`;
    el("q-subject").textContent = q.subject;
    el("q-number").textContent = `問題 ${q.number}`;
    el("q-text").textContent = q.text;

    const choicesEl = el("q-choices");
    choicesEl.innerHTML = "";
    q.choices.forEach((c) => {
      const btn = document.createElement("button");
      btn.className = "choice-btn";
      btn.textContent = `${c.num}　${c.text}`;
      btn.dataset.num = c.num;
      btn.addEventListener("click", () => selectChoice(q, c.num, btn));
      choicesEl.appendChild(btn);
    });

    el("q-feedback").classList.add("hidden");
    el("q-law-status").classList.add("hidden");
    el("q-explanation").classList.add("hidden");
    el("q-review-status").classList.add("hidden");
    nextBtn.classList.add("hidden");
  }

  const REVIEW_STATUS_LABEL = {
    ai_unreviewed: "AI生成・専門家未レビュー",
    expert_reviewed: "宅建士レビュー済み",
  };

  function renderReviewStatus(q) {
    const box = el("q-review-status");
    if (!q.review_status) {
      box.classList.add("hidden");
      return;
    }
    const label = REVIEW_STATUS_LABEL[q.review_status] || q.review_status;
    const mailBody = encodeURIComponent(`問題ID: ${q.id}\n指摘内容:\n`);
    box.innerHTML = `<span class="review-badge review-badge--${q.review_status}">${label}</span>` +
      `<a class="report-link" href="mailto:kagofactory@gmail.com?subject=${encodeURIComponent("誤りの報告：" + q.id)}&body=${mailBody}">誤りを報告する</a>`;
    box.classList.remove("hidden");
  }

  // 「valid」（現行法で有効）は多数派で毎回表示すると埋没するため、あえて何も表示しない。
  // 表示するのは「例外」（法改正で答えが変わった／成立しない／未確認）だけにして、
  // 長年受からない受験者が現行法とのズレを一目で見落とさないようにする（ユーザー指示）。
  const LAW_STATUS_LABEL = {
    amended: "⚠ 法改正により内容が変更されています",
    repealed: "⚠ 法改正により現在は成立しない設問です",
    unverified: "現行法との照合が未確認",
  };

  function renderLawStatus(q) {
    const box = el("q-law-status");
    if (!q.law_status || q.law_status === "valid" || !LAW_STATUS_LABEL[q.law_status]) {
      box.classList.add("hidden");
      return;
    }
    box.className = `law-status law-status--${q.law_status}`;
    const label = LAW_STATUS_LABEL[q.law_status];
    box.innerHTML = `<strong>${label}</strong>${q.law_status_note ? `　${q.law_status_note}` : ""}`;
  }

  function selectChoice(q, chosenNum, btnEl) {
    const buttons = el("q-choices").querySelectorAll(".choice-btn");
    buttons.forEach((b) => (b.disabled = true));

    // 没問（出題ミスにより正解肢がなく、実施団体が受験者全員を正解として扱った設問。
    // 平成2年問17・平成3年問9・平成24年問48・令和4年問48等、数年おきに実例がある）は、
    // どの選択肢を選んでも実施団体の扱いに合わせて正解とする。
    const isCorrect = q.no_correct_answer ? true : chosenNum === q.answer;
    buttons.forEach((b) => {
      const n = Number(b.dataset.num);
      if (q.no_correct_answer) {
        if (n === chosenNum) b.classList.add("correct");
      } else if (n === q.answer) {
        b.classList.add("correct");
      } else if (n === chosenNum) {
        b.classList.add("wrong");
      }
    });

    const feedback = el("q-feedback");
    feedback.classList.remove("hidden", "is-correct", "is-wrong");
    feedback.classList.add(isCorrect ? "is-correct" : "is-wrong");
    feedback.textContent = q.no_correct_answer
      ? "この問題は出題ミス等により正解肢がなく、実施団体により受験者全員が正解として扱われました（解説を参照）。"
      : isCorrect
      ? "正解です。"
      : `不正解です。正解は ${q.answer} です。`;

    renderLawStatus(q);
    renderExplanation(q);
    renderReviewStatus(q);

    if (isCorrect) score++;
    history.push({ question: q, chosen: chosenNum, correct: isCorrect });

    el("quiz-score").textContent = `正解 ${score} 問`;
    nextBtn.classList.remove("hidden");
  }

  // 解説文の先頭「正しい。」「誤り。」と、末尾の「（確度中）」を本文から切り出す。
  // データは一貫してこの2パターンで書かれている（このプロジェクトの執筆規約）。
  function parseExplanationText(text) {
    let body = text;
    let verdict = null;
    const verdictMatch = body.match(/^(正しい|誤り)[。.]?\s*/);
    if (verdictMatch) {
      verdict = verdictMatch[1];
      body = body.slice(verdictMatch[0].length);
    }
    let isUncertain = false;
    const confMatch = body.match(/\s*（確度中）\s*$/);
    if (confMatch) {
      isUncertain = true;
      body = body.slice(0, confMatch.index);
    }
    return { verdict, isUncertain, body };
  }

  function renderExplanation(q) {
    const box = el("q-explanation");
    if (!q.explanation) {
      box.classList.add("hidden");
      return;
    }
    const { verdict, isUncertain, body } = parseExplanationText(q.explanation);

    const verdictEl = el("q-explanation-verdict");
    if (verdict) {
      verdictEl.textContent = verdict === "正しい" ? "○ 正しい" : "× 誤り";
      verdictEl.className = `explanation-verdict ${verdict === "正しい" ? "is-correct" : "is-wrong"}`;
    } else {
      verdictEl.className = "explanation-verdict hidden";
    }
    el("q-explanation-confidence").classList.toggle("hidden", !isUncertain);

    let text = body;
    if (q.law_reference_date) {
      text += `\n（法令基準日: ${q.law_reference_date}）`;
    }
    el("q-explanation-text").textContent = text;

    const articlesEl = el("q-explanation-articles");
    articlesEl.innerHTML = "";
    (q.related_articles || []).forEach((a) => {
      const li = document.createElement("li");
      li.textContent = a;
      articlesEl.appendChild(li);
    });
    if (q.verification_note) {
      const li = document.createElement("li");
      li.className = "verification-note";
      li.textContent = q.verification_note;
      articlesEl.appendChild(li);
    }

    box.classList.remove("hidden");
  }

  nextBtn.addEventListener("click", () => {
    qIndex++;
    if (qIndex >= queue.length) {
      showResult();
    } else {
      saveProgress();
      renderQuestion();
    }
  });

  // ===== 4択実戦モード =====
  // データは各肢の正誤（○/×）のみを持ち、元の出題形式（「正しいものはどれか」か
  // 「誤っているものはどれか」か）の情報を持たないため、実際の正誤分布から
  // 単一正解形式の問題を自動生成する。これにより本試験と同じ「答えは1つ」の形式になる。
  function deriveQuestionSpec(items) {
    const correctItems = items.filter((it) => it.answer === 1);
    const wrongItems = items.filter((it) => it.answer === 2);

    if (correctItems.length === 1) {
      return { type: "select-correct", prompt: "次の記述のうち、正しいものはどれか。", correctItem: correctItems[0] };
    }
    if (wrongItems.length === 1) {
      return { type: "select-wrong", prompt: "次の記述のうち、誤っているものはどれか。", correctItem: wrongItems[0] };
    }
    return { type: "count", prompt: "次の記述のうち、正しいものはいくつあるか。", correctCount: correctItems.length, total: items.length };
  }

  let currentGroupSpec = null;
  let currentSelectedOption = null; // 選択中の値（itemオブジェクト or 数値）

  function renderGroupQuestion() {
    const g = queue[qIndex];
    currentGroupDivs = [];
    currentSelectedOption = null;

    el("quiz-progress").textContent = `${qIndex + 1} / ${queue.length} 問`;
    updateQuizProgressBar();
    el("quiz-score").textContent = `正解 ${score} 問`;
    el("g-subject").textContent = g.subject;
    el("g-number").textContent = g.baseNumber;

    const spec = deriveQuestionSpec(g.items);
    currentGroupSpec = spec;
    el("g-prompt").textContent = spec.prompt;

    // 「正しいものはどれか／誤っているものはどれか」型は、肢の文章そのものが選択肢になる
    // （読んでその場でクリックできるよう、下に別の選択ボタンを並べない）。
    // 「いくつあるか」型だけは文章に紐づかないので、下に個数ボタンを別途用意する。
    const clickable = spec.type !== "count";

    const wrap = el("g-statements");
    wrap.innerHTML = "";

    g.items.forEach((item) => {
      const label = (item.number.split("-")[1] || "").toUpperCase();

      const div = document.createElement("div");
      div.className = clickable ? "statement statement-selectable" : "statement";

      const head = document.createElement("div");
      head.className = "statement-head";
      const labelSpan = document.createElement("span");
      labelSpan.className = "statement-label";
      labelSpan.textContent = label;
      const textP = document.createElement("p");
      textP.className = "statement-text";
      textP.textContent = item.text;
      head.appendChild(labelSpan);
      head.appendChild(textP);
      div.appendChild(head);

      if (clickable) {
        div.addEventListener("click", () => finalizeGroupAnswer(item, div));
      }

      wrap.appendChild(div);
      currentGroupDivs.push({ item, div, label });
    });

    const optionsWrap = el("g-options");
    optionsWrap.innerHTML = "";
    optionsWrap.classList.toggle("hidden", clickable);

    if (!clickable) {
      for (let n = 0; n <= spec.total; n++) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "toggle-btn group-option-btn";
        btn.textContent = `${n}個`;
        btn.addEventListener("click", () => finalizeGroupAnswer(n, btn));
        optionsWrap.appendChild(btn);
      }
    }

    el("g-feedback").classList.add("hidden");
    el("g-explanation").classList.add("hidden");
    nextGroupBtn.classList.add("hidden");
  }

  // 選択と同時に採点する（肢別モードと同じく、クリック＝即回答）
  function finalizeGroupAnswer(value, pickedEl) {
    if (pickedEl.classList.contains("locked")) return;
    currentSelectedOption = value;

    const spec = currentGroupSpec;
    const clickable = spec.type !== "count";
    const isCorrect = spec.type === "count"
      ? value === spec.correctCount
      : value === spec.correctItem;

    if (spec.type === "count") {
      const optionsWrap = el("g-options");
      optionsWrap.querySelectorAll(".group-option-btn").forEach((b, idx) => {
        b.classList.add("locked");
        b.disabled = true;
        if (idx === spec.correctCount) b.classList.add("correct");
        else if (b === pickedEl) b.classList.add("wrong");
      });
    }

    // 各肢には○×の印だけ付ける（文章自体はそのまま、クリック前の見た目をなるべく崩さない）。
    // 解説は肢ごとにここへ吊り下げず、下の「解答・解説」に1か所へまとめる（本の解答ページのイメージ）。
    const explanationList = el("g-explanation-list");
    explanationList.innerHTML = "";

    currentGroupDivs.forEach(({ item, div, label }) => {
      const isItemCorrect = item.answer === 1;
      const wasPicked = clickable && div === pickedEl;
      div.classList.add(isItemCorrect ? "is-correct" : "is-wrong", "locked");
      if (wasPicked) div.classList.add("user-picked");

      const markSpan = document.createElement("span");
      markSpan.className = `statement-answer-mark ${isItemCorrect ? "is-correct" : "is-wrong"}`;
      markSpan.textContent = isItemCorrect ? "○ 正しい" : "× 誤り";
      if (wasPicked) markSpan.textContent += "（あなたの回答）";
      div.querySelector(".statement-head").appendChild(markSpan);

      if (item.explanation) {
        const row = document.createElement("div");
        row.className = "group-explanation-row";
        const head = document.createElement("p");
        head.className = "group-explanation-row-head";
        head.textContent = `${label}（${isItemCorrect ? "○ 正しい" : "× 誤り"}）`;
        const parsed = parseExplanationText(item.explanation);
        if (parsed.isUncertain) {
          const badge = document.createElement("span");
          badge.className = "confidence-badge";
          badge.textContent = "確度中";
          head.appendChild(document.createTextNode(" "));
          head.appendChild(badge);
        }
        const body = document.createElement("p");
        body.className = "group-explanation-row-body";
        let text = parsed.body;
        if (item.law_reference_date) text += `\n（法令基準日: ${item.law_reference_date}）`;
        body.textContent = text;
        row.appendChild(head);
        if (item.law_status && item.law_status !== "valid" && LAW_STATUS_LABEL[item.law_status]) {
          const lawBox = document.createElement("div");
          lawBox.className = `law-status law-status--${item.law_status}`;
          lawBox.innerHTML = `<strong>${LAW_STATUS_LABEL[item.law_status]}</strong>${item.law_status_note ? `　${item.law_status_note}` : ""}`;
          row.appendChild(lawBox);
        }
        row.appendChild(body);
        explanationList.appendChild(row);
      }
    });
    el("g-explanation").classList.remove("hidden");

    if (isCorrect) score++;
    history.push({ group: true, g: queue[qIndex], spec, selected: currentSelectedOption, correct: isCorrect });

    el("quiz-score").textContent = `正解 ${score} 問`;
    const feedback = el("g-feedback");
    feedback.classList.remove("hidden", "is-correct", "is-wrong");
    feedback.classList.add(isCorrect ? "is-correct" : "is-wrong");
    const correctLabel = spec.type === "count"
      ? `${spec.correctCount}個`
      : currentGroupDivs.find((d) => d.item === spec.correctItem).label;
    feedback.textContent = isCorrect
      ? "正解です。"
      : `不正解です。正解は「${correctLabel}」です。`;

    nextGroupBtn.classList.remove("hidden");
  }

  nextGroupBtn.addEventListener("click", () => {
    qIndex++;
    if (qIndex >= queue.length) {
      showResult();
    } else {
      saveProgress();
      renderGroupQuestion();
    }
  });

  function showResult() {
    clearProgress(); // 最後まで解き終えたので「続きから」は不要
    showView("result");
    const total = history.length;
    el("result-score").textContent = `${total} 問中 ${score} 問正解（正答率 ${Math.round((score / total) * 100)}%）`;

    const listEl = el("result-list");
    listEl.innerHTML = "";
    history.forEach((h) => {
      const item = document.createElement("div");
      if (h.group) {
        item.className = `result-item ${h.correct ? "ok" : "ng"}`;
        item.innerHTML = `<span>${h.g.baseNumber}（${h.g.subject}）</span><span>${h.correct ? "正解" : "不正解"}</span>`;
      } else {
        item.className = `result-item ${h.correct ? "ok" : "ng"}`;
        item.innerHTML = `<span>問題${h.question.number}（${h.question.subject}）</span><span>${h.correct ? "正解" : `不正解（正答:${h.question.answer}）`}</span>`;
      }
      listEl.appendChild(item);
    });

    retryWrongBtn.classList.toggle("hidden", history.every((h) => h.correct));
  }

  retryWrongBtn.addEventListener("click", () => {
    if (quizMode === "group") {
      const wrongGroups = history.filter((h) => !h.correct).map((h) => h.g);
      startQuiz("group", wrongGroups);
    } else {
      const wrong = history.filter((h) => !h.correct).map((h) => h.question);
      startQuiz("single", wrong);
    }
  });

  backSetupBtn.addEventListener("click", () => showView("setup"));

  loadExamList();
  loadProgressStats();
})();
