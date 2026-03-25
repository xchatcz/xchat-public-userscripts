// ==UserScript==
// @name         XChat - Vzkazy - Oprava tlačítka odpovědi
// @namespace    https://www.xchat.cz/
// @version      1.0
// @description  Opravuje funkčnost náhledu původního vzkazu a vložení textu do odpovědi
// @match        https://www.xchat.cz/*/offline/new_msg.php*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  function init() {
    const nahled = document.getElementById('nahled');
    if (!nahled) return;

    const spans = document.querySelectorAll('span.odkazA');
    spans.forEach(function (span) {
      const onclick = span.getAttribute('onclick');

      if (onclick === "zobraz('nahled')") {
        span.removeAttribute('onclick');
        span.addEventListener('click', function () {
          nahled.classList.remove('hid');
        });
      }

      if (onclick === 'vloz_text()') {
        span.removeAttribute('onclick');
        span.addEventListener('click', function () {
          var message = document.getElementById('message');
          var message_old = document.getElementById('message_old');
          if (!message || !message_old) return;

          var txt = 'Přidáním původního vzkazu si ubereš počet znaků pro svou vlastní zprávu.';
          if (message.value.length + message_old.value.length > 1024) {
            txt = 'Původní vzkaz nebude možné vložit celý a bude zkrácen.';
          }

          var vrat = confirm(txt + '\nOpravdu tedy chceš přidat text starého vzkazu?');
          if (vrat) {
            message.value += '\n\n-- Odpověď na --\n' + message_old.value + '\n-- ';
            if (typeof count_length === 'function') {
              count_length();
            }
          }
        });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
