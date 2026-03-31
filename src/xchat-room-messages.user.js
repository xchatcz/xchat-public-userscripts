// ==UserScript==
// @name         XChat sklo
// @namespace    https://www.xchat.cz/
// @version      1.1.0
// @description  Práci se sklem a zprávami na něm
// @match        https://www.xchat.cz/*/modchat?op=startframe*
// @match        https://www.xchat.cz/*/modchat?op=infopage*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Must match the domain relaxation used by all xchat frames,
  // otherwise cross-frame access (finding sendframe, top.whisper_to, etc.) fails.
  try { document.domain = 'xchat.cz'; } catch {}

  // ── Konfigurace ──
  var CONFIG = {
    greetings: {
      // 'nick': 'vlastní pozdrav'
    }
  };

  const ENTRY_RE = /(?:Uživatel(?:ka)?)\s+(\S+)\s+vstoupil[a]?\s+do\s+místnosti/;
  const STORAGE_KEY = 'xchat_greetings';
  const FILTER_STYLE_ID = 'xchat-board-filter';
  const HIGHLIGHT_STYLE_ID = 'xchat-board-highlight';

  var HIGHLIGHT_CSS = [
    '.umsg_room .umsg_hmynick',
    '.umsg_roomi .umsg_hmynick',
    '.umsg_whisper .umsg_hmynick',
    '.umsg_whisperi .umsg_hmynick',
    '.umsg_wcross .umsg_hmynick',
    '.umsg_wcrossi .umsg_hmynick'
  ].join(', ') + ' { background: yellow !important; }';

  function getOpParam() {
    return new URLSearchParams(location.search).get('op') || '';
  }

  function getSmileyUrl(id) {
    const bucket = id % 100;
    return 'https://x.ximg.cz/images/x4/sm/' + bucket + '/' + id + '.gif';
  }

  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function numToEmoji(text) {
    return escapeHtml(text).replace(/\*(\d+)\*/g, function (match, num) {
      var id = parseInt(num, 10);
      var bucket = id % 100;
      return '<img class="xchat-emoji" src="https://x.ximg.cz/images/x4/sm/' + bucket + '/' + id + '.gif" alt="*' + id + '*" title="*' + id + '*">';
    });
  }

  function getGreetings() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch { return {}; }
  }

  function getCustomGreeting(nick) {
    return getGreetings()[nick] || CONFIG.greetings[nick] || '';
  }

  function setCustomGreeting(nick, text) {
    var data = getGreetings();
    if (text) data[nick] = text;
    else delete data[nick];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function findOriginalForm() {
    try {
      const frames = window.top.frames;
      for (let i = 0; i < frames.length; i++) {
        try {
          const doc = frames[i].document;
          // textpageng: <input name="textarea" id="msg"> inside <form name="f">
          const input = doc.querySelector('#msg') || doc.querySelector('input[name="textarea"]');
          if (input) {
            const form = input.closest('form');
            if (form) return form;
          }
        } catch { /* cross-origin */ }
      }
    } catch { /* cross-origin */ }
    return null;
  }

  function sendMessage(text) {
    const origForm = findOriginalForm();
    if (!origForm) return;

    // Create a hidden iframe as the submission target,
    // so the original form and its input are never touched.
    var iframeName = 'xchat-greet-submit-' + Date.now();
    var iframe = document.createElement('iframe');
    iframe.name = iframeName;
    iframe.style.display = 'none';
    document.body.appendChild(iframe);

    // Build a fake form with the same action, method, and hidden fields.
    var fakeForm = document.createElement('form');
    fakeForm.method = origForm.method || 'post';
    fakeForm.action = origForm.action;
    fakeForm.target = iframeName;
    fakeForm.style.display = 'none';

    // Copy all hidden inputs from the original form.
    var hiddens = origForm.querySelectorAll('input[type="hidden"]');
    for (var i = 0; i < hiddens.length; i++) {
      var clone = document.createElement('input');
      clone.type = 'hidden';
      clone.name = hiddens[i].name;
      clone.value = hiddens[i].value;
      fakeForm.appendChild(clone);
    }

    // Add the message text.
    var msgInput = document.createElement('input');
    msgInput.type = 'hidden';
    msgInput.name = 'textarea';
    msgInput.value = text;
    fakeForm.appendChild(msgInput);

    // Add the submit button name so the server treats it as a normal send.
    var submitInput = document.createElement('input');
    submitInput.type = 'hidden';
    submitInput.name = 'submit_text';
    submitInput.value = 'Poslat';
    fakeForm.appendChild(submitInput);

    document.body.appendChild(fakeForm);
    fakeForm.submit();

    // Once the server responds, trigger a soft refresh of the message board
    // (same mechanism as the "obnovit" link in infopage).
    iframe.addEventListener('load', function () {
      fakeForm.remove();
      iframe.remove();
      try {
        if (window.top.roomframe && window.top.roomframe.dataframe && window.top.roomframe.dataframe.refresh) {
          window.top.roomframe.dataframe.refresh();
        }
      } catch { /* cross-origin */ }
    });

    // Fallback cleanup if load never fires.
    setTimeout(function () {
      fakeForm.remove();
      iframe.remove();
    }, 10000);
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
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  height: 19px;',
      '  min-width: 19px;',
      '  line-height: 15px;',
      '  box-sizing: border-box;',
      '}',
      '.xchat-greet-btn:hover { background: #ddd; }',
      '.xchat-greet-btn img { vertical-align: middle; height: 12px; margin: 0 1px; margin-left: 2px; }',
      '.xchat-greet-settings {',
      '  margin-left: 6px;',
      '  border-color: #aaa;',
      '  background: #ddd;',
      '  font-size: 11px;',
      '}',
      '.xchat-greet-settings:hover { background: #ccc; }',
      '.xchat-greet-label {',
      '  font-size: 10px;',
      '  font-weight: bold;',
      '  color: #666;',
      '  margin: 0 2px 0 4px;',
      '  vertical-align: middle;',
      '}',
      '.xchat-greet-label:first-child { margin-left: 0; }',
      '.xchat-greet-custom-empty {',
      '  opacity: 0.5;',
      '  font-style: italic;',
      '}',
      '.xchat-greet-modal-overlay {',
      '  position: fixed;',
      '  top: 0; left: 0; right: 0; bottom: 0;',
      '  background: rgba(0,0,0,0.5);',
      '  z-index: 99999;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '}',
      '.xchat-greet-modal {',
      '  background: #fff;',
      '  border: 1px solid #999;',
      '  border-radius: 6px;',
      '  padding: 12px 16px;',
      '  min-width: 280px;',
      '  font-family: arial, sans-serif;',
      '  font-size: 12px;',
      '}',
      '.xchat-greet-modal h4 {',
      '  margin: 0 0 8px 0;',
      '  font-size: 13px;',
      '}',
      '.xchat-greet-modal input[type="text"] {',
      '  width: 100%;',
      '  box-sizing: border-box;',
      '  padding: 4px 6px;',
      '  font-size: 12px;',
      '  margin-bottom: 8px;',
      '}',
      '.xchat-greet-modal-buttons {',
      '  text-align: right;',
      '}',
      '.xchat-greet-modal-buttons button {',
      '  margin-left: 6px;',
      '  padding: 3px 10px;',
      '  font-size: 11px;',
      '  cursor: pointer;',
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

  function createSmileyButton(title, onclick) {
    const btn = document.createElement('span');
    btn.className = 'xchat-greet-btn';
    btn.title = title;
    const img = document.createElement('img');
    img.src = getSmileyUrl(22);
    img.alt = '*22*';
    btn.appendChild(img);
    btn.addEventListener('click', onclick);
    return btn;
  }

  function createCustomButton(nick, prefix) {
    const greeting = getCustomGreeting(nick);
    const btn = document.createElement('span');
    btn.className = 'xchat-greet-btn';
    btn.dataset.xchatGreetCustom = prefix;
    btn.dataset.xchatGreetNick = nick;
    if (greeting) {
      btn.innerHTML = numToEmoji(greeting);
      btn.title = 'Vlastní: ' + greeting;
    } else {
      btn.textContent = '\u2026';
      btn.title = 'Vlastní pozdrav (nastav přes Nastavit)';
      btn.classList.add('xchat-greet-custom-empty');
    }
    btn.addEventListener('click', function () {
      const current = getCustomGreeting(nick);
      if (!current) return;
      sendMessage(prefix + current);
    });
    return btn;
  }

  function refreshCustomButtons(nick) {
    var greeting = getCustomGreeting(nick);
    var btns = document.querySelectorAll('.xchat-greet-btn[data-xchat-greet-nick="' + nick + '"]');
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      if (greeting) {
        btn.innerHTML = numToEmoji(greeting);
        btn.title = 'Vlastní: ' + greeting;
        btn.classList.remove('xchat-greet-custom-empty');
      } else {
        btn.textContent = '\u2026';
        btn.title = 'Vlastní pozdrav (nastav přes Nastavit)';
        btn.classList.add('xchat-greet-custom-empty');
      }
    }
  }

  function showGreetingModal(nick) {
    var existing = document.querySelector('.xchat-greet-modal-overlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.className = 'xchat-greet-modal-overlay';

    var modal = document.createElement('div');
    modal.className = 'xchat-greet-modal';

    var h4 = document.createElement('h4');
    h4.textContent = 'Vlastní pozdrav pro ' + nick;
    modal.appendChild(h4);

    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 200;
    input.value = getCustomGreeting(nick);
    input.placeholder = 'Např. Čau, jak se máš? *22*';
    modal.appendChild(input);

    var btns = document.createElement('div');
    btns.className = 'xchat-greet-modal-buttons';

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Zrušit';
    cancelBtn.addEventListener('click', function () { overlay.remove(); });

    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Uložit';
    saveBtn.addEventListener('click', function () {
      setCustomGreeting(nick, input.value.trim());
      refreshCustomButtons(nick);
      overlay.remove();
    });

    btns.appendChild(cancelBtn);
    btns.appendChild(saveBtn);
    modal.appendChild(btns);
    overlay.appendChild(modal);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
    input.focus();
    input.select();
  }

  function buildButtonGroup(nick, label, prefix) {
    var frag = document.createDocumentFragment();

    var lbl = document.createElement('span');
    lbl.className = 'xchat-greet-label';
    lbl.textContent = label + ':';
    frag.appendChild(lbl);

    frag.appendChild(createSmileyButton(label + ': Ahoj *22*', function () {
      sendMessage(prefix + 'Ahoj *22*');
    }));

    frag.appendChild(createGreetButton('Ahoj', label + ': Ahoj', function () {
      sendMessage(prefix + 'Ahoj');
    }));

    frag.appendChild(createGreetButton(':)', label + ': Ahoj :)', function () {
      sendMessage(prefix + 'Ahoj :)');
    }));

    frag.appendChild(createCustomButton(nick, prefix));

    return frag;
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

    const wrapper = document.createElement('span');

    wrapper.appendChild(buildButtonGroup(nick, 'Sklo', nick + ': '));
    wrapper.appendChild(document.createTextNode(' '));
    wrapper.appendChild(buildButtonGroup(nick, 'Šeptem', '/m ' + nick + ' '));
    wrapper.appendChild(document.createTextNode(' \u2013 '));
    var settingsBtn = createGreetButton('\u2699', 'Nastavit vlastní pozdrav pro ' + nick, function () {
      showGreetingModal(nick);
    });
    settingsBtn.classList.add('xchat-greet-settings');
    wrapper.appendChild(settingsBtn);

    flexImg.replaceWith(wrapper);
  }

  function processAll() {
    const board = document.getElementById('board');
    if (!board) return;
    const divs = board.querySelectorAll(':scope > div');
    for (const div of divs) {
      processEntryDiv(div);
    }
  }

  // ── Board filter (startframe side) ──

  var FILTER_CSS = {
    all: '',
    room: [
      '#board > div:has(.umsg_whisper)',
      '#board > div:has(.umsg_whisperi)',
      '#board > div:has(.umsg_wcross)',
      '#board > div:has(.umsg_wcrossi)',
      '#board > div:has(.umsg_wsystem)',
      '#board > div:has(.umsg_advert)'
    ].join(', ') + ' { display: none !important; }',
    whisper: '#board > div:not(:has(.umsg_whisper)):not(:has(.umsg_whisperi)):not(:has(.umsg_wcross)):not(:has(.umsg_wcrossi)) { display: none !important; }'
  };

  function findBoardDoc() {
    function search(win) {
      try {
        if (win.document && win.document.getElementById('board')) return win.document;
      } catch {}
      try {
        for (var i = 0; i < win.frames.length; i++) {
          var result = search(win.frames[i]);
          if (result) return result;
        }
      } catch {}
      return null;
    }
    try { return search(window.top); } catch {}
    return null;
  }

  function applyBoardFilter(mode) {
    try { window.top._xchatBoardFilter = mode; } catch {}
    var startDoc = findBoardDoc();
    if (!startDoc) return;
    var existing = startDoc.getElementById(FILTER_STYLE_ID);
    if (!mode || mode === 'all') {
      if (existing) existing.remove();
      return;
    }
    var css = FILTER_CSS[mode] || '';
    if (!css) return;
    if (existing) {
      existing.textContent = css;
    } else {
      var style = startDoc.createElement('style');
      style.id = FILTER_STYLE_ID;
      style.textContent = css;
      startDoc.head.appendChild(style);
    }
  }

  function restoreBoardFilter() {
    try {
      var mode = window.top._xchatBoardFilter;
      if (mode && mode !== 'all') applyBoardFilter(mode);
    } catch {}
  }

  function isHighlightOn() {
    try { return localStorage.getItem('xchat_highlight') === '1'; } catch { return false; }
  }

  function applyHighlight(on) {
    try { localStorage.setItem('xchat_highlight', on ? '1' : '0'); } catch {}
    var startDoc = findBoardDoc();
    if (!startDoc) return;
    var existing = startDoc.getElementById(HIGHLIGHT_STYLE_ID);
    if (!on) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    var style = startDoc.createElement('style');
    style.id = HIGHLIGHT_STYLE_ID;
    style.textContent = HIGHLIGHT_CSS;
    startDoc.head.appendChild(style);
  }

  function restoreHighlight() {
    if (isHighlightOn()) applyHighlight(true);
  }

  // ── Infopage: filter links ──

  function initInfopage() {
    var links = document.querySelectorAll('a');
    var historieLink = null;
    for (var i = 0; i < links.length; i++) {
      if (/historie/i.test(links[i].textContent)) {
        historieLink = links[i];
        break;
      }
    }
    if (!historieLink) return;

    var currentMode;
    try { currentMode = window.top._xchatBoardFilter || 'all'; } catch { currentMode = 'all'; }

    var filters = [
      { id: 'all', label: 'vše' },
      { id: 'room', label: 'texty v místnosti' },
      { id: 'whisper', label: 'pouze šeptání' }
    ];

    var container = document.createElement('span');
    container.id = 'xchat-filter-links';

    container.appendChild(document.createTextNode(' \u2013 Zobrazit: '));

    function renderFilterLinks() {
      while (container.childNodes.length > 1) container.removeChild(container.lastChild);
      for (var i = 0; i < filters.length; i++) {
        if (i > 0) container.appendChild(document.createTextNode(' | '));
        var f = filters[i];
        if (f.id === currentMode) {
          var b = document.createElement('b');
          b.textContent = f.label;
          container.appendChild(b);
        } else {
          var a = document.createElement('a');
          a.href = '#';
          a.textContent = f.label;
          a.dataset.filterMode = f.id;
          a.addEventListener('click', function (e) {
            e.preventDefault();
            currentMode = this.dataset.filterMode;
            applyBoardFilter(currentMode);
            renderFilterLinks();
          });
          container.appendChild(a);
        }
      }
    }

    renderFilterLinks();
    historieLink.parentNode.insertBefore(container, historieLink.nextSibling);

    // ── Highlight toggle ──

    var highlightOn = isHighlightOn();

    var hlContainer = document.createElement('span');
    hlContainer.id = 'xchat-highlight-links';
    hlContainer.appendChild(document.createTextNode(' \u2013 Zv\u00fdraznit: '));

    function renderHighlightLinks() {
      while (hlContainer.childNodes.length > 1) hlContainer.removeChild(hlContainer.lastChild);
      var options = [
        { on: true, label: 'Ano' },
        { on: false, label: 'Ne' }
      ];
      for (var i = 0; i < options.length; i++) {
        if (i > 0) hlContainer.appendChild(document.createTextNode(' | '));
        var opt = options[i];
        if (opt.on === highlightOn) {
          var b = document.createElement('b');
          b.textContent = opt.label;
          hlContainer.appendChild(b);
        } else {
          var a = document.createElement('a');
          a.href = '#';
          a.textContent = opt.label;
          a.dataset.hlOn = opt.on ? '1' : '0';
          a.addEventListener('click', function (e) {
            e.preventDefault();
            highlightOn = this.dataset.hlOn === '1';
            applyHighlight(highlightOn);
            renderHighlightLinks();
          });
          hlContainer.appendChild(a);
        }
      }
    }

    renderHighlightLinks();
    container.parentNode.insertBefore(hlContainer, container.nextSibling);
  }

  // ── Startframe: greet buttons + board ──

  function initStartframe() {
    injectStyles();
    processAll();
    restoreBoardFilter();
    restoreHighlight();

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

  // ── Boot ──

  function boot() {
    var op = getOpParam();
    if (op === 'startframe') initStartframe();
    else if (op === 'infopage') initInfopage();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
