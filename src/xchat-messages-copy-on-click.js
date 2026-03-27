// ==UserScript==
// @name         XChat - Vzkazy - Kopirovat detail zpravy
// @namespace    https://www.xchat.cz/
// @version      1.0
// @description  Prida tlacitko pro zkopirovani detailu prijate zpravy do schranky
// @match        https://www.xchat.cz/*/offline/read_msg.php*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const COPY_BUTTON_CLASS = 'xchat-copy-message-button';
  const COPY_BUTTON_COPIED_CLASS = 'is-copied';
  const COPY_HELPER_CLASS = 'xchat-copy-message-helper';
  const COPY_LABEL = 'Kop\u00edrovat';
  const COPIED_LABEL = 'Zkop\u00edrov\u00e1no';
  const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'TABLE', 'TBODY', 'TR', 'TD']);

  function injectStyles() {
    if (document.getElementById('xchat-copy-message-styles')) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'xchat-copy-message-styles';
    style.textContent = [
      '.' + COPY_BUTTON_CLASS + ' {',
      '  margin-left: 2px !important;',
      '}',
      '.' + COPY_BUTTON_CLASS + '.is-copied {',
      '  font-weight: bold;',
      '}',
      '.' + COPY_HELPER_CLASS + ' {',
      '  position: fixed;',
      '  top: -9999px;',
      '  left: -9999px;',
      '}',
    ].join('\n');

    document.head.appendChild(style);
  }

  function encodeHtmlEntities(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/\u00a0/g, '&nbsp;');
  }

  function normalizeLineBreaks(text) {
    return text
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function unwrapRedirectUrl(url) {
    if (!url) {
      return '';
    }

    try {
      const parsedUrl = new URL(url, window.location.href);
      if (parsedUrl.hostname !== 'redir.xchat.cz') {
        return parsedUrl.href;
      }

      const redirectedUrl = parsedUrl.searchParams.get('url');
      return redirectedUrl ? redirectedUrl : parsedUrl.href;
    } catch (error) {
      return url;
    }
  }

  function serializeNode(node) {
    if (!node) {
      return '';
    }

    if (node.nodeType === Node.TEXT_NODE) {
      return encodeHtmlEntities(node.nodeValue);
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const tagName = node.tagName;

    if (tagName === 'BR') {
      return '\n';
    }

    if (tagName === 'A') {
      return unwrapRedirectUrl(node.href || node.getAttribute('href') || '');
    }

    const content = Array.from(node.childNodes).map(serializeNode).join('');

    if (BLOCK_TAGS.has(tagName)) {
      return '\n' + content + '\n';
    }

    return content;
  }

  function getFieldValue(rows, labelPrefix) {
    const row = rows.find(function (currentRow) {
      const header = Array.from(currentRow.children).find(function (cell) {
        return cell.tagName === 'TH';
      });
      if (!header) {
        return false;
      }

      const normalizedHeader = header.textContent.replace(/\s+/g, ' ').trim();
      return normalizedHeader.indexOf(labelPrefix) === 0;
    });

    if (!row) {
      return '';
    }

    const cells = Array.from(row.children).filter(function (cell) {
      return cell.tagName === 'TD';
    });
    const valueCell = cells[cells.length - 1];
    return valueCell ? normalizeLineBreaks(encodeHtmlEntities(valueCell.textContent)) : '';
  }

  function getHeaderRows(form) {
    const headerTable = form.querySelector('.msg_head td > table');
    if (!headerTable) {
      return [];
    }

    return Array.from(headerTable.querySelectorAll('tr')).filter(function (row) {
      return Array.from(row.children).some(function (cell) {
        return cell.tagName === 'TH';
      });
    });
  }

  function getMessageBody(form) {
    const messageBoxes = form.querySelectorAll(':scope > .boxudaje2');
    const bodyContainer = messageBoxes[1] && messageBoxes[1].querySelector('.boxudaje3');

    if (!bodyContainer) {
      return '';
    }

    return normalizeLineBreaks(serializeNode(bodyContainer));
  }

  function buildClipboardText(form) {
    const headerRows = getHeaderRows(form);
    const sender = getFieldValue(headerRows, 'Od');
    const recipients = getFieldValue(headerRows, 'Uživatelům');
    const subject = getFieldValue(headerRows, 'Předmět');
    const sentAt = getFieldValue(headerRows, 'Zasláno');
    const body = getMessageBody(form);

    return [
      'Od: ' + sender,
      'Komu: ' + recipients,
      'Předmět: ' + subject,
      'Datum a čas: ' + sentAt,
      'Obsah zprávy: ' + body,
    ].join('\n');
  }

  async function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.className = COPY_HELPER_CLASS;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }

  function showCopiedState(button) {
    const originalLabel = button.value;
    button.value = COPIED_LABEL;
    button.classList.add(COPY_BUTTON_COPIED_CLASS);

    window.setTimeout(function () {
      button.value = originalLabel;
      button.classList.remove(COPY_BUTTON_COPIED_CLASS);
    }, 500);
  }

  function createCopyButton(form) {
    const ignoreButton = form.querySelector('input[name="operace"][value="Ignorovat"]');
    if (!ignoreButton || form.querySelector('.' + COPY_BUTTON_CLASS)) {
      return;
    }

    const copyButton = document.createElement('input');
    copyButton.type = 'button';
    copyButton.value = COPY_LABEL;
    copyButton.className = 'btn1 ' + COPY_BUTTON_CLASS;
    copyButton.addEventListener('click', async function () {
      try {
        const clipboardText = buildClipboardText(form);
        await copyToClipboard(clipboardText);
        showCopiedState(copyButton);
      } catch (error) {
        console.error('XChat copy message failed:', error);
      }
    });

    ignoreButton.insertAdjacentElement('afterend', copyButton);
  }

  function init() {
    const form = document.forms.readmsg;
    if (!form) {
      return;
    }

    injectStyles();
    createCopyButton(form);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
