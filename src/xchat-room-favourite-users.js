// ==UserScript==
// @name         XChat Room Favourite Users (VIP from Notes)
// @namespace    xchat-room-favourite-users
// @version      1.0.7
// @match        https://www.xchat.cz/*/modchat?op=userspage*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @connect      scripts.xchat.cz
// ==/UserScript==

(function () {
  'use strict';

  // Bail out immediately on any page that is NOT op=userspage.
  // This prevents DOM mutations on startframe and similar pages.
  try {
    const opParam = new URLSearchParams(location.search).get('op') || '';
    if (opParam !== 'userspage') return;
  } catch { return; }

  const USER_API_URL = 'https://scripts.xchat.cz/scripts/user.php?nick=';
  const STORAGE_KEY_FAVOURITE_ONLINE_USERS = 'favourite_online_users';
  const CACHE_MAX_AGE_LOADING_MS = 60 * 1000;
  const STYLE_ID_NICKS_H3 = 'xchat-favvip-h3-style';

  // Avoid mutation storms / keep UI responsive.
  const UPDATE_DEBOUNCE_MS = 15000;
  const USERINFO_CONCURRENCY = 5;

  const ICONS = {
    star: {
      none: 'https://ximg.cz/x4/star/x0.gif',
      black: 'https://ximg.cz/x4/star/x1.gif',
      blue: 'https://ximg.cz/x4/star/x2.gif',
      green: 'https://ximg.cz/x4/star/x4.gif',
      yellow: 'https://ximg.cz/x4/star/x8.gif',
      red: 'https://ximg.cz/x4/star/x16.gif',
    },
    sex: {
      male: 'https://ximg.cz/x4/rm/mn.gif',
      female: 'https://ximg.cz/x4/rm/wn.gif',
      maleCert: 'https://ximg.cz/x4/rm/mn_c.gif',
      femaleCert: 'https://ximg.cz/x4/rm/wn_c.gif',
    },
  };

  function isUsersPage() {
    try {
      const op = new URLSearchParams(location.search).get('op') || '';
      return op === 'userspage';
    } catch {
      return false;
    }
  }

  function getPrefixFromLocation() {
    return location.pathname.split('/').filter(Boolean)[0] || '';
  }

  function getClist() {
    return document.getElementById('clist');
  }

  function ensureFrameCss() {
    if (document.getElementById(STYLE_ID_NICKS_H3)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID_NICKS_H3;
    style.textContent = 'h3 { width: 64px; font-size: 85%; overflow: hidden; } #cr2 { left: -2px; } #cr3 { left: -4px; }';
    (document.head || document.documentElement).appendChild(style);
  }

  async function decodeIso88592(res) {
    const buf = await res.arrayBuffer();
    return new TextDecoder('iso-8859-2').decode(buf);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function yieldToUi() {
    await sleep(0);
  }

  function formatDatetimeCz(d) {
    const pad = (n) => String(n).padStart(2, '0');
    const day = d.getDate();
    const month = d.getMonth() + 1;
    const year = d.getFullYear();
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    const ss = pad(d.getSeconds());
    return `${day}.${month}.${year} ${hh}:${mm}:${ss}`;
  }

  function parseBooleanCell(cell) {
    if (!cell) return false;
    const strong = cell.querySelector('strong');
    const txt = strong ? String(strong.textContent || '').trim() : '';
    if (txt === 'X') return true;
    const ckd = cell.querySelector('span.ckd strong');
    return !!ckd;
  }

  function extractMaxPage(doc) {
    let max = 1;
    const links = doc.querySelectorAll('#mn a[href*="page="]');
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/[?&]page=(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!Number.isNaN(n) && n > max) max = n;
      }
    }
    return max;
  }

  async function fetchNotesPage(prefix, page, signal) {
    const baseUrl = `${location.origin}/${prefix}/notes/`;
    let res;
    try {
      res = await fetch(`${baseUrl}?page=${page}`, { credentials: 'include', signal });
    } catch (err) {
      return { ok: false, error: `Network error: ${String(err && err.message ? err.message : err)}` };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const html = await decodeIso88592(res);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return { ok: true, doc };
  }

  function parseNotesFromDoc(doc) {
    const rows = [...doc.querySelectorAll('.notesl')];
    const items = [];

    for (const row of rows) {
      const nameAnchor = row.querySelector('.notesw130 a[href*="profile.php"]');
      const nick = nameAnchor ? String(nameAnchor.textContent || '').trim() : '';
      if (!nick) continue;

      const roomsCell = row.querySelector('.notesw140');
      let rooms = [];
      let online = '';
      if (roomsCell) {
        const roomAnchors = [...roomsCell.querySelectorAll('a[href*="/room/intro.php?rid="]')];
        if (roomAnchors.length > 0) {
          rooms = roomAnchors.map((a) => {
            const href = a.getAttribute('href') || '';
            let rid = 0;
            try {
              const url = new URL(href, location.origin);
              const ridStr = url.searchParams.get('rid') || '';
              const n = parseInt(ridStr, 10);
              rid = Number.isFinite(n) ? n : 0;
            } catch {}
            const roomName = String(a.textContent || '').trim();
            return { rid, roomName };
          });
          online = formatDatetimeCz(new Date());
        } else {
          online = String(roomsCell.textContent || '').replace(/\s+/g, ' ').trim();
        }
      }

      const commentCell = row.querySelector('.notesw210');
      let comment = [];
      if (commentCell) {
        const text = String(commentCell.textContent || '').replace(/\u00A0/g, ' ').trim();
        comment = text
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s && s !== '&');
      }

      const flagCells = [...row.querySelectorAll('.notesw35')];
      const enter = parseBooleanCell(flagCells[0]);
      const vip = parseBooleanCell(flagCells[1]);
      const sms = parseBooleanCell(flagCells[2]);

      items.push({ nick, online, rooms, comment, enter, vip, sms });
    }

    return items;
  }

  async function loadNotes(prefix, signal) {
    const first = await fetchNotesPage(prefix, 1, signal);
    if (!first.ok) return { ok: false, notes: [], error: first.error || 'Failed to load notes' };

    const maxPage = extractMaxPage(first.doc);
    const all = [...parseNotesFromDoc(first.doc)];
    await yieldToUi();

    for (let p = 2; p <= maxPage; p++) {
      if (signal && signal.aborted) return { ok: false, notes: [], error: 'aborted' };
      const pageRes = await fetchNotesPage(prefix, p, signal);
      if (!pageRes.ok) return { ok: false, notes: [], error: pageRes.error || `Failed to load notes page ${p}` };
      all.push(...parseNotesFromDoc(pageRes.doc));
      await yieldToUi();
    }

    return { ok: true, notes: all };
  }

  function escapeForOnclickSingleQuotes(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  function starIconFromApi(starCode) {
    switch (starCode) {
      case 1: return ICONS.star.blue;
      case 2: return ICONS.star.green;
      case 3: return ICONS.star.yellow;
      case 4: return ICONS.star.red;
      case 5: return ICONS.star.black;
      default: return ICONS.star.none;
    }
  }

  function sexIconFromApi(sexCode, certified) {
    const isFemale = sexCode === 1;
    if (certified) return isFemale ? ICONS.sex.femaleCert : ICONS.sex.maleCert;
    return isFemale ? ICONS.sex.female : ICONS.sex.male;
  }

  function buildTitle(note, apiLastOnline) {
    if (note && Array.isArray(note.rooms) && note.rooms.length) {
      return note.rooms
        .map((r) => String(r && r.roomName ? r.roomName : '').trim())
        .filter(Boolean)
        .join(', ');
    }

    const last = apiLastOnline || (note ? note.online : '');
    return last ? String(last) : '';
  }

  function readFavouriteOnlineUsersCache() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_FAVOURITE_ONLINE_USERS);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const ts = Number(parsed.ts);
      const users = Array.isArray(parsed.users) ? parsed.users : [];
      if (!Number.isFinite(ts)) return null;
      return { ts, users };
    } catch {
      return null;
    }
  }

  function writeFavouriteOnlineUsersCache(users) {
    try {
      const payload = {
        ts: Date.now(),
        users: Array.isArray(users) ? users : [],
      };
      localStorage.setItem(STORAGE_KEY_FAVOURITE_ONLINE_USERS, JSON.stringify(payload));
    } catch {
      // ignore storage failures
    }
  }

  function buildRowsFromCachedUsers(users) {
    const safe = Array.isArray(users) ? users : [];
    const rows = [];
    for (const u of safe) {
      const nick = String(u && u.nick ? u.nick : '').trim();
      if (!nick) continue;
      const rooms = Array.isArray(u.rooms) ? u.rooms : [];
      const note = {
        nick,
        rooms: rooms
          .map((rn) => String(rn || '').trim())
          .filter(Boolean)
          .map((roomName) => ({ rid: 0, roomName })),
        online: '',
      };
      const info = {
        certified: !!(u && u.info && u.info.certified),
        sex: Number.isFinite(Number(u && u.info ? u.info.sex : 0)) ? Number(u.info.sex) : 0,
        star: Number.isFinite(Number(u && u.info ? u.info.star : 0)) ? Number(u.info.star) : 0,
        lastOnline: '',
      };
      rows.push(buildFavouriteRow(note, info));
    }
    return rows;
  }

  function renderRowsIntoSection(clist, rows, mode, source) {
    const existing = getExistingSection();
    if (existing) {
      existing.container.setAttribute('style', 'border-top: 0;');
      if (mode === 'error') {
        const p = document.createElement('p');
        p.textContent = '(nelze načíst)';
        existing.container.replaceChildren(p);
        existing.container.dataset.xchatFavvipSource = source || 'error';
      } else if (mode === 'confirmed-empty') {
        const p = document.createElement('p');
        p.textContent = '(nikdo není online)';
        existing.container.replaceChildren(p);
        existing.container.dataset.xchatFavvipSource = source || 'empty';
      } else if (mode === 'filtered-empty') {
        const p = document.createElement('p');
        p.textContent = '(žádní oblíbení v jiných místnostech)';
        existing.container.replaceChildren(p);
        existing.container.dataset.xchatFavvipSource = source || 'empty';
      } else if (rows && rows.length) {
        existing.container.replaceChildren(...rows);
        existing.container.dataset.xchatFavvipSource = source || 'live';
      } else {
        const p = document.createElement('p');
        p.textContent = '(načítám...)';
        existing.container.replaceChildren(p);
        existing.container.dataset.xchatFavvipSource = source || 'loading';
      }
      return true;
    }

    if (!clist) return false;
    const built = buildSectionDom(Array.isArray(rows) ? rows : []);
    if (mode === 'error') {
      built.container.replaceChildren();
      const p = document.createElement('p');
      p.textContent = '(nelze načíst)';
      built.container.appendChild(p);
      built.container.dataset.xchatFavvipSource = source || 'error';
    } else if (mode === 'confirmed-empty') {
      built.container.replaceChildren();
      const p = document.createElement('p');
      p.textContent = '(nikdo není online)';
      built.container.appendChild(p);
      built.container.dataset.xchatFavvipSource = source || 'empty';
    } else if (mode === 'filtered-empty') {
      built.container.replaceChildren();
      const p = document.createElement('p');
      p.textContent = '(žádní oblíbení v jiných místnostech)';
      built.container.appendChild(p);
      built.container.dataset.xchatFavvipSource = source || 'empty';
    } else if (rows && rows.length) {
      built.container.dataset.xchatFavvipSource = source || 'live';
    } else {
      built.container.replaceChildren();
      const p = document.createElement('p');
      p.textContent = '(načítám...)';
      built.container.appendChild(p);
      built.container.dataset.xchatFavvipSource = source || 'loading';
    }
    insertSection(clist, built.fieldset, built.container);
    return true;
  }

  function getNicksAlreadyShownInRoom(clist) {
    const result = new Set();
    if (!clist) return result;

    const anchors = clist.querySelectorAll('a[onclick*="userPopup("]');
    for (const a of anchors) {
      const container = a.closest('#xchat-favvip');
      if (container) continue;

      const onclick = String(a.getAttribute('onclick') || '');
      const m = onclick.match(/userPopup\('((?:\\\\|\\'|[^'])*)'/);
      if (m && m[1]) {
        const nick = String(m[1]).replace(/\\'/g, "'").replace(/\\\\/g, "\\").trim();
        if (nick) result.add(nick.toLowerCase());
        continue;
      }

      const txt = String(a.textContent || '').trim();
      if (txt) result.add(txt.toLowerCase());
    }

    return result;
  }

  function renderFromCacheIfFresh(clist, maxAgeMs) {
    const cache = readFavouriteOnlineUsersCache();
    if (!cache) return false;
    const age = Date.now() - cache.ts;
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return false;

    const existing = getExistingSection();
    if (existing && existing.container && existing.container.dataset.xchatFavvipSource === 'live') {
      return false;
    }

    const present = getNicksAlreadyShownInRoom(clist);
    const users = (cache.users || []).filter((u) => {
      const nick = String(u && u.nick ? u.nick : '').trim();
      if (!nick) return false;
      return !present.has(nick.toLowerCase());
    });

    const rows = buildRowsFromCachedUsers(users);
    renderRowsIntoSection(clist, rows, undefined, 'cache');
    return true;
  }

  function ensureFavouriteSectionNotEmpty(clist) {
    const existing = getExistingSection();
    if (existing) {
      existing.container.setAttribute('style', 'border-top: 0;');
      if (!existing.container.childNodes || existing.container.childNodes.length === 0) {
        const p = document.createElement('p');
        p.textContent = '(načítám...)';
        existing.container.replaceChildren(p);
      }
      if (!existing.container.dataset.xchatFavvipSource) {
        existing.container.dataset.xchatFavvipSource = 'placeholder';
      }
      return;
    }

    if (!clist) return;
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'hr_line';
    fieldset.id = 'xchat-favvip-legend';

    const legend = document.createElement('legend');
    legend.innerHTML = '&nbsp;Oblíbení&nbsp;';
    fieldset.appendChild(legend);

    const container = document.createElement('div');
    container.id = 'xchat-favvip';
    container.setAttribute('style', 'border-top: 0;');
    container.dataset.xchatFavvipSource = 'placeholder';

    const p = document.createElement('p');
    p.textContent = '(načítám...)';
    container.appendChild(p);

    insertSection(clist, fieldset, container);
  }

  function gmGetText(url, signal) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (txt) => {
        if (done) return;
        done = true;
        resolve(String(txt || ''));
      };

      // If GM_xmlhttpRequest is not available, fall back (may still fail due to CORS).
      if (typeof GM_xmlhttpRequest !== 'function') {
        fetch(url, { signal })
          .then((r) => (r.ok ? r.text() : ''))
          .then(finish)
          .catch(() => finish(''));
        return;
      }

      let req = null;
      try {
        req = GM_xmlhttpRequest({
          method: 'GET',
          url,
          onload: (r) => finish(r && typeof r.responseText === 'string' ? r.responseText : ''),
          onerror: () => finish(''),
          ontimeout: () => finish(''),
        });
      } catch {
        finish('');
        return;
      }

      if (signal) {
        if (signal.aborted) {
          try { req && req.abort && req.abort(); } catch {}
          finish('');
          return;
        }

        const onAbort = () => {
          try { req && req.abort && req.abort(); } catch {}
          finish('');
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  const userInfoCache = new Map();

  async function fetchUserInfo(nick, signal) {
    const key = String(nick || '').trim();
    if (!key) return null;
    if (userInfoCache.has(key)) return userInfoCache.get(key);

    const p = (async () => {
      const text = await gmGetText(`${USER_API_URL}${encodeURIComponent(key)}`, signal);
      if (signal && signal.aborted) return null;
      if (!text) return null;

      const lines = String(text).split(/\r?\n/);
      const certified = String(lines[3] || '').trim() === '1';
      const sex = parseInt(String(lines[4] || '').trim(), 10);
      const star = parseInt(String(lines[5] || '').trim(), 10);
      const lastOnline = String(lines[9] || '').trim();

      return {
        certified,
        sex: Number.isFinite(sex) ? sex : 0,
        star: Number.isFinite(star) ? star : 0,
        lastOnline,
      };
    })();

    userInfoCache.set(key, p);
    return p;
  }

  function createLimiter(maxConcurrent) {
    let active = 0;
    const queue = [];

    const runNext = () => {
      while (active < maxConcurrent && queue.length) {
        const { fn, resolve, reject } = queue.shift();
        active++;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--;
            runNext();
          });
      }
    };

    return (fn) => new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
  }

  function getExistingSection() {
    const fieldset = document.getElementById('xchat-favvip-legend');
    const container = document.getElementById('xchat-favvip');
    return (fieldset && container) ? { fieldset, container } : null;
  }

  function insertSection(clist, fieldset, container) {
    const away = clist.querySelector('#away');
    if (away && away.parentNode === clist) {
      if (away.nextSibling) {
        clist.insertBefore(fieldset, away.nextSibling);
        clist.insertBefore(container, fieldset.nextSibling);
      } else {
        clist.appendChild(fieldset);
        clist.appendChild(container);
      }
      return;
    }

    clist.appendChild(fieldset);
    clist.appendChild(container);
  }

  function buildSectionDom(rows) {
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'hr_line';
    fieldset.id = 'xchat-favvip-legend';

    const legend = document.createElement('legend');
    legend.innerHTML = '&nbsp;Oblíbení&nbsp;';
    fieldset.appendChild(legend);

    const container = document.createElement('div');
    container.id = 'xchat-favvip';
    container.setAttribute('style', 'border-top: 0;');

    if (!rows.length) {
      const p = document.createElement('p');
      p.textContent = '(nikdo není online)';
      container.appendChild(p);
      return { fieldset, container };
    }

    for (const row of rows) {
      container.appendChild(row);
    }

    return { fieldset, container };
  }

  function buildFavouriteRow(note, info) {
    const nick = String(note.nick || '').trim();
    const escapedNick = escapeForOnclickSingleQuotes(nick);

    const starIcon = starIconFromApi(info.star);
    const sexIcon = sexIconFromApi(info.sex, info.certified);

    const p = document.createElement('p');
    p.dataset.nick = nick;

    const em = document.createElement('em');
    const starImg = document.createElement('img');
    starImg.alt = 'star';
    starImg.src = starIcon;
    const sexImg = document.createElement('img');
    sexImg.alt = 'sex';
    sexImg.src = sexIcon;

    em.appendChild(starImg);
    em.appendChild(document.createTextNode('\u00A0'));
    em.appendChild(sexImg);

    const a = document.createElement('a');
    a.href = '#';
    a.textContent = nick;
    a.title = buildTitle(note, info.lastOnline);
    a.setAttribute('onclick', `userPopup('${escapedNick}',this,'U','${sexIcon}','${starIcon}'); return(false);`);

    p.appendChild(em);
    p.appendChild(document.createTextNode(' '));
    p.appendChild(a);
    return p;
  }

  async function buildFavouriteRows(notes, signal) {
    const presentInRoom = getNicksAlreadyShownInRoom(getClist());
    const allVipOnline = (notes || [])
      .filter((n) => n && n.vip === true)
      .filter((n) => Array.isArray(n.rooms) && n.rooms.length > 0);

    const favs = allVipOnline
      .filter((n) => !presentInRoom.has(String(n.nick || '').trim().toLowerCase()))
      .sort((a, b) => String(a.nick).localeCompare(String(b.nick), 'cs'));

    if (!favs.length) {
      return {
        rows: [],
        cacheUsers: [],
        onlineVipCount: allVipOnline.length,
      };
    }

    const limiter = createLimiter(USERINFO_CONCURRENCY);
    const defaultInfo = { certified: false, sex: 0, star: 0, lastOnline: '' };

    const results = await Promise.all(favs.map((note) => limiter(async () => {
      if (signal && signal.aborted) return null;
      const info = await fetchUserInfo(note.nick, signal);
      if (signal && signal.aborted) return null;
      return { note, info: info || defaultInfo };
    })));

    await yieldToUi();
    const items = results.filter(Boolean);
    return {
      rows: items.map((it) => buildFavouriteRow(it.note, it.info)),
      cacheUsers: items.map((it) => ({
        nick: String(it.note.nick || '').trim(),
        rooms: Array.isArray(it.note.rooms) ? it.note.rooms.map((r) => String(r && r.roomName ? r.roomName : '').trim()).filter(Boolean) : [],
        info: {
          certified: !!it.info.certified,
          sex: Number.isFinite(Number(it.info.sex)) ? Number(it.info.sex) : 0,
          star: Number.isFinite(Number(it.info.star)) ? Number(it.info.star) : 0,
        },
      })),
      onlineVipCount: allVipOnline.length,
    };
  }

  let updateTimer = null;
  let updateInFlight = false;
  let pendingUpdate = false;
  let abortController = null;
  let lastUpdateAt = 0;
  const renderedCacheForClist = new WeakSet();

  function scheduleUpdate() {
    pendingUpdate = true;
    if (updateTimer) return;

    const now = Date.now();
    const dueIn = Math.max(UPDATE_DEBOUNCE_MS - (now - lastUpdateAt), 0);
    updateTimer = setTimeout(() => {
      updateTimer = null;
      runUpdate().catch(() => {});
    }, dueIn);
  }

  async function runUpdate() {
    if (!pendingUpdate) return;
    if (updateInFlight) return;
    pendingUpdate = false;
    updateInFlight = true;
    lastUpdateAt = Date.now();

    if (abortController) abortController.abort();
    abortController = new AbortController();
    const signal = abortController.signal;

    try {
      if (!isUsersPage()) return;

      const clist = getClist();
      if (!clist) return;

      // Ensure our section exists and is never empty.
      ensureFavouriteSectionNotEmpty(clist);

      // If we're still showing a loading message, prefer showing cached list (≤ 1 minute).
      // This runs on every update tick to fight frame reloads / transient blanks.
      const existingNow = getExistingSection();
      const isLoadingNow = existingNow && existingNow.container && existingNow.container.dataset.xchatFavvipSource === 'loading';
      if (isLoadingNow) {
        renderFromCacheIfFresh(clist, CACHE_MAX_AGE_LOADING_MS);
      }

      // On initial load (including iframe reloads), render cached data immediately (if fresh).
      // Do this only once to avoid overwriting newer DOM with older cached data.
      if (!renderedCacheForClist.has(clist)) {
        renderedCacheForClist.add(clist);
        renderFromCacheIfFresh(clist, UPDATE_DEBOUNCE_MS * 2);
      }

      const prefix = getPrefixFromLocation();
      if (!prefix) return;

      // If we already have a section, ensure it has the requested inline style.
      const existing = getExistingSection();
      if (existing) {
        existing.container.setAttribute('style', 'border-top: 0;');
      }

      // 1) Gather ALL data first (no DOM touching / no flicker)
      let rows = [];
      let loadFailed = false;
      let cacheUsers = [];
      let onlineVipCount = 0;
      try {
        const notesRes = await loadNotes(prefix, signal);
        if (signal.aborted) return;
        if (!notesRes.ok) throw new Error(String(notesRes.error || 'Failed to load notes'));

        const built = await buildFavouriteRows(notesRes.notes, signal);
        rows = built.rows;
        cacheUsers = built.cacheUsers;
        onlineVipCount = built.onlineVipCount || 0;
        if (signal.aborted) return;
      } catch {
        if (signal.aborted) return;
        loadFailed = true;
      }

      // 2) Only now mutate DOM in one go
      if (loadFailed) {
        // Only show error if we don't already have some list displayed.
        const existing = getExistingSection();
        const src = existing && existing.container ? String(existing.container.dataset.xchatFavvipSource || '') : '';
        const hasAnyNickRows = existing && existing.container && existing.container.querySelector('p[data-nick]');
        if (src === 'live' || src === 'cache' || hasAnyNickRows) return;
        renderRowsIntoSection(clist, [], 'error', 'error');
        return;
      }

      // Only show "(nikdo není online)" if the *original online VIP list from Notes* is truly empty.
      // If it becomes empty only due to filtering out users already shown in this room, show a different message.
      if (!rows.length) {
        if (!onlineVipCount) {
          writeFavouriteOnlineUsersCache([]);
          renderRowsIntoSection(clist, [], 'confirmed-empty', 'live');
          return;
        }

        // Persist state and show a non-misleading message.
        writeFavouriteOnlineUsersCache([]);
        renderRowsIntoSection(clist, [], 'filtered-empty', 'live');
        return;
      }

      // Persist last successful state (even if empty).
      writeFavouriteOnlineUsersCache(cacheUsers);

      renderRowsIntoSection(clist, rows, undefined, 'live');
    } finally {
      updateInFlight = false;
      if (pendingUpdate) scheduleUpdate();
    }
  }

  function tryHookOnce() {
    if (!isUsersPage()) return false;
    ensureFrameCss();

    const clist = getClist();
    if (!clist) return false;

    // If the list/frame reloads, ensure section appears immediately.
    ensureFavouriteSectionNotEmpty(clist);
    if (!renderedCacheForClist.has(clist)) {
      renderedCacheForClist.add(clist);
      renderFromCacheIfFresh(clist, UPDATE_DEBOUNCE_MS * 2);
    }

    // If we're showing loading, refresh from cache (≤ 1 minute).
    const existing = getExistingSection();
    const isLoading = existing && existing.container && existing.container.dataset.xchatFavvipSource === 'loading';
    if (isLoading) {
      renderFromCacheIfFresh(clist, CACHE_MAX_AGE_LOADING_MS);
    }

    if (clist.dataset.xchatFavVipHooked === '1') {
      scheduleUpdate();
      return true;
    }
    clist.dataset.xchatFavVipHooked = '1';
    scheduleUpdate();
    return true;
  }

  // initial + rehook for iframe reloads / partial loads
  tryHookOnce();

  const bootTimer = setInterval(() => {
    const ok = tryHookOnce();
    if (ok) clearInterval(bootTimer);
  }, 400);

  const mo = new MutationObserver(() => {
    tryHookOnce();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // Heartbeat refresh: keeps cache render + live refresh running even without DOM mutations.
  setInterval(() => {
    tryHookOnce();
  }, UPDATE_DEBOUNCE_MS);
})();

