const els = {
  totalQuestions: document.getElementById('totalQuestions'),
  correctCount: document.getElementById('correctCount'),
  wrongCount: document.getElementById('wrongCount'),
  reviewCount: document.getElementById('reviewCount'),
  parseInfo: document.getElementById('parseInfo'),
  fileInput: document.getElementById('fileInput'),
  reloadButton: document.getElementById('reloadButton'),
  autoNextButton: document.getElementById('autoNextButton'),
  rawInput: document.getElementById('rawInput'),
  loadTextButton: document.getElementById('loadTextButton'),
  heroCard: document.getElementById('heroCard'),
  questionCard: document.getElementById('questionCard'),
  emptyState: document.getElementById('emptyState'),
  questionBadge: document.getElementById('questionBadge'),
  sourceBadge: document.getElementById('sourceBadge'),
  progressText: document.getElementById('progressText'),
  promptText: document.getElementById('promptText'),
  optionList: document.getElementById('optionList'),
  submitRow: document.getElementById('submitRow'),
  submitButton: document.getElementById('submitButton'),
  clearSelectionButton: document.getElementById('clearSelectionButton'),
  prevButton: document.getElementById('prevButton'),
  nextButton: document.getElementById('nextButton'),
  feedback: document.getElementById('feedback'),
};

const state = {
  questions: [],
  pendingNew: [],
  reviewQueue: [],
  pendingWrong: new Set(),
  current: null,
  currentIndex: -1,
  currentSource: 'new',
  turn: 0,
  correct: 0,
  wrong: 0,
  reviewSolved: 0,
  waitingForMulti: false,
  selectedLetters: new Set(),
  isLocked: false,
  history: [],
  historyPos: -1,
  lastShownIndex: -1,
  answeredCurrent: false,
  lastAnswerSelected: [],
  lastAnswerCorrect: false,
  questionStates: {},
  autoNextEnabled: false,
  autoNextTimer: null,
};

const SESSION_STORAGE_KEY = 'quiznet.study.session.v1';

function normalizeNewlines(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function htmlToText(fragment) {
  const normalized = normalizeNewlines(fragment)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<[^>]+>/g, '');

  const temp = document.createElement('textarea');
  temp.innerHTML = normalized;
  return temp.value;
}

function extractAnswerKey(answerChunk) {
  const plain = htmlToText(answerChunk)
    .replace(/\u00a0/g, ' ')
    .trim();

  const lines = plain.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const normalized = line.replace(/[^A-Za-z]/g, '');
    if (normalized && /^[A-Za-z]+$/.test(normalized)) {
      return normalized.toUpperCase().split('');
    }
  }

  const fallback = plain.match(/[A-Za-z]+/);
  return fallback ? fallback[0].toUpperCase().split('') : [];
}

function parseQuestionBlock(block) {
  const text = /<[^>]+>/.test(block) ? htmlToText(block) : block;
  const normalizedText = text.replace(/(\S)\s+([A-Ha-h])(?:[\.)]|:)\s+/g, '$1\n$2. ');
  const lines = normalizeNewlines(normalizedText)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const options = [];
  const questionLines = [];
  let activeOption = null;
  const optionPattern = /^([A-Ha-h])(?:[\.)]|:)\s*(.+)$/;

  function detectOptionLine(line) {
    const punctuatedMatch = line.match(optionPattern);
    if (punctuatedMatch) {
      return punctuatedMatch;
    }

    const looseMatch = line.match(/^([A-Ha-h])\s+(.+)$/);
    if (looseMatch) {
      const body = looseMatch[2].trim();
      if (/^[A-ZÀ-Ỵ"“'(\d]/u.test(body)) {
        return [looseMatch[0], looseMatch[1], body];
      }
    }

    return null;
  }

  for (const line of lines) {
    const optionMatch = detectOptionLine(line);
    if (optionMatch) {
      const label = optionMatch[1].toUpperCase();
      const body = optionMatch[2].trim();
      activeOption = { label, text: body };
      options.push(activeOption);
      continue;
    }

    if (options.length > 0 && activeOption) {
      activeOption.text = `${activeOption.text} ${line}`.trim();
    } else {
      questionLines.push(line);
    }
  }

  const prompt = questionLines.join(' ').replace(/\s+/g, ' ').trim();
  return { prompt, options };
}

