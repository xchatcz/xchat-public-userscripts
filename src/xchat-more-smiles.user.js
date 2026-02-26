// ==UserScript==
// @name         xchat.cz - více smajlíků
// @namespace    https://www.xchat.cz/
// @description  Více smajlíků v záložce Nastavit
// @include      http*://*xchat.cz/*/modchat?op=userspage*
// @include      http*://*xchat.cz/*/modchat?op=onlinehelppage*
// @include      http*://*xchat.cz/*/modchat?op=ignorepage*
// @version      0.5
// @author       ONDRASHEK (Xchat.cz), Elza (https://janelznic.cz)
// @updateURL    http://ondr4sh3k.wz.cz/scripty/xchat_more_smiles.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'smileys';
  const DEFAULT_SMILEYS = '1';

  function parseSmileys(value) {
    const source = String(value || '').trim();
    if (!source) return [];

    return source
      .split(/\s*,\s*/)
      .map((item) => Number(item))
      .filter((item, index, array) => Number.isInteger(item) && item > 0 && array.indexOf(item) === index);
  }

  function getStoredSmileys() {
    const stored = GM_getValue(STORAGE_KEY);
    const fallback = DEFAULT_SMILEYS;
    const raw = stored === undefined ? fallback : stored;
    const parsed = parseSmileys(raw);
    return parsed.length ? parsed : parseSmileys(fallback);
  }

  function getSmileyUrl(id) {
    const bucket = id % 100;
    return `https://x.ximg.cz/images/x4/sm/${bucket}/${id}.gif`;
  }

  function renameSettingsTabInDocument(doc) {
    if (!doc) return false;

    const targets = doc.querySelectorAll('#cr2 h3 a[href*="tab=settings"], #cr2 > h3 a');
    let changed = false;

    targets.forEach((link) => {
      if (!(link instanceof HTMLElement)) return;
      if (link.textContent === 'Smajlíci') return;
      link.textContent = 'Smajlíci';
      changed = true;
    });

    return targets.length > 0 ? true : changed;
  }

  function getCandidateDocuments() {
    const docs = [document];

    try {
      if (top && top.document && top.document !== document) {
        docs.push(top.document);
      }

      if (top && top.frames && top.frames.length) {
        for (let index = 0; index < top.frames.length; index += 1) {
          const frameDoc = top.frames[index]?.document;
          if (frameDoc && !docs.includes(frameDoc)) {
            docs.push(frameDoc);
          }
        }
      }
    } catch (error) {
      // ignore cross-origin or unavailable frame access
    }

    return docs;
  }

  function renameSettingsTab() {
    const docs = getCandidateDocuments();
    let foundAny = false;

    docs.forEach((doc) => {
      const foundInDoc = renameSettingsTabInDocument(doc);
      foundAny = foundAny || foundInDoc;
    });

    return foundAny;
  }

  function observeTabRename() {
    const docs = getCandidateDocuments();

    docs.forEach((doc) => {
      if (!doc?.body) return;

      const observer = new MutationObserver(() => {
        renameSettingsTab();
      });

      observer.observe(doc.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
  }

  function ensureSettingsTab() {
    renameSettingsTab();

    const tabContent = document.querySelector('#cr2 #crdiv2');
    if (!tabContent) return false;

    if (!tabContent.querySelector('#smileys')) {
      tabContent.innerHTML = '<div id="smileys"></div>';
    }

    return Boolean(document.getElementById('smileys'));
  }

  function ensureUpdateButton() {
    if (document.getElementById('updateSmiley')) return;

    const smileysContainer = document.getElementById('smileys');
    if (!smileysContainer) return;

    const button = document.createElement('button');
    button.id = 'updateSmiley';
    button.type = 'button';
    button.textContent = 'Nastavit smajlíky';
    button.style.position = 'absolute';
    button.style.bottom = '5px';
    button.style.left = '0';
    button.style.right = '0';
    button.style.margin = '0 auto';
    button.style.width = '150px';

    smileysContainer.insertAdjacentElement('afterend', button);
  }

  function saveSmileysFromPrompt() {
    const current = GM_getValue(STORAGE_KEY, DEFAULT_SMILEYS);
    const entered = prompt('Organizace smajlíků (pouze čísla!). Oddělit čárkou.', current);
    if (!entered) return;

    const parsed = parseSmileys(entered);
    if (!parsed.length) {
      alert('Nebyly zadány žádné platné hodnoty.');
      return;
    }

    GM_setValue(STORAGE_KEY, parsed.join(', '));
    alert('Uloženo, obnov záložku.');
  }

  function createSmileyElement(id) {
    const link = document.createElement('a');
    link.href = `javascript:add_smiley(${id});`;
    link.title = `*${id}*`;
    link.style.display = 'inline-block';
    link.style.margin = '1px';

    const image = document.createElement('img');
    image.src = getSmileyUrl(id);
    image.alt = `*${id}*`;
    image.title = `*${id}*`;
    image.style.cursor = 'pointer';

    link.appendChild(image);
    return link;
  }

  function renderSmileys() {
    const smileysContainer = document.getElementById('smileys');
    if (!smileysContainer) return;

    const smileys = getStoredSmileys();
    smileysContainer.innerHTML = '';

    smileys.forEach((id) => {
      smileysContainer.appendChild(createSmileyElement(id));
    });
  }

  function bindEvents() {
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.id !== 'updateSmiley') return;

      saveSmileysFromPrompt();
    });
  }

  let initialized = false;

  function tryInitialize() {
    if (!ensureSettingsTab()) return false;
    if (initialized) return true;

    ensureUpdateButton();
    renderSmileys();
    bindEvents();
    initialized = true;
    return true;
  }

  observeTabRename();

  if (!tryInitialize()) {
    let attempts = 0;
    const maxAttempts = 20;
    const timer = setInterval(() => {
      attempts += 1;
      const done = tryInitialize();
      if (done || attempts >= maxAttempts) {
        clearInterval(timer);
        renameSettingsTab();
      }
    }, 250);
  }
})();
