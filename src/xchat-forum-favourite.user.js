// ==UserScript==
// @name         XChat - Fórum - Oblíbená
// @namespace    https://www.xchat.cz/
// @version      1.0
// @description  Zobrazí pouze nová témata v oblíbených na fóru
// @match        https://www.xchat.cz/~*~*/forum/favourite.php
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // 🟡 Nastav výchozí chování zde:
  const showOnlyNewByDefault = true;

  const newOnlyText = 'Pouze nové';
  const allText = 'Zobrazit vše';

  const dlnDivs = document.querySelectorAll('.dln');
  if (dlnDivs.length > 0) {
    const btn = document.createElement('input');
    btn.type = 'button';
    btn.className = 'srs f';
    btn.style.marginBottom = '10px';

    let filterOn = showOnlyNewByDefault;

    function applyFilter() {
      const rows = document.querySelectorAll('table.fav tbody tr');
      btn.value = filterOn ? allText : newOnlyText;

      rows.forEach(row => {
        const cell = row.querySelectorAll('td')[1];
        if (!cell) return;

        const html = cell.innerHTML;
        const match = html.match(/\((\d+)\s*\/\s*\d+/);
        if (match) {
          const newPosts = parseInt(match[1], 10);
          if (filterOn && newPosts === 0) {
            row.style.display = 'none';
          } else {
            row.style.display = '';
          }
        }
      });
    }

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      filterOn = !filterOn;
      applyFilter();
    });

    dlnDivs[0].before(btn);

    // Aplikuj filtr hned po načtení
    applyFilter();
  }
})();