function parseQuestions(rawText) {
  const source = normalizeNewlines(rawText);
  const entries = [];
  let cursor = 0;

  while (true) {
    const markerIndex = source.indexOf('@@@', cursor);
    if (markerIndex === -1) {
      break;
    }

    const answerEnd = source.indexOf('###', markerIndex + 3);
    const questionChunk = source.slice(cursor, markerIndex).trim();
    const answerChunk = answerEnd === -1 ? source.slice(markerIndex + 3).trim() : source.slice(markerIndex + 3, answerEnd).trim();
    cursor = answerEnd === -1 ? source.length : answerEnd + 3;

    if (!questionChunk) {
      continue;
    }

    const parsed = parseQuestionBlock(questionChunk);
    const answer = extractAnswerKey(answerChunk);

    if (parsed.prompt && parsed.options.length > 0 && answer.length > 0) {
      const uniqueCorrect = [...new Set(answer)];
      entries.push({
        prompt: parsed.prompt,
        options: parsed.options,
        answer: uniqueCorrect,
        answerText: uniqueCorrect.join(''),
        source: questionChunk.includes('<') ? 'html' : 'text',
      });
    }
  }

  return entries;
}

function shuffle(array) {
  const clone = [...array];
  for (let index = clone.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [clone[index], clone[swapIndex]] = [clone[swapIndex], clone[index]];
  }
  return clone;
}

function pickReviewDelay() {
  return 3 + Math.floor(Math.random() * 2);
}

function updateStats() {
  if (els.totalQuestions) els.totalQuestions.textContent = String(state.questions.length);
  if (els.correctCount) els.correctCount.textContent = String(state.correct);
  if (els.wrongCount) els.wrongCount.textContent = String(state.wrong);
  if (els.reviewCount) els.reviewCount.textContent = String(state.reviewQueue.length);
  // hide parse info UI (kept minimal per user request)
  if (els.parseInfo) els.parseInfo.textContent = '';
}

function serializeSession() {
  return {
    version: 1,
    questionCount: state.questions.length,
    pendingNew: [...state.pendingNew],
    reviewQueue: state.reviewQueue.map((item) => ({ ...item })),
    pendingWrong: [...state.pendingWrong],
    currentIndex: state.currentIndex,
    currentSource: state.currentSource,
    turn: state.turn,
    correct: state.correct,
    wrong: state.wrong,
    reviewSolved: state.reviewSolved,
    history: [...state.history],
    historyPos: state.historyPos,
    answeredCurrent: state.answeredCurrent,
    selectedLetters: [...state.selectedLetters],
    lastAnswerSelected: state.lastAnswerSelected || [],
    lastAnswerCorrect: Boolean(state.lastAnswerCorrect),
    questionStates: state.questionStates,
    autoNextEnabled: Boolean(state.autoNextEnabled),
  };
}

function saveSession() {
  if (state.questions.length === 0) {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }

  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(serializeSession()));
}

function clearSession() {
  localStorage.removeItem(SESSION_STORAGE_KEY);
}

function restoreSession() {
  const raw = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) {
    return false;
  }

  try {
    const saved = JSON.parse(raw);
    if (!saved || saved.version !== 1 || saved.questionCount !== state.questions.length) {
      return false;
    }

    state.pendingNew = Array.isArray(saved.pendingNew) ? saved.pendingNew.filter((value) => Number.isInteger(value)) : [];
    state.reviewQueue = Array.isArray(saved.reviewQueue)
      ? saved.reviewQueue
          .filter((item) => item && Number.isInteger(item.questionIndex) && Number.isInteger(item.dueTurn))
          .map((item) => ({ questionIndex: item.questionIndex, dueTurn: item.dueTurn }))
      : [];
    state.pendingWrong = new Set(Array.isArray(saved.pendingWrong) ? saved.pendingWrong.filter((value) => Number.isInteger(value)) : []);
    state.currentIndex = Number.isInteger(saved.currentIndex) ? saved.currentIndex : -1;
    state.currentSource = saved.currentSource === 'review' ? 'review' : 'new';
    state.turn = Number.isInteger(saved.turn) ? saved.turn : 0;
    state.correct = Number.isInteger(saved.correct) ? saved.correct : 0;
    state.wrong = Number.isInteger(saved.wrong) ? saved.wrong : 0;
    state.reviewSolved = Number.isInteger(saved.reviewSolved) ? saved.reviewSolved : 0;
    state.history = Array.isArray(saved.history) ? saved.history.filter((value) => Number.isInteger(value)) : [];
    state.historyPos = Number.isInteger(saved.historyPos) ? saved.historyPos : -1;
    state.answeredCurrent = Boolean(saved.answeredCurrent);
    state.selectedLetters = new Set(Array.isArray(saved.selectedLetters) ? saved.selectedLetters.filter((value) => typeof value === 'string') : []);
    state.lastAnswerSelected = Array.isArray(saved.lastAnswerSelected) ? saved.lastAnswerSelected.filter((value) => typeof value === 'string') : [];
    state.lastAnswerCorrect = Boolean(saved.lastAnswerCorrect);
    state.questionStates = saved.questionStates && typeof saved.questionStates === 'object' ? saved.questionStates : {};
    state.autoNextEnabled = Boolean(saved.autoNextEnabled);

    if (!Number.isInteger(state.currentIndex) || state.currentIndex < 0 || state.currentIndex >= state.questions.length) {
      return false;
    }

    state.current = state.questions[state.currentIndex];
    return true;
  } catch (error) {
    return false;
  }
}

