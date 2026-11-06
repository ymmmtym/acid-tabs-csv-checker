function updateRowFocus(rows, focusedRowIndex) {
  for (const row of rows) {
    row.classList.remove('is-focused');
  }

  const targetRow = rows[focusedRowIndex];
  if (targetRow) {
    targetRow.classList.add('is-focused');
    targetRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

export function attachResultKeyboardNavigation(tbody, state) {
  tbody.addEventListener('keydown', (event) => {
    const rows = tbody.querySelectorAll('tr');
    if (rows.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      state.focusedRowIndex =
        state.focusedRowIndex < rows.length - 1
          ? state.focusedRowIndex + 1
          : 0;
      updateRowFocus(rows, state.focusedRowIndex);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      state.focusedRowIndex =
        state.focusedRowIndex > 0
          ? state.focusedRowIndex - 1
          : rows.length - 1;
      updateRowFocus(rows, state.focusedRowIndex);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const row = rows[state.focusedRowIndex];
      const checkbox = row?.querySelector('input.select-row');
      if (checkbox) {
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }

    if (event.key === 'Escape') {
      state.focusedRowIndex = -1;
      updateRowFocus(rows, state.focusedRowIndex);
    }
  });
}
