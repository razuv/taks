'use strict';

const hypotheses = [
  { id: 'drafts', name: 'Автосохранение черновиков', requests: 42, days: 3,
    value: 'Сохраняет работу при сбое или закрытии вкладки.' },
  { id: 'pdf', name: 'Экспорт в PDF', requests: 35, days: 1,
    value: 'Упрощает передачу готового документа.' },
  { id: 'history', name: 'История изменений', requests: 18, days: 5,
    value: 'Помогает восстановить документ после правок.',
    trial: { id: 'history-trial', name: 'Вернуть предыдущую версию', days: 2, reach: 12,
      scope: 'Храним один предыдущий снимок документа.',
      assumption: 'Часть запросов может быть связана с отменой недавней правки.',
      signal: 'Доля пользователей, восстановивших документ без помощи.' } },
  { id: 'templates', name: 'Готовые шаблоны', requests: 22, days: 4,
    value: 'Помогает быстрее начать работу.',
    trial: { id: 'templates-trial', name: 'Три стартовых шаблона', days: 1, reach: 14,
      scope: 'Добавляем три готовых примера при создании документа.',
      assumption: 'Часть запросов может быть связана со стартом с пустого листа.',
      signal: 'Время до первого сохранения документа у новых пользователей.' } },
  { id: 'collab', name: 'Совместное редактирование', requests: 10, days: 10,
    value: 'Позволяет команде работать в одном документе.',
    trial: { id: 'collab-trial', name: 'Комментарии по ссылке', days: 3, reach: 6,
      scope: 'Коллеги могут оставить комментарий к документу по ссылке.',
      assumption: 'Части пользователей может быть достаточно оставить обратную связь.',
      signal: 'Доля отправленных ссылок, по которым появился комментарий.' } },
  { id: 'tips', name: 'Контекстные подсказки', requests: 27, days: 2,
    value: 'Подсказывает следующий шаг при первом знакомстве с редактором.' },
];
const trials = hypotheses.filter(item => item.trial).map(item => ({ ...item.trial, parent: item }));
const byId = new Map([...hypotheses, ...trials].map(item => [item.id, item]));

const DEFAULT_CAPACITY = { total: 3, reserved: 0, note: '' };
const DECISIONS_KEY = 'tri-dnya:decisions:v1';
const DRAFT_KEY = 'tri-dnya:draft:v1';
const THEME_KEY = 'tri-dnya:theme';
const CATALOG_KEY = 'taks:catalog:v1';
const SCORES_KEY = 'taks:scores:v1';
const $ = selector => document.querySelector(selector);
const rows = $('#hypotheses');
const backlog = $('#backlog');
const planDrop = $('#plan-drop');
const selection = $('#selection');
const reason = $('#reason');
const sort = $('#sort');
const capacityControls = $('#capacity-controls');
const journal = $('#journal');
const dayWord = new Intl.PluralRules('ru');
const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short' });
const dayLabel = days => ({ one: 'день', few: 'дня', many: 'дней' })[dayWord.select(days)];
const formatDays = days => `${days} ${dayLabel(days)}`;
const demandOrder = (a, b) => (b.requests ?? -1) - (a.requests ?? -1);
const available = capacity => Math.max(0, capacity.total - capacity.reserved);
const sumDays = ids => ids.reduce((sum, id) => sum + byId.get(id).days, 0);
const family = item => item.parent?.id ?? item.id;
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const html = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const priorities = { high: 'Высокая', medium: 'Средняя', low: 'Низкая' };
const priorityRank = { high: 3, medium: 2, low: 1 };
function priorityOf(value) {
  if (typeof value === 'string' && Object.hasOwn(priorities, value)) return value;
  if (!Number.isInteger(value) || value < 1 || value > 5) return undefined;
  return value <= 2 ? 'low' : value === 3 ? 'medium' : 'high';
}
const isCustomIdea = item => !!item && /^idea-[a-f0-9-]+$/.test(item.id)
  && typeof item.name === 'string' && item.name.trim() && item.name.length <= 90
  && typeof item.value === 'string' && item.value.length <= 220
  && isDayCount(item.days) && item.days > 0
  && (item.requests === null || (Number.isInteger(item.requests) && item.requests >= 0 && item.requests <= 999999));

let priorityTrigger;
let sortBy = 'requests';
let entering;
let selectionKey;
let drag;
let noticeTimer;

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function isDayCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 99;
}

function validCapacity(capacity) {
  return !!capacity && isDayCount(capacity.total) && isDayCount(capacity.reserved)
    && typeof capacity.note === 'string';
}

function validSelection(ids) {
  return Array.isArray(ids) && ids.every(id => byId.has(id))
    && new Set(ids.map(id => family(byId.get(id)))).size === ids.length;
}