function setVisibility(hasQuestion) {
  els.heroCard.classList.toggle('hidden', hasQuestion);
  els.questionCard.classList.toggle('hidden', !hasQuestion);
  els.emptyState.classList.toggle('hidden', hasQuestion || state.questions.length > 0);
}

function clearAutoNextTimer() {
  if (state.autoNextTimer) {
    clearTimeout(state.autoNextTimer);
    state.autoNextTimer = null;
  }
}

function updateAutoNextButton() {
  if (!els.autoNextButton) return;
  els.autoNextButton.classList.toggle('active', state.autoNextEnabled);
}

function applyAnsweredState(current, selected, isCorrect) {
  const normalizedSelected = normalizeAnswerSet(selected);
  const optionEls = Array.from(els.optionList.querySelectorAll('.option-button, .option-check'));

  optionEls.forEach((el) => {
    const letter = el.dataset ? el.dataset.letter : (el.querySelector('.option-key') && el.querySelector('.option-key').textContent.trim());
    if (!letter) return;
    const upper = String(letter).trim().toUpperCase();
    if (current.answer.includes(upper)) {
      el.classList.add('correct');
    }
    if (normalizedSelected.includes(upper) && !current.answer.includes(upper)) {
      el.classList.add('wrong');
    }
    el.disabled = true;
    el.querySelectorAll('input').forEach((input) => (input.disabled = true));
  });

  const chosenText = escapeHtml(normalizedSelected.join(', ') || 'không chọn');
  if (isCorrect) {
    showFeedback(true, `<strong>Đúng.</strong> Bạn có thể bấm Tiếp theo để sang câu khác.`, 'good');
  } else {
    showFeedback(false, `${revealCorrectAnswer(current)}<br /><strong>Bạn chọn:</strong> ${chosenText}.`, 'bad');
  }

  if (els.nextButton) els.nextButton.disabled = false;
  state.isLocked = true;
  state.answeredCurrent = true;
}

function saveQuestionState(questionIndex, selected, isCorrect) {
  state.questionStates[String(questionIndex)] = {
    selectedLetters: [...normalizeAnswerSet(selected)],
    isCorrect: Boolean(isCorrect),
    answered: true,
  };
}

function applyStoredQuestionState(questionIndex) {
  const stored = state.questionStates[String(questionIndex)];
  if (!stored || !stored.answered) {
    return false;
  }

  applyAnsweredState(state.questions[questionIndex], stored.selectedLetters || [], stored.isCorrect);
  state.lastAnswerSelected = [...(stored.selectedLetters || [])];
  state.lastAnswerCorrect = Boolean(stored.isCorrect);
  return true;
}

function formatQuestionIndex() {
  const newIndex = state.pendingNew.length > 0 ? state.pendingNew[0] + 1 : state.questions.length;
  return `${Math.min(state.turn + 1, state.questions.length)} / ${state.questions.length}`;
}

