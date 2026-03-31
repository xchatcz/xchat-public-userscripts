// ==UserScript==
// @name         XChat Room Messages
// @namespace    https://www.xchat.cz/
// @version      1.1.0
// @description  Práci se sklem a zprávami na něm
// @match        https://www.xchat.cz/*/modchat?op=startframe*
// @match        https://www.xchat.cz/*/modchat?op=infopage*
// @match        https://www.xchat.cz/*/history.html*
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
    myNick: '',
    greetings: {
      // 'nick': 'vlastní pozdrav'
    }
  };

  const ENTRY_RE = /(?:Uživatel(?:ka)?)\s+(\S+)\s+vstoupil[a]?\s+do\s+místnosti/;
  const SETTINGS_KEY = '_xchat_room_message_settings';
  const FILTER_STYLE_ID = 'xchat-board-filter';
  const HIGHLIGHT_STYLE_ID = 'xchat-board-highlight';
  const KICK_HIGHLIGHT_STYLE_ID = 'xchat-board-kick-highlight';
  const BAD_CMD_STYLE_ID = 'xchat-board-hide-badcmd';
  var KICK_HIGHLIGHT_CSS = '.systemtext:has(.system.kicked), .systemtext:has(.system.killed) { background: #fcc !important; color: #900 !important; }';
  var REFRESH_OPTIONS = [1, 2, 3, 5, 10, 15];

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

  function getSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    } catch { return {}; }
  }

  function saveSettings(settings) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
  }

  function getSetting(key, def) {
    var s = getSettings();
    return s.hasOwnProperty(key) ? s[key] : def;
  }

  function setSetting(key, val) {
    var s = getSettings();
    s[key] = val;
    saveSettings(s);
  }

  function getGreetings() {
    return getSetting('greetings', {});
  }

  function getCustomGreeting(nick) {
    return getGreetings()[nick] || CONFIG.greetings[nick] || '';
  }

  function getAllGreetings() {
    var merged = {};
    var ck = CONFIG.greetings || {};
    for (var k in ck) if (ck.hasOwnProperty(k)) merged[k] = ck[k];
    var ls = getGreetings();
    for (var k in ls) if (ls.hasOwnProperty(k)) merged[k] = ls[k];
    return merged;
  }

  function areGreetButtonsEnabled() {
    return getSetting('greetButtons', true);
  }

  function isKickHighlightOn() {
    return getSetting('kickHighlight', false);
  }

  function isHideBadCommands() {
    return getSetting('hideBadCommands', false);
  }

  function getRefreshInterval() {
    return getSetting('refreshInterval', 0);
  }

  function setCustomGreeting(nick, text) {
    var data = getGreetings();
    if (text) data[nick] = text;
    else delete data[nick];
    setSetting('greetings', data);
  }

  // ── IndexedDB ──

  var DB_NAME = 'xchat_room_messages';
  var DB_VERSION = 1;
  var STORE_NAME = 'messages';

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          var store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          store.createIndex('room_id', 'room_id', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('message_type', 'message_type', { unique: false });
          store.createIndex('sender', 'sender', { unique: false });
          store.createIndex('recipient', 'recipient', { unique: false });
          store.createIndex('is_whisper', 'is_whisper', { unique: false });
          store.createIndex('room_timestamp', ['room_id', 'timestamp'], { unique: false });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  function dbAdd(record) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readwrite');
        var store = tx.objectStore(STORE_NAME);
        var req = store.add(record);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function dbQuery(filters) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readonly');
        var store = tx.objectStore(STORE_NAME);
        var results = [];
        var cursorReq;

        if (filters.room_id && filters.date_from) {
          var idx = store.index('room_timestamp');
          var lower = [filters.room_id, filters.date_from];
          var upper = [filters.room_id, filters.date_to || new Date(9999, 0)];
          cursorReq = idx.openCursor(IDBKeyRange.bound(lower, upper));
        } else if (filters.room_id) {
          var idx2 = store.index('room_id');
          cursorReq = idx2.openCursor(IDBKeyRange.only(filters.room_id));
        } else if (filters.date_from || filters.date_to) {
          var idx3 = store.index('timestamp');
          var lo = filters.date_from || new Date(0);
          var hi = filters.date_to || new Date(9999, 0);
          cursorReq = idx3.openCursor(IDBKeyRange.bound(lo, hi));
        } else {
          cursorReq = store.openCursor();
        }

        cursorReq.onsuccess = function (e) {
          var cursor = e.target.result;
          if (!cursor) { resolve(results); return; }
          var rec = cursor.value;
          var dominated = false;
          if (filters.sender && rec.sender !== filters.sender) dominated = true;
          if (filters.recipient && rec.recipient !== filters.recipient) dominated = true;
          if (filters.message_type && rec.message_type !== filters.message_type) dominated = true;
          if (typeof filters.is_whisper === 'boolean' && rec.is_whisper !== filters.is_whisper) dominated = true;
          if (filters.content_search) {
            var needle = filters.content_search.toLowerCase();
            if ((rec.content_text || '').toLowerCase().indexOf(needle) === -1) dominated = true;
          }
          if (!dominated) results.push(rec);
          cursor.continue();
        };
        cursorReq.onerror = function () { reject(cursorReq.error); };
      });
    });
  }

  function dbDeleteByIds(ids) {
    if (!ids.length) return Promise.resolve();
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readwrite');
        var store = tx.objectStore(STORE_NAME);
        var done = 0;
        for (var i = 0; i < ids.length; i++) {
          var req = store.delete(ids[i]);
          req.onsuccess = function () { done++; if (done === ids.length) resolve(); };
          req.onerror = function () { reject(req.error); };
        }
      });
    });
  }

  function dbClearAll() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readwrite');
        var store = tx.objectStore(STORE_NAME);
        var req = store.clear();
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function isHistoryEnabled() {
    return getSetting('historyEnabled', false);
  }

  // ── Message parsing ──

  function getRoomId() {
    try {
      var path = window.top.location.pathname;
      var m = path.match(/\/([^/]+)\/modchat/);
      if (m) return m[1];
    } catch {}
    try {
      var p2 = location.pathname;
      var m2 = p2.match(/\/([^/]+)\/modchat/);
      if (m2) return m2[1];
    } catch {}
    return 'unknown';
  }

  function parseBoardDiv(div) {
    var timeEl = div.querySelector('.systemtime');
    var timeStr = timeEl ? timeEl.textContent.trim() : '';

    var now = new Date();
    var parts = timeStr.split(':');
    if (parts.length === 3) {
      now.setHours(parseInt(parts[0], 10), parseInt(parts[1], 10), parseInt(parts[2], 10), 0);
    }

    var msgSpan = div.querySelector('.umsg_room, .umsg_roomi, .umsg_whisper, .umsg_whisperi, .umsg_wcross, .umsg_wcrossi, .umsg_wsystem, .umsg_advert');
    if (!msgSpan) {
      var sysText = div.querySelector('.systemtext');
      if (sysText) {
        return {
          room_id: getRoomId(),
          timestamp: now,
          message_type: 'system',
          sender: 'System',
          recipient: '~',
          content_html: sysText.innerHTML,
          content_text: sysText.textContent.trim(),
          is_whisper: false
        };
      }
      return null;
    }

    var cls = msgSpan.className;
    var message_type = 'room';
    var is_whisper = false;

    if (/umsg_whisper/.test(cls) || /umsg_wcross/.test(cls)) {
      message_type = 'whisper';
      is_whisper = true;
    } else if (/umsg_wsystem/.test(cls)) {
      message_type = 'system';
    } else if (/umsg_advert/.test(cls)) {
      message_type = 'advert';
    }
    if (/umsg_roomi|umsg_whisperi|umsg_wcrossi/.test(cls)) {
      message_type += '_out';
    }

    var sender = '';
    var recipient = '~';
    var contentAfterBold = '';

    var bold = msgSpan.querySelector('b');
    if (bold) {
      var boldText = bold.textContent.trim();
      if (message_type === 'system' || message_type === 'system_out') {
        var sysMatch = boldText.match(/^System->(.+?):$/);
        if (sysMatch) {
          sender = 'System';
          recipient = sysMatch[1];
        }
      } else if (is_whisper) {
        var wMatch = boldText.match(/^(.+?)->(.+?):$/);
        if (wMatch) {
          sender = wMatch[1];
          recipient = wMatch[2];
        }
      } else {
        sender = boldText.replace(/:$/, '');
      }

      var afterBold = '';
      var n = bold.nextSibling;
      while (n) { afterBold += (n.nodeType === Node.TEXT_NODE ? n.textContent : n.outerHTML || n.textContent); n = n.nextSibling; }
      contentAfterBold = afterBold;
    } else {
      contentAfterBold = msgSpan.innerHTML;
    }

    var contentText = '';
    if (bold) {
      var tn = bold.nextSibling;
      var txt = '';
      while (tn) { txt += tn.textContent || ''; tn = tn.nextSibling; }
      contentText = txt.trim();
    } else {
      contentText = msgSpan.textContent.trim();
    }

    return {
      room_id: getRoomId(),
      timestamp: now,
      message_type: message_type,
      sender: sender,
      recipient: recipient,
      content_html: contentAfterBold,
      content_text: contentText,
      is_whisper: is_whisper
    };
  }

  var _capturedFingerprints = {};

  function msgFingerprint(rec) {
    return rec.room_id + '|' + rec.timestamp.getTime() + '|' + rec.sender + '|' + rec.recipient + '|' + rec.content_text;
  }

  function captureDiv(div) {
    if (div.dataset.xchatHistCaptured) return;
    div.dataset.xchatHistCaptured = '1';
    if (!isHistoryEnabled()) return;
    var rec = parseBoardDiv(div);
    if (!rec) return;
    var fp = msgFingerprint(rec);
    if (_capturedFingerprints[fp]) return;
    _capturedFingerprints[fp] = true;
    dbAdd(rec).catch(function (err) { /* silent */ });
  }

  function captureAllDivs() {
    var board = document.getElementById('board');
    if (!board) return;
    var divs = board.querySelectorAll(':scope > div');
    for (var i = 0; i < divs.length; i++) captureDiv(divs[i]);
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
      greetAndRemove(nick, prefix + current);
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

  function getMyNick() {
    if (CONFIG.myNick) return CONFIG.myNick;
    var board = document.getElementById('board');
    if (!board) return null;
    // Try system messages "System->Nick:" — always present
    var sysMsgs = board.querySelectorAll('.umsg_wsystem');
    for (var i = 0; i < sysMsgs.length; i++) {
      var t = sysMsgs[i].textContent;
      var sm = t.match(/^System->(\S+?):/);
      if (sm) return sm[1];
    }
    var myMsg = board.querySelector('.umsg_roomi b');
    if (myMsg) return myMsg.textContent.trim().replace(/:$/, '');
    return null;
  }

  function removeGreetButtons(nick) {
    var wrappers = document.querySelectorAll('[data-xchat-greet-wrapper="' + nick + '"]');
    for (var i = 0; i < wrappers.length; i++) wrappers[i].remove();
  }

  function greetAndRemove(nick, text) {
    sendMessage(text);
    removeGreetButtons(nick);
  }

  function buildButtonGroup(nick, label, prefix) {
    var frag = document.createDocumentFragment();

    var lbl = document.createElement('span');
    lbl.className = 'xchat-greet-label';
    lbl.textContent = label + ':';
    frag.appendChild(lbl);

    frag.appendChild(createSmileyButton(label + ': Ahoj *22*', function () {
      greetAndRemove(nick, prefix + 'Ahoj *22*');
    }));

    frag.appendChild(createGreetButton('Ahoj', label + ': Ahoj', function () {
      greetAndRemove(nick, prefix + 'Ahoj');
    }));

    frag.appendChild(createGreetButton(':)', label + ': Ahoj :)', function () {
      greetAndRemove(nick, prefix + 'Ahoj :)');
    }));

    if (getCustomGreeting(nick)) {
      frag.appendChild(createCustomButton(nick, prefix));
    }

    return frag;
  }

  function hasMessagesForNick(nick) {
    var board = document.getElementById('board');
    if (!board) return false;

    // Check whispers from me to nick: umsg_whisperi contains a link with nick text
    var whispers = board.querySelectorAll('.umsg_whisperi a');
    for (var i = 0; i < whispers.length; i++) {
      if (whispers[i].textContent.trim() === nick) return true;
    }

    // Check room messages from me addressing nick: umsg_roomi text starts with "nick:"
    var rooms = board.querySelectorAll('.umsg_roomi');
    var prefix = nick + ':';
    for (var i = 0; i < rooms.length; i++) {
      // Text after the sender bold, e.g. "nick: Ahoj"
      var b = rooms[i].querySelector('b');
      if (!b) continue;
      var afterBold = '';
      var node = b.nextSibling;
      while (node) {
        afterBold += node.textContent || '';
        node = node.nextSibling;
      }
      if (afterBold.trimStart().indexOf(prefix) === 0) return true;
    }

    return false;
  }

  function processEntryDiv(div) {
    if (div.dataset.xchatGreetProcessed) return;
    div.dataset.xchatGreetProcessed = '1';

    if (!areGreetButtonsEnabled()) return;

    const span = div.querySelector('span.umsg_wsystem');
    if (!span) return;

    const text = span.textContent || '';
    const m = text.match(ENTRY_RE);
    if (!m) return;

    const nick = m[1];

    var myNick = getMyNick();
    if (myNick && nick === myNick) return;

    if (hasMessagesForNick(nick)) return;

    const flexImg = span.querySelector('img.flex');
    if (!flexImg) return;

    const wrapper = document.createElement('span');
    wrapper.dataset.xchatGreetWrapper = nick;

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
    return getSetting('highlight', false);
  }

  function applyHighlight(on) {
    setSetting('highlight', on);
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

  function applyKickHighlight(on) {
    setSetting('kickHighlight', on);
    var startDoc = findBoardDoc();
    if (!startDoc) return;
    var existing = startDoc.getElementById(KICK_HIGHLIGHT_STYLE_ID);
    if (!on) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    var style = startDoc.createElement('style');
    style.id = KICK_HIGHLIGHT_STYLE_ID;
    style.textContent = KICK_HIGHLIGHT_CSS;
    startDoc.head.appendChild(style);
  }

  function restoreKickHighlight() {
    if (isKickHighlightOn()) applyKickHighlight(true);
  }

  function markBadCommandDiv(div) {
    var sys = div.querySelector('.umsg_wsystem');
    if (!sys) return;
    var b = sys.querySelector('b');
    if (!b) return;
    var afterBold = '';
    var node = b.nextSibling;
    while (node) { afterBold += node.textContent || ''; node = node.nextSibling; }
    if (afterBold.trim() === '\u0160patn\u00fd p\u0159\u00edkaz') div.classList.add('xchat-badcmd');
  }

  function markAllBadCommands() {
    var board = document.getElementById('board');
    if (!board) return;
    var divs = board.querySelectorAll(':scope > div');
    for (var i = 0; i < divs.length; i++) markBadCommandDiv(divs[i]);
  }

  function applyHideBadCommands(on) {
    var startDoc = findBoardDoc();
    if (!startDoc) return;
    var existing = startDoc.getElementById(BAD_CMD_STYLE_ID);
    if (!on) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    var style = startDoc.createElement('style');
    style.id = BAD_CMD_STYLE_ID;
    style.textContent = '.xchat-badcmd { display: none !important; }';
    startDoc.head.appendChild(style);
  }

  function restoreHideBadCommands() {
    if (isHideBadCommands()) applyHideBadCommands(true);
  }

  // ── Infopage: filter links ──

  function initInfopage() {
    // Rename "Nemluvil jsi:" to "IDLE:"
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while ((node = walker.nextNode())) {
      if (node.textContent.indexOf('Nemluvil jsi:') !== -1) {
        node.textContent = node.textContent.replace('Nemluvil jsi:', 'IDLE:');
      }
    }

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
      { id: 'room', label: 'místnost' },
      { id: 'whisper', label: 'šeptání' }
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

    // ── Settings link ──

    var settingsSpan = document.createElement('span');
    settingsSpan.appendChild(document.createTextNode(' \u2013 '));
    var settingsLink = document.createElement('a');
    settingsLink.href = '#';
    settingsLink.textContent = 'Nastaven\u00ed';
    settingsLink.addEventListener('click', function (e) {
      e.preventDefault();
      showSettingsModal();
    });
    settingsSpan.appendChild(settingsLink);
    hlContainer.parentNode.insertBefore(settingsSpan, hlContainer.nextSibling);

    // ── Countdown override ──

    setupCountdown();
  }

  var countdownTimer = null;

  function setupCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }

    var customSec = getRefreshInterval();
    var refreshEl = document.getElementById('refresh') || document.getElementById('refresh-orig');

    if (!customSec || !refreshEl) return;

    // Find the parent text around <strong id="refresh"> (e.g. "obnovení: <strong>5</strong>")
    var parentNode = refreshEl.parentNode;

    // Remove the original element so native JS can no longer update it
    // Rename the id so native script loses track
    refreshEl.id = 'refresh-orig';

    if (customSec === 1) {
      // Hide the entire "obnovení: X" area
      // Walk backwards from refreshEl to find "obnovení:" text node
      var prev = refreshEl.previousSibling;
      while (prev) {
        var prevPrev = prev.previousSibling;
        if (prev.nodeType === Node.TEXT_NODE && /obnoven/i.test(prev.textContent)) {
          prev.textContent = prev.textContent.replace(/obnoven\u00ed:\s*/i, '');
          break;
        }
        prev = prevPrev;
      }
      refreshEl.style.display = 'none';

      // Silent 1s refresh
      countdownTimer = setInterval(function () {
        try {
          if (window.top.roomframe && window.top.roomframe.dataframe && window.top.roomframe.dataframe.refresh) {
            window.top.roomframe.dataframe.refresh();
          }
        } catch {}
      }, 1000);
    } else {
      // Replace counter with own countdown
      var counter = customSec;
      refreshEl.textContent = String(counter);

      countdownTimer = setInterval(function () {
        counter--;
        if (counter <= 0) {
          counter = customSec;
          try {
            if (window.top.roomframe && window.top.roomframe.dataframe && window.top.roomframe.dataframe.refresh) {
              window.top.roomframe.dataframe.refresh();
            }
          } catch {}
        }
        refreshEl.textContent = String(counter);
      }, 1000);
    }
  }

  // ── Settings modal (shown from infopage) ──

  function showSettingsModal() {
    var targetDoc = findBoardDoc() || document;
    var existing = targetDoc.querySelector('.xchat-greet-modal-overlay');
    if (existing) existing.remove();

    // Inject modal styles into infopage if not present
    if (!targetDoc.getElementById('xchat-settings-modal-styles')) {
      var s = targetDoc.createElement('style');
      s.id = 'xchat-settings-modal-styles';
      s.textContent = [
        '.xchat-greet-modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 99999; display: flex; align-items: center; justify-content: center; }',
        '.xchat-greet-modal { background: #fff; border: 1px solid #999; border-radius: 6px; padding: 12px 16px; min-width: 360px; max-height: 80vh; overflow-y: auto; font-family: arial, sans-serif; font-size: 12px; }',
        '.xchat-greet-modal h4 { margin: 0 0 8px 0; font-size: 13px; }',
        '.xchat-greet-modal h5 { margin: 10px 0 6px 0; font-size: 12px; border-top: 1px solid #ddd; padding-top: 8px; }',
        '.xchat-greet-modal label { font-size: 11px; margin-right: 4px; }',
        '.xchat-greet-modal input[type="text"] { width: 180px; padding: 2px 4px; font-size: 11px; margin-bottom: 4px; }',
        '.xchat-greet-modal select { font-size: 11px; padding: 2px; }',
        '.xchat-greet-modal-buttons { text-align: right; margin-top: 10px; }',
        '.xchat-greet-modal-buttons button { margin-left: 6px; padding: 3px 10px; font-size: 11px; cursor: pointer; }',
        '.xchat-settings-row { display: flex; align-items: center; gap: 4px; margin-bottom: 3px; }',
        '.xchat-settings-row .nick-label { font-weight: bold; min-width: 80px; font-size: 11px; }',
        '.xchat-settings-delete { cursor: pointer; color: #c00; font-size: 13px; margin-left: 4px; }',
      ].join('\n');
      targetDoc.head.appendChild(s);
    }

    var overlay = targetDoc.createElement('div');
    overlay.className = 'xchat-greet-modal-overlay';

    var modal = targetDoc.createElement('div');
    modal.className = 'xchat-greet-modal';

    var h4 = targetDoc.createElement('h4');
    h4.textContent = 'Nastaven\u00ed';
    modal.appendChild(h4);

    // ── Greet buttons toggle ──
    var h5b = targetDoc.createElement('h5');
    h5b.textContent = 'Tla\u010d\u00edtka pozdrav\u016f';
    modal.appendChild(h5b);

    var greetBtnRow = targetDoc.createElement('div');
    var greetBtnCheckbox = targetDoc.createElement('input');
    greetBtnCheckbox.type = 'checkbox';
    greetBtnCheckbox.id = 'xchat-greet-btn-toggle';
    greetBtnCheckbox.checked = areGreetButtonsEnabled();
    greetBtnRow.appendChild(greetBtnCheckbox);
    var greetBtnLabel = targetDoc.createElement('label');
    greetBtnLabel.htmlFor = 'xchat-greet-btn-toggle';
    greetBtnLabel.textContent = ' Zobrazovat tla\u010d\u00edtka pro pozdravy na skle';
    greetBtnLabel.style.cssText = 'font-size: 11px; cursor: pointer;';
    greetBtnRow.appendChild(greetBtnLabel);
    modal.appendChild(greetBtnRow);

    // ── Greetings section ──
    var h5g = targetDoc.createElement('h5');
    h5g.textContent = 'Vlastn\u00ed pozdravy';
    modal.appendChild(h5g);

    var allGreetings = getAllGreetings();
    var greetInputs = {};
    var greetingsContainer = targetDoc.createElement('div');

    function renderGreetingRows() {
      greetingsContainer.innerHTML = '';
      greetInputs = {};
      var nicks = Object.keys(allGreetings).sort();
      if (nicks.length === 0) {
        var p = targetDoc.createElement('p');
        p.textContent = '(\u017e\u00e1dn\u00e9 pozdravy)';
        p.style.cssText = 'color: #999; font-style: italic; margin: 4px 0;';
        greetingsContainer.appendChild(p);
        return;
      }
      for (var i = 0; i < nicks.length; i++) {
        var nick = nicks[i];
        var row = targetDoc.createElement('div');
        row.className = 'xchat-settings-row';

        var lbl = targetDoc.createElement('span');
        lbl.className = 'nick-label';
        lbl.textContent = nick + ':';
        row.appendChild(lbl);

        var inp = targetDoc.createElement('input');
        inp.type = 'text';
        inp.value = allGreetings[nick];
        inp.maxLength = 200;
        inp.dataset.nick = nick;
        row.appendChild(inp);
        greetInputs[nick] = inp;

        var del = targetDoc.createElement('span');
        del.className = 'xchat-settings-delete';
        del.textContent = '\u00d7';
        del.title = 'Smazat pozdrav pro ' + nick;
        del.dataset.nick = nick;
        del.addEventListener('click', function () {
          var n = this.dataset.nick;
          delete allGreetings[n];
          renderGreetingRows();
        });
        row.appendChild(del);

        greetingsContainer.appendChild(row);
      }
    }

    renderGreetingRows();
    modal.appendChild(greetingsContainer);

    // Add new greeting row
    var addRow = targetDoc.createElement('div');
    addRow.className = 'xchat-settings-row';
    addRow.style.cssText = 'margin-top: 6px;';

    var addNickInp = targetDoc.createElement('input');
    addNickInp.type = 'text';
    addNickInp.placeholder = 'Nick';
    addNickInp.style.cssText = 'width: 80px; padding: 2px 4px; font-size: 11px;';
    addRow.appendChild(addNickInp);

    var addGreetInp = targetDoc.createElement('input');
    addGreetInp.type = 'text';
    addGreetInp.placeholder = 'Pozdrav (nap\u0159. Ahoj *22*)';
    addGreetInp.style.cssText = 'width: 180px; padding: 2px 4px; font-size: 11px; margin-left: 4px;';
    addGreetInp.maxLength = 200;
    addRow.appendChild(addGreetInp);

    var addBtn = targetDoc.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = '+';
    addBtn.title = 'P\u0159idat pozdrav';
    addBtn.style.cssText = 'margin-left: 4px; font-size: 11px; cursor: pointer; padding: 1px 6px;';
    addBtn.addEventListener('click', function () {
      var nick = addNickInp.value.trim();
      var greet = addGreetInp.value.trim();
      if (!nick) { addNickInp.focus(); return; }
      if (!greet) { addGreetInp.focus(); return; }
      allGreetings[nick] = greet;
      renderGreetingRows();
      addNickInp.value = '';
      addGreetInp.value = '';
      addNickInp.focus();
    });
    addRow.appendChild(addBtn);
    modal.appendChild(addRow);

    var deleteAllBtn = targetDoc.createElement('button');
    deleteAllBtn.type = 'button';
    deleteAllBtn.textContent = 'Smazat v\u0161echny pozdravy';
    deleteAllBtn.style.cssText = 'margin-top: 6px; font-size: 11px; cursor: pointer; color: #c00;';
    deleteAllBtn.addEventListener('click', function () {
      allGreetings = {};
      renderGreetingRows();
    });
    modal.appendChild(deleteAllBtn);

    // ── Hide bad commands toggle ──
    var badCmdRow = targetDoc.createElement('div');
    badCmdRow.style.cssText = 'margin-top: 6px;';
    var badCmdCheckbox = targetDoc.createElement('input');
    badCmdCheckbox.type = 'checkbox';
    badCmdCheckbox.id = 'xchat-hide-badcmd-toggle';
    badCmdCheckbox.checked = isHideBadCommands();
    badCmdRow.appendChild(badCmdCheckbox);
    var badCmdLabel = targetDoc.createElement('label');
    badCmdLabel.htmlFor = 'xchat-hide-badcmd-toggle';
    badCmdLabel.textContent = ' Skr\u00fdt nepoveden\u00e9 p\u0159\u00edkazy';
    badCmdLabel.style.cssText = 'font-size: 11px; cursor: pointer;';
    badCmdRow.appendChild(badCmdLabel);
    modal.appendChild(badCmdRow);

    // ── Kick highlight toggle ──
    var kickRow = targetDoc.createElement('div');
    kickRow.style.cssText = 'margin-top: 6px;';
    var kickCheckbox = targetDoc.createElement('input');
    kickCheckbox.type = 'checkbox';
    kickCheckbox.id = 'xchat-kick-highlight-toggle';
    kickCheckbox.checked = isKickHighlightOn();
    kickRow.appendChild(kickCheckbox);
    var kickLabel = targetDoc.createElement('label');
    kickLabel.htmlFor = 'xchat-kick-highlight-toggle';
    kickLabel.textContent = ' Zv\u00fdraznit kicky \u010derven\u011b';
    kickLabel.style.cssText = 'font-size: 11px; cursor: pointer;';
    kickRow.appendChild(kickLabel);
    modal.appendChild(kickRow);

    // ── History toggle ──
    var h5h = targetDoc.createElement('h5');
    h5h.textContent = 'Historie';
    modal.appendChild(h5h);

    var histRow = targetDoc.createElement('div');
    var histCheckbox = targetDoc.createElement('input');
    histCheckbox.type = 'checkbox';
    histCheckbox.id = 'xchat-history-toggle';
    histCheckbox.checked = isHistoryEnabled();
    histRow.appendChild(histCheckbox);
    var histLabel = targetDoc.createElement('label');
    histLabel.htmlFor = 'xchat-history-toggle';
    histLabel.textContent = ' Ukl\u00e1dat lok\u00e1ln\u011b historii';
    histLabel.style.cssText = 'font-size: 11px; cursor: pointer;';
    histRow.appendChild(histLabel);

    var histDeleteBtn = targetDoc.createElement('button');
    histDeleteBtn.type = 'button';
    histDeleteBtn.textContent = 'Smazat ve\u0161kerou historii';
    histDeleteBtn.style.cssText = 'margin-left: 10px; font-size: 11px; cursor: pointer; color: #fff; background: #c00; border: 1px solid #900; border-radius: 3px; padding: 2px 8px;';
    histDeleteBtn.addEventListener('click', function () {
      if (confirm('Opravdu smazat ve\u0161kerou ulo\u017eenou historii?')) {
        dbClearAll().then(function () {
          histDeleteBtn.textContent = 'Smaz\u00e1no!';
          setTimeout(function () { histDeleteBtn.textContent = 'Smazat ve\u0161kerou historii'; }, 2000);
        });
      }
    });
    histRow.appendChild(histDeleteBtn);
    modal.appendChild(histRow);

    // ── Refresh section ──
    var h5r = targetDoc.createElement('h5');
    h5r.textContent = 'Obnoven\u00ed skla';
    modal.appendChild(h5r);

    var refreshRow = targetDoc.createElement('div');
    var refreshLabel = targetDoc.createElement('label');
    refreshLabel.textContent = 'Interval: ';
    refreshRow.appendChild(refreshLabel);

    var sel = targetDoc.createElement('select');
    var currentRefresh = getRefreshInterval();
    var defaultOpt = targetDoc.createElement('option');
    defaultOpt.value = '0';
    defaultOpt.textContent = 'v\u00fdchoz\u00ed (server)';
    if (!currentRefresh) defaultOpt.selected = true;
    sel.appendChild(defaultOpt);
    for (var r = 0; r < REFRESH_OPTIONS.length; r++) {
      var opt = targetDoc.createElement('option');
      opt.value = String(REFRESH_OPTIONS[r]);
      opt.textContent = REFRESH_OPTIONS[r] + ' s';
      if (currentRefresh === REFRESH_OPTIONS[r]) opt.selected = true;
      sel.appendChild(opt);
    }
    refreshRow.appendChild(sel);
    modal.appendChild(refreshRow);

    // ── Buttons ──
    var btns = targetDoc.createElement('div');
    btns.className = 'xchat-greet-modal-buttons';

    var cancelBtn = targetDoc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Zru\u0161it';
    cancelBtn.addEventListener('click', function () { overlay.remove(); });

    var saveBtn = targetDoc.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Ulo\u017eit';
    saveBtn.addEventListener('click', function () {
      // Save greetings
      var newData = {};
      for (var nick in greetInputs) {
        var val = greetInputs[nick].value.trim();
        if (val) newData[nick] = val;
      }
      // Save all settings at once
      var s = getSettings();
      s.greetings = newData;
      s.greetButtons = greetBtnCheckbox.checked;
      s.kickHighlight = kickCheckbox.checked;
      s.hideBadCommands = badCmdCheckbox.checked;
      s.historyEnabled = histCheckbox.checked;
      s.highlight = getSetting('highlight', false);
      s.refreshInterval = parseInt(sel.value, 10) || 0;
      saveSettings(s);

      // Apply CSS changes
      applyKickHighlight(kickCheckbox.checked);
      applyHideBadCommands(badCmdCheckbox.checked);

      overlay.remove();
      // Restart countdown in infopage
      try {
        setupCountdown();
      } catch {}
    });

    btns.appendChild(cancelBtn);
    btns.appendChild(saveBtn);
    modal.appendChild(btns);
    overlay.appendChild(modal);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });

    targetDoc.body.appendChild(overlay);
  }

  // ── Auto-refresh ──

  var autoRefreshTimer = null;

  function startAutoRefresh() {
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
    var sec = getRefreshInterval();
    if (!sec) return;
    autoRefreshTimer = setInterval(function () {
      try {
        if (window.top.roomframe && window.top.roomframe.dataframe && window.top.roomframe.dataframe.refresh) {
          window.top.roomframe.dataframe.refresh();
        }
      } catch {}
    }, sec * 1000);
  }

  // ── History page ──

  function getHistoryRoomId() {
    try {
      var path = window.top.location.pathname;
      var m = path.match(/\/([^/]+)\/modchat/);
      if (m) return m[1];
    } catch {}
    try {
      var p = location.pathname;
      var m2 = p.match(/\/([^/]+)\/history\.html/);
      if (m2) return m2[1];
    } catch {}
    return '';
  }

  function formatTime(d) {
    var h = String(d.getHours()).padStart(2, '0');
    var m = String(d.getMinutes()).padStart(2, '0');
    var s = String(d.getSeconds()).padStart(2, '0');
    return h + ':' + m + ':' + s;
  }

  function formatDate(d) {
    return d.getDate() + '.' + (d.getMonth() + 1) + '.' + d.getFullYear();
  }

  function formatDateTimeInput(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + 'T' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function msgTypeLabel(t) {
    var map = {
      room: 'M\u00edstnost', room_out: 'M\u00edstnost (odchoz\u00ed)',
      whisper: '\u0160ept\u00e1n\u00ed', whisper_out: '\u0160ept\u00e1n\u00ed (odchoz\u00ed)',
      system: 'Syst\u00e9m', system_out: 'Syst\u00e9m',
      advert: 'Reklama'
    };
    return map[t] || t;
  }

  function htmlWithSmileys(html) {
    return html.replace(/\*(\d+)\*/g, function (match, num) {
      var id = parseInt(num, 10);
      var bucket = id % 100;
      return '<img class="smiley" src="https://x.ximg.cz/images/x4/sm/' + bucket + '/' + id + '.gif" alt="*' + id + '*" title="*' + id + '*">';
    });
  }

  function recToPlaintext(rec, showDate) {
    var ts = new Date(rec.timestamp);
    var time = showDate ? formatDate(ts) + ' ' + formatTime(ts) : formatTime(ts);
    var from = rec.sender || '?';
    var to = rec.recipient || '~';
    var arrow = rec.is_whisper ? '->' : ':';
    var prefix = to === '~' ? from + ':' : from + '->' + to + ':';
    return time + ' ' + prefix + ' ' + (rec.content_text || '');
  }

  function initHistoryPage() {
    var defaultRoom = getHistoryRoomId();

    document.title = 'Historie zpr\u00e1v';
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin: 0; padding: 0; font-family: arial, helvetica, sans-serif; font-size: 12px; background: #f4f4f4; color: #333;';

    var style = document.createElement('style');
    style.textContent = [
      '* { box-sizing: border-box; }',
      '.hist-toolbar { background: #e8e8e8; border-bottom: 1px solid #ccc; padding: 8px 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }',
      '.hist-toolbar label { font-size: 11px; font-weight: bold; white-space: nowrap; }',
      '.hist-toolbar input, .hist-toolbar select { font-size: 11px; padding: 2px 4px; border: 1px solid #aaa; border-radius: 3px; }',
      '.hist-toolbar input[type="text"] { width: 100px; }',
      '.hist-toolbar input[type="datetime-local"] { width: 160px; }',
      '.hist-toolbar button { font-size: 11px; padding: 3px 10px; cursor: pointer; border: 1px solid #888; border-radius: 3px; background: #ddd; }',
      '.hist-toolbar button:hover { background: #ccc; }',
      '.hist-toolbar .hist-toggle { display: inline-flex; gap: 2px; }',
      '.hist-toolbar .hist-toggle span { font-size: 11px; padding: 2px 6px; border: 1px solid #aaa; cursor: pointer; background: #fff; border-radius: 3px; }',
      '.hist-toolbar .hist-toggle span.active { background: #4a90d9; color: #fff; border-color: #3a70b0; font-weight: bold; }',
      '.hist-actions { background: #e8e8e8; border-bottom: 1px solid #ccc; padding: 6px 12px; display: flex; gap: 6px; align-items: center; }',
      '.hist-actions button { font-size: 11px; padding: 3px 10px; cursor: pointer; border-radius: 3px; border: 1px solid #888; }',
      '.hist-actions .btn-export { background: #4a90d9; color: #fff; border-color: #3a70b0; }',
      '.hist-actions .btn-export:hover { background: #3a7bc8; }',
      '.hist-actions .btn-delete { background: #c00; color: #fff; border-color: #900; }',
      '.hist-actions .btn-delete:hover { background: #a00; }',
      '.hist-actions .hist-status { font-size: 11px; color: #666; margin-left: auto; }',
      '.hist-results { padding: 8px 12px; }',
      '.hist-msg { padding: 2px 0; line-height: 1.5; }',
      '.hist-msg .ht { color: #888; font-size: 11px; }',
      '.hist-msg .hs { font-weight: bold; }',
      '.hist-msg .hs-system { color: #666; }',
      '.hist-msg .hs-whisper { color: #906; }',
      '.hist-msg .hs-room { color: #006; }',
      '.hist-msg .hs-advert { color: #999; }',
      '.hist-msg .hc { }',
      '.hist-msg .highlight { background: yellow; }',
      '.hist-msg img.smiley { height: 15px; vertical-align: middle; }',
      '.hist-empty { padding: 20px; text-align: center; color: #999; font-style: italic; }',
    ].join('\n');
    document.head.appendChild(style);

    // ── Toolbar ──
    var toolbar = document.createElement('div');
    toolbar.className = 'hist-toolbar';

    function makeField(labelText, el) {
      var lbl = document.createElement('label');
      lbl.textContent = labelText;
      toolbar.appendChild(lbl);
      toolbar.appendChild(el);
      return el;
    }

    function makeToggle(labelText, options, defaultVal) {
      var lbl = document.createElement('label');
      lbl.textContent = labelText;
      toolbar.appendChild(lbl);
      var wrap = document.createElement('span');
      wrap.className = 'hist-toggle';
      var currentVal = defaultVal;
      var spans = [];
      for (var i = 0; i < options.length; i++) {
        var sp = document.createElement('span');
        sp.textContent = options[i].label;
        sp.dataset.val = options[i].value;
        if (options[i].value === defaultVal) sp.className = 'active';
        sp.addEventListener('click', function () {
          currentVal = this.dataset.val;
          for (var j = 0; j < spans.length; j++) spans[j].className = spans[j].dataset.val === currentVal ? 'active' : '';
        });
        spans.push(sp);
        wrap.appendChild(sp);
      }
      toolbar.appendChild(wrap);
      return { get: function () { return currentVal; } };
    }

    var inpSender = document.createElement('input');
    inpSender.type = 'text';
    inpSender.placeholder = 'v\u0161e';
    makeField('Odes\u00edlatel:', inpSender);

    var inpRecipient = document.createElement('input');
    inpRecipient.type = 'text';
    inpRecipient.placeholder = 'v\u0161e';
    makeField('P\u0159\u00edjemce:', inpRecipient);

    var whisperToggle = makeToggle('\u0160ept\u00e1n\u00ed:', [
      { label: 'V\u0161e', value: '' },
      { label: 'Ano', value: 'yes' },
      { label: 'Ne', value: 'no' }
    ], '');

    var selType = document.createElement('select');
    var types = ['', 'room', 'room_out', 'whisper', 'whisper_out', 'system', 'advert'];
    var typeLabels = ['V\u0161e', 'M\u00edstnost', 'M\u00edstnost (odchoz\u00ed)', '\u0160ept\u00e1n\u00ed', '\u0160ept\u00e1n\u00ed (odchoz\u00ed)', 'Syst\u00e9m', 'Reklama'];
    for (var t = 0; t < types.length; t++) {
      var o = document.createElement('option');
      o.value = types[t];
      o.textContent = typeLabels[t];
      selType.appendChild(o);
    }
    makeField('Typ:', selType);

    var inpContent = document.createElement('input');
    inpContent.type = 'text';
    inpContent.placeholder = 'hledat...';
    makeField('Zpr\u00e1va:', inpContent);

    var inpFrom = document.createElement('input');
    inpFrom.type = 'datetime-local';
    makeField('Od:', inpFrom);

    var inpTo = document.createElement('input');
    inpTo.type = 'datetime-local';
    makeField('Do:', inpTo);

    var inpRoom = document.createElement('input');
    inpRoom.type = 'text';
    inpRoom.value = defaultRoom;
    inpRoom.style.width = '80px';
    makeField('M\u00edstnost:', inpRoom);

    var highlightToggle = makeToggle('Zv\u00fdraznit nick:', [
      { label: 'Ne', value: 'no' },
      { label: 'Ano', value: 'yes' }
    ], 'no');

    var dateToggle = makeToggle('Zobrazit datum:', [
      { label: 'Ne', value: 'no' },
      { label: 'Ano', value: 'yes' }
    ], 'no');

    var searchBtn = document.createElement('button');
    searchBtn.textContent = 'Hledat';
    searchBtn.style.cssText = 'background: #4a90d9; color: #fff; border-color: #3a70b0; font-weight: bold;';
    toolbar.appendChild(searchBtn);

    document.body.appendChild(toolbar);

    // ── Actions bar ──
    var actions = document.createElement('div');
    actions.className = 'hist-actions';

    var exportJsonBtn = document.createElement('button');
    exportJsonBtn.className = 'btn-export';
    exportJsonBtn.textContent = 'Exportovat do JSON';
    actions.appendChild(exportJsonBtn);

    var exportTextBtn = document.createElement('button');
    exportTextBtn.className = 'btn-export';
    exportTextBtn.textContent = 'Exportovat v plaintext';
    actions.appendChild(exportTextBtn);

    var deleteFilteredBtn = document.createElement('button');
    deleteFilteredBtn.className = 'btn-delete';
    deleteFilteredBtn.textContent = 'Smazat zobrazen\u00e9';
    actions.appendChild(deleteFilteredBtn);

    var statusEl = document.createElement('span');
    statusEl.className = 'hist-status';
    actions.appendChild(statusEl);

    document.body.appendChild(actions);

    // ── Results ──
    var resultsDiv = document.createElement('div');
    resultsDiv.className = 'hist-results';
    document.body.appendChild(resultsDiv);

    var currentResults = [];

    function getFilters() {
      var f = {};
      if (inpRoom.value.trim()) f.room_id = inpRoom.value.trim();
      if (inpSender.value.trim()) f.sender = inpSender.value.trim();
      if (inpRecipient.value.trim()) f.recipient = inpRecipient.value.trim();
      if (selType.value) f.message_type = selType.value;
      var wv = whisperToggle.get();
      if (wv === 'yes') f.is_whisper = true;
      else if (wv === 'no') f.is_whisper = false;
      if (inpContent.value.trim()) f.content_search = inpContent.value.trim();
      if (inpFrom.value) f.date_from = new Date(inpFrom.value);
      if (inpTo.value) f.date_to = new Date(inpTo.value);
      return f;
    }

    function renderResults(results) {
      currentResults = results;
      resultsDiv.innerHTML = '';
      statusEl.textContent = 'Nalezeno: ' + results.length + ' zpr\u00e1v';

      if (results.length === 0) {
        resultsDiv.innerHTML = '<div class="hist-empty">\u017d\u00e1dn\u00e9 zpr\u00e1vy nenalezeny.</div>';
        return;
      }

      var showDate = dateToggle.get() === 'yes';
      var doHighlight = highlightToggle.get() === 'yes';
      var myNick = '';
      if (doHighlight) {
        try {
          var bd = findBoardDoc();
          if (bd) {
            var el = bd.querySelector('.umsg_hmynicki');
            if (el) myNick = el.textContent.trim();
            if (!myNick) {
              var mm = bd.querySelector('.umsg_roomi b');
              if (mm) myNick = mm.textContent.trim().replace(/:$/, '');
            }
          }
        } catch {}
        if (!myNick && CONFIG.myNick) myNick = CONFIG.myNick;
      }

      var frag = document.createDocumentFragment();
      for (var i = 0; i < results.length; i++) {
        var rec = results[i];
        var ts = new Date(rec.timestamp);
        var row = document.createElement('div');
        row.className = 'hist-msg';

        var timeText = showDate ? formatDate(ts) + ' ' + formatTime(ts) : formatTime(ts);
        var timeSpan = '<span class="ht">' + escapeHtml(timeText) + '</span> ';

        var senderClass = 'hs';
        if (rec.message_type === 'system' || rec.message_type === 'system_out') senderClass += ' hs-system';
        else if (rec.is_whisper) senderClass += ' hs-whisper';
        else if (rec.message_type === 'advert') senderClass += ' hs-advert';
        else senderClass += ' hs-room';

        var senderHtml;
        if (rec.recipient && rec.recipient !== '~') {
          senderHtml = '<span class="' + senderClass + '">' + escapeHtml(rec.sender) + '-&gt;' + escapeHtml(rec.recipient) + ':</span> ';
        } else {
          senderHtml = '<span class="' + senderClass + '">' + escapeHtml(rec.sender) + ':</span> ';
        }

        var contentHtml = htmlWithSmileys(escapeHtml(rec.content_text || ''));

        if (doHighlight && myNick) {
          var re = new RegExp('(' + myNick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
          contentHtml = contentHtml.replace(re, '<span class="highlight">$1</span>');
        }

        row.innerHTML = timeSpan + senderHtml + '<span class="hc">' + contentHtml + '</span>';
        frag.appendChild(row);
      }
      resultsDiv.appendChild(frag);
    }

    function doSearch() {
      statusEl.textContent = 'Na\u010d\u00edt\u00e1n\u00ed...';
      resultsDiv.innerHTML = '';
      var filters = getFilters();
      dbQuery(filters).then(function (results) {
        results.sort(function (a, b) { return new Date(a.timestamp) - new Date(b.timestamp); });
        renderResults(results);
      }).catch(function (err) {
        statusEl.textContent = 'Chyba: ' + err;
      });
    }

    searchBtn.addEventListener('click', doSearch);

    // ── Export JSON ──
    exportJsonBtn.addEventListener('click', function () {
      if (!currentResults.length) return;
      var json = JSON.stringify(currentResults, null, 2);
      navigator.clipboard.writeText(json).then(function () {
        exportJsonBtn.textContent = 'Zkop\u00edrov\u00e1no!';
        setTimeout(function () { exportJsonBtn.textContent = 'Exportovat do JSON'; }, 2000);
      });
    });

    // ── Export plaintext ──
    exportTextBtn.addEventListener('click', function () {
      if (!currentResults.length) return;
      var showDate = dateToggle.get() === 'yes';
      var lines = currentResults.map(function (r) { return recToPlaintext(r, showDate); });
      navigator.clipboard.writeText(lines.join('\n')).then(function () {
        exportTextBtn.textContent = 'Zkop\u00edrov\u00e1no!';
        setTimeout(function () { exportTextBtn.textContent = 'Exportovat v plaintext'; }, 2000);
      });
    });

    // ── Delete filtered ──
    deleteFilteredBtn.addEventListener('click', function () {
      if (!currentResults.length) return;
      if (!confirm('Opravdu smazat ' + currentResults.length + ' zobrazen\u00fdch zpr\u00e1v?')) return;
      var ids = currentResults.map(function (r) { return r.id; });
      dbDeleteByIds(ids).then(function () {
        deleteFilteredBtn.textContent = 'Smaz\u00e1no!';
        setTimeout(function () { deleteFilteredBtn.textContent = 'Smazat zobrazen\u00e9'; }, 2000);
        doSearch();
      });
    });

    // Auto-search on load
    doSearch();
  }

  // ── Startframe: greet buttons + board ──

  function initStartframe() {
    injectStyles();
    processAll();
    restoreBoardFilter();
    restoreHighlight();
    restoreKickHighlight();
    markAllBadCommands();
    restoreHideBadCommands();
    captureAllDivs();

    const board = document.getElementById('board');
    if (!board) return;

    const observer = new MutationObserver(function (mutations) {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'DIV') {
            processEntryDiv(node);
            markBadCommandDiv(node);
            captureDiv(node);
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
    else if (/history\.html/.test(location.pathname)) initHistoryPage();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