function mergeCustomIdeas(items) {
  for (const item of items) {
    if (byId.has(item.id)) continue;
    hypotheses.push(item);
    byId.set(item.id, item);
  }
}

function customIdeas() {
  const stored = read(CATALOG_KEY);
  return Array.isArray(stored) ? stored.filter(isCustomIdea)
    .map(({ id, name, value, requests, days }) => ({ id, name, value, requests, days })) : [];
}

function storedScores() {
  const stored = read(SCORES_KEY);
  return stored && typeof stored === 'object' && !Array.isArray(stored)
    ? Object.fromEntries(Object.entries(stored).flatMap(([id, score]) => {
        const level = priorityOf(score);
        return byId.has(id) && level ? [[id, level]] : [];
      }))
    : {};
}

mergeCustomIdeas(customIdeas());
let scores = storedScores();
const scoreLabel = id => priorities[scores[id]] ?? '—';

function loadDecisions() {
  const stored = read(DECISIONS_KEY);
  if (!Array.isArray(stored)) return [];
  const legacyDates = new Map();
  return stored.flatMap(decision => {
    if (!decision || typeof decision.reason !== 'string'
        || !Number.isFinite(Date.parse(decision.createdAt)) || !validSelection(decision.ids)) return [];
    const capacity = decision.capacity ?? DEFAULT_CAPACITY;
    if (!validCapacity(capacity) || sumDays(decision.ids) > available(capacity)
        || (!decision.ids.length && available(capacity) > 0)) return [];
    const occurrence = legacyDates.get(decision.createdAt) ?? 0;
    legacyDates.set(decision.createdAt, occurrence + 1);
    return [{
      ...decision, capacity,
      id: decision.id ?? `legacy-${Date.parse(decision.createdAt)}-${occurrence}`,
    }];
  });
}

const storedDraft = read(DRAFT_KEY);
let capacity = validCapacity(storedDraft?.capacity) ? storedDraft.capacity : { ...DEFAULT_CAPACITY };
let selected = validSelection(storedDraft?.ids) ? storedDraft.ids : [];
let compared = validSelection(storedDraft?.compared) ? storedDraft.compared.filter(id => !byId.get(id).parent).slice(0, 3) : [];
reason.value = typeof storedDraft?.reason === 'string' ? storedDraft.reason : '';
let decisions = loadDecisions();
let journalView = 'active';
let activeTheme = read(THEME_KEY) === 'light' ? 'light' : 'dark';

function persistDraft() {
  try {
    save(DRAFT_KEY, { capacity, ids: selected, compared, reason: reason.value });
    $('#draft-warning').hidden = true;
  } catch {
    $('#draft-warning').hidden = false;
  }
}

function showNotice(message) {
  const notice = $('#notice');
  notice.textContent = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.textContent = ''; }, 3500);
}

function setTheme() {
  const light = activeTheme === 'light';
  const button = $('#theme-toggle');
  document.documentElement.dataset.theme = activeTheme;
  button.innerHTML = icon(light ? 'moon' : 'sun');
  button.title = light ? 'Включить тёмную тему' : 'Включить светлую тему';
  button.setAttribute('aria-label', button.title);
}

function renderBoard(announce = false) {
  const limit = available(capacity);
  const used = sumDays(selected);
  const free = limit - used;
  const remaining = $('#remaining');
  const over = $('#over-budget');
  $('#used-days').textContent = `В плане ${used} из ${limit} дн.`;
  remaining.dataset.over = free < 0;
  remaining.textContent = free < 0 ? `Сверх бюджета ${formatDays(-free)}`
    : free === 0 ? 'Нет свободных дней' : `Свободно ${formatDays(free)}`;
  for (const key of ['total', 'reserved']) {
    const input = $(`#${key}`);
    if (input.valueAsNumber !== capacity[key]) input.value = capacity[key];
  }
  const detail = $('#capacity-detail');
  const reserveOver = capacity.reserved - capacity.total;
  detail.hidden = reserveOver <= 0;
  detail.textContent = reserveOver > 0 ? `Внеплановые задачи сами превышают ресурс на ${formatDays(reserveOver)}.` : '';
  over.hidden = free >= 0;
  const canShrink = selected.some(id => byId.get(id).trial);
  over.textContent = free < 0
    ? `Перерасход — ${formatDays(-free)}. ${canShrink ? 'Уберите гипотезу, выберите короткую проверку или добавьте дни.' : 'Уберите гипотезу или добавьте дни.'}`
    : '';
  $('#reason-label').textContent = limit === 0 && !selected.length ? 'Почему перенесли работу?' : 'Почему так решили?';
  $('#mobile-days').textContent = `${used}/${limit}`;
  $('#mobile-plan').dataset.over = free < 0;
  if (announce) $('#budget-announcement').textContent = `В плане ${formatDays(used)}. ${remaining.textContent}.`;

  const track = $('#budget-track');
  const fraction = limit > 0 ? Math.min(used / limit, 1) : Number(used > 0);
  track.setAttribute('aria-valuemax', Math.max(limit, 1));
  track.setAttribute('aria-valuenow', Math.min(used, limit));
  track.setAttribute('aria-valuetext', `В плане ${used} из ${limit} дней`);
  track.dataset.over = free < 0;
  track.style.setProperty('--progress', fraction);

  $('#save-decision').disabled = free < 0 || (!selected.length && limit > 0);
  planDrop.dataset.over = free < 0;
  $('#save-decision').textContent = limit === 0 && !selected.length ? 'Зафиксировать перенос' : 'Сохранить решение';
  const nextSelectionKey = `${selected.join(',')};${free < 0};${limit === 0}`;
  if (selectionKey === nextSelectionKey) return;
  selectionKey = nextSelectionKey;
  selection.innerHTML = selected.length ? selected.map(id => {
    const item = byId.get(id);
    const shrink = free < 0 && item.trial
      ? `<button type="button" class="button shrink-button" data-shrink="${item.trial.id}">Заменить на проверку · ${item.days} → ${formatDays(item.trial.days)}</button>` : '';
    return `<article class="assignment" draggable="true" data-drag="true" data-id="${id}"${id === entering ? ' data-enter' : ''}>
      <div><h3>${html(item.name)}</h3>${item.parent ? '<p>Короткая проверка</p>' : ''}${shrink}</div>
      <span class="duration">${formatDays(item.days)}</span>
      <button class="icon-button" type="button" data-remove="${id}" aria-label="Отложить: ${html(item.name)}" title="Вернуть в гипотезы">${icon('close')}</button>
    </article>`;
  }).join('') : '<p class="empty-plan">План пуст</p>';
}

