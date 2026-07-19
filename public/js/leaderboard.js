'use strict';
// Leaderboard: fetch per-user stats, render a table sortable by each metric.

(() => {
  let rows = [];
  let sortKey = 'pvpWins';

  function render() {
    const sorted = rows.slice().sort((a, b) =>
      (b[sortKey] - a[sortKey]) || a.name.localeCompare(b.name));

    const body = App.$('lb-body');
    body.textContent = '';
    for (const u of sorted) {
      const tr = document.createElement('tr');
      if (App.user === u.name) tr.classList.add('me');
      for (const value of [u.name, u.aiWins, u.aiLosses, u.pvpWins, u.pvpLosses]) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }

    for (const th of document.querySelectorAll('#lb-table th.sortable')) {
      th.classList.toggle('active', th.dataset.key === sortKey);
    }
  }

  async function open() {
    App.show('leaderboard');
    App.$('lb-error').textContent = '';
    const { ok, data } = await Auth.api('GET', '/api/leaderboard');
    if (!ok) {
      App.$('lb-error').textContent = '加载失败 Failed to load';
      return;
    }
    rows = data.users || [];
    render();
  }

  window.addEventListener('DOMContentLoaded', () => {
    App.$('btn-leaderboard').addEventListener('click', open);
    App.$('btn-lb-back').addEventListener('click', () => App.show('menu'));
    for (const th of document.querySelectorAll('#lb-table th.sortable')) {
      th.addEventListener('click', () => {
        sortKey = th.dataset.key;
        render();
      });
    }
  });
})();
