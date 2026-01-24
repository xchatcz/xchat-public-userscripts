// ==UserScript==
// @name         XChat Room Favourite Users (VIP from Notes)
// @namespace    xchat-room-favourite-users
// @version      1.0.0
// @match        https://www.xchat.cz/*/modchat?op=userspage*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
	'use strict';

	const USER_API_URL = 'https://scripts.xchat.cz/scripts/user.php?nick=';

	// Keep the UI responsive and avoid mutation storms.
	const UPDATE_DEBOUNCE_MS = 5000;
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
		// Let the browser paint / handle input.
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
		if (!first.ok) return [];

		const maxPage = extractMaxPage(first.doc);
		const all = [...parseNotesFromDoc(first.doc)];

		// Yield after first parse; large pages can be heavy.
		await yieldToUi();

		for (let p = 2; p <= maxPage; p++) {
			if (signal && signal.aborted) break;
			const pageRes = await fetchNotesPage(prefix, p, signal);
			if (!pageRes.ok) break;
			all.push(...parseNotesFromDoc(pageRes.doc));

			// Yield between pages to keep the tab responsive.
			await yieldToUi();
		}

		return all;
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
		const parts = [];
		if (note.rooms && note.rooms.length) {
			parts.push(note.rooms.map((r) => `${r.roomName} (rid=${r.rid || 0})`).join(' | '));
		} else if (apiLastOnline) {
			parts.push(String(apiLastOnline));
		} else if (note.online) {
			parts.push(String(note.online));
		}
		if (apiLastOnline && (!note.rooms || note.rooms.length === 0)) {
			// already used
		} else if (apiLastOnline) {
			parts.push(`Naposledy online: ${apiLastOnline}`);
		}
		return parts.join(' | ');
	}

	const userInfoCache = new Map();

	async function fetchUserInfo(nick, signal) {
		const key = String(nick || '').trim();
		if (!key) return null;
		if (userInfoCache.has(key)) return userInfoCache.get(key);

		const p = (async () => {
			let res;
			try {
				res = await fetch(`${USER_API_URL}${encodeURIComponent(key)}`, { credentials: 'omit', signal });
			} catch {
				return null;
			}
			if (!res.ok) return null;
			const text = String(await res.text() || '');
			const lines = text.split(/\r?\n/);

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

	function ensureFavouritesSection(clist) {
		let fieldset = document.getElementById('xchat-favvip-legend');
		let container = document.getElementById('xchat-favvip');
		if (fieldset && container) return { fieldset, container };

		fieldset = document.createElement('fieldset');
		fieldset.className = 'hr_line';
		fieldset.id = 'xchat-favvip-legend';
		const legend = document.createElement('legend');
		legend.innerHTML = '&nbsp;Oblíbení&nbsp;';
		fieldset.appendChild(legend);

		container = document.createElement('div');
		container.id = 'xchat-favvip';

		const away = clist.querySelector('#away');
		const insertAfter = away || clist;

		if (away && away.parentNode === clist) {
			if (away.nextSibling) {
				clist.insertBefore(fieldset, away.nextSibling);
				clist.insertBefore(container, fieldset.nextSibling);
			} else {
				clist.appendChild(fieldset);
				clist.appendChild(container);
			}
		} else {
			// fallback: append at the end, before the hr/help blocks if possible
			const hr = [...clist.querySelectorAll('p > hr, p > hr/ , p hr')][0];
			const before = hr ? hr.closest('p') : null;
			if (before && before.parentNode === clist) {
				clist.insertBefore(fieldset, before);
				clist.insertBefore(container, before);
			} else {
				clist.appendChild(fieldset);
				clist.appendChild(container);
			}
		}

		return { fieldset, container };
	}

	function renderFavouriteUsers(container, notes, signal) {
		container.textContent = '';

		const favs = (notes || [])
			.filter((n) => n && n.vip === true)
			.filter((n) => Array.isArray(n.rooms) && n.rooms.length > 0)
			.sort((a, b) => String(a.nick).localeCompare(String(b.nick), 'cs'));

		if (!favs.length) {
			const p = document.createElement('p');
			p.className = 'mtext';
			p.textContent = '— žádní VIP uživatelé online —';
			container.appendChild(p);
			return;
		}

		for (const note of favs) {
			const nick = String(note.nick || '').trim();
			if (!nick) continue;

			const p = document.createElement('p');
			p.dataset.nick = nick;

			const em = document.createElement('em');
			const starImg = document.createElement('img');
			starImg.alt = 'star';
			starImg.src = ICONS.star.none;
			const sexImg = document.createElement('img');
			sexImg.alt = 'sex';
			sexImg.src = ICONS.sex.male;

			em.appendChild(starImg);
			em.appendChild(document.createTextNode('\u00A0'));
			em.appendChild(sexImg);

			const a = document.createElement('a');
			a.href = '#';
			a.textContent = nick;

			const title = buildTitle(note, '');
			if (title) a.title = title;

			const escapedNick = escapeForOnclickSingleQuotes(nick);
			a.setAttribute('onclick', `userPopup('${escapedNick}',this,'U','${ICONS.sex.male}','${ICONS.star.none}'); return(false);`);

			p.appendChild(em);
			p.appendChild(document.createTextNode(' '));
			p.appendChild(a);
			container.appendChild(p);

			// Store refs for async enrichment.
			p._xchatFavVip = { note, nick, starImg, sexImg, link: a, escapedNick };
		}

		// Concurrency-limited async enrichment (prevents tab freezes on many users).
		const limiter = createLimiter(USERINFO_CONCURRENCY);
		const ps = [...container.querySelectorAll('p[data-nick]')];
		for (const p of ps) {
			const meta = p._xchatFavVip;
			if (!meta) continue;

			limiter(async () => {
				if (signal && signal.aborted) return;
				const info = await fetchUserInfo(meta.nick, signal);
				if (!info || (signal && signal.aborted)) return;

				const starIcon = starIconFromApi(info.star);
				const sexIcon = sexIconFromApi(info.sex, info.certified);
				meta.starImg.src = starIcon;
				meta.sexImg.src = sexIcon;
				meta.link.setAttribute('onclick', `userPopup('${meta.escapedNick}',this,'U','${sexIcon}','${starIcon}'); return(false);`);
				meta.link.title = buildTitle(meta.note, info.lastOnline);

				// Yield occasionally during long runs.
				await yieldToUi();
			}).catch(() => {});
		}
	}

	let updateTimer = null;
	let updateInFlight = false;
	let pendingUpdate = false;
	let abortController = null;
	let lastUpdateAt = 0;

	function scheduleUpdate() {
		// Debounce & coalesce update triggers.
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

		// Abort any previous in-progress network requests.
		if (abortController) abortController.abort();
		abortController = new AbortController();
		const signal = abortController.signal;

		try {
			if (!isUsersPage()) return;

			const clist = getClist();
			if (!clist) return;

			const prefix = getPrefixFromLocation();
			if (!prefix) return;

			const { container } = ensureFavouritesSection(clist);

			// lightweight loading state
			container.textContent = '';
			const loading = document.createElement('p');
			loading.className = 'mtext';
			loading.textContent = 'Načítám VIP z Poznámek…';
			container.appendChild(loading);

			await yieldToUi();

			const notes = await loadNotes(prefix, signal);
			if (signal.aborted) return;
			renderFavouriteUsers(container, notes, signal);
		} finally {
			updateInFlight = false;
			// If new triggers arrived during the run, schedule another run.
			if (pendingUpdate) scheduleUpdate();
		}
	}

	async function updateOnce() {
		if (!isUsersPage()) return false;

		const clist = getClist();
		if (!clist) return false;

		const prefix = getPrefixFromLocation();
		if (!prefix) return false;

		scheduleUpdate();
		return true;
	}

	function tryHookOnce() {
		const clist = getClist();
		if (!clist) return false;

		// idempotent per document instance
		if (clist.dataset.xchatFavVipHooked === '1') {
			// Only schedule; never run update synchronously from hot paths.
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
		// DOM in modchat frames can mutate rapidly; debounce hard.
		tryHookOnce();
	});
	mo.observe(document.documentElement, { childList: true, subtree: true });
})();