function renderRows() {
  closePriority(false);
  const order = {
    requests: demandOrder,
    score: (a, b) => (priorityRank[scores[b.id]] ?? 0) - (priorityRank[scores[a.id]] ?? 0) || demandOrder(a, b),
    days: (a, b) => a.days - b.days || demandOrder(a, b),
  };
  const visible = [...hypotheses].sort(order[sortBy]);
  rows.innerHTML = visible.map(item => {
    const active = selected.includes(item.id);
    const trial = item.trial ? byId.get(item.trial.id) : null;
    const label = `Важность: ${priorities[scores[item.id]] ?? 'не задана'}`;
    return `<li><article class="idea" data-drag="${!active}" draggable="${!active}" data-id="${item.id}">
      <div class="idea-text"><h3>${html(item.name)}</h3>${item.value ? `<p>${html(item.value)}</p>` : ''}</div>
      <div class="idea-metrics">
        <div class="metric"><span>Запросы / мес.</span><b aria-label="${item.requests ?? 'Неизвестно'}">${item.requests ?? '—'}</b></div>
        <div class="metric"><span>Разработка</span><b>${formatDays(item.days)}</b></div>
      </div>
      <div class="idea-actions">
        <div class="priority-control">
          <button class="button priority-trigger" type="button" data-priority="${item.id}" data-level="${scores[item.id] ?? ''}"
            aria-expanded="false" aria-controls="priority-menu" aria-label="${label}. ${html(item.name)}"><span>${priorities[scores[item.id]] ?? 'Важность'}</span>${icon('down')}</button>
        </div>
        <div class="idea-secondary">
          <button class="icon-button compare-toggle" type="button" data-compare="${item.id}" aria-pressed="${compared.includes(item.id)}"
            aria-label="Сравнить: ${html(item.name)}" title="Сравнить">${icon('columns')}<span>Сравнить</span></button>
          ${toggleButton(item)}
        </div>
      </div>
    </article>${trial ? `<details class="trial-details"><summary>Короткая проверка ${icon('down')}</summary>${trialCard(trial)}</details>` : ''}</li>`;
  }).join('');
}

function renderComparison() {
  for (const button of rows.querySelectorAll('[data-compare]')) {
    button.disabled = compared.length >= 3 && !compared.includes(button.dataset.compare);
  }
  const items = compared.map(id => byId.get(id));
  $('#compare').hidden = !items.length;
  $('#compare-jump').hidden = !items.length;
  $('#compare-jump-count').textContent = items.length;
  $('#compare-count').textContent = `${items.length} из 3`;
  $('#clear-compare').hidden = !items.length;
  const result = $('#comparison-results');
  if (!items.length) {
    result.innerHTML = '';
    return;
  }
  const metrics = [
    ['Важность', item => `<span data-comparison-level="${item.id}" data-level="${scores[item.id] ?? ''}">${scoreLabel(item.id)}</span>`],
    ['Запросы / мес.', item => item.requests ?? '—'],
    ['Разработка', item => formatDays(item.days)],
    ['Ожидаемая польза', item => html(item.value || '—')],
  ];
  result.innerHTML = `<div class="comparison-scroll" data-columns="${items.length}" tabindex="0" role="region" aria-label="Метрики выбранных гипотез">
      <table><thead><tr><th scope="col">Критерий</th>${items.map(item => `<th scope="col">${html(item.name)}</th>`).join('')}</tr></thead>
      <tbody>${metrics.map(([label, render]) => `<tr><th scope="row">${label}</th>${items.map(item => `<td>${render(item)}</td>`).join('')}</tr>`).join('')}
      <tr><td></td>${items.map(item => `<td><button type="button" data-compare-plan="${item.id}" class="button button-outline" aria-pressed="${selected.includes(item.id)}">${selected.includes(item.id) ? 'Убрать из плана' : 'В план'}</button></td>`).join('')}</tr>
      </tbody></table>
    </div>`;
}