function renderQuestion(pushHistory = true) {
  if (!state.current) {
    setVisibility(false);
    return;
  }

  setVisibility(true);
  clearAutoNextTimer();
  state.isLocked = false;
  state.selectedLetters.clear();
  state.answeredCurrent = false;
  state.lastAnswerSelected = [];
  state.lastAnswerCorrect = false;

  const current = state.current;
  const questionNumber = state.currentIndex + 1;

  els.questionBadge.textContent = `Câu ${questionNumber}`;
  els.sourceBadge.textContent = state.currentSource === 'review' ? 'Ôn lại' : 'Câu mới';
  els.progressText.textContent = `${state.turn + 1} / ${state.questions.length}`;
  els.promptText.innerHTML = renderPrompt(current.prompt, current.answerText);
  els.optionList.innerHTML = '';
  els.feedback.className = 'feedback hidden';
  els.feedback.textContent = '';

  const isMulti = current.answer.length > 1;
  els.submitRow.classList.toggle('hidden', !isMulti);
  state.waitingForMulti = isMulti;

  current.options.forEach((option, index) => {
    if (isMulti) {
      const label = document.createElement('label');
      label.className = 'option-check';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = option.label;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          state.selectedLetters.add(option.label);
        } else {
          state.selectedLetters.delete(option.label);
        }
      });

      const key = document.createElement('span');
      key.className = 'option-key';
      key.textContent = option.label;

      const body = document.createElement('span');
      body.className = 'option-body';
      body.textContent = option.text;

      label.append(checkbox, key, body);
      els.optionList.appendChild(label);
      return;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'option-button';
    button.dataset.letter = option.label;

    const key = document.createElement('span');
    key.className = 'option-key';
    key.textContent = option.label;

    const body = document.createElement('span');
    body.className = 'option-body';
    body.textContent = option.text;

    button.append(key, body);
    button.addEventListener('click', () => handleAnswer([option.label]));
    els.optionList.appendChild(button);
  });

  if (isMulti) {
    els.submitButton.onclick = () => handleAnswer([...state.selectedLetters]);
    els.clearSelectionButton.onclick = clearSelections;
  }

  // push to history when showing a new question
  if (pushHistory) {
    // avoid duplicate consecutive entries
    if (state.historyPos === -1 || state.history[state.historyPos] !== state.currentIndex) {
      state.history.splice(state.historyPos + 1);
      state.history.push(state.currentIndex);
      state.historyPos = state.history.length - 1;
    }
  }

  // update nav buttons
  if (els.prevButton) els.prevButton.disabled = state.historyPos <= 0;
  if (els.nextButton) els.nextButton.disabled = true; // enabled after answering
  updateAutoNextButton();
  saveSession();
}

function renderPrompt(prompt, answerText) {
  const escaped = escapeHtml(prompt);
  const answerHint = answerText.length > 1 ? `<span class="tag">Chọn ${answerText.length} đáp án</span>` : '';
  return `${answerHint}${escaped}`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeAnswerSet(answer) {
  return [...new Set(answer.map((item) => String(item).trim().toUpperCase()).filter(Boolean))].sort();
}

function clearSelections() {
  state.selectedLetters.clear();
  els.optionList.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.checked = false;
  });
}

function scheduleReview(questionIndex) {
  const delay = pickReviewDelay();
  const dueTurn = state.turn + delay;
  const existing = state.reviewQueue.find((item) => item.questionIndex === questionIndex);
  if (existing) {
    existing.dueTurn = Math.max(existing.dueTurn, dueTurn);
    return;
  }

  state.reviewQueue.push({
    questionIndex,
    dueTurn,
  });
}

function removeReviewEntries(questionIndex) {
  state.reviewQueue = state.reviewQueue.filter((item) => item.questionIndex !== questionIndex);
}

function pullDueReview() {
  const dueIndices = [];
  const pending = [];

  for (const item of state.reviewQueue) {
    if (item.dueTurn <= state.turn) {
      dueIndices.push(item.questionIndex);
    } else {
      pending.push(item);
    }
  }

  state.reviewQueue = pending;
  if (dueIndices.length === 0) {
    return null;
  }

  const chosenIndex = dueIndices[Math.floor(Math.random() * dueIndices.length)];
  const stillPending = dueIndices.filter((index) => index !== chosenIndex).map((index) => ({ questionIndex: index, dueTurn: state.turn }));
  state.reviewQueue.push(...stillPending);
  return chosenIndex;
}

