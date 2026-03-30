// ==UserScript==
// @name         XChat sklo
// @namespace    https://www.xchat.cz/
// @version      1.0.0
// @description  Práci se sklem a zprávami na něm
// @match        https://www.xchat.cz/*/modchat?op=startframe*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Must match the domain relaxation used by all xchat frames,
  // otherwise cross-frame access (finding sendframe, top.whisper_to, etc.) fails.
  try { document.domain = 'xchat.cz'; } catch {}

  const ENTRY_RE = /(?:Uživatel(?:ka)?)\s+(\S+)\s+vstoupil[a]?\s+do\s+místnosti/;

  function findSendForm() {
    try {
      const frames = window.top.frames;
      for (let i = 0; i < frames.length; i++) {
        try {
          const doc = frames[i].document;
          // textpageng: <input name="textarea" id="msg"> inside <form name="f">
          const input = doc.querySelector('#msg') || doc.querySelector('input[name="textarea"]');
          if (input) {
            const form = input.closest('form');
            const submitBtn = form ? form.querySelector('input[type="submit"][name="submit_text"]') : null;
            return { input, form, submitBtn };
          }
        } catch { /* cross-origin */ }
      }
    } catch { /* cross-origin */ }
    return null;
  }

  function sendMessage(text) {
    const found = findSendForm();
    if (!found) return;

    found.input.value = text;

    // Click the submit button so that onSubmit handlers
    // (check_command, chatHistorySubmit) are triggered.
    if (found.submitBtn) {
      found.submitBtn.click();
    } else if (found.form) {
      found.form.requestSubmit();
    }
  }

  function injectStyles() {
    if (document.getElementById('xchat-greet-styles')) return;
    const style = document.createElement('style');
    style.id = 'xchat-greet-styles';
    style.textContent = [
      '.xchat-greet-btn {',
      '  cursor: pointer;',
      '  font-size: 10px;',
      '  padding: 0 3px;',
      '  margin: 0 1px;',
      '  border: 1px solid #999;',
      '  border-radius: 3px;',
      '  background: #eee;',
      '  color: #333;',
      '  vertical-align: middle;',
      '}',
      '.xchat-greet-btn:hover {',
      '  background: #ddd;',
      '}',
    ].join('\n');
    document.head.appendChild(style);
  }

  function createGreetButton(label, title, onclick) {
    const btn = document.createElement('span');
    btn.className = 'xchat-greet-btn';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', onclick);
    return btn;
  }

  function processEntryDiv(div) {
    if (div.dataset.xchatGreetProcessed) return;
    div.dataset.xchatGreetProcessed = '1';

    const span = div.querySelector('span.umsg_wsystem');
    if (!span) return;

    const text = span.textContent || '';
    const m = text.match(ENTRY_RE);
    if (!m) return;

    const nick = m[1];

    const flexImg = span.querySelector('img.flex');
    if (!flexImg) return;

    const btnPublic = createGreetButton('Sklo', 'Pozdravit na skle', function () {
      sendMessage(nick + ': Ahoj :)');
    });

    const btnWhisper = createGreetButton('Šepot', 'Pozdravit šeptem', function () {
      sendMessage('/m ' + nick + ' Ahoj :)');
    });

    flexImg.replaceWith(btnPublic, document.createTextNode(' '), btnWhisper);
  }

  function processAll() {
    const board = document.getElementById('board');
    if (!board) return;
    const divs = board.querySelectorAll(':scope > div');
    for (const div of divs) {
      processEntryDiv(div);
    }
  }

  function init() {
    injectStyles();
    processAll();

    const board = document.getElementById('board');
    if (!board) return;

    const observer = new MutationObserver(function (mutations) {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'DIV') {
            processEntryDiv(node);
          }
        }
      }
    });

    observer.observe(board, { childList: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