function toggleState(item) {
  const active = selected.includes(item.id);
  const replacing = !active && selected.some(id => family(byId.get(id)) === family(item));
  const action = active ? 'Отложить' : replacing ? 'Заменить в плане на' : 'Добавить в план';
  const content = item.parent ? active ? 'В плане' : replacing ? 'Заменить' : 'Взять проверку'
    : icon(active ? 'check' : 'add');
  return { active, action, content };
}

function toggleButton(item) {
  const { active, action, content } = toggleState(item);
  return `<button class="${item.parent ? 'button button-outline' : 'icon-button'}" type="button"
    data-toggle="${item.id}" aria-pressed="${active}" aria-label="${action}: ${html(item.name)}" title="${action}">${content}</button>`;
}

function patchSelection(id) {
  const item = byId.get(id);
  const button = rows.querySelector(`[data-toggle="${id}"]`);
  if (button) {
    const { active, action, content } = toggleState(item);
    button.setAttribute('aria-pressed', active);
    button.setAttribute('aria-label', `${action}: ${item.name}`);
    button.title = action;
    button.innerHTML = content;
    const card = button.closest('[data-drag]');
    if (card) {
      card.draggable = !active;
      card.dataset.drag = String(!active);
    }
  }
  if (!compared.includes(id)) return;
  const compareAction = $(`[data-compare-plan="${id}"]`);
  if (!compareAction) return;
  const active = selected.includes(id);
  compareAction.setAttribute('aria-pressed', active);
  compareAction.textContent = active ? 'Убрать из плана' : 'В план';
}

function trialCard(item) {
  const active = selected.includes(item.id);
  return `<article class="trial" draggable="${!active}" data-drag="${!active}" data-id="${item.id}">
    <div><h3>${html(item.name)}</h3><p>${item.scope}</p>
      <p class="trial-metrics">Оценка · ${formatDays(item.days)} · ≈${item.reach} из ${item.parent.requests} запросов</p>
      <p>${item.assumption}</p></div>
    ${toggleButton(item)}
    <p class="trial-signal"><strong>Что измерим</strong> · ${item.signal}</p>
  </article>`;
}

function proposalFor(id) {
  const item = byId.get(id);
  const existing = selected.find(current => family(byId.get(current)) === family(item));
  return existing ? selected.map(current => current === existing ? id : current) : [...selected, id];
}

function updateSelection(next) {
  entering = next.find(id => !selected.includes(id));
  const changed = [...selected.filter(id => !next.includes(id)), ...next.filter(id => !selected.includes(id))];
  selected = next;
  for (const id of new Set(changed.flatMap(id => {
    const item = byId.get(family(byId.get(id)));
    return item.trial ? [item.id, item.trial.id] : [id];
  }))) patchSelection(id);
  persistDraft();
  renderBoard(true);
  entering = undefined;
}

function addItem(id) {
  if (!byId.has(id) || selected.includes(id)) return;
  updateSelection(proposalFor(id));
}

function removeItem(id) {
  updateSelection(selected.filter(item => item !== id));
}

function openJournal() {
  journalView = 'active';
  renderJournal();
  $('#journal-title').focus({ preventScroll: true });
  journal.scrollIntoView({ block: 'nearest' });
}