function pickNextQuestion() {
  const reviewIndex = pullDueReview();
  if (reviewIndex !== null) {
    state.currentIndex = reviewIndex;
    state.current = state.questions[reviewIndex];
    state.currentSource = 'review';
    return true;
  }

  if (state.pendingNew.length === 0) {
    if (state.reviewQueue.length > 0) {
      let earliestIndex = 0;
      for (let index = 1; index < state.reviewQueue.length; index += 1) {
        if (state.reviewQueue[index].dueTurn < state.reviewQueue[earliestIndex].dueTurn) {
          earliestIndex = index;
        }
      }

      const [nextReview] = state.reviewQueue.splice(earliestIndex, 1);
      state.currentIndex = nextReview.questionIndex;
      state.current = state.questions[nextReview.questionIndex];
      state.currentSource = 'review';
      return true;
    }

    state.current = null;
    state.currentIndex = -1;
    return false;
  }

  const nextIndex = state.pendingNew.shift();
  state.currentIndex = nextIndex;
  state.current = state.questions[nextIndex];
  state.currentSource = 'new';
  return true;
}

function showFeedback(isCorrect, message, kind) {
  els.feedback.classList.remove('hidden', 'good', 'bad');
  els.feedback.classList.add(kind);
  els.feedback.innerHTML = message;
}

function revealCorrectAnswer(current) {
  const correctLabels = current.answer.join(', ');
  const correctOptions = current.options
    .filter((option) => current.answer.includes(option.label))
    .map((option) => `<strong>${escapeHtml(option.label)}.</strong> ${escapeHtml(option.text)}`)
    .join('<br />');
  return `<strong>Đáp án đúng:</strong> ${escapeHtml(correctLabels)}<br />${correctOptions}`;
}

function handleAnswer(selected) {
  if (!state.current || state.isLocked) {
    return;
  }

  const current = state.current;
  const normalizedSelected = normalizeAnswerSet(selected);
  const normalizedCorrect = normalizeAnswerSet(current.answer);
  const isCorrect = normalizedSelected.length === normalizedCorrect.length && normalizedSelected.every((value, index) => value === normalizedCorrect[index]);

  state.isLocked = true;
  state.turn += 1;

  // mark stats and schedule review if wrong
  if (isCorrect) {
    state.correct += 1;
    if (state.currentSource === 'review') {
      state.reviewSolved += 1;
      if (state.pendingWrong.has(state.currentIndex)) {
        state.pendingWrong.delete(state.currentIndex);
        state.wrong = Math.max(0, state.wrong - 1);
        removeReviewEntries(state.currentIndex);
      }
    }
  } else {
    if (!state.pendingWrong.has(state.currentIndex)) {
      state.wrong += 1;
      state.pendingWrong.add(state.currentIndex);
    }
    scheduleReview(state.currentIndex);
  }

  // show feedback and highlight options
  applyAnsweredState(current, normalizedSelected, isCorrect);
  saveQuestionState(state.currentIndex, normalizedSelected, isCorrect);
  updateStats();

  // highlight option elements
  const optionEls = Array.from(els.optionList.querySelectorAll('.option-button, .option-check'));
  optionEls.forEach((el) => {
    const letter = el.dataset ? el.dataset.letter : (el.querySelector('.option-key') && el.querySelector('.option-key').textContent.trim());
    if (!letter) return;
    const upper = String(letter).trim().toUpperCase();
    if (current.answer.includes(upper)) {
      el.classList.add('correct');
    }
    if (normalizedSelected.includes(upper) && !current.answer.includes(upper)) {
      el.classList.add('wrong');
    }
    // disable further clicks
    el.disabled = true;
    const inputs = el.querySelectorAll('input');
    inputs.forEach((i) => (i.disabled = true));
  });

  state.answeredCurrent = true;
  if (els.nextButton) els.nextButton.disabled = false;
  state.lastAnswerSelected = normalizedSelected;
  state.lastAnswerCorrect = isCorrect;
  saveSession();

  if (isCorrect && state.autoNextEnabled) {
    clearAutoNextTimer();
    const answeredIndex = state.currentIndex;
    state.autoNextTimer = setTimeout(() => {
      state.autoNextTimer = null;
      if (!state.current) return;
      if (state.currentIndex !== answeredIndex) return;
      if (!state.isLocked) return;
      goNext();
    }, 500);
  }
}

