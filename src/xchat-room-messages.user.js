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

  function getWhisperMode() {
    return getSetting('whisperMode', 'popup');
  }

  function getFwNewestFirst() {
    return getSetting('fwNewestFirst', true);
  }

  function setCustomGreeting(nick, text) {
    var data = getGreetings();
    if (text) data[nick] = text;
    else delete data[nick];
    setSetting('greetings', data);
  }

  // ── IndexedDB ──

  var DB_NAME = 'xchat_room_messages';
  var DB_VERSION = 2;
  var STORE_NAME = 'messages';

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        var store;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          store.createIndex('room_id', 'room_id', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('message_type', 'message_type', { unique: false });
          store.createIndex('sender', 'sender', { unique: false });
          store.createIndex('recipient', 'recipient', { unique: false });
          store.createIndex('is_whisper', 'is_whisper', { unique: false });
          store.createIndex('room_timestamp', ['room_id', 'timestamp'], { unique: false });
        } else {
          store = e.target.transaction.objectStore(STORE_NAME);
        }
        if (!store.indexNames.contains('fingerprint')) {
          store.createIndex('fingerprint', 'fingerprint', { unique: true });
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
        req.onerror = function (e) {
          if (req.error && req.error.name === 'ConstraintError') {
            e.preventDefault();
            resolve(null);
          } else {
            reject(req.error);
          }
        };
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
    return getSetting('historyEnabled', true);
  }

  // ── Message parsing ──

  function getRoomId() {
    try { if (window.top._xchatRoomId) return String(window.top._xchatRoomId); } catch {}
    var stored = getSetting('currentRoomId', '');
    if (stored) return String(stored);
    return 'unknown';
  }

  function parseBoardDiv(div) {
    var timeStr = '';
    var timeEl = div.querySelector('.systemtime');
    if (timeEl) {
      timeStr = timeEl.textContent.trim();
    } else {
      var tm = div.textContent.match(/(\d{1,2}:\d{2}:\d{2})/);
      if (tm) timeStr = tm[1];
    }

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

  function msgFingerprint(rec) {
    return rec.room_id + '|' + rec.timestamp.getTime() + '|' + rec.sender + '|' + rec.recipient + '|' + rec.content_text;
  }

  function captureDiv(div) {
    if (div.dataset.xchatHistCaptured) return;
    div.dataset.xchatHistCaptured = '1';
    if (!isHistoryEnabled()) return;
    var rec = parseBoardDiv(div);
    if (!rec) return;
    rec.fingerprint = msgFingerprint(rec);
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

    btns.appendChild(saveBtn);
    btns.appendChild(cancelBtn);
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

  // ── Floating whisper windows ──

  var floatingWindows = {}; // keyed by normalized nick
  var FW_STATE_KEY = '_xchat_fw_state';
  var FW_HISTORY_KEY = '_xchat_fw_history';
  var FW_HISTORY_MAX = 1000;

  function getFloatingState() {
    try { return JSON.parse(localStorage.getItem(FW_STATE_KEY) || '{}'); } catch { return {}; }
  }

  function getWhisperHistory() {
    try {
      var data = JSON.parse(localStorage.getItem(FW_HISTORY_KEY) || '[]');
      return Array.isArray(data) ? data : [];
    } catch { return []; }
  }

  function saveWhisperHistory(list) {
    // Keep only last FW_HISTORY_MAX entries
    if (list.length > FW_HISTORY_MAX) list = list.slice(list.length - FW_HISTORY_MAX);
    try { localStorage.setItem(FW_HISTORY_KEY, JSON.stringify(list)); } catch {}
  }

  function touchWhisperHistory(nick) {
    var list = getWhisperHistory();
    var key = normNick(nick);
    var now = Date.now();
    var found = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === key) {
        list[i].nick = nick;
        list[i].updated_at = now;
        found = true;
        break;
      }
    }
    if (!found) list.push({ key: key, nick: nick, updated_at: now });
    // Sort newest first
    list.sort(function (a, b) { return b.updated_at - a.updated_at; });
    saveWhisperHistory(list);
  }

  function saveFloatingState() {
    var state = {};
    for (var k in floatingWindows) {
      if (floatingWindows.hasOwnProperty(k)) {
        state[k] = {
          nick: floatingWindows[k].origNick || k,
          minimized: floatingWindows[k].el.classList.contains('xchat-fw-minimized')
        };
      }
    }
    try { localStorage.setItem(FW_STATE_KEY, JSON.stringify(state)); } catch {}
  }

  function getFloatingContainer() {
    var c = document.getElementById('xchat-fw-container');
    if (c) return c;
    c = document.createElement('div');
    c.id = 'xchat-fw-container';
    c.className = 'xchat-fw-container';
    document.body.appendChild(c);
    return c;
  }

  function getHeadsSidebar() {
    var s = document.getElementById('xchat-fw-heads');
    if (s) return s;
    s = document.createElement('div');
    s.id = 'xchat-fw-heads';
    s.className = 'xchat-fw-heads';
    document.body.appendChild(s);
    return s;
  }

  function getMaxHeads() {
    var sidebar = getHeadsSidebar();
    var available = sidebar.clientHeight || window.innerHeight - 20;
    return Math.floor(available / 52); // 40px head + 8px gap + 4px margin
  }

  function countMinimizedHeads() {
    var count = 0;
    for (var k in floatingWindows) {
      if (floatingWindows.hasOwnProperty(k) && floatingWindows[k].el.classList.contains('xchat-fw-minimized')) {
        count++;
      }
    }
    return count;
  }

  function normNick(n) {
    return n.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  }

  function getRoomName() {
    try {
      var rooms = getSetting('rooms', {});
      var rid = getRoomId();
      if (rooms[rid]) return rooms[rid];
    } catch {}
    return '';
  }

  function getAuthPath() {
    var auth = '';
    try { auth = window.top.my_auth || ''; } catch {}
    if (!auth) {
      var m = location.pathname.match(/(~[^/]+)/);
      if (m) auth = m[1];
    }
    return auth;
  }

  function buildWhisperBaseUrl(nick) {
    var auth = getAuthPath();
    var rid = 0;
    try { rid = window.top.rid || 0; } catch {}
    return location.protocol + '//www.xchat.cz/' + auth + '/modchat?op=whisperingframeset&rid=' + rid + '&wfrom=' + encodeURIComponent(nick);
  }

  function openFloatingWhisper(nick, startMinimized) {
    var key = normNick(nick);
    touchWhisperHistory(nick);
    refreshLauncherHistory();
    // If already open, un-minimize
    if (floatingWindows[key]) {
      floatingWindows[key].el.classList.remove('xchat-fw-minimized');
      saveFloatingState();
      return;
    }

    var container = getFloatingContainer();
    var framesetUrl = buildWhisperBaseUrl(nick);

    // Create the window shell immediately
    var fw = document.createElement('div');
    fw.className = 'xchat-fw';
    fw.dataset.nick = key;

    // ── Header ──
    var header = document.createElement('div');
    header.className = 'xchat-fw-header';

    var info = document.createElement('div');
    info.className = 'xchat-fw-header-info';

    var iconsSpan = document.createElement('span');
    iconsSpan.className = 'xchat-fw-icons';
    info.appendChild(iconsSpan);

    var texts = document.createElement('div');
    texts.className = 'xchat-fw-texts';

    var nickEl = document.createElement('div');
    nickEl.className = 'xchat-fw-nick';
    nickEl.textContent = nick;
    texts.appendChild(nickEl);

    var roomEl = document.createElement('div');
    roomEl.className = 'xchat-fw-room';
    var rn = getRoomName();
    roomEl.textContent = rn ? 'v m\u00edstnosti \u201e' + rn + '\u201c' : '';
    texts.appendChild(roomEl);

    info.appendChild(texts);
    header.appendChild(info);

    var btnsDiv = document.createElement('div');
    btnsDiv.className = 'xchat-fw-header-btns';

    // Minimize
    var minBtn = document.createElement('button');
    minBtn.className = 'xchat-fw-header-btn';
    minBtn.textContent = '\u2013';
    minBtn.title = 'Minimalizovat';
    minBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      fw.classList.toggle('xchat-fw-minimized');
      head.classList.toggle('xchat-fw-head-visible');
      saveFloatingState();
    });
    btnsDiv.appendChild(minBtn);

    // Popup
    var popBtn = document.createElement('button');
    popBtn.className = 'xchat-fw-header-btn';
    popBtn.innerHTML = '&#8599;';
    popBtn.title = 'Otev\u0159\u00edt ve vyskakovac\u00edm okn\u011b';
    popBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      try {
        var uid = window.top.uid || '';
        window.open(framesetUrl, uid + '_' + key, 'width=500,height=400,resizable=yes,scrolling=no,menubar=no,location=no,statusbar=no');
      } catch {}
      closeFloatingWhisper(key);
    });
    btnsDiv.appendChild(popBtn);

    // Close
    var closeBtn = document.createElement('button');
    closeBtn.className = 'xchat-fw-header-btn';
    closeBtn.textContent = '\u00d7';
    closeBtn.title = 'Zav\u0159\u00edt';
    closeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      closeFloatingWhisper(key);
    });
    btnsDiv.appendChild(closeBtn);

    header.appendChild(btnsDiv);
    header.addEventListener('click', function () {
      var wasMinimized = fw.classList.contains('xchat-fw-minimized');
      fw.classList.toggle('xchat-fw-minimized');
      head.classList.toggle('xchat-fw-head-visible');
      saveFloatingState();
      // Refresh messages when maximizing
      if (wasMinimized && floatingWindows[key] && floatingWindows[key].fetchMessages) {
        floatingWindows[key].fetchMessages();
      }
    });
    fw.appendChild(header);

    // ── Body (startframe iframe, filled after fetch) ──
    var body = document.createElement('div');
    body.className = 'xchat-fw-body';
    fw.appendChild(body);

    // ── Footer (textpageng iframe, filled after fetch) ──
    var footer = document.createElement('div');
    footer.className = 'xchat-fw-footer';
    fw.appendChild(footer);

    // ── Avatar head (shown when minimized) ──
    var head = document.createElement('div');
    head.className = 'xchat-fw-head';

    var headImg = document.createElement('img');
    headImg.className = 'xchat-fw-head-img';
    headImg.src = 'https://www.xchat.cz/whoiswho/perphoto.php?nick=' + encodeURIComponent(nick);
    headImg.alt = nick;
    head.appendChild(headImg);

    // Close button on head
    var headClose = document.createElement('span');
    headClose.className = 'xchat-fw-head-close';
    headClose.textContent = '\u00d7';
    headClose.addEventListener('click', function (e) {
      e.stopPropagation();
      closeFloatingWhisper(key);
    });
    head.appendChild(headClose);

    // Tooltip (shown on hover, to the left)
    var headTip = document.createElement('div');
    headTip.className = 'xchat-fw-head-tip';
    var headTipIcons = document.createElement('span');
    headTipIcons.className = 'xchat-fw-head-tip-icons';
    headTip.appendChild(headTipIcons);
    var headTipNick = document.createElement('span');
    headTipNick.textContent = nick;
    headTip.appendChild(headTipNick);
    head.appendChild(headTip);

    head.addEventListener('click', function () {
      fw.classList.remove('xchat-fw-minimized');
      head.classList.remove('xchat-fw-head-visible');
      saveFloatingState();
      // Refresh messages when maximizing from head
      if (floatingWindows[key] && floatingWindows[key].fetchMessages) {
        floatingWindows[key].fetchMessages();
      }
    });

    if (startMinimized) {
      fw.classList.add('xchat-fw-minimized');
      head.classList.add('xchat-fw-head-visible');
    }

    container.appendChild(fw);
    getHeadsSidebar().appendChild(head);

    // Store reference with room element for live updates
    floatingWindows[key] = { el: fw, head: head, roomEl: roomEl, origNick: nick, headTipIcons: headTipIcons, seenMsgKeys: {} };
    saveFloatingState();

    // ── Fetch frameset to extract individual frame URLs ──
    fetch(framesetUrl, { credentials: 'include' })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        // DOMParser discards <frame> tags, so parse with regex
        var roomtopUrl = '';
        var textpageUrl = '';
        var userpageUrl = '';
        var frameRe = /<frame\b[^>]*>/gi;
        var frameMatch;
        while ((frameMatch = frameRe.exec(html)) !== null) {
          var tag = frameMatch[0];
          var srcM = tag.match(/\bsrc="([^"]*)"/i);
          var nameM = tag.match(/\bname="([^"]*)"/i);
          var src = srcM ? srcM[1] : '';
          var name = nameM ? nameM[1] : '';
          if (name === 'roomframe' || /op=room(top|frame)ng/i.test(src)) roomtopUrl = src;
          else if (name === 'textpage' || /op=textpageng/i.test(src)) textpageUrl = src;
          else if (name === 'userpage' || /op=whisperuserpage/i.test(src)) userpageUrl = src;
        }

        // roomframe points to roomframeng (sub-frameset), we need roomtopng (actual content)
        if (roomtopUrl) {
          roomtopUrl = roomtopUrl.replace(/op=roomframeng/i, 'op=roomtopng');
        }

        // Make URLs absolute
        var base = location.protocol + '//www.xchat.cz/';
        if (roomtopUrl && !/^https?:/.test(roomtopUrl)) roomtopUrl = base + roomtopUrl.replace(/^\//, '');
        if (textpageUrl && !/^https?:/.test(textpageUrl)) textpageUrl = base + textpageUrl.replace(/^\//, '');
        if (userpageUrl && !/^https?:/.test(userpageUrl)) userpageUrl = base + userpageUrl.replace(/^\//, '');

        // Ensure js=0 in roomtop URL (no JS auto-refresh, plain HTML)
        if (roomtopUrl) {
          if (/[&?]js=\d+/.test(roomtopUrl)) {
            roomtopUrl = roomtopUrl.replace(/([&?]js=)\d+/, '$10');
          } else {
            roomtopUrl += (roomtopUrl.indexOf('?') >= 0 ? '&' : '?') + 'js=0';
          }
        }

        // ── Load messages from roomtopng via fetch+parse ──
        if (roomtopUrl) {
          // Create message container
          var msgContainer = document.createElement('div');
          msgContainer.className = 'xchat-fw-messages';
          body.innerHTML = '';
          body.appendChild(msgContainer);

          // Helper: create a DOM element for one message
          var createMsgEl = function (msg) {
            var msgEl = document.createElement('div');
            msgEl.className = 'xchat-fw-msg ' + (msg.cls === 'umsg_whwi' ? 'xchat-fw-msg-mine' : 'xchat-fw-msg-theirs');
            msgEl.dataset.key = msg.key;

            var timeSpan = document.createElement('span');
            timeSpan.className = 'xchat-fw-msg-time';
            timeSpan.textContent = msg.time;
            msgEl.appendChild(timeSpan);

            var nickSpan = document.createElement('span');
            nickSpan.className = 'xchat-fw-msg-nick';
            nickSpan.style.color = msg.color;
            nickSpan.textContent = msg.nick + ':';
            msgEl.appendChild(nickSpan);

            var textSpan = document.createElement('span');
            textSpan.className = 'xchat-fw-msg-text';
            // Preserve images (smileys) in text
            var tmpDiv = document.createElement('div');
            tmpDiv.innerHTML = msg.text;
            while (tmpDiv.firstChild) textSpan.appendChild(tmpDiv.firstChild);
            msgEl.appendChild(textSpan);

            return msgEl;
          };

          // Build fetch URL with cache-busting fake= param
          var buildFetchUrl = function () {
            var url = roomtopUrl;
            // Replace or add fake= timestamp
            if (/[&?]fake=/.test(url)) {
              url = url.replace(/([&?]fake=)\d+/, '$1' + Math.floor(Date.now() / 1000));
            } else {
              url += (url.indexOf('?') >= 0 ? '&' : '?') + 'fake=' + Math.floor(Date.now() / 1000);
            }
            return url;
          };

          var fetchAndUpdateMessages = function () {
            if (!floatingWindows[key]) return; // window was closed

            fetch(buildFetchUrl(), {
              method: 'GET',
              credentials: 'include',
              headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
              }
            })
              .then(function (r2) { return r2.text(); })
              .then(function (rfHtml) {
                if (!floatingWindows[key]) return;

                // The body contains nested <font> wrappers then messages separated by <br>
                // Structure: <body ...><font face="..."><font size="2">
                //   HH:MM:SS <font color="COLOR"><span class="umsg_whw|umsg_whwi"><b>Nick:</b> Text</span></font><br>
                //   ...
                // </font></font></body>
                // We extract the inner HTML and split on <br>
                var bodyMatch = rfHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
                if (!bodyMatch) return;
                var bodyInner = bodyMatch[1];

                // Strip outer <font> wrappers to get to message lines
                // Remove <font face="..."> and <font size="..."> opening tags, and their closing </font>
                var stripped = bodyInner
                  .replace(/<font\s+face="[^"]*">/gi, '')
                  .replace(/<font\s+size="[^"]*">/gi, '')
                  .replace(/<\/font>/gi, '');

                // Split on <br> to get individual message lines
                var lines = stripped.split(/<br\s*\/?>/gi);
                var parsedMsgs = [];

                for (var li = 0; li < lines.length; li++) {
                  var line = lines[li].trim();
                  if (!line) continue;

                  // Extract time at start
                  var timeMatch = line.match(/^(\d{1,2}:\d{2}:\d{2})\s*/);
                  if (!timeMatch) continue;
                  var time = timeMatch[1];

                  // Extract color from <font color="...">
                  var colorMatch = line.match(/<font\s+color="([^"]*)"/i);
                  var color = colorMatch ? colorMatch[1] : '#282828';

                  // Extract span class (umsg_whw = outgoing orange, umsg_whwi = incoming dark)
                  var spanMatch = line.match(/<span\s+class="([^"]*)">/i);
                  if (!spanMatch) continue;
                  var msgClass = spanMatch[1];

                  // Extract content inside <span ...>...</span>
                  var spanContentMatch = line.match(/<span\s+class="[^"]*">([\s\S]*?)<\/span>/i);
                  if (!spanContentMatch) continue;
                  var spanContent = spanContentMatch[1];

                  // Parse nick and text: <b>Nick:</b> Text
                  var nickTextMatch = spanContent.match(/<b>([^<]+):<\/b>\s*([\s\S]*)/i);
                  if (!nickTextMatch) continue;
                  var msgNick = nickTextMatch[1].trim();
                  var msgText = nickTextMatch[2].trim();
                  // Remove trailing </font> that might remain
                  msgText = msgText.replace(/<\/font>\s*$/i, '').trim();

                  // Unique key for deduplication
                  var msgKey = time + '|' + msgNick + '|' + msgText;

                  parsedMsgs.push({
                    key: msgKey,
                    time: time,
                    nick: msgNick,
                    text: msgText,
                    color: color,
                    cls: msgClass
                  });
                }

                // Server sends newest-first; reverse to get chronological (oldest-first)
                parsedMsgs.reverse();

                var seenKeys = floatingWindows[key].seenMsgKeys;
                var newestFirst = getFwNewestFirst();
                var wasScrolled;
                if (newestFirst) {
                  wasScrolled = msgContainer.scrollTop < 30; // at top = auto-position
                } else {
                  wasScrolled = msgContainer.scrollHeight - msgContainer.scrollTop - msgContainer.clientHeight < 30;
                }

                // Add only messages not already in DOM
                for (var mi = 0; mi < parsedMsgs.length; mi++) {
                  var msg = parsedMsgs[mi];
                  if (seenKeys[msg.key]) continue;
                  seenKeys[msg.key] = true;

                  var msgEl = createMsgEl(msg);
                  if (newestFirst) {
                    // Newest on top: prepend (newest = last in chronological = appended last → prepend each)
                    msgContainer.insertBefore(msgEl, msgContainer.firstChild);
                  } else {
                    // Newest on bottom: append
                    msgContainer.appendChild(msgEl);
                  }
                }

                // Auto-scroll
                if (wasScrolled) {
                  if (newestFirst) {
                    msgContainer.scrollTop = 0;
                  } else {
                    msgContainer.scrollTop = msgContainer.scrollHeight;
                  }
                }
              })
              .catch(function () {});
          };

          // Initial fetch
          fetchAndUpdateMessages();

          // Periodic polling (5 seconds)
          var pollTimer = setInterval(fetchAndUpdateMessages, 5000);
          floatingWindows[key].pollTimer = pollTimer;
          floatingWindows[key].fetchMessages = fetchAndUpdateMessages;
        }

        // ── Fetch textpage form data for sending ──
        if (textpageUrl) {
          fetch(textpageUrl, { credentials: 'include' })
            .then(function (r3) { return r3.text(); })
            .then(function (tpHtml) {
              if (!floatingWindows[key]) return;
              var tpDoc = new DOMParser().parseFromString(tpHtml, 'text/html');
              var form = tpDoc.querySelector('form');
              if (!form) return;
              var action = form.getAttribute('action') || '';
              if (action && !/^https?:/.test(action)) {
                action = base + action.replace(/^\//, '');
              }
              var hiddenFields = {};
              var hiddens = form.querySelectorAll('input[type="hidden"]');
              for (var hi = 0; hi < hiddens.length; hi++) {
                hiddenFields[hiddens[hi].name] = hiddens[hi].value;
              }
              floatingWindows[key].formAction = action;
              floatingWindows[key].formFields = hiddenFields;
            })
            .catch(function () {});
        }

        // ── Input UI ──
        var fwInput = document.createElement('input');
        fwInput.type = 'text';
        fwInput.className = 'xchat-fw-input';
        fwInput.placeholder = 'Napi\u0161te zpr\u00e1vu\u2026';
        var sendBtn = document.createElement('button');
        sendBtn.className = 'xchat-fw-send';
        sendBtn.innerHTML = '&#9654;';
        sendBtn.title = 'Poslat';
        var doSend = function () {
          var text = fwInput.value.trim();
          if (!text) return;
          var fwData = floatingWindows[key];
          if (!fwData || !fwData.formAction) return;
          fwInput.value = '';
          // Submit via hidden iframe (preserves ISO-8859-2 encoding)
          var iframeName = 'xchat-fw-submit-' + Date.now();
          var hIframe = document.createElement('iframe');
          hIframe.name = iframeName;
          hIframe.style.cssText = 'display:none';
          document.body.appendChild(hIframe);
          var fakeForm = document.createElement('form');
          fakeForm.method = 'post';
          fakeForm.action = fwData.formAction;
          fakeForm.target = iframeName;
          fakeForm.style.cssText = 'display:none';
          var fields = fwData.formFields;
          for (var fname in fields) {
            if (fields.hasOwnProperty(fname)) {
              var fi = document.createElement('input');
              fi.type = 'hidden'; fi.name = fname; fi.value = fields[fname];
              fakeForm.appendChild(fi);
            }
          }
          var mi = document.createElement('input');
          mi.type = 'hidden'; mi.name = 'textarea'; mi.value = text;
          fakeForm.appendChild(mi);
          var si = document.createElement('input');
          si.type = 'hidden'; si.name = 'submit_text'; si.value = 'Poslat';
          fakeForm.appendChild(si);
          document.body.appendChild(fakeForm);
          fakeForm.submit();
          hIframe.addEventListener('load', function () {
            fakeForm.remove(); hIframe.remove();
            // Refresh messages after sending
            var fwd = floatingWindows[key];
            if (fwd && fwd.fetchMessages) {
              setTimeout(function () { fwd.fetchMessages(); }, 600);
            }
          });
          setTimeout(function () { fakeForm.remove(); hIframe.remove(); }, 10000);
        };
        fwInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); doSend(); }
        });
        sendBtn.addEventListener('click', doSend);
        footer.appendChild(fwInput);
        footer.appendChild(sendBtn);

        // Fetch userpage for status icons (skip photos and smileys)
        if (userpageUrl) {
          fetch(userpageUrl, { credentials: 'include' })
            .then(function (r2) { return r2.text(); })
            .then(function (upHtml) {
              var upDoc = new DOMParser().parseFromString(upHtml, 'text/html');
              var crdiv = upDoc.getElementById('crdiv1');
              if (!crdiv) return;
              var imgs = crdiv.querySelectorAll('img');
              for (var ii = 0; ii < imgs.length; ii++) {
                var src = imgs[ii].getAttribute('src') || '';
                // Skip personal photos, smileys and pict_ icons
                if (/images\/personal\//i.test(src)) continue;
                if (/images\/x4\/sm\//i.test(src)) continue;
                if (/\/pict_/i.test(src)) continue;
                var img = document.createElement('img');
                img.src = src;
                img.border = '0';
                iconsSpan.appendChild(img);
                // Also add to head tooltip
                if (floatingWindows[key] && floatingWindows[key].headTipIcons) {
                  var tipImg = document.createElement('img');
                  tipImg.src = src;
                  floatingWindows[key].headTipIcons.appendChild(tipImg);
                }
              }
            })
            .catch(function () { /* icons are optional */ });
        }
      })
      .catch(function () {
        // Fallback: show error in body
        body.textContent = 'Nepoda\u0159ilo se na\u010d\u00edst \u0161ept.';
      });
  }

  function closeFloatingWhisper(key) {
    if (floatingWindows[key]) {
      if (floatingWindows[key].pollTimer) {
        clearInterval(floatingWindows[key].pollTimer);
      }
      floatingWindows[key].el.remove();
      if (floatingWindows[key].head) floatingWindows[key].head.remove();
      delete floatingWindows[key];
      saveFloatingState();
    }
  }

  // ── Pošeptat launcher bubble ──

  var launcherHistoryList = null; // reference to the <ul> in popup

  function refreshLauncherHistory() {
    if (!launcherHistoryList) return;
    var history = getWhisperHistory();
    launcherHistoryList.innerHTML = '';
    // Display oldest first so recently closed appear at the bottom
    for (var i = history.length - 1; i >= 0; i--) {
      var li = document.createElement('li');
      li.className = 'xchat-fw-launcher-item';
      li.textContent = history[i].nick;
      li.dataset.nick = history[i].nick;
      li.addEventListener('click', (function (n) {
        return function () {
          openFloatingWhisper(n);
          closeLauncherPopup();
        };
      })(history[i].nick));
      launcherHistoryList.appendChild(li);
    }
    // Scroll to bottom to show most recent
    launcherHistoryList.scrollTop = launcherHistoryList.scrollHeight;
  }

  function closeLauncherPopup() {
    var win = document.getElementById('xchat-fw-launcher-win');
    if (win) win.remove();
  }

  function createLauncherBubble() {
    var sidebar = getHeadsSidebar();

    // The bubble itself
    var bubble = document.createElement('div');
    bubble.className = 'xchat-fw-head xchat-fw-head-visible xchat-fw-launcher-head';
    bubble.id = 'xchat-fw-launcher';
    bubble.title = 'Po\u0161eptat';

    // Chat icon SVG
    bubble.innerHTML = '<svg class="xchat-fw-launcher-icon" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';

    bubble.addEventListener('click', function () {
      // Toggle: if window exists, close it; otherwise open it
      var existing = document.getElementById('xchat-fw-launcher-win');
      if (existing) {
        closeLauncherPopup();
        return;
      }

      var container = getFloatingContainer();

      // Build a .xchat-fw style window
      var fw = document.createElement('div');
      fw.className = 'xchat-fw xchat-fw-launcher-win';
      fw.id = 'xchat-fw-launcher-win';

      // Header (same style as whisper windows)
      var header = document.createElement('div');
      header.className = 'xchat-fw-header';

      var headerInfo = document.createElement('div');
      headerInfo.className = 'xchat-fw-header-info';
      var texts = document.createElement('div');
      texts.className = 'xchat-fw-texts';
      var nickEl = document.createElement('div');
      nickEl.className = 'xchat-fw-nick';
      nickEl.textContent = 'Po\u0161eptat';
      texts.appendChild(nickEl);
      headerInfo.appendChild(texts);
      header.appendChild(headerInfo);

      var btns = document.createElement('div');
      btns.className = 'xchat-fw-header-btns';
      var closeBtn = document.createElement('button');
      closeBtn.className = 'xchat-fw-header-btn';
      closeBtn.innerHTML = '&times;';
      closeBtn.title = 'Zav\u0159\u00edt';
      closeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        closeLauncherPopup();
      });
      btns.appendChild(closeBtn);
      header.appendChild(btns);
      fw.appendChild(header);

      // Body
      var body = document.createElement('div');
      body.className = 'xchat-fw-launcher-body';

      // Nick input row
      var inputRow = document.createElement('div');
      inputRow.className = 'xchat-fw-launcher-input-row';

      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'xchat-fw-launcher-input';
      input.placeholder = 'Nick...';
      input.autocomplete = 'off';

      var confirmBtn = document.createElement('button');
      confirmBtn.className = 'xchat-fw-launcher-confirm';
      confirmBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

      function submitNick() {
        var val = input.value.trim();
        if (!val) return;
        openFloatingWhisper(val);
        input.value = '';
        closeLauncherPopup();
      }

      confirmBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        submitNick();
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitNick();
        }
      });

      inputRow.appendChild(input);
      inputRow.appendChild(confirmBtn);
      body.appendChild(inputRow);

      // History list
      var historyUl = document.createElement('ul');
      historyUl.className = 'xchat-fw-launcher-list';
      launcherHistoryList = historyUl;
      body.appendChild(historyUl);

      fw.appendChild(body);
      container.appendChild(fw);

      // Populate history
      refreshLauncherHistory();

      setTimeout(function () { input.focus(); }, 50);
    });

    // Insert as first child so it's at the bottom (column-reverse)
    sidebar.insertBefore(bubble, sidebar.firstChild);
  }

  // Update room names in all open floating windows
  function updateFloatingRoomNames() {
    var rn = getRoomName();
    var text = rn ? 'v m\u00edstnosti \u201e' + rn + '\u201c' : '';
    for (var k in floatingWindows) {
      if (floatingWindows.hasOwnProperty(k) && floatingWindows[k].roomEl) {
        floatingWindows[k].roomEl.textContent = text;
      }
    }
  }

  function installWhisperOverride() {
    var wrapper = function (nick) { openFloatingWhisper(nick); };
    wrapper._xchatFW = true;

    // Collect all unique window objects to patch
    var targets = [window];
    try { if (window.parent !== window) targets.push(window.parent); } catch {}
    try { if (window.top !== window && window.top !== window.parent) targets.push(window.top); } catch {}

    for (var ti = 0; ti < targets.length; ti++) {
      try { _patchWhisper(targets[ti], wrapper); } catch {}
    }
  }

  function _patchWhisper(win, wrapper) {
    if (getWhisperMode() === 'floating') {
      // Save original if present and not our wrapper
      var cur = null;
      try { cur = win.whisper_to; } catch {}
      if (typeof cur === 'function' && cur._xchatFW) {
        return; // Already our wrapper, don't overwrite
      }
      if (typeof cur === 'function') {
        win._xchat_orig_whisper_to = cur;
      }

      // defineProperty trap — survives later reassignment by xchat scripts
      try { delete win.whisper_to; } catch {}
      Object.defineProperty(win, 'whisper_to', {
        get: function () { return wrapper; },
        set: function (fn) {
          if (typeof fn === 'function' && !fn._xchatFW) {
            win._xchat_orig_whisper_to = fn;
          }
        },
        configurable: true,
        enumerable: true
      });
    } else {
      // Remove property trap if set
      try {
        var desc = Object.getOwnPropertyDescriptor(win, 'whisper_to');
        if (desc && (desc.get || desc.set)) delete win.whisper_to;
      } catch {}
      // Restore original popup behavior
      if (typeof win._xchat_orig_whisper_to === 'function') {
        win.whisper_to = win._xchat_orig_whisper_to;
      }
    }
  }

  // ── Infopage: filter links ──

  function initInfopage() {
    // ── Extract numeric RID and room name from infopage ──
    var roomLinks = document.querySelectorAll('a[href*="roominfo"]');
    for (var ri = 0; ri < roomLinks.length; ri++) {
      var href = roomLinks[ri].getAttribute('href') || '';
      var ridMatch = href.match(/roominfo\((\d+)\)/);
      if (ridMatch) {
        var rid = ridMatch[1];
        var roomName = roomLinks[ri].textContent.trim();
        try { window.top._xchatRoomId = rid; } catch {}
        setSetting('currentRoomId', rid);
        var rooms = getSetting('rooms', {});
        if (roomName && rooms[rid] !== roomName) {
          rooms[rid] = roomName;
          setSetting('rooms', rooms);
          // Update floating whisper window headers
          try { if (typeof window.top._xchatUpdateFloatingRoomNames === 'function') window.top._xchatUpdateFloatingRoomNames(); } catch {}
        }
        // Show RID in parentheses after room name link
        if (getSetting('showRid', true)) {
          roomLinks[ri].parentNode.insertBefore(document.createTextNode(' (' + rid + ')'), roomLinks[ri].nextSibling);
        }
        break;
      }
    }

    // Rename "Nemluvil jsi:" to "IDLE:"
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while ((node = walker.nextNode())) {
      if (node.textContent.indexOf('Nemluvil jsi:') !== -1) {
        node.textContent = node.textContent.replace('Nemluvil jsi:', 'IDLE:');
      }
    }

    // Remove "smazat" link
    var allLinks = document.querySelectorAll('a');
    for (var si = 0; si < allLinks.length; si++) {
      if (/^smazat$/i.test(allLinks[si].textContent.trim())) {
        var prev = allLinks[si].previousSibling;
        if (prev && prev.nodeType === Node.TEXT_NODE) prev.textContent = prev.textContent.replace(/\s+$/, '');
        allLinks[si].remove();
        break;
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
      highlightOn = isHighlightOn();
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
    try { window.top._xchatRenderHighlightLinks = renderHighlightLinks; } catch {}

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

    // ── Section: Místnost ──
    var h5m = targetDoc.createElement('h5');
    h5m.textContent = 'M\u00edstnost';
    modal.appendChild(h5m);

    // Highlight my nick toggle
    var hlRow = targetDoc.createElement('div');
    var hlCheckbox = targetDoc.createElement('input');
    hlCheckbox.type = 'checkbox';
    hlCheckbox.id = 'xchat-highlight-toggle';
    hlCheckbox.checked = isHighlightOn();
    hlRow.appendChild(hlCheckbox);
    var hlLabel = targetDoc.createElement('label');
    hlLabel.htmlFor = 'xchat-highlight-toggle';
    hlLabel.textContent = ' Zv\u00fdraznit m\u016fj nick';
    hlLabel.style.cssText = 'font-size: 11px; cursor: pointer;';
    hlRow.appendChild(hlLabel);
    modal.appendChild(hlRow);

    // Kick highlight toggle
    var kickRow = targetDoc.createElement('div');
    kickRow.style.cssText = 'margin-top: 3px;';
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

    // Show RID toggle
    var ridRow = targetDoc.createElement('div');
    ridRow.style.cssText = 'margin-top: 3px;';
    var ridCheckbox = targetDoc.createElement('input');
    ridCheckbox.type = 'checkbox';
    ridCheckbox.id = 'xchat-show-rid-toggle';
    ridCheckbox.checked = getSetting('showRid', true);
    ridRow.appendChild(ridCheckbox);
    var ridLabel = targetDoc.createElement('label');
    ridLabel.htmlFor = 'xchat-show-rid-toggle';
    ridLabel.textContent = ' Zobrazovat RID m\u00edstnosti';
    ridLabel.style.cssText = 'font-size: 11px; cursor: pointer;';
    ridRow.appendChild(ridLabel);
    modal.appendChild(ridRow);

    // Hide bad commands toggle
    var badCmdRow = targetDoc.createElement('div');
    badCmdRow.style.cssText = 'margin-top: 3px;';
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

    // Whisper mode dropdown
    var whisperRow = targetDoc.createElement('div');
    whisperRow.style.cssText = 'margin-top: 3px;';
    var whisperLabel = targetDoc.createElement('label');
    whisperLabel.htmlFor = 'xchat-whisper-mode';
    whisperLabel.textContent = '\u0160ept\u00e1n\u00ed: ';
    whisperLabel.style.cssText = 'font-size: 11px; cursor: pointer;';
    whisperRow.appendChild(whisperLabel);
    var whisperSelect = targetDoc.createElement('select');
    whisperSelect.id = 'xchat-whisper-mode';
    whisperSelect.style.cssText = 'font-size: 11px;';
    var wOpts = [
      { value: 'popup', text: 'Vyskakovac\u00ed okna' },
      { value: 'floating', text: 'Plovouc\u00ed okna' }
    ];
    for (var wi = 0; wi < wOpts.length; wi++) {
      var wOpt = targetDoc.createElement('option');
      wOpt.value = wOpts[wi].value;
      wOpt.textContent = wOpts[wi].text;
      whisperSelect.appendChild(wOpt);
    }
    whisperSelect.value = getWhisperMode();
    whisperRow.appendChild(whisperSelect);
    modal.appendChild(whisperRow);

    // Newest first toggle for floating whisper windows
    var fwOrderRow = targetDoc.createElement('div');
    fwOrderRow.style.cssText = 'margin-top: 3px;';
    var fwOrderCheckbox = targetDoc.createElement('input');
    fwOrderCheckbox.type = 'checkbox';
    fwOrderCheckbox.id = 'xchat-fw-newest-first';
    fwOrderCheckbox.checked = getFwNewestFirst();
    fwOrderRow.appendChild(fwOrderCheckbox);
    var fwOrderLabel = targetDoc.createElement('label');
    fwOrderLabel.htmlFor = 'xchat-fw-newest-first';
    fwOrderLabel.textContent = ' Nejnov\u011bj\u0161\u00ed \u0161epty naho\u0159e';
    fwOrderLabel.style.cssText = 'font-size: 11px; cursor: pointer;';
    fwOrderRow.appendChild(fwOrderLabel);
    modal.appendChild(fwOrderRow);

    // ── Section: Historie ──
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

    // ── Section: Obnovení skla ──
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

    // ── Section: Tlačítka pozdravů ──
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

    var allGreetings = getAllGreetings();
    var greetInputs = {};
    var greetingsContainer = targetDoc.createElement('div');
    greetingsContainer.style.cssText = 'margin-top: 6px;';

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
    deleteAllBtn.style.cssText = 'margin-top: 6px; font-size: 11px; cursor: pointer; color: #fff; background: #c00; border: 1px solid #900; border-radius: 3px; padding: 2px 8px;';
    deleteAllBtn.addEventListener('click', function () {
      allGreetings = {};
      renderGreetingRows();
    });
    modal.appendChild(deleteAllBtn);

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
      s.highlight = hlCheckbox.checked;
      s.showRid = ridCheckbox.checked;
      s.whisperMode = whisperSelect.value;
      s.fwNewestFirst = fwOrderCheckbox.checked;
      s.refreshInterval = parseInt(sel.value, 10) || 0;
      saveSettings(s);

      // Apply CSS changes
      applyKickHighlight(kickCheckbox.checked);
      applyHideBadCommands(badCmdCheckbox.checked);
      applyHighlight(hlCheckbox.checked);

      // Re-install or remove whisper override
      try { installWhisperOverride(); } catch {}

      overlay.remove();
      // Restart countdown in infopage
      try {
        setupCountdown();
      } catch {}
      // Sync highlight toggle on infopage
      try {
        if (typeof window.top._xchatRenderHighlightLinks === 'function') {
          window.top._xchatRenderHighlightLinks();
        }
      } catch {}
    });

    btns.appendChild(saveBtn);
    btns.appendChild(cancelBtn);
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
    try { if (window.top._xchatRoomId) return String(window.top._xchatRoomId); } catch {}
    var stored = getSetting('currentRoomId', '');
    if (stored) return String(stored);
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
      room: 'M\u00edstnost', room_out: 'M\u00edstnost (out)',
      whisper: '\u0160ept\u00e1n\u00ed', whisper_out: '\u0160ept\u00e1n\u00ed (out)',
      system: 'Syst\u00e9m', system_out: 'Syst\u00e9m (out)',
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
    var knownRooms = getSetting('rooms', {});

    document.title = 'Historie zpr\u00e1v';
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin: 0; padding: 0; font-family: arial, helvetica, sans-serif; font-size: 12px; background: #f4f4f4; color: #333;';

    var style = document.createElement('style');
    style.textContent = [
      '* { box-sizing: border-box; }',
      'html, body { height: 100%; }',
      'body { display: flex; flex-direction: column; }',
      '.hist-toolbar { background: #e8e8e8; border-bottom: 1px solid #ccc; padding: 6px 12px; }',
      '.hist-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 2px 0; }',
      '.hist-row label { font-size: 11px; font-weight: bold; white-space: nowrap; }',
      '.hist-row input, .hist-row select { font-size: 11px; padding: 2px 4px; border: 1px solid #aaa; border-radius: 3px; }',
      '.hist-row input[type="text"] { width: 100px; }',
      '.hist-row input[type="datetime-local"] { width: 140px; }',
      '.hist-row button { font-size: 11px; padding: 3px 10px; cursor: pointer; border: 1px solid #888; border-radius: 3px; background: #ddd; }',
      '.hist-row button:hover { background: #ccc; }',
      '.hist-toggle { display: inline-flex; gap: 2px; }',
      '.hist-toggle span { font-size: 11px; padding: 2px 6px; border: 1px solid #aaa; cursor: pointer; background: #fff; border-radius: 3px; user-select: none; }',
      '.hist-toggle span.active { background: #4a90d9; color: #fff; border-color: #3a70b0; font-weight: bold; }',
      '.hist-results { flex: 1; overflow-y: auto; padding: 6px 12px; }',
      '.hist-msg { padding: 1px 0; line-height: 1.3; font-size: 12px; }',
      '.hist-msg.hist-msg-system { font-size: 10px; color: #888; }',
      '.hist-msg .ht { color: #888; font-size: inherit; }',
      '.hist-msg .hs { font-weight: bold; }',
      '.hist-msg .hs-system { color: #666; font-weight: normal; }',
      '.hist-msg .hs-whisper { color: #906; }',
      '.hist-msg.hist-msg-whisper { background: #f9f0f5; }',
      '.hist-msg .hs-room { color: #006; }',
      '.hist-msg .hs-advert { color: #999; }',
      '.hist-msg .hc { }',
      '.hist-msg .highlight { background: yellow; }',
      '.hist-msg img.smiley { height: 15px; vertical-align: middle; }',
      '.hist-empty { padding: 20px; text-align: center; color: #999; font-style: italic; }',
      '.hist-actions { background: #e0e0e0; border-top: 1px solid #bbb; padding: 6px 12px; display: flex; gap: 6px; align-items: center; flex-shrink: 0; }',
      '.hist-actions button { font-size: 11px; padding: 3px 10px; cursor: pointer; border-radius: 3px; border: 1px solid #888; }',
      '.hist-actions .btn-export { background: #4a90d9; color: #fff; border-color: #3a70b0; }',
      '.hist-actions .btn-export:hover { background: #3a7bc8; }',
      '.hist-actions .btn-delete { background: #c00; color: #fff; border-color: #900; }',
      '.hist-actions .btn-delete:hover { background: #a00; }',
      '.hist-actions .hist-status { font-size: 11px; color: #666; margin-left: auto; }',
    ].join('\n');
    document.head.appendChild(style);

    // ── Toolbar (2 rows) ──
    var toolbar = document.createElement('div');
    toolbar.className = 'hist-toolbar';

    var row1 = document.createElement('div');
    row1.className = 'hist-row';
    var row2 = document.createElement('div');
    row2.className = 'hist-row';

    function makeField(row, labelText, el) {
      var lbl = document.createElement('label');
      lbl.textContent = labelText;
      row.appendChild(lbl);
      row.appendChild(el);
      return el;
    }

    function makeToggle(row, labelText, options, defaultVal) {
      var lbl = document.createElement('label');
      lbl.textContent = labelText;
      row.appendChild(lbl);
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
      row.appendChild(wrap);
      return { get: function () { return currentVal; } };
    }

    // ── Row 1: Odesílatel, Příjemce, Zpráva, Typ, Místnost ──
    var inpSender = document.createElement('input');
    inpSender.type = 'text';
    inpSender.placeholder = 'v\u0161e';
    makeField(row1, 'Odes\u00edlatel:', inpSender);

    var inpRecipient = document.createElement('input');
    inpRecipient.type = 'text';
    inpRecipient.placeholder = 'v\u0161e';
    makeField(row1, 'P\u0159\u00edjemce:', inpRecipient);

    var inpContent = document.createElement('input');
    inpContent.type = 'text';
    inpContent.placeholder = 'hledat...';
    makeField(row1, 'Zpr\u00e1va:', inpContent);

    var selType = document.createElement('select');
    var types = ['', 'room', 'room_out', 'whisper', 'whisper_out', 'system', 'advert'];
    var typeLabels = ['V\u0161e', 'M\u00edstnost', 'M\u00edstnost (out)', '\u0160ept\u00e1n\u00ed', '\u0160ept\u00e1n\u00ed (out)', 'Syst\u00e9m', 'Reklama'];
    for (var t = 0; t < types.length; t++) {
      var o = document.createElement('option');
      o.value = types[t];
      o.textContent = typeLabels[t];
      selType.appendChild(o);
    }
    makeField(row1, 'Typ:', selType);

    // Room: select + text field
    var roomLbl = document.createElement('label');
    roomLbl.textContent = 'M\u00edstnost:';
    row1.appendChild(roomLbl);

    var selRoom = document.createElement('select');
    selRoom.style.cssText = 'font-size: 11px; margin-right: 2px;';
    var roomIds = Object.keys(knownRooms).sort();
    var defaultOptRoom = document.createElement('option');
    defaultOptRoom.value = '';
    defaultOptRoom.textContent = '-- vybrat --';
    selRoom.appendChild(defaultOptRoom);
    for (var ri = 0; ri < roomIds.length; ri++) {
      var rOpt = document.createElement('option');
      rOpt.value = roomIds[ri];
      rOpt.textContent = knownRooms[roomIds[ri]] + ' (' + roomIds[ri] + ')';
      if (roomIds[ri] === defaultRoom) rOpt.selected = true;
      selRoom.appendChild(rOpt);
    }
    row1.appendChild(selRoom);

    var inpRoom = document.createElement('input');
    inpRoom.type = 'text';
    inpRoom.value = defaultRoom;
    inpRoom.style.width = '80px';
    row1.appendChild(inpRoom);

    selRoom.addEventListener('change', function () {
      if (selRoom.value) inpRoom.value = selRoom.value;
    });

    // ── Row 2: Od, Do, Šeptání, Zvýraznit nick, Zobrazit datum, Hledat ──
    var inpFrom = document.createElement('input');
    inpFrom.type = 'datetime-local';
    makeField(row2, 'Od:', inpFrom);

    var inpTo = document.createElement('input');
    inpTo.type = 'datetime-local';
    makeField(row2, 'Do:', inpTo);

    var whisperToggle = makeToggle(row2, '\u0160ept\u00e1n\u00ed:', [
      { label: 'V\u0161e', value: '' },
      { label: 'Ano', value: 'yes' },
      { label: 'Ne', value: 'no' }
    ], '');

    var highlightToggle = makeToggle(row2, 'Zv\u00fdraznit:', [
      { label: 'Ne', value: 'no' },
      { label: 'Ano', value: 'yes' }
    ], 'no');

    var dateToggle = makeToggle(row2, 'Datum:', [
      { label: 'Ne', value: 'no' },
      { label: 'Ano', value: 'yes' }
    ], 'no');

    var orderToggle = makeToggle(row2, 'Nov\u00e9 zpr\u00e1vy:', [
      { label: 'Naho\u0159e', value: 'top' },
      { label: 'Dole', value: 'bottom' }
    ], 'top');

    var searchBtn = document.createElement('button');
    searchBtn.textContent = 'Hledat';
    searchBtn.style.cssText = 'background: #4a90d9; color: #fff; border-color: #3a70b0; font-weight: bold;';
    row2.appendChild(searchBtn);

    toolbar.appendChild(row1);
    toolbar.appendChild(row2);
    document.body.appendChild(toolbar);

    // ── Results ──
    var resultsDiv = document.createElement('div');
    resultsDiv.className = 'hist-results';
    document.body.appendChild(resultsDiv);

    // ── Actions bar (sticky bottom) ──
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
      results = results.filter(function (r) {
        return !(r.message_type === 'system' && /\u0160patn\u00fd p\u0159\u00edkaz/.test(r.content_text));
      });
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
        myNick = getSetting('myNick', '');
        if (!myNick) {
          for (var ni = 0; ni < results.length; ni++) {
            var mt = results[ni].message_type;
            if ((mt === 'room_out' || mt === 'whisper_out' || mt === 'wcross_out') && results[ni].sender) {
              myNick = results[ni].sender;
              setSetting('myNick', myNick);
              break;
            }
          }
        }
        if (!myNick) {
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
        }
        if (!myNick && CONFIG.myNick) myNick = CONFIG.myNick;
      }

      var frag = document.createDocumentFragment();
      for (var i = 0; i < results.length; i++) {
        var rec = results[i];
        var ts = new Date(rec.timestamp);
        var row = document.createElement('div');
        var isSystem = rec.message_type === 'system' || rec.message_type === 'system_out';
        var isWhisper = !!rec.is_whisper || /^whisper/.test(rec.message_type) || /^wcross/.test(rec.message_type);
        row.className = 'hist-msg' + (isSystem ? ' hist-msg-system' : '') + (isWhisper ? ' hist-msg-whisper' : '');

        var timeText = showDate ? formatDate(ts) + ' ' + formatTime(ts) : formatTime(ts);
        var timeSpan = '<span class="ht">' + escapeHtml(timeText) + '</span> ';

        var senderClass = 'hs';
        if (isSystem) senderClass += ' hs-system';
        else if (isWhisper) senderClass += ' hs-whisper';
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
        var asc = orderToggle.get() !== 'top';
        results.sort(function (a, b) {
          var diff = new Date(a.timestamp) - new Date(b.timestamp);
          return asc ? diff : -diff;
        });
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

  function injectFloatingStyles() {
    if (document.getElementById('xchat-fw-styles')) return;
    var style = document.createElement('style');
    style.id = 'xchat-fw-styles';
    style.textContent = [
      '.xchat-fw-container {',
      '  position: fixed;',
      '  bottom: 0;',
      '  right: 60px;',
      '  display: flex;',
      '  flex-direction: row-reverse;',
      '  align-items: flex-end;',
      '  gap: 6px;',
      '  z-index: 99990;',
      '  pointer-events: none;',
      '}',
      '.xchat-fw-heads {',
      '  position: fixed;',
      '  right: 10px;',
      '  bottom: 10px;',
      '  display: flex;',
      '  flex-direction: column-reverse;',
      '  gap: 8px;',
      '  z-index: 99991;',
      '  pointer-events: none;',
      '}',
      '.xchat-fw {',
      '  pointer-events: auto;',
      '  width: 300px;',
      '  height: 400px;',
      '  background: #fff;',
      '  border: 1px solid #999;',
      '  border-bottom: none;',
      '  border-radius: 8px 8px 0 0;',
      '  display: flex;',
      '  flex-direction: column;',
      '  box-shadow: 0 -2px 12px rgba(0,0,0,0.25);',
      '  font-family: arial, sans-serif;',
      '  overflow: hidden;',
      '}',
      '.xchat-fw.xchat-fw-minimized {',
      '  display: none;',
      '}',
      '.xchat-fw-head {',
      '  pointer-events: auto;',
      '  width: 40px;',
      '  height: 40px;',
      '  border-radius: 50%;',
      '  cursor: pointer;',
      '  box-shadow: 0 2px 8px rgba(0,0,0,0.3);',
      '  border: 2px solid #fff;',
      '  display: none;',
      '  flex-shrink: 0;',
      '  position: relative;',
      '}',
      '.xchat-fw-head-img {',
      '  width: 100%;',
      '  height: 100%;',
      '  object-fit: cover;',
      '  display: block;',
      '  border-radius: 50%;',
      '}',
      '.xchat-fw-head-visible {',
      '  display: block;',
      '}',
      '.xchat-fw-head:hover {',
      '  box-shadow: 0 2px 12px rgba(0,0,0,0.5);',
      '}',
      '.xchat-fw-head-close {',
      '  position: absolute;',
      '  top: -4px;',
      '  right: -4px;',
      '  width: 16px;',
      '  height: 16px;',
      '  line-height: 15px;',
      '  text-align: center;',
      '  background: rgba(0,0,0,0.65);',
      '  color: #fff;',
      '  font-size: 12px;',
      '  border-radius: 50%;',
      '  cursor: pointer;',
      '  display: none;',
      '  z-index: 2;',
      '}',
      '.xchat-fw-head:hover .xchat-fw-head-close {',
      '  display: block;',
      '}',
      '.xchat-fw-head-close:hover {',
      '  background: rgba(200,0,0,0.85);',
      '}',
      '.xchat-fw-head-tip {',
      '  position: absolute;',
      '  right: 100%;',
      '  top: 50%;',
      '  transform: translateY(-50%);',
      '  margin-right: 8px;',
      '  background: rgba(0,0,0,0.8);',
      '  color: #fff;',
      '  font-size: 12px;',
      '  font-family: arial, sans-serif;',
      '  font-weight: bold;',
      '  padding: 4px 10px;',
      '  border-radius: 6px;',
      '  white-space: nowrap;',
      '  display: none;',
      '  align-items: center;',
      '  gap: 4px;',
      '  pointer-events: none;',
      '  box-shadow: 0 2px 8px rgba(0,0,0,0.3);',
      '}',
      '.xchat-fw-head:hover .xchat-fw-head-tip {',
      '  display: flex;',
      '}',
      '.xchat-fw-head-tip-icons {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 2px;',
      '}',
      '.xchat-fw-head-tip-icons img {',
      '  vertical-align: middle;',
      '}',

      '.xchat-fw-header {',
      '  background: #8291A5;',
      '  color: #fff;',
      '  padding: 6px 8px;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  cursor: pointer;',
      '  flex-shrink: 0;',
      '  user-select: none;',
      '}',
      '.xchat-fw-header-info {',
      '  overflow: hidden;',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 6px;',
      '  min-width: 0;',
      '}',
      '.xchat-fw-icons {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 2px;',
      '  flex-shrink: 0;',
      '}',
      '.xchat-fw-icons img {',
      '  vertical-align: middle;',
      '}',
      '.xchat-fw-texts {',
      '  min-width: 0;',
      '}',
      '.xchat-fw-nick {',
      '  font-size: 13px;',
      '  font-weight: bold;',
      '  white-space: nowrap;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '}',
      '.xchat-fw-room {',
      '  font-size: 10px;',
      '  opacity: 0.8;',
      '  white-space: nowrap;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '}',
      '.xchat-fw-header-btns {',
      '  display: flex;',
      '  gap: 4px;',
      '  flex-shrink: 0;',
      '}',
      '.xchat-fw-header-btn {',
      '  background: none;',
      '  border: none;',
      '  color: #fff;',
      '  font-size: 14px;',
      '  cursor: pointer;',
      '  padding: 0 3px;',
      '  line-height: 1;',
      '  opacity: 0.8;',
      '}',
      '.xchat-fw-header-btn:hover {',
      '  opacity: 1;',
      '}',
      '.xchat-fw-body {',
      '  flex: 1;',
      '  overflow-y: auto;',
      '  font-size: 12px;',
      '  line-height: 1.4;',
      '  word-wrap: break-word;',
      '  padding: 4px;',
      '  background: #CCCCCD;',
      '}',
      '.xchat-fw-footer {',
      '  flex-shrink: 0;',
      '  border-top: 1px solid #ccc;',
      '  display: flex;',
      '  align-items: center;',
      '  padding: 4px;',
      '  gap: 4px;',
      '}',
      '.xchat-fw-input {',
      '  flex: 1;',
      '  border: 1px solid #ccc;',
      '  border-radius: 12px;',
      '  padding: 4px 10px;',
      '  font-size: 12px;',
      '  outline: none;',
      '  min-width: 0;',
      '}',
      '.xchat-fw-input:focus {',
      '  border-color: #8291A5;',
      '}',
      '.xchat-fw-send {',
      '  background: #8291A5;',
      '  color: #fff;',
      '  border: none;',
      '  border-radius: 50%;',
      '  width: 24px;',
      '  height: 24px;',
      '  cursor: pointer;',
      '  font-size: 12px;',
      '  line-height: 24px;',
      '  text-align: center;',
      '  flex-shrink: 0;',
      '  padding: 0;',
      '}',
      '.xchat-fw-send:hover {',
      '  background: #6b7d96;',
      '}',
      '.xchat-fw-body .splash {',
      '  text-align: center;',
      '  padding: 20px;',
      '  color: #999;',
      '}',
      '.xchat-fw-messages {',
      '  height: 100%;',
      '  overflow-y: auto;',
      '  display: flex;',
      '  flex-direction: column;',
      '}',
      '.xchat-fw-msg {',
      '  padding: 2px 4px;',
      '  font-size: 12px;',
      '  line-height: 1.4;',
      '  word-wrap: break-word;',
      '}',
      '.xchat-fw-msg-time {',
      '  color: #666;',
      '  margin-right: 4px;',
      '  font-size: 11px;',
      '}',
      '.xchat-fw-msg-nick {',
      '  font-weight: bold;',
      '  margin-right: 4px;',
      '}',
      '.xchat-fw-msg-text img {',
      '  vertical-align: middle;',
      '}',

      // Pošeptat launcher bubble + window
      '.xchat-fw-launcher-head {',
      '  background: #8291A5;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '}',
      '.xchat-fw-launcher-icon {',
      '  width: 22px;',
      '  height: 22px;',
      '  pointer-events: none;',
      '}',
      '.xchat-fw-launcher-win {',
      '  height: 280px;',
      '}',
      '.xchat-fw-launcher-body {',
      '  flex: 1;',
      '  display: flex;',
      '  flex-direction: column;',
      '  overflow: hidden;',
      '}',
      '.xchat-fw-launcher-input-row {',
      '  display: flex;',
      '  align-items: center;',
      '  padding: 6px;',
      '  gap: 4px;',
      '  border-bottom: 1px solid #eee;',
      '  flex-shrink: 0;',
      '}',
      '.xchat-fw-launcher-input {',
      '  flex: 1;',
      '  border: 1px solid #ccc;',
      '  border-radius: 12px;',
      '  padding: 4px 10px;',
      '  font-size: 12px;',
      '  outline: none;',
      '  min-width: 0;',
      '}',
      '.xchat-fw-launcher-input:focus {',
      '  border-color: #8291A5;',
      '}',
      '.xchat-fw-launcher-confirm {',
      '  background: #8291A5;',
      '  border: none;',
      '  border-radius: 50%;',
      '  width: 24px;',
      '  height: 24px;',
      '  cursor: pointer;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  flex-shrink: 0;',
      '  padding: 0;',
      '}',
      '.xchat-fw-launcher-confirm:hover {',
      '  background: #6b7d96;',
      '}',
      '.xchat-fw-launcher-list {',
      '  list-style: none;',
      '  margin: 0;',
      '  padding: 0;',
      '  flex: 1;',
      '  overflow-y: auto;',
      '}',
      '.xchat-fw-launcher-item {',
      '  padding: 5px 10px;',
      '  font-size: 12px;',
      '  cursor: pointer;',
      '  white-space: nowrap;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '}',
      '.xchat-fw-launcher-item:hover {',
      '  background: #eef1f5;',
      '}',

    ].join('\n');
    document.head.appendChild(style);
  }

  function initStartframe() {
    injectStyles();
    captureAllDivs();
    processAll();
    restoreBoardFilter();
    restoreHighlight();
    restoreKickHighlight();
    markAllBadCommands();
    restoreHideBadCommands();

    var detectedNick = getMyNick();
    if (detectedNick) setSetting('myNick', detectedNick);

    // Skip floating whisper management when inside a floating window iframe
    // The main startframe stores its window ref on top; nested iframes see a different window
    var isNestedStartframe = false;
    try {
      if (window.top._xchatFWWindow && window.top._xchatFWWindow === window) {
        // Same window reloaded — not nested, re-run setup
        isNestedStartframe = false;
      } else if (window.top._xchatFWWindow) {
        // Different window — nested iframe
        isNestedStartframe = true;
      }
      if (!isNestedStartframe) window.top._xchatFWWindow = window;
    } catch {}

    if (!isNestedStartframe) {
      // Floating whisper windows
      injectFloatingStyles();
      installWhisperOverride();
      try { window.top._xchatUpdateFloatingRoomNames = updateFloatingRoomNames; } catch {}

      // Pošeptat launcher bubble
      if (getWhisperMode() === 'floating') {
        createLauncherBubble();
      }

      // Restore previously open floating whisper windows
      if (getWhisperMode() === 'floating') {
        var savedState = getFloatingState();
        for (var sk in savedState) {
          if (savedState.hasOwnProperty(sk)) {
            openFloatingWhisper(savedState[sk].nick, savedState[sk].minimized);
          }
        }
      }
    }

    const board = document.getElementById('board');
    if (!board) return;

    // Intercept clicks on whisper_to links — more reliable than overriding
    // the function across frame boundaries
    if (!isNestedStartframe) {
      board.addEventListener('click', function (e) {
        if (getWhisperMode() !== 'floating') return;
        var link = e.target.closest('a[href*="whisper_to"]');
        if (!link) return;
        var m = (link.getAttribute('href') || '').match(/whisper_to\s*\(\s*['"]([^'"]+)['"]\s*\)/);
        if (!m) return;
        e.preventDefault();
        e.stopPropagation();
        openFloatingWhisper(m[1]);
      }, true);
    }

    const observer = new MutationObserver(function (mutations) {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'DIV') {
            captureDiv(node);
            processEntryDiv(node);
            markBadCommandDiv(node);
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
