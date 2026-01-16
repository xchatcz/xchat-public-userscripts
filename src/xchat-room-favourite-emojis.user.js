// ==UserScript==
// @name         XChat Modchat Smilepage Enhancer
// @namespace    elza.xchat
// @version      1.0.2
// @description  Adds custom smilies to smilepage frame and increases smiley frame height in room frameset
// @match        https://www.xchat.cz/*/modchat?op=smilepage*
// @match        https://www.xchat.cz/*/modchat/room/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
	'use strict';

	// --- Config ---
	const smileyFrameHeightPx = 320; // <— set your desired height here (3rd row in rightframe frameset)
	const extraSmileyIdsRaw = [
		141, 712, 3189, 921, 2009, 2373, 2374, 2583, 2653, 2731, 4548, 4661,
		5016, 5068, 4068, 4069, 4146, 4594, 3093, 4142
	];

	// --- Helpers ---
	function uniqueSortedNumbers(arr) {
		return Array.from(new Set(arr.map(n => Number(n)).filter(n => Number.isFinite(n))))
			.sort((a, b) => a - b);
	}

	function buildSmileyUrl(id) {
		const s = String(id);
		const last2 = s.length >= 2 ? s.slice(-2) : s;
		const bucket = (s.length >= 2 && last2[0] === '0') ? last2[1] : last2;
		return `https://x.ximg.cz/images/x4/sm/${bucket}/${id}.gif`;
	}

	function createSmileyAnchor(id) {
		const a = document.createElement('a');
		a.href = `javascript:add_smiley(${id});`;

		const img = document.createElement('img');
		img.src = buildSmileyUrl(id);
		img.alt = `*${id}*`;
		img.title = `*${id}*`;

		a.appendChild(img);
		return a;
	}

	function forceCrHeight() {
		const cr = document.querySelector('div.cr');
		if (!cr) return;
		cr.style.height = '10000px';
	}

	function injectSmilies() {
		const wrap = document.getElementById('crdiv1');
		if (!wrap) return;

		// Avoid duplicates on reload / re-run
		const existing = wrap.querySelector('#tm-extra-smilies');
		if (existing) existing.remove();

		const ids = uniqueSortedNumbers(extraSmileyIdsRaw);

		const container = document.createElement('div');
		container.id = 'tm-extra-smilies';
		container.style.marginTop = '6px';

		const p = document.createElement('p');
		p.className = 'psm';

		for (const id of ids) {
			p.appendChild(createSmileyAnchor(id));
		}

		container.appendChild(p);

		// Insert before bottom navigation ("upravit/další") if present, otherwise append.
		const bottomNav = wrap.querySelector('#er, #mr')?.closest('p');
		if (bottomNav && bottomNav.parentElement === wrap) {
			wrap.insertBefore(container, bottomNav);
		} else {
			wrap.appendChild(container);
		}
	}

	function handleSmilepage() {
		forceCrHeight();
		injectSmilies();
	}

	function handleRoomFrameset() {
		const fs = document.getElementById('rightframe');
		if (!fs) return;

		const desired = `50,*,${Math.max(0, Math.floor(Number(smileyFrameHeightPx) || 0))},0,0,0`;
		const current = fs.getAttribute('rows') || '';
		if (current !== desired) fs.setAttribute('rows', desired);
	}

	function runWithRetries(fn, retries) {
		let left = retries;
		const tick = () => {
			fn();
			left -= 1;
			if (left > 0) setTimeout(tick, 250);
		};
		tick();
	}

	// --- Router by URL ---
	const url = location.href;

	if (url.includes('/modchat?op=smilepage')) {
		// Runs inside the frame document due to @match.
		// Also cover reloads / late DOM writes by retrying a few times.
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', () => runWithRetries(handleSmilepage, 8), { once: true });
		} else {
			runWithRetries(handleSmilepage, 8);
		}
	}

	if (url.includes('/modchat/room/')) {
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', () => runWithRetries(handleRoomFrameset, 8), { once: true });
		} else {
			runWithRetries(handleRoomFrameset, 8);
		}
	}
})();

