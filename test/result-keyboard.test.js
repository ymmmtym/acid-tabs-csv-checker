import test from 'node:test';
import assert from 'node:assert/strict';
import { attachResultKeyboardNavigation } from '../public/result-keyboard.js';

function createHarness(rowCount, focusedRowIndex = -1) {
  const state = { focusedRowIndex };
  const rows = Array.from({ length: rowCount }, () => {
    const classes = new Set();
    const checkbox = {
      checked: false,
      changes: [],
      dispatchEvent(event) {
        this.changes.push(event.type);
      }
    };

    return {
      classList: {
        add: (value) => classes.add(value),
        remove: (value) => classes.delete(value),
        contains: (value) => classes.has(value)
      },
      checkbox,
      scrolls: [],
      querySelector(selector) {
        return selector === 'input.select-row' ? checkbox : null;
      },
      scrollIntoView(options) {
        this.scrolls.push(options);
      }
    };
  });

  let keydown;
  const tbody = {
    addEventListener(type, handler) {
      assert.equal(type, 'keydown');
      keydown = handler;
    },
    querySelectorAll(selector) {
      assert.equal(selector, 'tr');
      return rows;
    }
  };

  attachResultKeyboardNavigation(tbody, state);

  return {
    state,
    rows,
    press(key) {
      let prevented = false;
      keydown({
        key,
        preventDefault() {
          prevented = true;
        }
      });
      return prevented;
    }
  };
}

test('矢印キーで結果行を移動し、端では折り返す', () => {
  const { state, rows, press } = createHarness(2);

  assert.equal(press('ArrowDown'), true);
  assert.equal(state.focusedRowIndex, 0);
  assert.equal(rows[0].classList.contains('is-focused'), true);
  assert.deepEqual(rows[0].scrolls, [
    { behavior: 'smooth', block: 'nearest' }
  ]);

  press('ArrowDown');
  assert.equal(state.focusedRowIndex, 1);
  press('ArrowDown');
  assert.equal(state.focusedRowIndex, 0);
  press('ArrowUp');
  assert.equal(state.focusedRowIndex, 1);
  assert.equal(rows[0].classList.contains('is-focused'), false);
  assert.equal(rows[1].classList.contains('is-focused'), true);
});

test('Enter と Space でフォーカス中の行の選択を切り替える', () => {
  const { rows, press } = createHarness(1, 0);

  assert.equal(press('Enter'), true);
  assert.equal(rows[0].checkbox.checked, true);
  assert.deepEqual(rows[0].checkbox.changes, ['change']);

  press(' ');
  assert.equal(rows[0].checkbox.checked, false);
  assert.deepEqual(rows[0].checkbox.changes, ['change', 'change']);
});

test('Escape で行の視覚的なフォーカスを解除する', () => {
  const { state, rows, press } = createHarness(1, 0);
  rows[0].classList.add('is-focused');

  press('Escape');

  assert.equal(state.focusedRowIndex, -1);
  assert.equal(rows[0].classList.contains('is-focused'), false);
});

test('行がない場合は何も操作しない', () => {
  const { state, press } = createHarness(0);

  assert.equal(press('ArrowDown'), false);
  assert.equal(state.focusedRowIndex, -1);
});
