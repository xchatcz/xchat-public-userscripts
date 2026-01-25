// ==UserScript==
// @name         XChat Room Favourite Users (VIP from Notes)
// @namespace    xchat-room-favourite-users
// @version      1.0.2
// @match        https://www.xchat.cz/*/modchat?op=userspage*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @connect      scripts.xchat.cz
// ==/UserScript==

(function () {
  'use strict';

  const USER_API_URL = 'https://scripts.xchat.cz/scripts/user.php?nick=';

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

  function setCrdivHeightPlus10000() {
    const el = document.getElementById('crdiv1');
    if (!el) return;

    // Measure height without any inline styles (we overwrite them anyway).
    el.removeAttribute('style');
    const cs = getComputedStyle(el);
    let h = parseFloat(cs && cs.height ? cs.height : '');
    if (!Number.isFinite(h) || h <= 0) h = el.offsetHeight || el.clientHeight || 0;
    const target = Math.max(0, Math.round(h + 10000));

    // Overwrite existing inline styles and force !important.
    el.style.cssText = '';
    el.style.setProperty('height', `${target}px`, 'important');
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
    const favs = (notes || [])
      .filter((n) => n && n.vip === true)
      .filter((n) => Array.isArray(n.rooms) && n.rooms.length > 0)
      .sort((a, b) => String(a.nick).localeCompare(String(b.nick), 'cs'));

    if (!favs.length) return [];

    const limiter = createLimiter(USERINFO_CONCURRENCY);
    const defaultInfo = { certified: false, sex: 0, star: 0, lastOnline: '' };

    const results = await Promise.all(favs.map((note) => limiter(async () => {
      if (signal && signal.aborted) return null;
      const info = await fetchUserInfo(note.nick, signal);
      if (signal && signal.aborted) return null;
      return buildFavouriteRow(note, info || defaultInfo);
    })));

    await yieldToUi();
    return results.filter(Boolean);
  }

  let updateTimer = null;
  let updateInFlight = false;
  let pendingUpdate = false;
  let abortController = null;
  let lastUpdateAt = 0;

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

      setCrdivHeightPlus10000();

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
      try {
        const notesRes = await loadNotes(prefix, signal);
        if (signal.aborted) return;
        if (!notesRes.ok) throw new Error(String(notesRes.error || 'Failed to load notes'));

        rows = await buildFavouriteRows(notesRes.notes, signal);
        if (signal.aborted) return;
      } catch {
        if (signal.aborted) return;
        loadFailed = true;
      }

      // 2) Only now mutate DOM in one go
      if (existing) {
        if (loadFailed) {
          const p = document.createElement('p');
          p.textContent = '(nelze načíst)';
          existing.container.replaceChildren(p);
        } else if (rows.length) {
          existing.container.replaceChildren(...rows);
        } else {
          const p = document.createElement('p');
          p.textContent = '(nikdo není online)';
          existing.container.replaceChildren(p);
        }
        return;
      }

      const built = loadFailed ? buildSectionDom([]) : buildSectionDom(rows);
      if (loadFailed) {
        built.container.replaceChildren();
        const p = document.createElement('p');
        p.textContent = '(nelze načíst)';
        built.container.appendChild(p);
      }
      insertSection(clist, built.fieldset, built.container);
    } finally {
      updateInFlight = false;
      if (pendingUpdate) scheduleUpdate();
    }
  }

  function tryHookOnce() {
    const clist = getClist();
    if (!clist) return false;

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
})();