function renderJournal() {
  const list = $('#journal-list');
  const archived = journalView === 'archived';
  $('#journal-active').setAttribute('aria-pressed', !archived);
  $('#journal-archive').setAttribute('aria-pressed', archived);
  const visible = decisions.filter(decision => Boolean(decision.archived) === archived);
  if (!visible.length) {
    list.innerHTML = `<p class="journal-empty">${archived ? 'Архив пуст' : 'Решений пока нет'}</p>`;
    return;
  }
  list.replaceChildren(...visible.map(decision => {
    const card = document.createElement('article');
    card.className = 'entry';
    const id = html(decision.id);
    card.innerHTML = `<div class="entry-top">
      <h3>${decision.ids.length ? 'Выбрали в работу' : 'Перенос гипотез'}</h3>
      <p><time></time><span>${sumDays(decision.ids)} из ${available(decision.capacity)} дн.</span></p>
      </div>
      <p class="entry-capacity"></p>
      ${decision.ids.length ? `<ul>${decision.ids.map(id => {
        const item = byId.get(id);
        return `<li>${html(item.name)} · ${formatDays(item.days)}${item.parent ? `<br><small>Проверка: ${item.parent.name}. Что измерим: ${item.signal}</small>` : ''}</li>`;
      }).join('')}</ul>` : ''}
      <p class="entry-alternatives" hidden></p>
      <p class="entry-reason"></p>
      <div class="entry-actions">
        <button class="button button-outline" type="button" data-journal-action="copy" data-decision="${id}">${icon('copy')}Копировать</button>
        <button class="button button-outline" type="button" data-journal-action="edit" data-decision="${id}">Редактировать</button>
        <button class="button button-outline" type="button" data-journal-action="archive" data-decision="${id}">${archived ? 'Восстановить' : 'В архив'}</button>
        <button class="button button-danger" type="button" data-journal-action="delete" data-decision="${id}">Удалить</button>
      </div>`;
    const time = card.querySelector('time');
    time.dateTime = decision.createdAt;
    time.textContent = dateFormat.format(new Date(decision.createdAt));
    const capacityInfo = card.querySelector('.entry-capacity');
    capacityInfo.textContent = capacitySummary(decision.capacity);
    capacityInfo.hidden = !capacityInfo.textContent;
    const alternatives = card.querySelector('.entry-alternatives');
    const considered = alternativeNames(decision);
    alternatives.hidden = !considered;
    alternatives.textContent = considered;
    card.querySelector('.entry-reason').textContent = decision.reason;
    return card;
  }));
}

function capacitySummary(resource) {
  return [
    resource.reserved ? `Внеплановые задачи: ${formatDays(resource.reserved)} при ресурсе ${resource.total} дн.` : '',
    resource.note,
  ].filter(Boolean).join(' · ');
}

function alternativeNames(decision) {
  const alternatives = Array.isArray(decision.alternatives) ? decision.alternatives : [];
  const names = alternatives.filter(item => typeof item?.name === 'string')
    .map(item => {
      const label = priorities[priorityOf(item.score)];
      return label ? `${item.name} (${label.toLowerCase()})` : item.name;
    });
  return names.length ? `Рассматривали также: ${names.join(' · ')}` : '';
}

function changeCapacity(key, value) {
  if (!isDayCount(value) || capacity[key] === value) return;
  capacity = { ...capacity, [key]: value };
  persistDraft();
  renderBoard(true);
}

$('#theme-toggle').addEventListener('click', () => {
  activeTheme = activeTheme === 'light' ? 'dark' : 'light';
  setTheme();
  try { save(THEME_KEY, activeTheme); } catch { /* Тема действует до закрытия страницы. */ }
});

capacityControls.addEventListener('click', event => {
  const button = event.target.closest('[data-step]');
  if (!button) return;
  const key = button.dataset.step;
  changeCapacity(key, capacity[key] + Number(button.dataset.delta));
});
for (const key of ['total', 'reserved']) {
  const input = $(`#${key}`);
  input.addEventListener('input', () => changeCapacity(key, input.valueAsNumber));
  input.addEventListener('blur', () => { input.value = capacity[key]; });
}
$('#capacity-note').value = capacity.note;
$('#capacity-note').addEventListener('input', event => {
  capacity = { ...capacity, note: event.target.value.trim() };
  persistDraft();
});

sort.addEventListener('click', event => {
  const selectedButton = event.target.closest('[data-sort]');
  if (!selectedButton || selectedButton.dataset.sort === sortBy) return;
  sortBy = selectedButton.dataset.sort;
  sort.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', button === selectedButton));
  renderRows();
});

const priorityMenu = $('#priority-menu');
function closePriority(focus) {
  if (!priorityTrigger) return;
  priorityTrigger.setAttribute('aria-expanded', 'false');
  priorityMenu.hidden = true;
  document.body.append(priorityMenu);
  if (focus) priorityTrigger.focus({ preventScroll: true });
  priorityTrigger = undefined;
}

function patchPriority(id) {
  const button = rows.querySelector(`[data-priority="${id}"]`);
  const level = scores[id] ?? '';
  if (button) {
    button.dataset.level = level;
    button.querySelector('span').textContent = priorities[level] ?? 'Важность';
    button.setAttribute('aria-label', `Важность: ${priorities[level] ?? 'не задана'}. ${byId.get(id).name}`);
  }
  if (!compared.includes(id)) return;
  const cell = $(`[data-comparison-level="${id}"]`);
  if (cell) {
    cell.dataset.level = level;
    cell.textContent = scoreLabel(id);
  }
}

