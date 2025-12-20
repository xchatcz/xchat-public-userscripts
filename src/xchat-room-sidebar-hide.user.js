// ==UserScript==
// @name         XChat Room Sidebar Hide
// @namespace    https://www.xchat.cz/
// @version      1.1
// @description  Hides element #ffc on modchat pages (works in frames + late load)
// @match        https://www.xchat.cz/*/modchat*
// @match        https://www.xchat.cz/modchat*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
	'use strict';

	function hideFfc() {
		var el = document.getElementById('ffc');
		if (el) {
			el.style.setProperty('display', 'none', 'important');
			return true;
		}
		return false;
	}

	// Try immediately
	if (hideFfc()) return;

	// Watch for late-added element
	var obs = new MutationObserver(function () {
		if (hideFfc()) obs.disconnect();
	});

	obs.observe(document.documentElement || document.body, {
		childList: true,
		subtree: true
	});
})();