function finishSession() {
  clearAutoNextTimer();
  state.current = null;
  state.currentIndex = -1;
  setVisibility(false);
  els.heroCard.classList.remove('hidden');
  els.emptyState.classList.remove('hidden');
  if (els.parseInfo) els.parseInfo.textContent = '';
  clearSession();
}

function startSession() {
  if (state.questions.length === 0) {
    setVisibility(false);
    return;
  }

  // present questions in original order (source order)
  state.pendingNew = [...state.questions.keys()];
  state.reviewQueue = [];
  state.pendingWrong = new Set();
  state.turn = 0;
  state.correct = 0;
  state.wrong = 0;
  state.reviewSolved = 0;
  state.current = null;
  state.currentIndex = -1;
  state.currentSource = 'new';
  state.isLocked = false;
  state.lastAnswerCorrect = false;
  state.questionStates = {};
  clearAutoNextTimer();

  if (pickNextQuestion()) {
    renderQuestion(true);
    updateStats();
  }

  saveSession();
}

function goNext() {
  // if there's forward history, move forward
  if (state.historyPos < state.history.length - 1) {
    state.historyPos += 1;
    const idx = state.history[state.historyPos];
    state.currentIndex = idx;
    state.current = state.questions[idx];
    renderQuestion(false);
    applyStoredQuestionState(idx);
    updateStats();
    saveSession();
    return;
  }

  // otherwise pick a fresh next question
  if (pickNextQuestion()) {
    renderQuestion(true);
    updateStats();
  } else {
    finishSession();
  }
}

function loadDataset(text, sourceName = 'ques.md') {
  const parsed = parseQuestions(text);
  state.questions = parsed;
  updateStats();

  if (parsed.length === 0) {
    els.parseInfo.textContent = `Không đọc được câu hỏi nào từ ${sourceName}. Hãy kiểm tra định dạng hoặc dán lại nội dung.`;
    setVisibility(false);
    return;
  }

  if (els.parseInfo) els.parseInfo.textContent = '';
  if (!restoreSession()) {
    startSession();
  } else {
    const restoredAnsweredCurrent = state.answeredCurrent;
    const restoredSelectedLetters = [...state.selectedLetters];
    const restoredLastAnswerCorrect = state.lastAnswerCorrect;
    setVisibility(true);
    renderQuestion(false);
    if (restoredAnsweredCurrent && state.currentSource !== 'review') {
      applyAnsweredState(state.current, restoredSelectedLetters, restoredLastAnswerCorrect);
    }
    saveSession();
    updateStats();
  }
}

async function loadDefaultFile() {
  try {
    const response = await fetch('./ques.md', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    loadDataset(text, 'ques.md');
  } catch (error) {
    if (els.parseInfo) els.parseInfo.textContent = '';
    setVisibility(false);
  }
}

if (els.fileInput) {
  els.fileInput.addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const text = await file.text();
    loadDataset(text, file.name);
  });
}

// require confirmation before resetting/refreshing
if (els.reloadButton) {
  els.reloadButton.addEventListener('click', () => {
    const confirmed = window.confirm('Xác nhận làm mới? Mọi tiến độ hiện tại sẽ bị mất.');
    if (!confirmed) return;
    if (state.questions.length > 0) {
      startSession();
    } else {
      loadDefaultFile();
    }
  });
}

if (els.autoNextButton) {
  els.autoNextButton.addEventListener('click', () => {
    state.autoNextEnabled = !state.autoNextEnabled;
    updateAutoNextButton();
    saveSession();
  });
}

// Prev / Next navigation
if (els.prevButton) {
  els.prevButton.addEventListener('click', () => {
    if (state.historyPos > 0) {
      state.historyPos -= 1;
      const idx = state.history[state.historyPos];
      state.currentIndex = idx;
      state.current = state.questions[idx];
      renderQuestion(false);
      applyStoredQuestionState(idx);
      updateStats();
      saveSession();
    }
  });
}

if (els.nextButton) {
  els.nextButton.addEventListener('click', () => {
    goNext();
  });
}

if (els.loadTextButton) {
  els.loadTextButton.addEventListener('click', () => {
    const text = els.rawInput.value.trim();
    if (!text) return;
    loadDataset(text, 'nội dung dán vào');
  });
}

loadDefaultFile();