priorityMenu.addEventListener('click', event => {
  const button = event.target.closest('[data-level]');
  if (!button || !priorityTrigger) return;
  const id = priorityTrigger.dataset.priority;
  const level = button.dataset.level;
  const next = storedScores();
  next[id] = level;
  try { save(SCORES_KEY, next); }
  catch { showNotice('Браузер не смог сохранить важность.'); return; }
  scores = next;
  closePriority(false);
  patchPriority(id);
  if (sortBy === 'score') renderRows();
  rows.querySelector(`[data-priority="${id}"]`)?.focus({ preventScroll: true });
});

document.addEventListener('click', event => {
  if (priorityTrigger && !event.target.closest('#priority-menu, [data-priority]')) closePriority(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && priorityTrigger) closePriority(true);
});

rows.addEventListener('click', event => {
  const flag = event.target.closest('[data-priority]');
  if (flag) {
    const wasOpen = flag === priorityTrigger;
    closePriority(false);
    if (!wasOpen) {
      priorityTrigger = flag;
      flag.setAttribute('aria-expanded', 'true');
      flag.parentElement.append(priorityMenu);
      priorityMenu.hidden = false;
      for (const option of priorityMenu.querySelectorAll('[data-level]')) {
        option.setAttribute('aria-pressed', option.dataset.level === scores[flag.dataset.priority]);
      }
      (priorityMenu.querySelector('[aria-pressed="true"]') ?? priorityMenu.querySelector('button'))?.focus({ preventScroll: true });
    }
    return;
  }
  const compareButton = event.target.closest('[data-compare]');
  if (compareButton) {
    const id = compareButton.dataset.compare;
    if (compared.includes(id)) compared = compared.filter(current => current !== id);
    else if (compared.length < 3) compared.push(id);
    else { showNotice('Можно сравнить до трёх гипотез.'); return; }
    persistDraft();
    compareButton.setAttribute('aria-pressed', compared.includes(id));
    renderComparison();
    return;
  }

  const button = event.target.closest('[data-toggle]');
  if (!button) return;
  const id = button.dataset.toggle;
  if (selected.includes(id)) removeItem(id);
  else addItem(id);
  rows.querySelector(`[data-toggle="${id}"]`)?.focus({ preventScroll: true });
});

selection.addEventListener('click', event => {
  const remove = event.target.closest('[data-remove]');
  const shrink = event.target.closest('[data-shrink]');
  if (!remove && !shrink) return;
  if (remove) removeItem(remove.dataset.remove);
  else addItem(shrink.dataset.shrink);
  (selection.querySelector('button') ?? $('#plan-title')).focus({ preventScroll: true });
});

function clearDrag() {
  drag?.node.classList.remove('drag-source');
  for (const zone of [backlog, planDrop]) zone.classList.remove('drop-ready', 'drop-over');
  $('#drop-preview').hidden = true;
  drag = undefined;
}

document.addEventListener('dragstart', event => {
  const node = event.target.closest('[data-drag="true"]');
  if (!node || !event.dataTransfer || !byId.has(node.dataset.id)) return;
  const fromPlan = planDrop.contains(node);
  drag = { id: node.dataset.id, node, target: fromPlan ? backlog : planDrop };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', drag.id);
  node.classList.add('drag-source');
  drag.target.classList.add('drop-ready');
});
document.addEventListener('dragend', clearDrag);
for (const zone of [backlog, planDrop]) {
  zone.addEventListener('dragover', event => {
    if (drag?.target !== zone) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    zone.classList.add('drop-over');
    if (zone === planDrop && $('#drop-preview').hidden) {
      const projected = sumDays(proposalFor(drag.id));
      const excess = projected - available(capacity);
      const preview = $('#drop-preview');
      preview.textContent = excess > 0 ? `В черновике будет ${formatDays(projected)} · сверх лимита ${formatDays(excess)}`
        : `В черновике будет ${formatDays(projected)}`;
      preview.dataset.over = excess > 0;
      preview.hidden = false;
    }
  });
  zone.addEventListener('dragleave', event => {
    if (zone.contains(event.relatedTarget)) return;
    zone.classList.remove('drop-over');
    $('#drop-preview').hidden = true;
  });
  zone.addEventListener('drop', event => {
    if (drag?.target !== zone) return;
    event.preventDefault();
    const { id } = drag;
    clearDrag();
    if (zone === planDrop) addItem(id);
    else removeItem(id);
  });
}

