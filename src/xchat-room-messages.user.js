// ==UserScript==
// @name         XChat Room Messages
// @namespace    https://www.xchat.cz/
// @version      1.2.0
// @description  Práci se sklem a zprávami na něm
// @match        https://www.xchat.cz/*/modchat?op=startframe*
// @match        https://www.xchat.cz/*/modchat?op=infopage*
// @match        https://www.xchat.cz/*/history.html*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @connect      scripts.xchat.cz
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
  var KICK_HIGHLIGHT_CSS = '.xchat-kick-highlight { background: #fcc !important; color: #900 !important; }';
  var REFRESH_OPTIONS = [5, 10, 15];
  var BOARD_PROCESS_BATCH_SIZE = 12;
  var IDLE_DB_TIMEOUT_MS = 1000;
  var ROOM_BOARD_MAX_KEYS = 250;
  var ROOM_BOARD_TEXT_DECODER = new TextDecoder('iso-8859-2');
  var XCHAT_HTML_JOB_GAP_MS = 250;
  var FW_USER_ICON_CACHE_KEY = '_xchat_fw_user_icons';
  var FW_USER_ICON_CACHE_TTL_MS = 60000;
  var FW_USER_ICON_OPEN_REFRESH_MS = 60000;
  var FW_USER_ICON_MINIMIZED_REFRESH_MS = 300000;
  var NATIVE_REFRESH_KILL_RETRY_MS = 500;
  var NATIVE_REFRESH_KILL_MAX_ATTEMPTS = 20;
  var xchatHtmlJobQueue = [];
  var xchatHtmlJobActive = false;
  var xchatHtmlJobTimer = null;
  var xchatHtmlNextAllowedAt = 0;

  function pumpXchatHtmlJobQueue() {
    if (xchatHtmlJobActive) return;
    if (!xchatHtmlJobQueue.length) return;
    if (xchatHtmlJobTimer) return;

    var waitMs = Math.max(0, xchatHtmlNextAllowedAt - Date.now());
    if (waitMs > 0) {
      xchatHtmlJobTimer = setTimeout(function () {
        xchatHtmlJobTimer = null;
        pumpXchatHtmlJobQueue();
      }, waitMs);
      return;
    }

    var entry = xchatHtmlJobQueue.shift();
    xchatHtmlJobActive = true;
    Promise.resolve()
      .then(entry.job)
      .then(entry.resolve, entry.reject)
      .finally(function () {
        xchatHtmlJobActive = false;
        xchatHtmlNextAllowedAt = Date.now() + XCHAT_HTML_JOB_GAP_MS;
        pumpXchatHtmlJobQueue();
      });
  }

  function enqueueXchatHtmlJob(key, job) {
    return new Promise(function (resolve, reject) {
      for (var i = xchatHtmlJobQueue.length - 1; i >= 0; i--) {
        if (xchatHtmlJobQueue[i].key === key) {
          xchatHtmlJobQueue[i].resolve(null);
          xchatHtmlJobQueue.splice(i, 1);
        }
      }
      xchatHtmlJobQueue.push({ key: key, job: job, resolve: resolve, reject: reject });
      pumpXchatHtmlJobQueue();
    });
  }

  function runWhenIdle(fn, timeoutMs) {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(function () { fn(); }, { timeout: timeoutMs || IDLE_DB_TIMEOUT_MS });
    } else {
      setTimeout(fn, 0);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // ── Registr intervalů (timery) ──
  // Každý interval lze zapnout/vypnout přes enabled: true/false.
  // ══════════════════════════════════════════════════════════════════
  var TIMERS = {
    // setTimeout(5000) – lehký polling hlavního skla bez nativní roomtopng navigace.
    // Callback: lightweight main board refresh přes js=0 odpověď a vlastní DOM update.
    mainBoardPoll:     { enabled: true, intervalMs: 5000, description: 'Lehký polling hlavního skla bez nativního refresh navigací' },

    // setInterval(5000) – polling whisper zpráv v každém otevřeném FW okně
    // Callback: fetchAndUpdateMessages() → fetch roomtopng, parse HTML, update DOM
    // Přeskakuje minimalizovaná okna.
    fwMessagesPoll:    { enabled: true, intervalMs: 5000,  description: 'Polling zpráv v plovoucích whisper oknech' },

    // setInterval(60000) – polling online stavu uživatele (wonline.php)
    // Callback: fetchAndUpdateRooms() → GM_xmlhttpRequest na scripts.xchat.cz
    // Přeskakuje minimalizovaná okna.
    fwOnlineStatusPoll: { enabled: true, intervalMs: 60000, description: 'Polling online stavu přes wonline.php' },

    // setInterval(1000) – countdown/auto-refresh skla (v infopage)
    // Callback: aktualizuje odpočet a volá dataframe.refresh() když counter=0
    // Aktivní jen když refreshInterval > 0 v nastavení.
    countdownRefresh:  { enabled: true, description: 'Odpočet a auto-refresh skla (nastavitelný interval)' },
  };

  // ══════════════════════════════════════════════════════════════════
  // ── Registr síťových požadavků ──
  // Každý požadavek lze vypnout přes enabled: false pro diagnostiku.
  // ══════════════════════════════════════════════════════════════════
  var NETWORK = {
    // fetch() – polling hlavního room boardu přes roomtopng&js=0&inc=1
    // URL: /modchat?op=roomtopng&rid={rid}&js=0&inc=1&last_line={n}&fake={timestamp}
    mainBoardMessages: { enabled: true, description: 'Polling hlavního skla přes roomtopng v js=0 režimu' },

    // fetch() – jednorázový při otevření FW okna
    // URL: /modchat?op=whisperingframeset&rid={rid}&wfrom={nick}
    fwFrameset:   { enabled: true, description: 'Načtení framesetu whisper okna (jednorázový)' },

    // fetch() – polling každých fwMessagesPoll.intervalMs ms
    // URL: /modchat?op=roomtopng&...&js=0&fake={timestamp}
    fwMessages:   { enabled: true, description: 'Polling whisper zpráv (roomtopng)' },

    // fetch() – jednorázový při otevření FW okna
    // URL: /modchat?op=textpageng&...
    fwTextpage:   { enabled: true, description: 'Načtení formuláře pro odesílání (jednorázový)' },

    // fetch() – jednorázový při otevření FW okna
    // URL: /modchat?op=whisperuserpage&...
    fwUserpage:   { enabled: true, description: 'Načtení ikon uživatele (jednorázový)' },

    // GM_xmlhttpRequest – polling každých fwOnlineStatusPoll.intervalMs ms
    // URL: https://scripts.xchat.cz/scripts/wonline.php?nick={nick}
    fwWonline:    { enabled: true, description: 'Online status uživatele (cross-origin, GM_xmlhttpRequest)' },

    // IndexedDB – zápis při každém novém div na boardu
    idbWrite:     { enabled: true, description: 'Ukládání zpráv do IndexedDB' },

    // IndexedDB – čtení při otevření FW okna
    idbHistoryRead: { enabled: true, description: 'Načítání historie z IndexedDB pro FW okna' },
  };

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
    var value = parseInt(getSetting('refreshInterval', 5), 10) || 5;
    return Math.max(5, value);
  }

  function getWhisperMode() {
    return getSetting('whisperMode', 'popup');
  }

  function getFwNewestFirst() {
    return getSetting('fwNewestFirst', true);
  }

  function getFwMaxMessages() {
    var v = getSetting('fwMaxMessages', 100);
    return Math.max(1, parseInt(v, 10) || 100);
  }

  function getFwAutoOpen() {
    var v = getSetting('fwAutoOpen', 'none');
    // Migrate old boolean values
    if (v === true) return 'window';
    if (v === false) return 'none';
    return v;
  }

  var FW_UNREAD_KEY = '_xchat_fw_unread';

  function getFwUnread() {
    try { return JSON.parse(localStorage.getItem(FW_UNREAD_KEY) || '{}'); } catch { return {}; }
  }

  function setFwUnread(key, count) {
    var data = getFwUnread();
    if (count > 0) data[key] = count; else delete data[key];
    try { localStorage.setItem(FW_UNREAD_KEY, JSON.stringify(data)); } catch {}
  }

  function clearFwUnread(key) {
    setFwUnread(key, 0);
  }

  var FW_READ_KEYS_KEY = '_xchat_fw_read_keys';

  function getReadKeys(nickKey) {
    try {
      var data = JSON.parse(localStorage.getItem(FW_READ_KEYS_KEY) || '{}');
      return data[nickKey] || {};
    } catch { return {}; }
  }

  function saveReadKeys(nickKey, keys) {
    try {
      var data = JSON.parse(localStorage.getItem(FW_READ_KEYS_KEY) || '{}');
      var merged = data[nickKey] || {};
      for (var k in keys) if (keys.hasOwnProperty(k)) merged[k] = 1;
      var all = Object.keys(merged);
      if (all.length > 500) {
        var trimmed = {};
        for (var i = all.length - 500; i < all.length; i++) trimmed[all[i]] = 1;
        merged = trimmed;
      }
      data[nickKey] = merged;
      localStorage.setItem(FW_READ_KEYS_KEY, JSON.stringify(data));
    } catch {}
  }

  function getFwUserIconCache() {
    try { return JSON.parse(localStorage.getItem(FW_USER_ICON_CACHE_KEY) || '{}'); } catch { return {}; }
  }

  function saveFwUserIconCache(cache) {
    try { localStorage.setItem(FW_USER_ICON_CACHE_KEY, JSON.stringify(cache)); } catch {}
  }

  function getCachedUserIconSources(key) {
    var cache = getFwUserIconCache();
    var entry = cache[key];
    if (!entry || !Array.isArray(entry.sources)) return null;
    return entry;
  }

  function cacheUserIconSources(key, sources) {
    var cache = getFwUserIconCache();
    cache[key] = {
      updatedAt: Date.now(),
      sources: sources
    };
    saveFwUserIconCache(cache);
  }

  function parseIdleToSeconds(idle) {
    if (!idle) return 0;
    var parts = idle.split(':');
    if (parts.length === 3) return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
    if (parts.length === 2) return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    return parseInt(parts[0], 10) || 0;
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

  var _dbCache = null;
  var _dbPromise = null;

  function openDB() {
    if (_dbCache) {
      // Verify the connection is still alive
      try {
        _dbCache.transaction(STORE_NAME, 'readonly');
        return Promise.resolve(_dbCache);
      } catch {
        _dbCache = null;
        _dbPromise = null;
      }
    }
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
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
      req.onsuccess = function (e) {
        _dbCache = e.target.result;
        _dbCache.onclose = function () { _dbCache = null; _dbPromise = null; };
        _dbCache.onversionchange = function () { _dbCache.close(); _dbCache = null; _dbPromise = null; };
        resolve(_dbCache);
      };
      req.onerror = function (e) { _dbPromise = null; reject(e.target.error); };
    });
    return _dbPromise;
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

    // Extract font color from wrapping <font> element
    var fontColor = '';
    var fontEl = msgSpan.closest('font[color]');
    if (fontEl) {
      fontColor = fontEl.getAttribute('color');
    }

    return {
      room_id: getRoomId(),
      timestamp: now,
      message_type: message_type,
      sender: sender,
      recipient: recipient,
      content_html: contentAfterBold,
      content_text: contentText,
      is_whisper: is_whisper,
      color: fontColor
    };
  }

  function msgFingerprint(rec) {
    return rec.room_id + '|' + rec.timestamp.getTime() + '|' + rec.sender + '|' + rec.recipient + '|' + rec.content_text;
  }

  function captureDiv(div) {
    if (div.dataset.xchatHistCaptured) return;
    div.dataset.xchatHistCaptured = '1';
    if (!isHistoryEnabled() || !NETWORK.idbWrite.enabled) return;
    var rec = parseBoardDiv(div);
    if (!rec) return;
    rec.fingerprint = msgFingerprint(rec);
    runWhenIdle(function () {
      dbAdd(rec).then(function (id) {
        // id is null when the record already existed in IndexedDB (duplicate)
        if (!id || !rec.is_whisper || rec.message_type !== 'whisper' || getWhisperMode() !== 'floating') return;
        var autoMode = getFwAutoOpen();
        if (autoMode === 'none') return;

        // Extract nick from the whisper_to link
        var link = div.querySelector('a[href*="whisper_to"]');
        if (!link) return;
        var m = (link.getAttribute('href') || '').match(/whisper_to\s*\(\s*['"]([^'"]+)['"]\s*\)/);
        if (!m) return;
        var senderNick = m[1];
        var senderKey = normNick(senderNick);

        // Check if window already exists and is minimized
        if (floatingWindows[senderKey]) {
          if (floatingWindows[senderKey].el.classList.contains('xchat-fw-minimized')) {
            // Window is minimized — increment unread badge
            updateUnreadBadge(senderKey, (floatingWindows[senderKey].unreadCount || 0) + 1);
          }
          return;
        }

        // No window exists yet — open based on mode
        if (autoMode === 'window') {
          link.click();
        } else if (autoMode === 'bubble') {
          // Open as minimized bubble with badge
          _fwAutoOpenNoFocus = true;
          openFloatingWhisper(senderNick, true, true);
          _fwAutoOpenNoFocus = false;
          updateUnreadBadge(senderKey, 1);
        }
      }).catch(function () { /* silent */ });
    }, IDLE_DB_TIMEOUT_MS);
  }

  function captureAllDivs() {
    var board = document.getElementById('board');
    if (!board) return;
    var divs = board.querySelectorAll(':scope > div');
    for (var i = 0; i < divs.length; i++) captureDiv(divs[i]);
  }

  function processBoardDiv(div) {
    syncMainBoardRecentKey(div);
    captureDiv(div);
    rememberOutgoingNickFromDiv(div);
    processEntryDiv(div);
    markBadCommandDiv(div);
    markKickHighlightDiv(div);
  }

  function processExistingBoardDivs() {
    var board = document.getElementById('board');
    if (!board) return;
    var divs = board.querySelectorAll(':scope > div');
    for (var i = 0; i < divs.length; i++) processBoardDiv(divs[i]);
  }

  function getMainBoardFrames() {
    try {
      var roomFrame = window.top.roomframe;
      var boardFrame = roomFrame && (roomFrame.frames.roomframetop || roomFrame.frames[0]);
      var dataFrame = roomFrame && (roomFrame.frames.dataframe || roomFrame.frames[1]);
      var infoFrame = window.top.infopage || window.top.frames.infopage || window.top.frames[2];
      var board = boardFrame && boardFrame.document.getElementById('board');
      if (!roomFrame || !boardFrame || !dataFrame || !infoFrame || !board) return null;
      return {
        roomFrame: roomFrame,
        boardFrame: boardFrame,
        dataFrame: dataFrame,
        infoFrame: infoFrame,
        board: board
      };
    } catch {}
    return null;
  }

  function parseRoomBoardBodyLines(html) {
    var bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (!bodyMatch) return [];
    var inner = bodyMatch[1]
      .replace(/^\s*<font\b[^>]*><font\b[^>]*>/i, '')
      .replace(/<\/font>\s*<\/font>\s*$/i, '')
      .trim();
    if (!inner) return [];
    return inner.split(/<br\s*\/?>/gi).map(function (line) { return line.trim(); }).filter(Boolean);
  }

  function buildBoardLineKey(div, fallbackIndex) {
    var rec = parseBoardDiv(div);
    if (rec) return msgFingerprint(rec);
    return 'raw|' + fallbackIndex + '|' + (div.textContent || '').trim();
  }

  function getActiveMainBoardRefreshState() {
    try {
      var state = window.top._xchatLightBoardRefreshState;
      if (state && state.active) return state;
    } catch {}
    return null;
  }

  function rememberRecentBoardKey(state, key) {
    if (!key) return;
    if (!state.recentBoardKeys[key]) {
      state.recentBoardKeyOrder.push(key);
      state.recentBoardKeys[key] = 1;
    }
    if (state.recentBoardKeyOrder.length > ROOM_BOARD_MAX_KEYS) {
      var dropKey = state.recentBoardKeyOrder.shift();
      delete state.recentBoardKeys[dropKey];
    }
  }

  function seedRecentBoardKeys(state) {
    var divs = state.board.querySelectorAll(':scope > div');
    for (var i = 0; i < divs.length; i++) {
      var key = buildBoardLineKey(divs[i], i);
      divs[i].dataset.xchatBoardKey = key;
      rememberRecentBoardKey(state, key);
    }
  }

  function syncMainBoardRecentKeysFromDom(state) {
    if (!state || !state.board) return;
    var divs = state.board.querySelectorAll(':scope > div');
    for (var i = 0; i < divs.length; i++) {
      var key = divs[i].dataset.xchatBoardKey || buildBoardLineKey(divs[i], state.lastLine + i);
      divs[i].dataset.xchatBoardKey = key;
      rememberRecentBoardKey(state, key);
    }
  }

  function syncMainBoardRecentKey(div) {
    var state = getActiveMainBoardRefreshState();
    if (!state || !div) return;
    var hadKey = !!div.dataset.xchatBoardKey;
    var key = div.dataset.xchatBoardKey || buildBoardLineKey(div, state.lastLine + state.recentBoardKeyOrder.length);
    if (!hadKey && state.recentBoardKeys[key]) {
      div.remove();
      return;
    }
    div.dataset.xchatBoardKey = key;
    rememberRecentBoardKey(state, key);
  }

  function updateMainBoardCountdown(state, reset) {
    var refreshEl;
    try {
      refreshEl = state.infoFrame.document.getElementById('refresh') || state.infoFrame.document.getElementById('refresh-orig');
    } catch {}
    if (!refreshEl) return;
    if (reset) state.countdown = Math.max(1, Math.round(state.intervalMs / 1000));
    refreshEl.textContent = String(state.countdown);
  }

  function scheduleMainBoardRefresh(state) {
    if (!state.active) return;
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(function () {
      runMainBoardRefresh(state);
    }, state.intervalMs);
  }

  function stopMainBoardRefresh(state) {
    if (!state) return;
    state.active = false;
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    if (state.countdownTimer) clearInterval(state.countdownTimer);
    if (state.infoCountdownTimer) clearInterval(state.infoCountdownTimer);
    if (state.ownerWindow && state.unloadHandler) {
      try { state.ownerWindow.removeEventListener('unload', state.unloadHandler); } catch {}
    }
  }

  function runMainBoardRefresh(state) {
    if (!state.active || state.inFlight || !NETWORK.mainBoardMessages.enabled) {
      scheduleMainBoardRefresh(state);
      return;
    }
    state.inFlight = true;

    var url = new URL(state.baseUrl.toString());
    url.searchParams.set('last_line', String(state.lastLine));
    url.searchParams.set('fake', String(Math.floor(Date.now() / 1000)));

    enqueueXchatHtmlJob('main-board', function () {
      return fetch(url.toString(), {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      })
        .then(function (response) { return response.arrayBuffer(); })
        .then(function (buf) { return ROOM_BOARD_TEXT_DECODER.decode(buf); })
        .then(function (html) {
          if (!state.active) return;
          var lines = parseRoomBoardBodyLines(html);
          if (lines.length === 0) return;

          syncMainBoardRecentKeysFromDom(state);

          var fragment = state.boardFrame.document.createDocumentFragment();
          for (var i = 0; i < lines.length; i++) {
            var div = state.boardFrame.document.createElement('div');
            div.innerHTML = lines[i];
            var key = buildBoardLineKey(div, state.lastLine + i);
            if (state.recentBoardKeys[key]) continue;
            div.dataset.xchatBoardKey = key;
            rememberRecentBoardKey(state, key);
            fragment.appendChild(div);
          }

          if (fragment.childNodes.length > 0) {
            state.board.insertBefore(fragment, state.board.firstChild);
            while (state.board.children.length > state.maxLines) {
              state.board.lastElementChild.remove();
            }
          }

          state.lastLine += lines.length;
        });
    })
      .catch(function () {})
      .finally(function () {
        state.inFlight = false;
        updateMainBoardCountdown(state, true);
        scheduleMainBoardRefresh(state);
      });
  }

  function installLightweightMainBoardRefresh() {
    if (!TIMERS.mainBoardPoll.enabled || !NETWORK.mainBoardMessages.enabled) return;

    var frames = getMainBoardFrames();
    if (!frames) return;

    var currentHref = '';
    try { currentHref = frames.dataFrame.location.href; } catch {}
    if (!currentHref) return;

    var previous = window.top._xchatLightBoardRefreshState;
    if (previous && previous.active && previous.dataFrame === frames.dataFrame) {
      previous.dataFrame = frames.dataFrame;
      previous.boardFrame = frames.boardFrame;
      previous.infoFrame = frames.infoFrame;
      previous.board = frames.board;
      previous.intervalMs = getRefreshInterval() * 1000;
      previous.countdown = getRefreshInterval();
      updateMainBoardCountdown(previous, true);
      scheduleMainBoardRefresh(previous);
      return;
    }
    stopMainBoardRefresh(previous);

    var baseUrl = new URL(currentHref);
    var lastLine = parseInt(baseUrl.searchParams.get('last_line') || '0', 10);
    if (!isFinite(lastLine) || lastLine < 0) lastLine = 0;
    baseUrl.searchParams.set('js', '0');
    baseUrl.searchParams.set('inc', '1');

    var state = {
      active: true,
      ownerWindow: window,
      unloadHandler: null,
      dataFrame: frames.dataFrame,
      boardFrame: frames.boardFrame,
      infoFrame: frames.infoFrame,
      board: frames.board,
      baseUrl: baseUrl,
      lastLine: lastLine,
      intervalMs: getRefreshInterval() * 1000,
      countdown: getRefreshInterval(),
      recentBoardKeys: {},
      recentBoardKeyOrder: [],
      refreshTimer: null,
      countdownTimer: null,
      infoCountdownTimer: null,
      inFlight: false,
      maxLines: Math.max(frames.board.children.length || 0, 100)
    };

    seedRecentBoardKeys(state);
    window.top._xchatLightBoardRefreshState = state;
    state.unloadHandler = function () {
      if (window.top._xchatLightBoardRefreshState === state) {
        stopMainBoardRefresh(state);
      }
    };
    window.addEventListener('unload', state.unloadHandler);

    try {
      var metaRefresh = frames.dataFrame.document.querySelector('meta[http-equiv="Refresh" i]');
      if (metaRefresh) metaRefresh.remove();
    } catch {}

    try {
      if (frames.dataFrame.document && frames.dataFrame.document.body) {
        frames.dataFrame.document.body.removeAttribute('onload');
      }
    } catch {}

    // Permanently trap refresh/doLoad on dataframe so even late native re‑assignment is harmless
    var noop = function () {};
    noop._xchatNoOp = true;
    var dfTargets = [];
    try { dfTargets.push(frames.dataFrame); } catch {}
    try { if (frames.dataFrame.window && frames.dataFrame.window !== frames.dataFrame) dfTargets.push(frames.dataFrame.window); } catch {}
    dfTargets.forEach(function (target) {
      ['refresh', 'doLoad'].forEach(function (fnName) {
        try {
          Object.defineProperty(target, fnName, {
            get: function () { return noop; },
            set: function () { /* swallow native assignment */ },
            configurable: true,
            enumerable: true
          });
        } catch {
          try { target[fnName] = noop; } catch {}
        }
      });
    });

    // Kill current native timer and re‑kill periodically to catch late native setup
    function killNativeCID() {
      try {
        if (window.top.cID) {
          clearInterval(window.top.cID);
          window.top.cID = null;
        }
      } catch {}
    }
    killNativeCID();
    var cidKillCount = 0;
    var cidKillTimer = setInterval(function () {
      killNativeCID();
      cidKillCount++;
      if (cidKillCount >= 10) clearInterval(cidKillTimer);
    }, 500);

    updateMainBoardCountdown(state, true);
    state.infoCountdownTimer = setInterval(function () {
      if (!state.active) return;
      state.countdown = Math.max(0, state.countdown - 1);
      updateMainBoardCountdown(state, false);
    }, 1000);

    scheduleMainBoardRefresh(state);
  }

  function ensureLightweightMainBoardRefreshInstalled(attempt) {
    var tryCount = attempt || 0;
    if (getMainBoardFrames()) {
      installLightweightMainBoardRefresh();
      return;
    }
    if (tryCount >= NATIVE_REFRESH_KILL_MAX_ATTEMPTS) return;
    setTimeout(function () {
      ensureLightweightMainBoardRefreshInstalled(tryCount + 1);
    }, NATIVE_REFRESH_KILL_RETRY_MS);
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
    // via the lightweight polling queue (dataframe.refresh is a no-op).
    iframe.addEventListener('load', function () {
      fakeForm.remove();
      iframe.remove();
      var state = getActiveMainBoardRefreshState();
      if (state && state.active) {
        if (state.refreshTimer) clearTimeout(state.refreshTimer);
        runMainBoardRefresh(state);
      }
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
      if (sm) { CONFIG.myNick = sm[1]; return sm[1]; }
    }
    var myMsg = board.querySelector('.umsg_roomi b');
    if (myMsg) {
      var nick = myMsg.textContent.trim().replace(/:$/, '');
      CONFIG.myNick = nick;
      return nick;
    }
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
    if (!_outgoingNickCache) rebuildOutgoingNickCache();
    return !!_outgoingNickCache[normNick(nick)];
  }

  var _outgoingNickCache = null;

  function addOutgoingNickToCache(nick) {
    if (!nick) return;
    if (!_outgoingNickCache) _outgoingNickCache = {};
    _outgoingNickCache[normNick(nick)] = true;
  }

  function rememberOutgoingNickFromDiv(div) {
    var whisperLink = div.querySelector('.umsg_whisperi a');
    if (whisperLink) addOutgoingNickToCache(whisperLink.textContent.trim());

    var roomMsg = div.querySelector('.umsg_roomi');
    if (!roomMsg) return;
    var bold = roomMsg.querySelector('b');
    if (!bold) return;
    var textAfterBold = '';
    var node = bold.nextSibling;
    while (node) {
      textAfterBold += node.textContent || '';
      node = node.nextSibling;
    }
    var match = textAfterBold.trimStart().match(/^([^:]+):/);
    if (match) addOutgoingNickToCache(match[1].trim());
  }

  function rebuildOutgoingNickCache() {
    _outgoingNickCache = {};
    var board = document.getElementById('board');
    if (!board) return;
    var divs = board.querySelectorAll(':scope > div');
    for (var i = 0; i < divs.length; i++) rememberOutgoingNickFromDiv(divs[i]);
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

  function markKickHighlightDiv(div) {
    if (div.querySelector('.system.kicked, .system.killed')) {
      div.classList.add('xchat-kick-highlight');
    }
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
  var _fwAutoOpenNoFocus = false; // temporary flag for auto-open without focus
  var FW_STATE_KEY = '_xchat_fw_state';

  function updateUnreadBadge(key, count) {
    if (!floatingWindows[key]) return;
    floatingWindows[key].unreadCount = count;
    setFwUnread(key, count);
    var badge = floatingWindows[key].headBadge;
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count;
      badge.classList.add('xchat-fw-head-badge-visible');
    } else {
      badge.textContent = '';
      badge.classList.remove('xchat-fw-head-badge-visible');
    }
  }
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

  // Ensure all visible floating windows fit within the viewport.
  // Minimizes the leftmost visible whisper window (last in DOM = leftmost in
  // row-reverse layout) until nothing overflows. The optional protectedEl will
  // never be minimized so the window the user just opened/maximized stays visible.
  function ensureWindowsFit(protectedEl) {
    var container = document.getElementById('xchat-fw-container');
    if (!container) return;
    var changed = false;

    var safetyLimit = 50;
    while (safetyLimit-- > 0) {
      var visible = container.querySelectorAll('.xchat-fw:not(.xchat-fw-minimized)');
      if (visible.length <= 1) break; // always keep at least 1 container visible

      // Check if any visible window overflows the viewport (left edge < 0)
      var overflows = false;
      for (var vi = 0; vi < visible.length; vi++) {
        var rect = visible[vi].getBoundingClientRect();
        if (rect.left < 0) { overflows = true; break; }
      }
      if (!overflows) break;

      // Find the leftmost visible whisper window to minimize.
      // With row-reverse the last DOM child is visually leftmost.
      // Skip launcher and the protected element.
      var toMinimize = null;
      for (var i = visible.length - 1; i >= 0; i--) {
        if (visible[i] !== protectedEl && !visible[i].classList.contains('xchat-fw-launcher-win')) {
          toMinimize = visible[i];
          break;
        }
      }
      if (!toMinimize) break;

      toMinimize.classList.add('xchat-fw-minimized');
      // Activate corresponding head bubble
      var keys = Object.keys(floatingWindows);
      for (var ki = 0; ki < keys.length; ki++) {
        if (floatingWindows[keys[ki]].el === toMinimize && floatingWindows[keys[ki]].head) {
          floatingWindows[keys[ki]].head.classList.add('xchat-fw-head-visible');
          break;
        }
      }
      changed = true;
    }

    if (changed) saveFloatingState();
  }

  // Track viewport width so we recalculate only when the window shrinks
  var _fwLastViewportWidth = window.innerWidth;
  window.addEventListener('resize', function () {
    if (window.innerWidth < _fwLastViewportWidth) {
      ensureWindowsFit();
    }
    _fwLastViewportWidth = window.innerWidth;
  });

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

  function getWtkn() {
    try { return window.top.wtkn || ''; } catch { return ''; }
  }

  function buildRoomVisitUrl(rid) {
    var auth = getAuthPath();
    var wtkn = getWtkn();
    return 'https://www.xchat.cz/' + auth + '/room/intro.php?rid=' + encodeURIComponent(rid) + (wtkn ? '&wtkn=' + encodeURIComponent(wtkn) : '');
  }

  // Fetch user online status from wonline.php
  // Returns promise resolving to { online: bool, rooms: [{rid, idle, link, name}] }
  function fetchWonline(nick) {
    var url = 'https://scripts.xchat.cz/scripts/wonline.php?nick=' + encodeURIComponent(nick);
    return new Promise(function (resolve) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        console.error('[xchat-fw] GM_xmlhttpRequest not available, falling back to fetch (through queue)');
        enqueueXchatHtmlJob('fw-wonline-fallback:' + normNick(nick), function () {
          return fetch(url).then(function (r) { return r.text(); });
        }).then(function (t) { resolve(t || ''); }).catch(function () { resolve(''); });
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        onload: function (resp) {
          resolve(resp.responseText || '');
        },
        onerror: function (err) {
          console.error('[xchat-fw] wonline GM_xmlhttpRequest error:', err);
          resolve('');
        },
        ontimeout: function () {
          console.error('[xchat-fw] wonline GM_xmlhttpRequest timeout');
          resolve('');
        }
      });
    }).then(function (text) {
      if (!text) { return { online: false, rooms: [] }; }
      var lines = text.trim().split('\n');
      if (!lines.length) return { online: false, rooms: [] };
      var count = parseInt(lines[0], 10);
      if (!count || count <= 0) return { online: false, rooms: [] };
      var rooms = [];
      for (var i = 1; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        var parts = line.match(/^(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
        if (parts) {
          rooms.push({ rid: parts[1], idle: parts[2], link: parts[3], name: parts[4].trim() });
        }
      }
      var result = { online: rooms.length > 0, rooms: rooms };
      return result;
    });
  }

  function extractUserIconSources(upHtml) {
    var upDoc = new DOMParser().parseFromString(upHtml, 'text/html');
    var crdiv = upDoc.getElementById('crdiv1');
    if (!crdiv) return [];
    var imgs = crdiv.querySelectorAll('img');
    var sources = [];
    for (var ii = 0; ii < imgs.length; ii++) {
      var src = imgs[ii].getAttribute('src') || '';
      if (/images\/personal\//i.test(src)) continue;
      if (/images\/x4\/sm\//i.test(src)) continue;
      if (/\/pict_/i.test(src)) continue;
      if (/\/x0\.gif/i.test(src)) continue;
      sources.push(src);
    }
    return sources;
  }

  function applyUserIconSources(fwData, sources) {
    if (!fwData) return;
    if (fwData.iconsEl) fwData.iconsEl.innerHTML = '';
    if (fwData.headTipIcons) fwData.headTipIcons.innerHTML = '';
    for (var i = 0; i < sources.length; i++) {
      if (fwData.iconsEl) {
        var iconImg = document.createElement('img');
        iconImg.src = sources[i];
        iconImg.border = '0';
        fwData.iconsEl.appendChild(iconImg);
      }
      if (!fwData.headTipIcons) continue;
      var tipImg = document.createElement('img');
      tipImg.src = sources[i];
      fwData.headTipIcons.appendChild(tipImg);
    }
  }

  function parseWhisperFrameUrls(html) {
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

    if (roomtopUrl) {
      roomtopUrl = roomtopUrl.replace(/op=roomframeng/i, 'op=roomtopng');
    }

    var base = location.protocol + '//www.xchat.cz/';
    if (roomtopUrl && !/^https?:/.test(roomtopUrl)) roomtopUrl = base + roomtopUrl.replace(/^\//, '');
    if (textpageUrl && !/^https?:/.test(textpageUrl)) textpageUrl = base + textpageUrl.replace(/^\//, '');
    if (userpageUrl && !/^https?:/.test(userpageUrl)) userpageUrl = base + userpageUrl.replace(/^\//, '');

    if (roomtopUrl) {
      if (/[&?]js=\d+/.test(roomtopUrl)) {
        roomtopUrl = roomtopUrl.replace(/([&?]js=)\d+/, '$10');
      } else {
        roomtopUrl += (roomtopUrl.indexOf('?') >= 0 ? '&' : '?') + 'js=0';
      }
    }

    return {
      roomtopUrl: roomtopUrl,
      textpageUrl: textpageUrl,
      userpageUrl: userpageUrl
    };
  }

  function resolveWhisperFrameUrls(key, framesetUrl) {
    var fwData = floatingWindows[key];
    if (!fwData || !framesetUrl) return Promise.resolve(null);
    if (fwData.roomtopUrl || fwData.textpageUrl || fwData.userpageUrl) {
      return Promise.resolve({
        roomtopUrl: fwData.roomtopUrl || '',
        textpageUrl: fwData.textpageUrl || '',
        userpageUrl: fwData.userpageUrl || ''
      });
    }
    if (fwData.frameUrlsPromise) return fwData.frameUrlsPromise;
    if (!NETWORK.fwFrameset.enabled) return Promise.resolve(null);

    fwData.frameUrlsPromise = enqueueXchatHtmlJob('fw-frameset:' + key, function () {
      return fetch(framesetUrl, { credentials: 'include' });
    })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var urls = parseWhisperFrameUrls(html);
        if (floatingWindows[key]) {
          floatingWindows[key].roomtopUrl = urls.roomtopUrl;
          floatingWindows[key].textpageUrl = urls.textpageUrl;
          floatingWindows[key].userpageUrl = urls.userpageUrl;
        }
        return urls;
      })
      .finally(function () {
        if (floatingWindows[key]) {
          floatingWindows[key].frameUrlsPromise = null;
        }
      });

    return fwData.frameUrlsPromise;
  }

  function getWhisperUserIconRefreshInterval(fwData) {
    if (!fwData || !fwData.el) return FW_USER_ICON_OPEN_REFRESH_MS;
    return fwData.el.classList.contains('xchat-fw-minimized') ? FW_USER_ICON_MINIMIZED_REFRESH_MS : FW_USER_ICON_OPEN_REFRESH_MS;
  }

  function refreshWhisperUserIcons(key, userpageUrl, force) {
    if (!NETWORK.fwUserpage.enabled || !userpageUrl) return Promise.resolve([]);
    var fwData = floatingWindows[key];
    if (!fwData) return Promise.resolve([]);
    fwData.userpageUrl = userpageUrl;

    var cached = getCachedUserIconSources(key);
    if (!force && cached && (Date.now() - cached.updatedAt) < FW_USER_ICON_CACHE_TTL_MS) {
      applyUserIconSources(fwData, cached.sources);
      return Promise.resolve(cached.sources);
    }

    return enqueueXchatHtmlJob('fw-userpage:' + key, function () {
      return fetch(userpageUrl, { credentials: 'include' });
    })
      .then(function (r2) { return r2.text(); })
      .then(function (upHtml) {
        var sources = extractUserIconSources(upHtml);
        cacheUserIconSources(key, sources);
        if (floatingWindows[key]) {
          applyUserIconSources(floatingWindows[key], sources);
        }
        return sources;
      })
      .catch(function () { return []; });
  }

  function scheduleUserIconRefresh(key, framesetUrl, delayMs, forceFetch) {
    var fwData = floatingWindows[key];
    if (!fwData) return;
    if (fwData.userIconRefreshTimer) clearTimeout(fwData.userIconRefreshTimer);
    fwData.userIconRefreshTimer = setTimeout(function () {
      var current = floatingWindows[key];
      if (!current) return;
      resolveWhisperFrameUrls(key, current.framesetUrl || framesetUrl)
        .then(function (frameUrls) {
          if (!floatingWindows[key] || !frameUrls || !frameUrls.userpageUrl) return [];
          return refreshWhisperUserIcons(key, frameUrls.userpageUrl, forceFetch !== false);
        })
        .finally(function () {
          var next = floatingWindows[key];
          if (!next) return;
          scheduleUserIconRefresh(key, next.framesetUrl || framesetUrl, getWhisperUserIconRefreshInterval(next), true);
        });
    }, delayMs);
  }

  function bootstrapWhisperUserIcons(key, framesetUrl) {
    var fwData = floatingWindows[key];
    if (!fwData) return;
    var cached = getCachedUserIconSources(key);
    if (cached) {
      applyUserIconSources(fwData, cached.sources);
    }
    var refreshMs = getWhisperUserIconRefreshInterval(fwData);
    var needsImmediateFetch = !cached || (Date.now() - cached.updatedAt) >= refreshMs;
    scheduleUserIconRefresh(key, framesetUrl, needsImmediateFetch ? 0 : refreshMs, true);
  }

  function rescheduleWhisperUserIconsForState(key, immediate) {
    var fwData = floatingWindows[key];
    if (!fwData) return;
    scheduleUserIconRefresh(key, fwData.framesetUrl, immediate ? 0 : getWhisperUserIconRefreshInterval(fwData), true);
  }

  function buildWhisperBaseUrl(nick) {
    var auth = getAuthPath();
    var rid = 0;
    try { rid = window.top.rid || 0; } catch {}
    return location.protocol + '//www.xchat.cz/' + auth + '/modchat?op=whisperingframeset&rid=' + rid + '&wfrom=' + encodeURIComponent(nick);
  }

  function openFloatingWhisper(nick, startMinimized, noFocus) {
    var key = normNick(nick);
    touchWhisperHistory(nick);
    refreshLauncherHistory();
    // If already open, un-minimize
    if (floatingWindows[key]) {
      var fwRef = floatingWindows[key];
      fwRef.el.classList.remove('xchat-fw-minimized');
      if (fwRef.head) fwRef.head.classList.remove('xchat-fw-head-visible');
      // Clear unread badge and persist read keys
      updateUnreadBadge(key, 0);
      saveReadKeys(key, fwRef.seenMsgKeys);
      // Move to front of DOM = rightmost in row-reverse layout
      var container = getFloatingContainer();
      if (fwRef.el !== container.firstChild) container.insertBefore(fwRef.el, container.firstChild);
      saveFloatingState();
      ensureWindowsFit(fwRef.el);
      // Lazy-load content if not yet loaded
      if (!fwRef.loaded && fwRef.loadContent) fwRef.loadContent();
      rescheduleWhisperUserIconsForState(key, true);
      // Focus the input field (only for manual opens)
      if (!noFocus) {
        var inp = fwRef.el.querySelector('.xchat-fw-input');
        if (inp) setTimeout(function () { inp.focus(); }, 50);
      }
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

    // Avatar thumbnail in header (wrapped for status dot overlay)
    var avatarWrap = document.createElement('div');
    avatarWrap.className = 'xchat-fw-avatar-wrap';
    var avatarImg = document.createElement('img');
    avatarImg.className = 'xchat-fw-header-avatar';
    avatarImg.src = 'https://www.xchat.cz/whoiswho/perphoto.php?nick=' + encodeURIComponent(nick);
    avatarImg.alt = nick;
    avatarWrap.appendChild(avatarImg);
    info.appendChild(avatarWrap);

    var infoTexts = document.createElement('div');
    infoTexts.className = 'xchat-fw-header-texts';

    var nickRow = document.createElement('div');
    nickRow.className = 'xchat-fw-nick-row';

    var iconsSpan = document.createElement('span');
    iconsSpan.className = 'xchat-fw-icons';
    nickRow.appendChild(iconsSpan);

    var nickEl = document.createElement('span');
    nickEl.className = 'xchat-fw-nick';
    nickEl.textContent = nick;
    nickRow.appendChild(nickEl);

    infoTexts.appendChild(nickRow);

    var roomEl = document.createElement('div');
    roomEl.className = 'xchat-fw-room';
    roomEl.textContent = '';
    infoTexts.appendChild(roomEl);

    info.appendChild(infoTexts);
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
      rescheduleWhisperUserIconsForState(key, false);
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
      // When un-minimizing, move to front of DOM = rightmost in row-reverse
      if (wasMinimized && fw !== container.firstChild) container.insertBefore(fw, container.firstChild);
      // Clear unread badge when un-minimizing and persist read keys
      if (wasMinimized) {
        updateUnreadBadge(key, 0);
        if (floatingWindows[key]) saveReadKeys(key, floatingWindows[key].seenMsgKeys);
      }
      saveFloatingState();
      // When un-minimizing, ensure windows still fit and focus input
      if (wasMinimized) {
        ensureWindowsFit(fw);
        var inp = fw.querySelector('.xchat-fw-input');
        if (inp) setTimeout(function () { inp.focus(); }, 50);
      }
      // Lazy-load content if not yet loaded, or refresh messages
      if (wasMinimized && floatingWindows[key]) {
        if (!floatingWindows[key].loaded && floatingWindows[key].loadContent) {
          floatingWindows[key].loadContent();
        } else if (floatingWindows[key].fetchMessages) {
          floatingWindows[key].fetchMessages();
        }
      }
      rescheduleWhisperUserIconsForState(key, wasMinimized);
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

    // Unread badge (shown at bottom-right)
    var headBadge = document.createElement('span');
    headBadge.className = 'xchat-fw-head-badge';
    head.appendChild(headBadge);

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
      // Clear unread badge and persist read keys
      updateUnreadBadge(key, 0);
      if (floatingWindows[key]) saveReadKeys(key, floatingWindows[key].seenMsgKeys);
      // Move to front of DOM = rightmost in row-reverse layout
      if (fw !== container.firstChild) container.insertBefore(fw, container.firstChild);
      saveFloatingState();
      ensureWindowsFit(fw);
      // Focus the input field
      var inp = fw.querySelector('.xchat-fw-input');
      if (inp) setTimeout(function () { inp.focus(); }, 50);
      // Lazy-load content if not yet loaded, or refresh messages
      if (floatingWindows[key]) {
        if (!floatingWindows[key].loaded && floatingWindows[key].loadContent) {
          floatingWindows[key].loadContent();
        } else if (floatingWindows[key].fetchMessages) {
          floatingWindows[key].fetchMessages();
        }
      }
      rescheduleWhisperUserIconsForState(key, true);
    });

    if (startMinimized) {
      fw.classList.add('xchat-fw-minimized');
      head.classList.add('xchat-fw-head-visible');
    }

    // Insert new window as first child = rightmost in row-reverse layout.
    // The launcher (if open) will always re-insert itself as firstChild when toggled,
    // so new whisper windows appear to the right of all older whisper windows.
    container.insertBefore(fw, container.firstChild);
    getHeadsSidebar().appendChild(head);

    // Store reference with room element for live updates
    var initialSeenKeys = {};
    var savedReadKeys = getReadKeys(key);
    for (var rk in savedReadKeys) if (savedReadKeys.hasOwnProperty(rk)) initialSeenKeys[rk] = true;
    floatingWindows[key] = { el: fw, head: head, headBadge: headBadge, roomEl: roomEl, avatarWrap: avatarWrap, origNick: nick, headTipIcons: headTipIcons, iconsEl: iconsSpan, seenMsgKeys: initialSeenKeys, unreadCount: 0, openedAt: Date.now(), loaded: false, messageFetchInFlight: false, fetchMessagesTimeout: null, onlinePollTimer: null, userIconRefreshTimer: null, framesetUrl: framesetUrl, roomtopUrl: '', textpageUrl: '', userpageUrl: '', frameUrlsPromise: null };
    saveFloatingState();
    if (startMinimized) bootstrapWhisperUserIcons(key, framesetUrl);

    // Restore unread badge from localStorage (for minimized windows after page reload)
    if (startMinimized) {
      var savedUnread = getFwUnread();
      if (savedUnread[key] > 0) {
        updateUnreadBadge(key, savedUnread[key]);
      }
    }

    // Auto-minimize oldest windows if the new one doesn't fit
    if (!startMinimized) {
      ensureWindowsFit(fw);
    }

    // ── Fetch frameset to extract individual frame URLs ──
    var loadContent = function () {
      if (floatingWindows[key] && floatingWindows[key].loaded) return;
      if (floatingWindows[key]) floatingWindows[key].loaded = true;
      resolveWhisperFrameUrls(key, framesetUrl)
      .then(function (frameUrls) {
        if (!frameUrls) return;
        var roomtopUrl = frameUrls.roomtopUrl;
        var textpageUrl = frameUrls.textpageUrl;
        var userpageUrl = frameUrls.userpageUrl;
        var base = location.protocol + '//www.xchat.cz/';

        // ── Load messages from roomtopng via fetch+parse ──
        if (roomtopUrl) {
          // Create message container
          var msgContainer = document.createElement('div');
          msgContainer.className = 'xchat-fw-messages';
          body.innerHTML = '';
          body.appendChild(msgContainer);

          // Track how many history messages are displayed and total available
          var historyDisplayed = 0;
          var historyTotal = 0;
          var allHistoryMsgs = [];
          var loadMoreEl = null;

          // Helper: create a DOM element for one message
          var createMsgEl = function (msg) {
            var msgEl = document.createElement('div');
            msgEl.className = 'xchat-fw-msg ' + (msg.cls === 'umsg_whwi' || msg.cls === 'whisper_out' ? 'xchat-fw-msg-mine' : 'xchat-fw-msg-theirs');
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
            textSpan.style.color = msg.color;
            // Preserve images (smileys) in text
            var tmpDiv = document.createElement('div');
            tmpDiv.innerHTML = msg.text;
            while (tmpDiv.firstChild) textSpan.appendChild(tmpDiv.firstChild);
            msgEl.appendChild(textSpan);

            return msgEl;
          };

          // ── Load initial messages from IndexedDB history ──
          var loadHistoryFromDB = function () {
            if (!NETWORK.idbHistoryRead.enabled) return Promise.resolve();
            var origNick = floatingWindows[key] ? floatingWindows[key].origNick : nick;
            var normKey = normNick(origNick);
            return dbQuery({ is_whisper: true }).then(function (results) {
              // Filter to messages involving this nick (sender or recipient)
              var relevant = results.filter(function (rec) {
                return normNick(rec.sender) === normKey || normNick(rec.recipient) === normKey;
              });
              // Sort by timestamp ascending (oldest first)
              relevant.sort(function (a, b) {
                var ta = a.timestamp instanceof Date ? a.timestamp.getTime() : new Date(a.timestamp).getTime();
                var tb = b.timestamp instanceof Date ? b.timestamp.getTime() : new Date(b.timestamp).getTime();
                return ta - tb;
              });
              allHistoryMsgs = relevant;
              historyTotal = relevant.length;
              var maxMsgs = getFwMaxMessages();
              // Show only last N messages
              var startIdx = Math.max(0, relevant.length - maxMsgs);
              historyDisplayed = relevant.length - startIdx;
              var seenKeys = floatingWindows[key] ? floatingWindows[key].seenMsgKeys : {};
              var newestFirst = getFwNewestFirst();

              for (var i = startIdx; i < relevant.length; i++) {
                var rec = relevant[i];
                var ts = rec.timestamp instanceof Date ? rec.timestamp : new Date(rec.timestamp);
                var timeStr = ('0' + ts.getHours()).slice(-2) + ':' + ('0' + ts.getMinutes()).slice(-2) + ':' + ('0' + ts.getSeconds()).slice(-2);
                var msgKey = timeStr + '|' + rec.sender + '|' + rec.content_text;
                // Mark as seen for live-fetch dedup, but always display history messages
                seenKeys[msgKey] = true;
                var isMine = /_(out|i)$/.test(rec.message_type || '');
                var msgEl = createMsgEl({
                  key: msgKey,
                  time: timeStr,
                  nick: rec.sender,
                  text: rec.content_html || escapeHtml(rec.content_text || ''),
                  color: rec.color || (isMine ? '#C87000' : '#282828'),
                  cls: isMine ? 'whisper_out' : 'whisper_in'
                });
                msgEl.classList.add('xchat-fw-msg-history');
                if (newestFirst) {
                  msgContainer.insertBefore(msgEl, msgContainer.firstChild);
                } else {
                  msgContainer.appendChild(msgEl);
                }
              }

              // Add 'load more' link if there are more messages
              if (startIdx > 0) {
                addLoadMoreLink(startIdx);
              }

              // Scroll to correct position
              if (newestFirst) {
                msgContainer.scrollTop = 0;
              } else {
                msgContainer.scrollTop = msgContainer.scrollHeight;
              }
            }).catch(function () { /* IndexedDB may not be available */ });
          };

          var addLoadMoreLink = function (remainingCount) {
            if (loadMoreEl) loadMoreEl.remove();
            loadMoreEl = document.createElement('a');
            loadMoreEl.className = 'xchat-fw-load-more';
            loadMoreEl.textContent = 'Na\u010d\u00edst v\u00edce zpr\u00e1v (' + remainingCount + ')';
            loadMoreEl.addEventListener('click', function (e) {
              e.preventDefault();
              loadMoreHistory();
            });
            var newestFirst = getFwNewestFirst();
            if (newestFirst) {
              msgContainer.appendChild(loadMoreEl);
            } else {
              msgContainer.insertBefore(loadMoreEl, msgContainer.firstChild);
            }
          };

          var loadMoreHistory = function () {
            if (!allHistoryMsgs.length) return;
            var maxMsgs = getFwMaxMessages();
            var currentStart = Math.max(0, allHistoryMsgs.length - historyDisplayed);
            var newStart = Math.max(0, currentStart - maxMsgs);
            var seenKeys = floatingWindows[key] ? floatingWindows[key].seenMsgKeys : {};
            var newestFirst = getFwNewestFirst();
            var fragment = document.createDocumentFragment();

            for (var i = newStart; i < currentStart; i++) {
              var rec = allHistoryMsgs[i];
              var ts = rec.timestamp instanceof Date ? rec.timestamp : new Date(rec.timestamp);
              var timeStr = ('0' + ts.getHours()).slice(-2) + ':' + ('0' + ts.getMinutes()).slice(-2) + ':' + ('0' + ts.getSeconds()).slice(-2);
              var msgKey = timeStr + '|' + rec.sender + '|' + rec.content_text;
              // Mark as seen for live-fetch dedup, but always display history messages
              seenKeys[msgKey] = true;
              var isMine = /_(out|i)$/.test(rec.message_type || '');
              var msgEl = createMsgEl({
                key: msgKey,
                time: timeStr,
                nick: rec.sender,
                text: rec.content_html || escapeHtml(rec.content_text || ''),
                color: rec.color || (isMine ? '#C87000' : '#282828'),
                cls: isMine ? 'whisper_out' : 'whisper_in'
              });
              msgEl.classList.add('xchat-fw-msg-history');
              fragment.appendChild(msgEl);
            }

            historyDisplayed += (currentStart - newStart);

            if (newestFirst) {
              // Append older messages at the bottom (before load-more link)
              if (loadMoreEl && loadMoreEl.parentNode) {
                msgContainer.insertBefore(fragment, loadMoreEl);
              } else {
                msgContainer.appendChild(fragment);
              }
            } else {
              // Prepend older messages at the top (after load-more link)
              var prevHeight = msgContainer.scrollHeight;
              if (loadMoreEl && loadMoreEl.nextSibling) {
                msgContainer.insertBefore(fragment, loadMoreEl.nextSibling);
              } else {
                msgContainer.insertBefore(fragment, msgContainer.firstChild);
              }
              // Preserve scroll position
              msgContainer.scrollTop += msgContainer.scrollHeight - prevHeight;
            }

            // Update or remove load-more link
            if (newStart > 0) {
              addLoadMoreLink(newStart);
            } else if (loadMoreEl) {
              loadMoreEl.remove();
              loadMoreEl = null;
            }
          };

          // Load history later in idle time so it does not contend with live roomtopng polling.
          runWhenIdle(function () {
            loadHistoryFromDB().then(function () {
              // Mark history messages so live fetch can skip duplicates
            });
          }, 1500);

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
            if (!NETWORK.fwMessages.enabled) return Promise.resolve();
            if (floatingWindows[key].messageFetchInFlight) return Promise.resolve();
            floatingWindows[key].messageFetchInFlight = true;

            return enqueueXchatHtmlJob('fw-messages:' + key, function () {
              return fetch(buildFetchUrl(), {
                method: 'GET',
                credentials: 'include',
                headers: {
                  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                  'Cache-Control': 'no-cache',
                  'Pragma': 'no-cache'
                }
              })
              .then(function (r2) { return r2.arrayBuffer(); })
              .then(function (buf) { return new TextDecoder('iso-8859-2').decode(buf); })
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

                // Strip <font> wrappers to get to message lines.
                // First extract color from any <font> that carries a color attribute,
                // then remove ALL <font> opening and closing tags.
                var stripped = bodyInner
                  .replace(/<font\b[^>]*>/gi, function (tag) {
                    // Preserve per-message color as a lightweight marker
                    var cm = tag.match(/\bcolor=["']?([^"'\s>]+)/i);
                    return cm ? '\x01' + cm[1] + '\x01' : '';
                  })
                  .replace(/<\/font>/gi, '');

                // Split on <br> to get individual message lines
                var lines = stripped.split(/<br\s*\/?>/gi);
                var parsedMsgs = [];

                for (var li = 0; li < lines.length; li++) {
                  var line = lines[li].trim();
                  if (!line) continue;

                  // Extract time (possibly preceded by residual tags/markers)
                  var timeMatch = line.match(/(\d{1,2}:\d{2}:\d{2})/);
                  if (!timeMatch) continue;
                  var time = timeMatch[1];

                  // Extract color from preserved marker, or derive from span class
                  var colorMarker = line.match(/\x01([^\x01]+)\x01/);

                  // Extract span class (umsg_whwi = outgoing/mine, umsg_whw = incoming/theirs)
                  var spanMatch = line.match(/<span\s+class="([^"]*)">/i);
                  if (!spanMatch) continue;
                  var msgClass = spanMatch[1];

                  // Skip non-whisper messages (system notifications etc.) — only count actual whispers
                  if (!/umsg_whw|umsg_wcross/.test(msgClass)) continue;

                  var color = colorMarker ? colorMarker[1] : (msgClass === 'umsg_whwi' ? '#C87000' : '#282828');

                  // Extract content inside <span ...>...</span>
                  var spanContentMatch = line.match(/<span\s+class="[^"]*">([\s\S]*?)<\/span>/i);
                  if (!spanContentMatch) continue;
                  var spanContent = spanContentMatch[1];

                  // Parse nick and text: <b>Nick:</b> Text
                  var nickTextMatch = spanContent.match(/<b>([^<]+):<\/b>\s*([\s\S]*)/i);
                  if (!nickTextMatch) continue;
                  var msgNick = nickTextMatch[1].trim();
                  var msgText = nickTextMatch[2].trim();
                  // Remove residual font markers and tags
                  msgText = msgText.replace(/\x01[^\x01]*\x01/g, '').replace(/<\/font>\s*$/i, '').trim();

                  // Unique key for deduplication (strip HTML to match content_text from IndexedDB)
                  var msgTextPlain = msgText.replace(/<[^>]+>/g, '').trim();
                  var msgKey = time + '|' + msgNick + '|' + msgTextPlain;

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
                var newMsgCount = 0;
                for (var mi = 0; mi < parsedMsgs.length; mi++) {
                  var msg = parsedMsgs[mi];
                  if (seenKeys[msg.key]) continue;
                  seenKeys[msg.key] = true;
                  newMsgCount++;

                  var msgEl = createMsgEl(msg);
                  if (newestFirst) {
                    // Newest on top: prepend (newest = last in chronological = appended last → prepend each)
                    msgContainer.insertBefore(msgEl, msgContainer.firstChild);
                  } else {
                    // Newest on bottom: append
                    msgContainer.appendChild(msgEl);
                  }
                }

                // Trim seenMsgKeys to prevent unbounded memory growth
                var allSeenKeys = Object.keys(seenKeys);
                if (allSeenKeys.length > 500) {
                  allSeenKeys.slice(0, allSeenKeys.length - 500).forEach(function (k) { delete seenKeys[k]; });
                }

                // Update unread badge if window is minimized and new messages arrived
                if (newMsgCount > 0 && floatingWindows[key] && floatingWindows[key].el.classList.contains('xchat-fw-minimized')) {
                  updateUnreadBadge(key, (floatingWindows[key].unreadCount || 0) + newMsgCount);
                }

                // Auto-scroll
                if (wasScrolled) {
                  if (newestFirst) {
                    msgContainer.scrollTop = 0;
                  } else {
                    msgContainer.scrollTop = msgContainer.scrollHeight;
                  }
                }
              });
            })
              .catch(function () {})
              .finally(function () {
                if (floatingWindows[key]) {
                  floatingWindows[key].messageFetchInFlight = false;
                }
              });
          };

          var scheduleMessagePoll = function (delayMs) {
            if (!floatingWindows[key] || !TIMERS.fwMessagesPoll.enabled) return;
            if (floatingWindows[key].msgPollTimer) clearTimeout(floatingWindows[key].msgPollTimer);
            floatingWindows[key].msgPollTimer = setTimeout(function () {
              var current = floatingWindows[key];
              if (!current) return;
              if (current.el.classList.contains('xchat-fw-minimized')) {
                scheduleMessagePoll(TIMERS.fwMessagesPoll.intervalMs);
                return;
              }
              fetchAndUpdateMessages().finally(function () {
                scheduleMessagePoll(TIMERS.fwMessagesPoll.intervalMs);
              });
            }, delayMs);
          };

          // ── Fetch remote user's online status from wonline.php ──
          var fetchAndUpdateRooms = function () {
            if (!floatingWindows[key]) return;
            if (!NETWORK.fwWonline.enabled) return;
            var aw = floatingWindows[key].avatarWrap;
            return enqueueXchatHtmlJob('fw-wonline:' + key, function () {
              return fetchWonline(floatingWindows[key].origNick);
            }).then(function (result) {
              if (!floatingWindows[key]) return;
              roomEl.innerHTML = '';
              // Remove previous status dot from avatar
              var oldDot = aw && aw.querySelector('.xchat-fw-status-dot');
              if (oldDot) oldDot.remove();
              if (result.online && result.rooms.length > 0) {
                // Sort rooms by idle time ascending (least idle first)
                var sortedRooms = result.rooms.slice().sort(function (a, b) {
                  return parseIdleToSeconds(a.idle) - parseIdleToSeconds(b.idle);
                });
                // Status dot on avatar
                if (aw) {
                  var dot = document.createElement('span');
                  dot.className = 'xchat-fw-status-dot xchat-fw-status-online';
                  dot.textContent = '\u25CF';
                  aw.appendChild(dot);
                }
                // Build room text as a single string for word-safe truncation
                var parts = [];
                for (var ri = 0; ri < sortedRooms.length; ri++) {
                  parts.push(ri === 0 ? sortedRooms[ri].name + ' (' + sortedRooms[ri].idle + ')' : sortedRooms[ri].name);
                }
                var fullText = parts.join(', ');
                // Measure overflow using a temporary span
                var measure = document.createElement('span');
                measure.textContent = fullText;
                roomEl.appendChild(measure);
                // Force layout to measure
                if (roomEl.scrollWidth > roomEl.clientWidth) {
                  // Remove entries from end until text fits with ellipsis
                  while (parts.length > 1) {
                    parts.pop();
                    measure.textContent = parts.join(', ') + '\u2026';
                    if (roomEl.scrollWidth <= roomEl.clientWidth) break;
                  }
                  if (parts.length === 1 && roomEl.scrollWidth > roomEl.clientWidth) {
                    measure.textContent = parts[0] + '\u2026';
                  }
                }
                measure.remove();
                // Now build DOM with links for the visible entries
                for (var ri2 = 0; ri2 < parts.length; ri2++) {
                  if (ri2 > 0) {
                    roomEl.appendChild(document.createTextNode(', '));
                  }
                  var roomLink = document.createElement('a');
                  roomLink.className = 'xchat-fw-room-link';
                  roomLink.href = buildRoomVisitUrl(sortedRooms[ri2].rid);
                  roomLink.target = '_blank';
                  roomLink.textContent = parts[ri2];
                  roomLink.title = sortedRooms[ri2].name + ' \u2013 nemluvil ' + sortedRooms[ri2].idle;
                  roomLink.addEventListener('click', function (e) { e.stopPropagation(); });
                  roomEl.appendChild(roomLink);
                }
                if (parts.length < sortedRooms.length) {
                  roomEl.appendChild(document.createTextNode('\u2026'));
                }
              } else {
                // Status dot on avatar (offline)
                if (aw) {
                  var dot = document.createElement('span');
                  dot.className = 'xchat-fw-status-dot xchat-fw-status-offline';
                  dot.textContent = '\u25CF';
                  aw.appendChild(dot);
                }
                var offlineText = document.createElement('span');
                offlineText.className = 'xchat-fw-status-offline-text';
                offlineText.textContent = 'offline';
                roomEl.appendChild(offlineText);
              }
            });
          };

          var scheduleOnlinePoll = function (delayMs) {
            if (!floatingWindows[key] || !TIMERS.fwOnlineStatusPoll.enabled) return;
            if (floatingWindows[key].onlinePollTimer) clearTimeout(floatingWindows[key].onlinePollTimer);
            floatingWindows[key].onlinePollTimer = setTimeout(function () {
              var current = floatingWindows[key];
              if (!current) return;
              if (current.el.classList.contains('xchat-fw-minimized')) {
                scheduleOnlinePoll(TIMERS.fwOnlineStatusPoll.intervalMs);
                return;
              }
              Promise.resolve(fetchAndUpdateRooms()).finally(function () {
                scheduleOnlinePoll(TIMERS.fwOnlineStatusPoll.intervalMs);
              });
            }, delayMs);
          };

          // Initial fetches
          fetchAndUpdateMessages();
          fetchAndUpdateRooms();

          // Periodický polling zpráv — přeskakuje minimalizovaná okna a neběží paralelně
          var msgPollTimer = null;
          if (TIMERS.fwMessagesPoll.enabled) {
            scheduleMessagePoll(TIMERS.fwMessagesPoll.intervalMs);
            msgPollTimer = floatingWindows[key] ? floatingWindows[key].msgPollTimer : null;
          }

          // Periodický polling online stavu — přeskakuje minimalizovaná okna
          if (TIMERS.fwOnlineStatusPoll.enabled) {
            scheduleOnlinePoll(TIMERS.fwOnlineStatusPoll.intervalMs);
          }

          if (floatingWindows[key]) floatingWindows[key].msgPollTimer = msgPollTimer;
          floatingWindows[key].fetchMessages = fetchAndUpdateMessages;
        }

        // ── Fetch textpage form data for sending ──
        if (textpageUrl && NETWORK.fwTextpage.enabled) {
          enqueueXchatHtmlJob('fw-textpage:' + key, function () {
            return fetch(textpageUrl, { credentials: 'include' });
          })
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
              if (fwd.fetchMessagesTimeout) clearTimeout(fwd.fetchMessagesTimeout);
              fwd.fetchMessagesTimeout = setTimeout(function () {
                var latest = floatingWindows[key];
                if (latest && latest.fetchMessages) latest.fetchMessages();
              }, 900);
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

        // Focus input when visible (not currently minimized)
        if (!fw.classList.contains('xchat-fw-minimized')) {
          setTimeout(function () { fwInput.focus(); }, 100);
        }

        // Fetch userpage for status icons (skip photos and smileys)
        if (userpageUrl && NETWORK.fwUserpage.enabled) {
          refreshWhisperUserIcons(key, userpageUrl, false).catch(function () { /* icons are optional */ });
          rescheduleWhisperUserIconsForState(key, false);
        }
      })
      .catch(function () {
        // Fallback: show error in body
        body.textContent = 'Nepoda\u0159ilo se na\u010d\u00edst \u0161ept.';
      });
    };
    if (floatingWindows[key]) floatingWindows[key].loadContent = loadContent;
    if (!startMinimized) {
      loadContent();
    }
  }

  function closeFloatingWhisper(key) {
    if (floatingWindows[key]) {
      if (floatingWindows[key].msgPollTimer) {
        clearInterval(floatingWindows[key].msgPollTimer);
      }
      if (floatingWindows[key].onlinePollTimer) {
        clearTimeout(floatingWindows[key].onlinePollTimer);
      }
      if (floatingWindows[key].userIconRefreshTimer) {
        clearTimeout(floatingWindows[key].userIconRefreshTimer);
      }
      if (floatingWindows[key].fetchMessagesTimeout) {
        clearTimeout(floatingWindows[key].fetchMessagesTimeout);
      }
      clearFwUnread(key);
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
          closeLauncherPopup();
          openFloatingWhisper(n);
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

    // Chat icon SVG
    bubble.innerHTML = '<svg class="xchat-fw-launcher-icon" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';

    // Tooltip (like whisper heads)
    var launcherTip = document.createElement('div');
    launcherTip.className = 'xchat-fw-head-tip';
    launcherTip.textContent = 'Napsat zpr\u00e1vu';
    bubble.appendChild(launcherTip);

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
      var nickEl = document.createElement('div');
      nickEl.className = 'xchat-fw-nick';
      nickEl.textContent = 'Nov\u00e1 soukrom\u00e1 zpr\u00e1va';
      headerInfo.appendChild(nickEl);
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
      header.addEventListener('click', function () {
        closeLauncherPopup();
      });
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
        closeLauncherPopup();
        openFloatingWhisper(val);
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
      container.insertBefore(fw, container.firstChild);

      // Ensure nothing overflows after launcher opens
      ensureWindowsFit(fw);

      // Populate history
      refreshLauncherHistory();

      setTimeout(function () { input.focus(); }, 50);
    });

    // Insert as first child so it's at the bottom (column-reverse)
    sidebar.insertBefore(bubble, sidebar.firstChild);
  }

  // Update room names in all open floating windows
  function updateFloatingRoomNames() {
    // Room names are now fetched per-window from infopagewh; this is a no-op placeholder.
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

    ensureLightweightMainBoardRefreshInstalled();
    setupCountdown();
  }

  var countdownTimer = null;

  function setupCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }

    var customSec = getRefreshInterval();
    var refreshEl = document.getElementById('refresh') || document.getElementById('refresh-orig');

    if (!refreshEl) return;
    if (!TIMERS.countdownRefresh.enabled) return;

    // Remove the original element so native JS can no longer update it
    // Rename the id so native script loses track
    refreshEl.id = 'refresh-orig';

    if (TIMERS.mainBoardPoll.enabled) {
      refreshEl.textContent = String(customSec);
      return;
    }

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

    // Auto-open floating windows on incoming whisper
    var fwAutoOpenRow = targetDoc.createElement('div');
    fwAutoOpenRow.style.cssText = 'margin-top: 3px;';
    var fwAutoOpenLabel = targetDoc.createElement('label');
    fwAutoOpenLabel.htmlFor = 'xchat-fw-auto-open';
    fwAutoOpenLabel.textContent = 'Kdy\u017e mi n\u011bkdo za\u0161ept\u00e1: ';
    fwAutoOpenLabel.style.cssText = 'font-size: 11px;';
    fwAutoOpenRow.appendChild(fwAutoOpenLabel);
    var fwAutoOpenSelect = targetDoc.createElement('select');
    fwAutoOpenSelect.id = 'xchat-fw-auto-open';
    fwAutoOpenSelect.style.cssText = 'font-size: 11px;';
    var autoOpenOpts = [
      { value: 'none', text: 'Ned\u011blat nic' },
      { value: 'window', text: 'Otev\u0159\u00edt nov\u00e9 plovouc\u00ed okno' },
      { value: 'bubble', text: 'Otev\u0159\u00edt bublinu s hlavou' }
    ];
    for (var aoi = 0; aoi < autoOpenOpts.length; aoi++) {
      var aoOpt = targetDoc.createElement('option');
      aoOpt.value = autoOpenOpts[aoi].value;
      aoOpt.textContent = autoOpenOpts[aoi].text;
      fwAutoOpenSelect.appendChild(aoOpt);
    }
    fwAutoOpenSelect.value = getFwAutoOpen();
    fwAutoOpenRow.appendChild(fwAutoOpenSelect);
    modal.appendChild(fwAutoOpenRow);

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

    // Max messages in floating whisper window
    var fwMaxRow = targetDoc.createElement('div');
    fwMaxRow.style.cssText = 'margin-top: 3px;';
    var fwMaxLabel = targetDoc.createElement('label');
    fwMaxLabel.htmlFor = 'xchat-fw-max-messages';
    fwMaxLabel.textContent = 'Po\u010det zpr\u00e1v z historie: ';
    fwMaxLabel.style.cssText = 'font-size: 11px; cursor: pointer;';
    fwMaxRow.appendChild(fwMaxLabel);
    var fwMaxInput = targetDoc.createElement('input');
    fwMaxInput.type = 'number';
    fwMaxInput.id = 'xchat-fw-max-messages';
    fwMaxInput.min = '1';
    fwMaxInput.max = '10000';
    fwMaxInput.value = String(getFwMaxMessages());
    fwMaxInput.style.cssText = 'width: 60px; font-size: 11px;';
    fwMaxRow.appendChild(fwMaxInput);
    modal.appendChild(fwMaxRow);

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
      s.fwAutoOpen = fwAutoOpenSelect.value;
      s.fwNewestFirst = fwOrderCheckbox.checked;
      s.fwMaxMessages = parseInt(fwMaxInput.value, 10) || 100;
      s.refreshInterval = Math.max(5, parseInt(sel.value, 10) || 5);
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
        ensureLightweightMainBoardRefreshInstalled();
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
      '.xchat-fw-head-badge {',
      '  position: absolute;',
      '  bottom: -4px;',
      '  right: -4px;',
      '  min-width: 16px;',
      '  height: 16px;',
      '  line-height: 16px;',
      '  text-align: center;',
      '  background: #e00;',
      '  color: #fff;',
      '  font-size: 10px;',
      '  font-weight: bold;',
      '  font-family: arial, sans-serif;',
      '  border-radius: 8px;',
      '  padding: 0 3px;',
      '  display: none;',
      '  z-index: 3;',
      '  box-shadow: 0 1px 3px rgba(0,0,0,0.4);',
      '}',
      '.xchat-fw-head-badge-visible {',
      '  display: block;',
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
      '.xchat-fw-head-tip::after {',
      '  content: "";',
      '  position: absolute;',
      '  right: -6px;',
      '  top: 50%;',
      '  transform: translateY(-50%);',
      '  border: 6px solid transparent;',
      '  border-left-color: rgba(0,0,0,0.8);',
      '  border-right: none;',
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
      '  position: relative;',
      '  cursor: pointer;',
      '  flex-shrink: 0;',
      '  user-select: none;',
      '}',
      '.xchat-fw-header-info {',
      '  overflow: hidden;',
      '  display: flex;',
      '  flex-direction: row;',
      '  align-items: center;',
      '  gap: 6px;',
      '  min-width: 0;',
      '}',
      '.xchat-fw-avatar-wrap {',
      '  position: relative;',
      '  flex-shrink: 0;',
      '}',
      '.xchat-fw-avatar-wrap .xchat-fw-status-dot {',
      '  position: absolute;',
      '  bottom: -2px;',
      '  right: -2px;',
      '  font-size: 10px;',
      '  line-height: 1;',
      '}',
      '.xchat-fw-header-avatar {',
      '  width: 28px;',
      '  height: 28px;',
      '  border-radius: 50%;',
      '  object-fit: cover;',
      '  display: block;',
      '}',
      '.xchat-fw-header-texts {',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 0;',
      '  min-width: 0;',
      '  overflow: hidden;',
      '}',
      '.xchat-fw-nick-row {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 4px;',
      '  min-width: 0;',
      '  padding-right: 58px;',
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
      '.xchat-fw-nick {',
      '  font-size: 13px;',
      '  font-weight: bold;',
      '  white-space: nowrap;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '}',
      '.xchat-fw-room {',
      '  font-size: 10px;',
      '  white-space: nowrap;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '  line-height: 1;',
      '  margin-top: 3px;',
      '}',
      '.xchat-fw-status-dot {',
      '  font-size: 14px;',
      '  line-height: 1;',
      '}',
      '.xchat-fw-status-online {',
      '  color: #0f0;',
      '  text-shadow: 0 0 4px #0f0;',
      '}',
      '.xchat-fw-status-offline {',
      '  color: #FF0000;',
      '  text-shadow: 0 0 4px #FF0000;',
      '}',
      '.xchat-fw-status-offline-text {',
      '  color: #FF0000;',
      '  font-size: 10px;',
      '}',
      '.xchat-fw-room-links {',
      '  color: #fff;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '  white-space: nowrap;',
      '}',
      '.xchat-fw-room-link, .xchat-fw-room-link:visited {',
      '  color: #fff;',
      '  text-decoration: none;',
      '  cursor: pointer;',
      '}',
      '.xchat-fw-room-link:hover {',
      '  color: #fff;',
      '  text-decoration: underline;',
      '}',
      '.xchat-fw-load-more {',
      '  display: block;',
      '  text-align: center;',
      '  padding: 6px;',
      '  color: #69f;',
      '  cursor: pointer;',
      '  font-size: 11px;',
      '}',
      '.xchat-fw-load-more:hover {',
      '  text-decoration: underline;',
      '}',
      '.xchat-fw-header-btns {',
      '  display: flex;',
      '  gap: 4px;',
      '  position: absolute;',
      '  top: 4px;',
      '  right: 4px;',
      '  z-index: 1;',
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
      '  background: #6E7F98;',
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
      '  background: #E6E7E8;',
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
      '  overscroll-behavior: contain;',
      '  display: flex;',
      '  flex-direction: column;',
      '}',
      '.xchat-fw-msg {',
      '  padding: 1px 4px;',
      '  font-size: 12px;',
      '  line-height: 1.2;',
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
    processExistingBoardDivs();
    restoreBoardFilter();
    restoreHighlight();
    restoreKickHighlight();
    restoreHideBadCommands();

    var detectedNick = getMyNick();
    if (detectedNick) setSetting('myNick', detectedNick);

    // Skip floating whisper management when inside a standard whisper window (wfrom/wfromid in URL)
    var urlParams = new URLSearchParams(location.search);
    var isWhisperWindow = urlParams.has('wfrom') || urlParams.has('wfromid');

    // Skip floating whisper management when inside a floating window iframe
    // The main startframe stores its window ref on top; nested iframes see a different window
    var isNestedStartframe = isWhisperWindow;
    try {
      if (window.top._xchatFWWindow && window.top._xchatFWWindow === window) {
        // Same window reloaded — not nested, re-run setup
        isNestedStartframe = false;
      } else if (window.top._xchatFWWindow) {
        // Different window — check if old window is still alive (has a board).
        // If the startframe navigated (room switch etc.), the old reference is stale
        // and we must take over as the main startframe.
        try {
          var oldBoard = window.top._xchatFWWindow.document.getElementById('board');
          isNestedStartframe = !!oldBoard;
        } catch (ex) {
          // Can't access old window (closed/navigated/cross-origin) — we're the main one
          isNestedStartframe = false;
        }
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

      // Restore previously open floating whisper windows (sequentially to avoid
      // flooding the connection pool with 12× parallel fetch cascades)
      if (getWhisperMode() === 'floating') {
        var savedState = getFloatingState();
        var savedKeys = Object.keys(savedState);
        var fwIdx = 0;
        function openNextFW() {
          if (fwIdx >= savedKeys.length) return;
          var sk = savedKeys[fwIdx++];
          openFloatingWhisper(savedState[sk].nick, savedState[sk].minimized);
          setTimeout(openNextFW, 300);
        }
        openNextFW();
      }
    }

    const board = document.getElementById('board');
    if (!board) return;

    ensureLightweightMainBoardRefreshInstalled();

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
        openFloatingWhisper(m[1], false, _fwAutoOpenNoFocus);
      }, true);
    }

    var pendingNodes = [];
    var pendingRaf = 0;

    function processPendingNodes() {
      pendingRaf = 0;
      var batch = pendingNodes.splice(0, BOARD_PROCESS_BATCH_SIZE);
      for (var ni = 0; ni < batch.length; ni++) {
        processBoardDiv(batch[ni]);
      }
      if (pendingNodes.length > 0) {
        pendingRaf = requestAnimationFrame(processPendingNodes);
      }
    }

    const observer = new MutationObserver(function (mutations) {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'DIV') {
            pendingNodes.push(node);
          }
        }
      }
      if (pendingNodes.length > 0 && !pendingRaf) {
        pendingRaf = requestAnimationFrame(processPendingNodes);
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
