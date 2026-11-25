const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = readFileSync(resolve(__dirname, '../docs/app.js'), 'utf8');
const DECISIONS = 'tri-dnya:decisions:v1';
const DRAFT = 'tri-dnya:draft:v1';
const legacy = { ids: ['drafts'], reason: 'Старое решение', createdAt: '2026-11-23T20:00:00Z' };
const event = (action, id) => ({
  preventDefault() {},
  target: { closest: selector => selector === `[data-${action}]` ? { dataset: { [action]: id }, setAttribute() {} } : null },
});

function board(storage = new Map()) {
  const make = () => {
    const classes = new Set();
    return {
      dataset: {},
      style: { setProperty(key, value) { this[key] = value; } },
      markupWrites: 0,
      set innerHTML(value) { this.markup = value; this.markupWrites++; },
      get innerHTML() { return this.markup ?? ''; },
      classList: {
        add: value => classes.add(value),
        remove: (...values) => values.forEach(value => classes.delete(value)),
        contains: value => classes.has(value),
        toggle: (value, active) => active ? classes.add(value) : classes.delete(value),
      },
      setAttribute(name, value) { this[name] = value; },
      querySelector() { return make(); },
      closest() { return null; },
      append() {},
      contains(node) { return node?.parent === this; },
      focus() {}, replaceChildren(...children) { this.children = children; }, setCustomValidity() {},
      showModal() { this.open = true; }, close() { this.open = false; },
      reset() {}, scrollIntoView() {}, querySelectorAll() { return []; },
      addEventListener(name, handler) { this[name] = handler; },
    };
  };
  const elements = new Map();
  const get = selector => {
    if (!elements.has(selector)) elements.set(selector, make());
    return elements.get(selector);
  };
  get('#drop-preview').hidden = true;
  const document = {
    ...make(), documentElement: make(), body: make(), querySelector: get, querySelectorAll: () => [], createElement: make,
  };
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const window = { ...make(), confirm: () => true };
  vm.runInContext(source, vm.createContext({ crypto, document, localStorage, window, setTimeout() {}, clearTimeout() {} }));
  return {
    get, document, storage,
    click: (action, id) => get('#hypotheses').click(event(action, id)),
    capacity(total, reserved, note = '') {
      get('#total').valueAsNumber = total;
      get('#total').input();
      get('#reserved').valueAsNumber = reserved;
      get('#reserved').input();
      get('#capacity-note').input({ target: { value: note } });
    },
    drop(id, fromPlan = false) {
      const target = get(fromPlan ? '#backlog' : '#plan-drop');
      const node = { ...make(), dataset: { id }, parent: fromPlan ? get('#plan-drop') : get('#backlog') };
      document.dragstart({ target: { closest: () => node }, dataTransfer: { setData() {} } });
      const interaction = { preventDefault() {}, dataTransfer: {} };
      target.dragover(interaction);
      const preview = get('#drop-preview').hidden ? '' : get('#drop-preview').textContent;
      target.drop(interaction);
      return preview;
    },
    save(reason) {
      get('#reason').value = reason;
      get('#reason').input();
      get('#decision-form').submit({ preventDefault() {} });
    },
  };
}

test('a drop over budget lands in the draft, with an inline reason saving is blocked', () => {
  const app = board();
  assert.match(app.drop('templates'), /сверх лимита 1 день/);
  assert.equal(app.get('#save-decision').disabled, true);
  assert.match(app.get('#over-budget').textContent, /Перерасход — 1 день/);
  app.save('Черновик');
  assert.equal(app.storage.has(DECISIONS), false);
  app.get('#capacity-controls').click({
    target: { closest: () => ({ dataset: { step: 'total', delta: '1' } }) },
  });
  assert.equal(app.get('#used-days').textContent, 'В плане 4 из 4 дн.');
  assert.equal(app.get('#save-decision').disabled, false);
  assert.match(app.get('#selection').innerHTML, /Готовые шаблоны/);
  app.get('#reason').value = 'Сократить время до первого документа';
  app.get('#reason').input();

  app.capacity(4, 2, 'Срочная работа');
  assert.match(app.get('#remaining').textContent, /Сверх бюджета 2 дня/);
  assert.match(app.get('#selection').innerHTML, /Готовые шаблоны/);
  assert.equal(app.get('#save-decision').disabled, true);
  assert.match(app.get('#selection').innerHTML, /Заменить на проверку · 4 → 1 день/);
  assert.equal(app.get('#reason').value, 'Сократить время до первого документа');
  app.get('#selection').click(event('shrink', 'templates-trial'));
  assert.doesNotMatch(app.get('#selection').innerHTML, /Готовые шаблоны/);
  assert.match(app.get('#selection').innerHTML, /Три стартовых шаблона/);
  assert.match(app.get('#remaining').textContent, /Свободно 1 день/);
  assert.equal(app.get('#save-decision').disabled, false);
  assert.equal(app.drop('templates-trial', true), '');
  assert.match(app.get('#selection').innerHTML, /План пуст/);
});