const ideaForm = $('#idea-form');
function showIdeaForm(visible) {
  ideaForm.hidden = !visible;
  $('#open-idea').setAttribute('aria-expanded', visible);
  $(visible ? '#idea-name' : '#open-idea').focus();
}
$('#open-idea').addEventListener('click', () => showIdeaForm(ideaForm.hidden));
$('#cancel-idea').addEventListener('click', () => showIdeaForm(false));
ideaForm.addEventListener('submit', event => {
  event.preventDefault();
  const rawRequests = $('#idea-requests').value.trim();
  const item = {
    id: `idea-${crypto.randomUUID?.() ?? Date.now().toString(16) + '-' + Math.random().toString(16).slice(2)}`,
    name: $('#idea-name').value.trim(),
    value: $('#idea-value').value.trim(),
    requests: rawRequests === '' ? null : $('#idea-requests').valueAsNumber,
    days: $('#idea-days').valueAsNumber,
  };
  const error = $('#idea-error');
  if (!isCustomIdea(item)) {
    error.textContent = 'Укажите название и срок разработки от 1 до 99 дней.';
    error.hidden = false;
    return;
  }
  const next = [...customIdeas(), item];
  try { save(CATALOG_KEY, next); }
  catch {
    error.textContent = 'Браузер не смог сохранить гипотезу. Данные остались в форме.';
    error.hidden = false;
    return;
  }
  mergeCustomIdeas(next);
  ideaForm.reset();
  error.hidden = true;
  showIdeaForm(false);
  renderRows();
  showNotice('Гипотеза добавлена');
});

$('#clear-compare').addEventListener('click', () => {
  const firstToggle = rows.querySelector(`[data-compare="${compared[0]}"]`);
  for (const id of compared) rows.querySelector(`[data-compare="${id}"]`)?.setAttribute('aria-pressed', 'false');
  compared = [];
  persistDraft();
  renderComparison();
  firstToggle?.focus();
});
$('#compare-jump').addEventListener('click', event => {
  event.preventDefault();
  $('#compare-title').focus();
});
$('#comparison-results').addEventListener('click', event => {
  const action = event.target.closest('[data-compare-plan]');
  if (!action) return;
  const id = action.dataset.comparePlan;
  if (selected.includes(id)) removeItem(id);
  else addItem(id);
  $(`[data-compare-plan="${id}"]`)?.focus({ preventScroll: true });
});

reason.addEventListener('input', () => {
  $('#form-error').hidden = true;
  reason.setCustomValidity('');
  persistDraft();
});

