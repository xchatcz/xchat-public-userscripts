// ==UserScript==
// @name         XChat - Místnosti - Skrytí vyskakovacího okna
// @namespace    https://www.xchat.cz/
// @version      1.0
// @description  Skryje vyskakovací okno s potvrzením věku
// @match        https://www.xchat.cz/~*~*/modchat*op=roomlist*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const popUp = document.querySelector('#modalwin');
  if (!popUp) return;
  popUp.style.display = 'none';
})();