test('zero capacity allows an explicit deferral with a reason and retains old journal entries', () => {
  const app = board(new Map([[DECISIONS, JSON.stringify([legacy])]]));
  app.click('toggle', 'pdf');
  app.capacity(3, 4, 'Сбой в проде');
  assert.equal(app.get('#used-days').textContent, 'В плане 1 из 0 дн.');
  app.save('Подождём до следующей недели');
  assert.equal(JSON.parse(app.storage.get(DECISIONS)).length, 1);
  app.get('#selection').click(event('remove', 'pdf'));
  assert.equal(app.get('#save-decision').textContent, 'Зафиксировать перенос');
  app.save('Подождём до следующей недели');
  app.save('Подождём до следующей недели');
  assert.equal(app.get('#journal-active')['aria-pressed'], true);
  const records = JSON.parse(app.storage.get(DECISIONS));
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].ids, []);
  assert.deepEqual(records[0].capacity, { total: 3, reserved: 4, note: 'Сбой в проде' });
  assert.equal(records[1].reason, legacy.reason);
  assert.deepEqual(records[1].capacity, { total: 3, reserved: 0, note: '' });
});

test('theme, resource and draft return after reload', () => {
  const app = board();
  app.get('#theme-toggle').click();
  app.capacity(5, 1);
  app.click('toggle', 'drafts');
  app.get('#reason').value = 'Черновик';
  app.get('#reason').input();
  assert.deepEqual(JSON.parse(app.storage.get(DRAFT)).ids, ['drafts']);
  const reloaded = board(app.storage);
  assert.equal(reloaded.document.documentElement.dataset.theme, 'light');
  assert.equal(reloaded.get('#used-days').textContent, 'В плане 3 из 4 дн.');
  assert.equal(reloaded.get('#reason').value, 'Черновик');
  assert.equal(reloaded.get('#save-decision').disabled, false);
});

test('sorting by requests, time and value uses the corresponding criterion', () => {
  const app = board();
  const before = app.get('#hypotheses').innerHTML;
  assert.ok(before.indexOf('Автосохранение черновиков') < before.indexOf('Экспорт в PDF'));
  app.get('#sort').click(event('sort', 'days'));
  const after = app.get('#hypotheses').innerHTML;
  assert.ok(after.indexOf('Экспорт в PDF') < after.indexOf('Автосохранение черновиков'));
});

test('add an idea, score it, compare it and record the trade-off', () => {
  const app = board();
  app.get('#idea-name').value = 'Экспорт <теста>';
  app.get('#idea-value').value = 'Удобнее & быстрее';
  app.get('#idea-requests').value = '';
  app.get('#idea-days').valueAsNumber = 1;
  app.get('#idea-form').submit({ preventDefault() {} });
  const [created] = JSON.parse(app.storage.get('taks:catalog:v1'));
  assert.equal(created.requests, null);
  assert.match(app.get('#hypotheses').innerHTML, /Экспорт &lt;теста&gt;/);
  assert.doesNotMatch(app.get('#hypotheses').innerHTML, /Экспорт <теста>/);

  const beforePriority = app.get('#hypotheses').markupWrites;
  const flag = { dataset: { priority: created.id }, setAttribute() {}, parentElement: { append() {} } };
  app.get('#hypotheses').click({ target: { closest: selector => selector === '[data-priority]' ? flag : null } });
  app.get('#priority-menu').click(event('level', 'high'));
  assert.equal(app.get('#hypotheses').markupWrites, beforePriority);
  app.get('#sort').click(event('sort', 'score'));
  const sorted = app.get('#hypotheses').innerHTML;
  assert.ok(sorted.indexOf('Экспорт &lt;теста&gt;') < sorted.indexOf('Автосохранение черновиков'));
  app.click('compare', 'pdf');
  app.click('compare', created.id);
  assert.match(app.get('#comparison-results').innerHTML, /Высокая/);
  assert.match(app.get('#comparison-results').innerHTML, /Экспорт в PDF/);
  const reloaded = board(app.storage);
  assert.match(reloaded.get('#comparison-results').innerHTML, /Экспорт &lt;теста&gt;/);
  assert.match(reloaded.get('#comparison-results').innerHTML, /Высокая/);
  reloaded.get('#comparison-results').click({ target: {
    closest: selector => selector === '[data-compare-plan]' ? { dataset: { comparePlan: 'pdf' } } : null,
  } });
  reloaded.save('Для заказчика нужен именно PDF.');
  const [saved] = JSON.parse(app.storage.get(DECISIONS));
  assert.deepEqual(saved.ids, ['pdf']);
  assert.deepEqual(saved.alternatives, [{ name: 'Экспорт <теста>', score: 'high' }]);
  assert.match(board(app.storage).get('#journal-list').children[0].innerHTML, /Выбрали в работу/);
});