$('#decision-form').addEventListener('submit', event => {
  event.preventDefault();
  const explanation = reason.value.trim();
  const limit = available(capacity);
  if (sumDays(selected) > limit || (!selected.length && limit > 0)) return;
  if (!explanation) {
    reason.setCustomValidity('Добавьте обоснование решения.');
    reason.reportValidity();
    return;
  }
  const alternatives = compared.filter(id => !selected.some(chosen => family(byId.get(chosen)) === id))
    .map(id => ({ name: byId.get(id).name, score: scores[id] ?? null }));
  const decision = {
    id: crypto.randomUUID?.() ?? `decision-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ids: [...selected], capacity: { ...capacity }, reason: explanation, alternatives, createdAt: new Date().toISOString(),
  };
  try {
    const previous = loadDecisions();
    if (previous.length && !previous[0].archived && previous[0].reason === explanation
        && JSON.stringify(previous[0].ids) === JSON.stringify(selected)
        && JSON.stringify(previous[0].capacity) === JSON.stringify(capacity)
        && JSON.stringify(previous[0].alternatives ?? []) === JSON.stringify(alternatives)) {
      decisions = previous;
      openJournal();
      showNotice('Это решение уже сохранено');
      return;
    }
    const updated = [decision, ...previous];
    save(DECISIONS_KEY, updated);
    decisions = updated;
  } catch {
    $('#form-error').textContent = 'Браузер не смог сохранить решение. Черновик остался в форме.';
    $('#form-error').hidden = false;
    return;
  }
  openJournal();
  showNotice('Решение сохранено');
});

const decisionEditor = $('#decision-editor');
let editingDecision;

function writeJournal(next) {
  try { save(DECISIONS_KEY, next); }
  catch { return false; }
  decisions = next;
  renderJournal();
  return true;
}

function editDecision(decision) {
  editingDecision = decision;
  const options = [...hypotheses, ...trials];
  $('#edit-hypotheses').innerHTML = options.map(item => {
    const label = item.parent ? `${item.name} (проверка: ${item.parent.name})` : item.name;
    return `<label class="editor-option">
      <input type="checkbox" value="${item.id}"${decision.ids.includes(item.id) ? ' checked' : ''}>
      <span>${html(label)}</span><span class="duration">${formatDays(item.days)}</span>
    </label>`;
  }).join('');
  $('#edit-total').value = decision.capacity.total;
  $('#edit-reserved').value = decision.capacity.reserved;
  $('#edit-note').value = decision.capacity.note;
  $('#edit-reason').value = decision.reason;
  $('#edit-error').hidden = true;
  decisionEditor.showModal();
}

$('#cancel-edit').addEventListener('click', () => decisionEditor.close());
decisionEditor.addEventListener('close', () => {
  editingDecision = undefined;
});

$('#decision-edit-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!editingDecision) return;
  const checked = [...$('#edit-hypotheses').querySelectorAll('input:checked')].map(input => input.value);
  const ids = [...editingDecision.ids.filter(id => checked.includes(id)), ...checked.filter(id => !editingDecision.ids.includes(id))];
  const resource = {
    total: $('#edit-total').valueAsNumber,
    reserved: $('#edit-reserved').valueAsNumber,
    note: $('#edit-note').value.trim(),
  };
  const explanation = $('#edit-reason').value.trim();
  const latest = loadDecisions();
  const current = latest.find(decision => decision.id === editingDecision.id);
  const error = $('#edit-error');
  let issue = '';
  if (!current) issue = 'Решение уже удалено.';
  else if (JSON.stringify(current) !== JSON.stringify(editingDecision)) issue = 'Решение изменилось в другой вкладке. Откройте его заново.';
  else if (!explanation) issue = 'Добавьте обоснование.';
  else if (!validCapacity(resource)) issue = 'Укажите целое число от 0 до 99 для каждого поля ресурса.';
  else if (!validSelection(ids)) issue = 'Для каждой гипотезы выберите один вариант: полный или короткую проверку.';
  else if (sumDays(ids) > available(resource)) issue = `Перерасход — ${formatDays(sumDays(ids) - available(resource))}.`;
  else if (!ids.length && available(resource) > 0) issue = 'Добавьте гипотезу в решение.';
  if (!issue) {
    const chosen = new Set(ids.map(id => byId.get(family(byId.get(id))).name));
    const alternatives = Array.isArray(current.alternatives)
      ? current.alternatives.filter(item => !chosen.has(item?.name)) : [];
    const updated = { ...current, ids, reason: explanation, capacity: resource, alternatives };
    if (writeJournal(latest.map(decision => decision.id === current.id ? updated : decision))) {
      decisionEditor.close();
      $('#journal-title').focus({ preventScroll: true });
      showNotice('Изменения сохранены');
      return;
    }
    issue = 'Браузер не смог сохранить изменения.';
  }
  error.textContent = issue;
  error.hidden = false;
});

$('#journal-filter').addEventListener('click', event => {
  const button = event.target.closest('[data-journal-filter]');
  if (!button) return;
  journalView = button.dataset.journalFilter;
  renderJournal();
});

$('#journal-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-journal-action]');
  if (!button) return;
  const { decision: id, journalAction: action } = button.dataset;
  const latest = loadDecisions();
  const decision = latest.find(item => item.id === id);
  if (!decision) {
    decisions = latest;
    renderJournal();
    showNotice('Решение уже удалено');
    return;
  }
  if (action === 'edit') {
    editDecision(decision);
    return;
  }
  if (action === 'archive' || action === 'delete') {
    if (action === 'delete' && !window.confirm('Удалить решение без возможности восстановления?')) return;
    const next = action === 'delete' ? latest.filter(item => item.id !== id)
      : latest.map(item => item.id === id ? { ...item, archived: !item.archived } : item);
    if (!writeJournal(next)) {
      showNotice('Браузер не смог обновить журнал');
      return;
    }
    $(journalView === 'archived' ? '#journal-archive' : '#journal-active').focus({ preventScroll: true });
    showNotice(action === 'delete' ? 'Решение удалено' : decision.archived ? 'Решение восстановлено' : 'Решение в архиве');
    return;
  }
  const summary = [
    `${decision.ids.length ? 'Выбрали в работу' : 'Перенос гипотез'} · ${sumDays(decision.ids)} из ${available(decision.capacity)} дн.`,
    capacitySummary(decision.capacity),
    alternativeNames(decision),
    ...decision.ids.map(id => {
      const item = byId.get(id);
      return `• ${item.name} · ${formatDays(item.days)}${item.parent ? `\n  Проверка: ${item.parent.name}. Что измерим: ${item.signal}` : ''}`;
    }),
  ].filter(Boolean).join('\n') + `\n\n${decision.reason}`;
  try {
    await navigator.clipboard.writeText(summary);
    showNotice('Решение скопировано');
  } catch {
    showNotice('Не удалось скопировать. Текст можно выделить в журнале.');
  }
});
window.addEventListener('storage', event => {
  if (event.key === CATALOG_KEY || event.key === null) mergeCustomIdeas(customIdeas());
  if (event.key === SCORES_KEY || event.key === null) scores = storedScores();
  if (event.key === DECISIONS_KEY || event.key === CATALOG_KEY || event.key === null) {
    decisions = loadDecisions();
    renderJournal();
  }
  if (event.key === CATALOG_KEY || event.key === SCORES_KEY || event.key === null) {
    renderRows();
    renderComparison();
  }
});

setTheme();
renderBoard();
renderRows();
renderComparison();
renderJournal();
