// ==UserScript==
// @name         XChat Room Sidebar Hide
// @namespace    https://www.xchat.cz/
// @version      1.2
// @description  Hides element #ffc or #ffd on modchat pages (works in frames + late load)
// @match        https://www.xchat.cz/*/modchat*
// @match        https://www.xchat.cz/modchat*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const css = `
    #ffc, #ffd {
      display: none !important;
    }
  `;

  function injectCss() {
    const style = document.createElement('style');
    style.textContent = css;
    document.documentElement.appendChild(style);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectCss);
  } else {
    injectCss();
  }
})();