test('capacity, comparison selection, and the plan update without replacing the catalog', () => {
  const app = board(new Map([['taks:scores:v1', JSON.stringify({ pdf: 4, tips: 2 })]]));
  const rows = app.get('#hypotheses');
  const initialWrites = rows.markupWrites;
  assert.equal(app.get('#compare').hidden, true);
  assert.match(rows.innerHTML, /data-priority="pdf" data-level="high"/);
  assert.match(rows.innerHTML, /data-priority="tips" data-level="low"/);
  app.capacity(16, 0);
  app.click('compare', 'pdf');
  assert.equal(app.get('#compare').hidden, false);
  assert.doesNotMatch(app.get('#comparison-results').innerHTML, /Выберите/);
  app.click('toggle', 'pdf');
  assert.equal(rows.markupWrites, initialWrites);
  assert.equal(app.get('#budget-track').style['--progress'], 1 / 16);
  app.capacity(0, 0);
  assert.equal(app.get('#budget-track').style['--progress'], 1);
  assert.equal(app.get('#budget-track').dataset.over, true);
});

test('edit, archive, restore and delete a legacy decision without changing the draft', async () => {
  const storage = new Map([[DECISIONS, JSON.stringify([legacy])]]);
  const app = board(storage);
  const id = /data-decision="([^"]+)"/.exec(app.get('#journal-list').children[0].innerHTML)[1];
  const action = (target, name) => target.get('#journal-list').click({
    target: { closest: () => ({ dataset: { decision: id, journalAction: name } }) },
  });
  const latest = () => JSON.parse(storage.get(DECISIONS));
  await action(app, 'edit');
  assert.equal(app.get('#decision-editor').open, true);
  app.get('#edit-hypotheses').querySelectorAll = () => [{ value: 'pdf' }, { value: 'tips' }];
  app.get('#edit-total').valueAsNumber = 2;
  app.get('#edit-reserved').valueAsNumber = 0;
  app.get('#edit-reason').value = 'Обновили решение';
  app.get('#decision-edit-form').submit({ preventDefault() {} });
  assert.match(app.get('#edit-error').textContent, /Перерасход/);
  assert.equal(latest()[0].reason, legacy.reason);
  app.get('#edit-total').valueAsNumber = 3;
  app.get('#decision-edit-form').submit({ preventDefault() {} });
  assert.equal(latest()[0].reason, 'Обновили решение');
  assert.deepEqual(latest()[0].ids, ['pdf', 'tips']);
  assert.equal(latest()[0].createdAt, legacy.createdAt);
  assert.equal(storage.has(DRAFT), false);

  await action(app, 'archive');
  assert.equal(latest()[0].archived, true);
  const reloaded = board(storage);
  assert.match(reloaded.get('#journal-list').innerHTML, /Решений пока нет/);
  reloaded.get('#journal-filter').click({
    target: { closest: () => ({ dataset: { journalFilter: 'archived' } }) },
  });
  assert.match(reloaded.get('#journal-list').children[0].innerHTML, /Восстановить/);
  await action(reloaded, 'archive');
  assert.equal(latest()[0].archived, false);
  await action(reloaded, 'delete');
  assert.deepEqual(latest(), []);
});
