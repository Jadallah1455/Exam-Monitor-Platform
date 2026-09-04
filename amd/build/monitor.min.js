define([], function () {
  let sequenceNumber = 0;
  let moodleContext = {};
  let enforce = {
    copy: false,
    paste: false,
    rightclick: false,
    print: false,
    shortcuts: false,
    fullscreen: false,
  };

  // =====================================================
  // Session persistence: survive page refreshes
  // =====================================================
  function getSessionId() {
    var attemptId = (moodleContext.quiz && moodleContext.quiz.attempt_id) || 'default';
    var key = 'em_session_' + attemptId;
    var existing = sessionStorage.getItem(key);
    if (existing) return existing;
    var id = 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
    sessionStorage.setItem(key, id);
    return id;
  }

  let sessionId = '';
  const pageLoadedAt = Date.now();
  const debugMode = false;

  let suppressNextScreenshotBlur = false;
  let suppressNextScreenshotHidden = false;
  let screenshotSuppressionUntil = 0;
  const screenshotSuppressionWindowMs = 1200;

  // =====================================================
  // Idle detection
  // =====================================================
  let lastActivityTime = Date.now();
  let idleTimer = null;
  const IDLE_THRESHOLD_MS = 30000; // 30 seconds of no activity = idle
  let idleEmitted = false;

  function resetIdle() {
    lastActivityTime = Date.now();
    if (idleEmitted) {
      idleEmitted = false;
      handleEvent('idle_end', { reason: 'activity_resumed' });
    }
  }

  function startIdleDetection() {
    idleTimer = setInterval(function () {
      var elapsed = Date.now() - lastActivityTime;
      if (elapsed >= IDLE_THRESHOLD_MS && !idleEmitted) {
        idleEmitted = true;
        handleEvent('idle_detected', {
          idle_duration_ms: elapsed,
          reason: 'no_user_activity',
        });
      }
    }, 5000);
  }

  // =====================================================
  // Typing & Mouse counters (aggregate locally, send periodically)
  // =====================================================
  var typingCounters = { keydown: 0, backspace: 0, enter: 0 };
  var mouseCounters = { click: 0, move: 0, scroll: 0 };
  var lastSummarySent = Date.now();
  const SUMMARY_INTERVAL_MS = 30000; // Send summary every 30s

  function flushTypingMouseSummary() {
    var now = Date.now();
    if (now - lastSummarySent < SUMMARY_INTERVAL_MS) return;

    var typingTotal = typingCounters.keydown + typingCounters.backspace + typingCounters.enter;
    var mouseTotal = mouseCounters.click + mouseCounters.move + mouseCounters.scroll;

    if (typingTotal > 0 || mouseTotal > 0) {
      handleEvent('activity_summary', {
        typing: {
          keydown_count: typingCounters.keydown,
          backspace_count: typingCounters.backspace,
          enter_count: typingCounters.enter,
          total: typingTotal,
        },
        mouse: {
          click_count: mouseCounters.click,
          move_count: mouseCounters.move,
          scroll_count: mouseCounters.scroll,
          total: mouseTotal,
        },
        interval_ms: now - lastSummarySent,
      });

      typingCounters = { keydown: 0, backspace: 0, enter: 0 };
      mouseCounters = { click: 0, move: 0, scroll: 0 };
      lastSummarySent = now;
    }
  }

  // =====================================================
  // Heartbeat: liveness signal every 30s
  // =====================================================
  var heartbeatTimer = null;

  function startHeartbeat() {
    heartbeatTimer = setInterval(function () {
      var telemetry = getDeviceTelemetry();
      handleEvent('heartbeat', {
        uptime_ms: Date.now() - pageLoadedAt,
        online: navigator.onLine,
        visibility: document.visibilityState,
        device_telemetry: telemetry,
      });
    }, 10000);
  }

  // =====================================================
  // Compression support
  // =====================================================
  const supportsCompression = typeof CompressionStream !== 'undefined';

  async function compressPayload(str) {
    if (!supportsCompression) return null;
    try {
      var stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
      return await new Response(stream).arrayBuffer();
    } catch (e) {
      return null;
    }
  }

  // =====================================================
  // Exponential backoff
  // =====================================================
  let retryDelay = 1000;
  const MAX_RETRY_DELAY = 30000;
  const MIN_RETRY_DELAY = 1000;

  function getNextRetryDelay() {
    var delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
    return delay;
  }

  function resetRetryDelay() {
    retryDelay = MIN_RETRY_DELAY;
  }

  // =====================================================
  // Utility functions
  // =====================================================
  function generateEventId() {
    return 'evt_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
  }

  function getTimestamp() {
    return new Date().toISOString();
  }

  function getElapsedMs() {
    return Date.now() - pageLoadedAt;
  }

  function getNetworkInfo() {
    var connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
    if (!connection) {
      return { online: navigator.onLine, effective_type: null, downlink: null, rtt: null };
    }
    return {
      online: navigator.onLine,
      effective_type: connection.effectiveType || null,
      downlink: typeof connection.downlink === 'number' ? connection.downlink : null,
      rtt: typeof connection.rtt === 'number' ? connection.rtt : null,
    };
  }

  // =====================================================
  // v28: Device Telemetry (fingerprint, screen, CPU, TZ)
  // =====================================================
  var deviceTelemetryCache = null;

  function generateFingerprintHash() {
    try {
      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillText('exammonitor-fp-salt', 2, 2);
      var dataURL = canvas.toDataURL();
      var str = dataURL + '|' + navigator.userAgent + '|' + (screen.width || '') + 'x' + (screen.height || '') + '|' + (navigator.language || '');
      // Simple hash (djb2)
      var hash = 5381;
      for (var i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
        hash = hash & hash; // Convert to 32-bit integer
      }
      return 'fp_' + (hash >>> 0).toString(36);
    } catch (e) {
      return 'fp_unknown';
    }
  }

  function getDeviceTelemetry() {
    if (deviceTelemetryCache) return deviceTelemetryCache;

    var fp = generateFingerprintHash();
    var screenRes = (screen.width || 0) + 'x' + (screen.height || 0);
    var cpuCores = navigator.hardwareConcurrency || 0;
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
    var deviceMemory = navigator.deviceMemory || 0;

    deviceTelemetryCache = {
      fingerprint_hash: fp,
      screen_resolution: screenRes,
      cpu_cores: cpuCores,
      client_timezone: tz,
      device_memory_gb: deviceMemory,
      language: navigator.language || '',
      platform: navigator.platform || '',
    };

    return deviceTelemetryCache;
  }

  function createEvent(eventType, metadata) {
    sequenceNumber++;
    return {
      schema_version: '1.0',
      event_id: generateEventId(),
      session_id: sessionId,
      sequence_number: sequenceNumber,
      event_type: eventType,
      timestamp: getTimestamp(),
      elapsed_ms: getElapsedMs(),
      source: { layer: 'browser_side', component: 'moodle_quiz_monitor', plugin: 'quizaccess_exammonitor' },
      moodle: {
        site_url: moodleContext.site_url || '',
        student: moodleContext.student || {},
        teacher: moodleContext.teacher || [],
        quiz: moodleContext.quiz || {},
      },
      browser: {
        url: window.location.href,
        title: document.title,
        visibility_state: document.visibilityState,
        has_focus: document.hasFocus(),
        user_agent: navigator.userAgent,
        language: navigator.language,
        platform: navigator.platform,
      },
      network: getNetworkInfo(),
      metadata: {
        device_telemetry: getDeviceTelemetry(),
        ...(metadata || {})
      },
    };
  }

  function logEvent(eventData) {
    console.log('📡 [ExamMonitor Event]', eventData.event_type, eventData);
  }

  function debounce(func, wait) {
    var timer = null;
    return function () {
      var context = this;
      var args = arguments;
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(function () {
        timer = null;
        func.apply(context, args);
      }, wait);
    };
  }

  // =====================================================
  // Batch sending with compression + error recovery
  // =====================================================
  var serverUrl = '';
  var eventQueue = [];
  var BATCH_SIZE = 50;
  var BATCH_INTERVAL_MS = 3000;
  var batchTimer = null;
  var QUEUE_KEY = 'em_event_queue';
  var MAX_QUEUE_SIZE = 500;

  function getLocalQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (e) { return []; }
  }

  function saveLocalQueue(queue) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE_SIZE))); } catch (e) {}
  }

  // =====================================================
  // Payload Encryption (AES-256-GCM via Web Crypto API)
  // =====================================================
  var cryptoKeyCache = null;

  async function getCryptoKey(secret) {
    if (cryptoKeyCache) return cryptoKeyCache;
    if (!secret || typeof window === 'undefined' || !window.crypto || !window.crypto.subtle) return null;
    try {
      var enc = new TextEncoder();
      var keyData = await window.crypto.subtle.digest('SHA-256', enc.encode(secret));
      cryptoKeyCache = await window.crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
      );
      return cryptoKeyCache;
    } catch (e) {
      return null;
    }
  }

  function bufferToBase64(buffer) {
    var binary = '';
    var bytes = new Uint8Array(buffer);
    for (var i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  async function encryptPayload(dataObj, secret) {
    if (!secret) return dataObj;
    var rawJson = JSON.stringify(dataObj);
    var key = await getCryptoKey(secret);
    if (!key || typeof window.crypto.getRandomValues !== 'function') {
      return dataObj;
    }

    try {
      var enc = new TextEncoder();
      var iv = window.crypto.getRandomValues(new Uint8Array(12));
      var ciphertext = await window.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        enc.encode(rawJson)
      );

      return {
        encrypted: true,
        v: 1,
        iv: bufferToBase64(iv),
        data: bufferToBase64(ciphertext),
      };
    } catch (e) {
      return dataObj;
    }
  }

  function sendBatch(events) {
    if (!serverUrl || events.length === 0) return;
    try {
      var targetUrl = serverUrl;
      if (pluginSecret) {
        targetUrl += (targetUrl.indexOf('?') === -1 ? '?' : '&') + 'k=' + encodeURIComponent(pluginSecret);
      }

      var payload = JSON.stringify({
        secret: pluginSecret || '',
        events: events
      });

      fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Exam-Monitor-Secret': pluginSecret || ''
        },
        body: payload,
        keepalive: true
      })
      .then(function(response) {
        if (!response.ok && response.status !== 204) {
          throw new Error('HTTP ' + response.status);
        }
        resetRetryDelay();
      })
      .catch(function(e) {
        var localQueue = getLocalQueue();
        localQueue.push.apply(localQueue, events);
        saveLocalQueue(localQueue);
        var delay = getNextRetryDelay();
        setTimeout(retryLocalQueue, delay);
      });
    } catch (e) {}
  }

  function flushBatch() {
    if (eventQueue.length === 0) return;
    var toSend = eventQueue.splice(0, BATCH_SIZE);
    sendBatch(toSend);
  }

  function retryLocalQueue() {
    var localQueue = getLocalQueue();
    if (localQueue.length === 0) return;
    var toRetry = localQueue.splice(0, BATCH_SIZE);
    sendBatch(toRetry);
    if (toRetry.length > 0) saveLocalQueue(localQueue);
  }

  function startBatchTimer() {
    if (batchTimer) return;
    batchTimer = setInterval(function () { flushBatch(); retryLocalQueue(); }, 1000);
  }

  function sendToServer(eventData) {
    if (!serverUrl) return;
    eventQueue.push(eventData);
    flushBatch();
  }

  function handleEvent(eventType, metadata) {
    var eventData = createEvent(eventType, metadata);
    logEvent(eventData);
    sendToServer(eventData);
  }

  // =====================================================
  // UI: Toast
  // =====================================================
  function showToast(message, force) {
    if (!force && !enforce.copy && !enforce.paste && !enforce.rightclick && !enforce.print && !enforce.shortcuts) return;
    try {
      var existing = document.getElementById('exammonitor-toast');
      if (existing) existing.remove();
      var toast = document.createElement('div');
      toast.id = 'exammonitor-toast';
      toast.textContent = message;
      toast.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:999999;background:#1e293b;color:#fff;padding:14px 20px;border-radius:14px;font-family:inherit;font-size:14px;font-weight:700;box-shadow:0 10px 30px rgba(0,0,0,0.35);border:1px solid rgba(255,255,255,0.1);transition:opacity .3s;max-width:360px;direction:rtl;text-align:right;';
      document.body.appendChild(toast);
      window.setTimeout(function () { toast.style.opacity = '0'; window.setTimeout(function () { toast.remove(); }, 350); }, 3500);
    } catch (e) {}
  }

  // =====================================================
  // Question / Answer info
  // =====================================================
  function getQuestionContainer(element) {
    if (!element) return null;
    var qc = (typeof element.closest === 'function') ? element.closest('.que') : null;
    if (!qc && element.ownerDocument && element.ownerDocument !== document) {
      try {
        var iframes = document.querySelectorAll('iframe');
        for (var k = 0; k < iframes.length; k++) {
          if (iframes[k].contentDocument === element.ownerDocument || iframes[k].contentWindow === element.ownerDocument.defaultView) {
            qc = iframes[k].closest('.que');
            break;
          }
        }
      } catch (e) {}
    }
    return qc;
  }

  function getQuestionInfo(element) {
    var qc = getQuestionContainer(element);
    if (!qc) return { question_dom_id: null, question_number: null, question_type: null };
    var ne = qc.querySelector('.qno');
    var qn = ne ? ne.textContent.trim() : null;
    var qt = null;
    qc.classList.forEach(function (c) {
      if (c !== 'que' && c !== 'deferredfeedback' && c !== 'notyetanswered' && c !== 'answer' && c !== 'clearfix') qt = qt || c;
    });
    return { question_dom_id: qc.id || null, question_number: qn, question_type: qt };
  }

  function getAnswerInfo(element) {
    var tag = element.tagName ? element.tagName.toLowerCase() : '';
    var type = element.type || tag;
    var vi = {};
    if (type === 'password') {
      vi = { has_value: Boolean(element.value), value_length: element.value ? element.value.length : 0 };
    } else if (tag === 'textarea' || type === 'text') {
      var tv = element.value || '';
      vi = {
        has_value: tv.length > 0,
        value_length: tv.length,
        word_count: tv.trim() ? tv.trim().split(/\s+/).length : 0,
        answer_text: tv,
        answer_value: tv,
      };
    } else if (element.isContentEditable || element.classList?.contains('editor_atto_content')) {
      var cv = element.innerText || element.textContent || '';
      vi = {
        has_value: cv.length > 0,
        value_length: cv.length,
        word_count: cv.trim() ? cv.trim().split(/\s+/).length : 0,
        answer_text: cv,
        answer_value: cv,
      };
    } else if (type === 'radio' || type === 'checkbox') {
      var labelEl = element.closest('label') || (element.id ? document.querySelector('label[for="' + element.id + '"]') : null) || element.parentElement;
      var labelText = labelEl ? labelEl.textContent.trim() : (element.value || '');
      vi = {
        checked: element.checked,
        answer_value: element.value,
        answer_text: element.checked ? (labelText || element.value) : '',
        word_count: labelText.trim() ? labelText.trim().split(/\s+/).length : 0,
      };
    } else {
      vi = {
        has_value: Boolean(element.value),
        answer_value: element.value,
        answer_text: element.value || '',
      };
    }
    return { field_name: element.name || null, field_id: element.id || null, field_tag: tag, field_type: type, ...vi };
  }

  // =====================================================
  // Event Listeners
  // =====================================================
  function registerBrowserEventListeners() {
    window.addEventListener('blur', function () {
      var now = Date.now();
      if (suppressNextScreenshotBlur && now <= screenshotSuppressionUntil) { suppressNextScreenshotBlur = false; return; }
      suppressNextScreenshotBlur = false;
      handleEvent('window_blur', { reason: 'browser_window_lost_focus' });
    });

    window.addEventListener('focus', function () {
      handleEvent('window_focus', { reason: 'browser_window_gained_focus' });
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        var now = Date.now();
        if (suppressNextScreenshotHidden && now <= screenshotSuppressionUntil) { suppressNextScreenshotHidden = false; return; }
        suppressNextScreenshotHidden = false;
        handleEvent('tab_hidden', { reason: 'document_visibility_changed_to_hidden' });
      } else {
        handleEvent('tab_visible', { reason: 'document_visibility_changed_to_visible' });
      }
    });

    function onCopyHandler(event) {
      var sel = window.getSelection();
      var selStr = sel ? sel.toString() : '';
      var selLen = selStr.length;
      var activeEl = event.target || document.activeElement;
      var qInfo = activeEl ? getQuestionInfo(activeEl) : { question_dom_id: null, question_number: null, question_type: null };
      handleEvent('copy', {
        action: enforce.copy ? 'copy_blocked' : 'copy_detected',
        selection_length: selLen,
        selection_text: selLen > 0 ? selStr.substring(0, 1000) : '',
        question: qInfo,
        question_id: qInfo.question_dom_id || qInfo.question_number || 'q',
      });
      if (enforce.copy) { event.preventDefault(); showToast('النسخ غير مسموح خلال هذا الامتحان'); }
      resetIdle();
    }

    function onPasteHandler(event) {
      var pastedText = '';
      try {
        if (event.clipboardData) pastedText = event.clipboardData.getData('text') || '';
        else if (window.clipboardData) pastedText = window.clipboardData.getData('text') || '';
      } catch (e) {}
      var activeEl = event.target || document.activeElement;
      var qInfo = activeEl ? getQuestionInfo(activeEl) : { question_dom_id: null, question_number: null, question_type: null };
      handleEvent('paste', {
        action: enforce.paste ? 'paste_blocked' : 'paste_detected',
        pasted_text: pastedText ? pastedText.substring(0, 3000) : '',
        pasted_length: pastedText ? pastedText.length : 0,
        question: qInfo,
        question_id: qInfo.question_dom_id || qInfo.question_number || 'q',
      });
      if (enforce.paste) { event.preventDefault(); showToast('اللصق غير مسموح خلال هذا الامتحان'); }
      resetIdle();
    }

    function onCutHandler(event) {
      var sel = window.getSelection();
      var selStr = sel ? sel.toString() : '';
      var activeEl = event.target || document.activeElement;
      var qInfo = activeEl ? getQuestionInfo(activeEl) : { question_dom_id: null, question_number: null, question_type: null };
      handleEvent('cut', {
        action: enforce.copy ? 'cut_blocked' : 'cut_detected',
        selection_length: selStr.length,
        selection_text: selStr.length > 0 ? selStr.substring(0, 1000) : '',
        question: qInfo,
        question_id: qInfo.question_dom_id || qInfo.question_number || 'q',
      });
      if (enforce.copy) event.preventDefault();
      resetIdle();
    }

    // Capture phase listeners on document (catches events before any rich editor swallows them)
    document.addEventListener('copy', onCopyHandler, true);
    document.addEventListener('paste', onPasteHandler, true);
    document.addEventListener('cut', onCutHandler, true);

    document.addEventListener('contextmenu', function (event) {
      handleEvent('right_click', { action: enforce.rightclick ? 'context_menu_blocked' : 'context_menu_opened' });
      if (enforce.rightclick) event.preventDefault();
      resetIdle();
    });

    // Also attach to rich editor iframes (TinyMCE) and observe DOM changes
    function attachToEditorIframes() {
      try {
        var iframes = document.querySelectorAll('iframe');
        iframes.forEach(function (ifr) {
          try {
            var doc = ifr.contentDocument || ifr.contentWindow?.document;
            if (doc && !doc._em_attached) {
              doc._em_attached = true;
              doc.addEventListener('paste', onPasteHandler, true);
              doc.addEventListener('copy', onCopyHandler, true);
              doc.addEventListener('cut', onCutHandler, true);
            }
          } catch (err) {}
        });
      } catch (err) {}
    }
    attachToEditorIframes();
    setInterval(attachToEditorIframes, 3000);

    // Track typing for counters
    document.addEventListener('keydown', function (event) {
      resetIdle();
      typingCounters.keydown++;
      if (event.key === 'Backspace') typingCounters.backspace++;
      if (event.key === 'Enter') typingCounters.enter++;
    }, true);

    // Track mouse activity
    document.addEventListener('click', function () { mouseCounters.click++; resetIdle(); }, true);
    document.addEventListener('mousemove', debounce(function () { mouseCounters.move++; }, 500), true);
    document.addEventListener('scroll', debounce(function () { mouseCounters.scroll++; }, 500), true);

    // Track selection changes for copy_selection_chars
    document.addEventListener('selectionchange', debounce(function () {
      var sel = window.getSelection();
      if (sel && sel.toString().length > 10) {
        handleEvent('selection_detected', { selection_length: sel.toString().length });
      }
    }, 1000), true);

    window.addEventListener('beforeunload', function () {
      flushBatch();
      flushTypingMouseSummary();
      var telemetry = getDeviceTelemetry();
      handleEvent('page_leave', { reason: 'page_beforeunload', device_telemetry: telemetry });
    });
  }

  function registerPrintListener() {
    window.addEventListener('beforeprint', function (event) {
      if (!enforce.print) return;
      event.preventDefault();
      handleEvent('print_attempt', { action: 'print_blocked', method: 'beforeprint_event' });
      showToast('الطباعة غير مسموح خلال هذا الامتحان');
      try { if (typeof window.print === 'function' && window.stop) window.stop(); } catch (e) {}
    });
  }

  // =====================================================
  // Fullscreen enforcement
  // =====================================================
  function requestFullscreen() {
    if (!enforce.fullscreen) return;
    try {
      var el = document.documentElement;
      if (el.requestFullscreen) el.requestFullscreen();
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else if (el.msRequestFullscreen) el.msRequestFullscreen();
    } catch (e) {}
  }

  function registerFullscreenListener() {
    document.addEventListener('fullscreenchange', function () {
      if (!document.fullscreenElement) {
        handleEvent('fullscreen_exit', { reason: 'user_exited_fullscreen' });
        showToast('يجب البقاء في وضع ملء الشاشة');
        // Re-enforce after 2 seconds
        setTimeout(requestFullscreen, 2000);
      }
    });

    document.addEventListener('webkitfullscreenchange', function () {
      if (!document.webkitFullscreenElement) {
        handleEvent('fullscreen_exit', { reason: 'user_exited_fullscreen' });
        setTimeout(requestFullscreen, 2000);
      }
    });
  }

  function registerScreenshotListeners() {
    document.addEventListener('keydown', function (event) {
      var method = null;
      var shortcut = null;
      var confidence = null;
      var platform = (navigator.platform || '').toLowerCase();
      var isWindows = platform.indexOf('win') !== -1;
      var isMac = platform.indexOf('mac') !== -1;

      if (enforce.print && event.key.toLowerCase() === 'p' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        handleEvent('print_attempt', { action: 'print_blocked', shortcut: 'ctrl_cmd_p' });
        showToast('الطباعة غير مسموح خلال هذا الامتحان');
        return;
      }

      if (enforce.shortcuts) {
        var ctrl = event.ctrlKey || event.metaKey;
        var devtoolsShortcut = event.key === 'F12' || (ctrl && event.shiftKey && ['I', 'J', 'C'].indexOf(event.key.toUpperCase()) !== -1) || (ctrl && !event.shiftKey && event.key.toLowerCase() === 'u');
        if (devtoolsShortcut) {
          event.preventDefault();
          handleEvent('devtools_shortcut', { action: 'shortcut_blocked', key: event.key, code: event.code });
          showToast('مفاتيح المطور غير مسموح بها خلال هذا الامتحان');
          return;
        }
      }

      if (event.key === 'PrintScreen') { method = 'print_screen_key'; shortcut = 'print_screen'; confidence = 'high'; }
      else if (isWindows && event.metaKey && event.shiftKey && event.key.toLowerCase() === 's') { method = 'windows_snipping_shortcut'; shortcut = 'windows_shift_s'; confidence = 'medium'; }
      else if (isMac && event.metaKey && event.shiftKey && ['3', '4', '5'].includes(event.key)) { method = 'macos_screenshot_shortcut'; shortcut = 'cmd_shift_' + event.key; confidence = 'medium'; }

      if (!method) return;

      suppressNextScreenshotBlur = true;
      suppressNextScreenshotHidden = true;
      screenshotSuppressionUntil = Date.now() + screenshotSuppressionWindowMs;

      handleEvent('screenshot_attempt', {
        action: 'screenshot_shortcut_detected',
        method: method, shortcut: shortcut, confidence: confidence,
        ctrl_key: event.ctrlKey, alt_key: event.altKey, shift_key: event.shiftKey, meta_key: event.metaKey,
        key: event.key, code: event.code,
      });
    });
  }

  function registerAnswerEventListeners() {
    document.addEventListener('change', function (e) {
      try {
        var evt = e || window.event;
        var element = (evt && evt.target) ? evt.target : null;
        if (!element || typeof element.matches !== 'function' || !element.matches('input, textarea, select')) return;
        var qInfo = getQuestionInfo(element);
        var aInfo = getAnswerInfo(element);
        handleEvent('answer_changed', {
          question: qInfo,
          answer: aInfo,
          question_id: qInfo.question_dom_id || qInfo.question_number || 'q',
          question_type: qInfo.question_type || 'multichoice',
          answer_text: aInfo.answer_text || aInfo.answer_value || '',
        });
      } catch (err) {}
    });

    var essayDebounceTimer = null;
    document.addEventListener('input', function (e) {
      try {
        var evt = e || window.event;
        var element = (evt && evt.target) ? evt.target : null;
        if (!element) return;
        var isTextInput = (typeof element.matches === 'function' && element.matches('textarea, input[type="text"]'));
        var isContentEditable = element.isContentEditable || (element.classList && element.classList.contains('editor_atto_content'));
        if (!isTextInput && !isContentEditable) return;

        var targetEl = element;
        if (essayDebounceTimer) clearTimeout(essayDebounceTimer);
        essayDebounceTimer = setTimeout(function () {
          try {
            if (!targetEl) return;
            var qInfo = getQuestionInfo(targetEl);
            var aInfo = getAnswerInfo(targetEl);
            var ansText = targetEl.value || targetEl.innerText || targetEl.textContent || '';
            handleEvent('answer_changed', {
              question: qInfo,
              answer: aInfo,
              question_id: qInfo.question_dom_id || qInfo.question_number || 'q',
              question_type: qInfo.question_type || 'essay',
              answer_text: ansText,
            });
          } catch (err) {}
        }, 1200);
      } catch (err) {}
    }, true);
  }

  var devToolsTrapInterval = null;
  var isDevToolsOpen = false;

  function startDevToolsTrap() {
    if (devToolsTrapInterval) return;

    devToolsTrapInterval = setInterval(function () {
      try {
        var widthDiff = window.outerWidth - window.innerWidth;
        var heightDiff = window.outerHeight - window.innerHeight;
        var threshold = 160;
        var detected = (widthDiff > threshold || heightDiff > threshold);

        // Timing debugger check
        var start = performance.now();
        (function () {}['constructor']('debugger'))();
        var duration = performance.now() - start;

        if (duration > 100) {
          detected = true;
        }

        if (detected) {
          if (!isDevToolsOpen) {
            isDevToolsOpen = true;
            handleEvent('devtools_opened', {
              action: 'devtools_detected',
              width_diff: widthDiff,
              height_diff: heightDiff,
              timing_delay_ms: Math.round(duration),
            });
            showToast('🚨 تم رصد فتح أدوات المطور (DevTools) — هذا الإجراء محظور ومسجل لدى مراقب الامتحان');
          }
        } else {
          isDevToolsOpen = false;
        }
      } catch (e) {}
    }, 2000);
  }

  function registerNetworkEventListeners() {
    window.addEventListener('online', function () {
      handleEvent('network_online', { reason: 'browser_detected_online_status' });
      retryLocalQueue();
    });
    window.addEventListener('offline', function () {
      handleEvent('network_offline', { reason: 'browser_detected_offline_status' });
    });

    try {
      var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (conn) {
        conn.addEventListener('change', function () {
          handleEvent('network_changed', {
            effective_type: conn.effectiveType || null,
            downlink: conn.downlink || null,
            rtt: conn.rtt || null,
            save_data: conn.saveData || false,
          });
          showToast('📡 تم رصد تغيير في حالة أو سرعة اتصال الشبكة');
        });
      }
    } catch (e) {}
  }

  // =====================================================
  // Periodic typing/mouse summary flush
  // =====================================================
  var summaryFlushTimer = null;

  function startSummaryFlush() {
    summaryFlushTimer = setInterval(flushTypingMouseSummary, SUMMARY_INTERVAL_MS);
  }

  // =====================================================
  // Teacher real-time actions polling & persistent enforcement
  // =====================================================
  var ACTION_POLL_INTERVAL_MS = 3000;
  var actionPollTimer = null;
  var timerManagerInterval = null;
  var pluginSecret = '';
  var processedActionIds = {};
  var lastAppliedReducedSec = 0;
  var isExamLocked = false;

  function lockInputInterceptor(e) {
    if (isExamLocked) {
      e.stopImmediatePropagation();
      e.preventDefault();
      return false;
    }
  }

  function registerLockListeners() {
    window.addEventListener('keydown', lockInputInterceptor, true);
    window.addEventListener('keyup', lockInputInterceptor, true);
    window.addEventListener('keypress', lockInputInterceptor, true);
    window.addEventListener('contextmenu', lockInputInterceptor, true);
  }

  function getQuizStorageKey(prefix) {
    var qid = (moodleContext.quiz && moodleContext.quiz.id) || '0';
    var uid = (moodleContext.student && moodleContext.student.id) || '0';
    var sess = sessionId || getSessionId() || '0';
    return prefix + '_q' + qid + '_u' + uid + '_s_' + sess;
  }

  function showMessageOverlay(message) {
    try {
      var existing = document.getElementById('exammonitor-teacher-msg');
      if (existing) existing.remove();
      var overlay = document.createElement('div');
      overlay.id = 'exammonitor-teacher-msg';
      overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999999;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);';
      overlay.innerHTML = '<div style="background:#fff;border-radius:20px;padding:32px 40px;max-width:480px;text-align:center;box-shadow:0 25px 70px rgba(0,0,0,0.5);border:1px solid #e2e8f0;">' +
        '<div style="font-size:48px;margin-bottom:12px;">💬</div>' +
        '<h2 style="font-size:20px;font-weight:800;color:#0f172a;margin:0 0 10px;">رسالة تنبيهية من المدرّس</h2>' +
        '<p style="font-size:16px;color:#334155;line-height:1.7;margin:0 0 24px;white-space:pre-wrap;font-weight:600;">' + message.replace(/</g, '&lt;') + '</p>' +
        '<button onclick="this.closest(\'#exammonitor-teacher-msg\').remove()" style="background:#2563eb;color:#fff;border:none;padding:12px 36px;border-radius:12px;font-size:15px;font-weight:800;cursor:pointer;box-shadow:0 4px 12px rgba(37,99,235,0.3);">حسناً، فهمت</button>' +
        '</div>';
      document.body.appendChild(overlay);
    } catch (e) {}
  }

  function hideLockOverlay() {
    try {
      isExamLocked = false;
      var lockKey = getQuizStorageKey('exammonitor_locked');
      localStorage.removeItem(lockKey);
      sessionStorage.removeItem(lockKey);
      var existing = document.getElementById('exammonitor-locked');
      if (existing) existing.remove();
      document.querySelectorAll('input, textarea, select, button, a').forEach(function(el) {
        el.disabled = false;
        el.style.pointerEvents = '';
        el.tabIndex = 0;
      });
    } catch (e) {}
  }

  var isSubmittingGracefully = false;
  var isTerminating = false;

  function terminateAndSubmitQuiz(customMsg) {
    if (isTerminating || isSubmittingGracefully) return;
    isTerminating = true;

    // 1. Immediately cancel all repeating timers to prevent background requests or loops
    if (actionPollTimer) { clearInterval(actionPollTimer); actionPollTimer = null; }
    if (batchTimer) { clearInterval(batchTimer); batchTimer = null; }
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }

    var termKey = getQuizStorageKey('exammonitor_terminated');
    var submitKey = getQuizStorageKey('exammonitor_submitted');
    var lockKey = getQuizStorageKey('exammonitor_locked');
    sessionStorage.setItem(termKey, '1');
    sessionStorage.setItem(submitKey, '1');
    sessionStorage.removeItem(lockKey);
    localStorage.removeItem(lockKey);

    // 2. Display calm, clean, professional Red Termination Overlay
    try {
      var exLock = document.getElementById('exammonitor-locked');
      if (exLock) exLock.remove();
      var existing = document.getElementById('exammonitor-terminated');
      if (!existing) {
        var overlay = document.createElement('div');
        overlay.id = 'exammonitor-terminated';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:linear-gradient(135deg, #991b1b 0%, #7f1d1d 100%);display:flex;align-items:center;justify-content:center;user-select:none;pointer-events:all;font-family:inherit;padding:20px;';
        overlay.innerHTML = '<div style="background:rgba(0,0,0,0.45);border:1.5px solid rgba(255,255,255,0.2);border-radius:24px;padding:36px 30px;max-width:520px;text-align:center;box-shadow:0 25px 50px -12px rgba(0,0,0,0.6);color:#fff;">' +
          '<div style="font-size:52px;margin-bottom:12px;">🛑</div>' +
          '<h2 style="font-size:22px;font-weight:900;margin:0 0 10px;letter-spacing:-0.5px;color:#fff;">تم إنهاء جلسة الامتحان</h2>' +
          '<p style="font-size:15px;line-height:1.7;margin:0 0 18px;color:#fee2e2;font-weight:600;">' + (customMsg || 'قام مدرّس المساق بإنهاء جلسة الاختبار الخاصة بك.<br>جاري حفظ إجاباتك وتسليم الامتحان بشكل نهائي للنظام...') + '</p>' +
          '<div style="display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,0.15);padding:8px 22px;border-radius:999px;font-size:12px;font-weight:700;">' +
            '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#4ade80;"></span>' +
            '<span>حالة المحاولة: تسليم إجباري نهائي</span>' +
          '</div>' +
        '</div>';
        document.body.appendChild(overlay);
      }

      // Block interaction with answers during final submission
      document.querySelectorAll('input:not([type="hidden"]), textarea, select, button, a').forEach(function(el) {
        el.style.pointerEvents = 'none';
      });
    } catch (e) {}

    // 3. Gracefully submit quiz answers ONCE
    setTimeout(function() {
      submitQuizGracefully();
    }, 600);
  }

  function submitQuizGracefully() {
    try {
      var submitKey = getQuizStorageKey('exammonitor_submitted');
      if (isSubmittingGracefully) {
        return;
      }
      isSubmittingGracefully = true;
      sessionStorage.setItem(submitKey, '1');

      // 1. Stop Moodle native timer
      if (typeof M !== 'undefined' && M.mod_quiz && M.mod_quiz.timer && typeof M.mod_quiz.timer.stop === 'function') {
        try {
          M.mod_quiz.timer.stop(null);
        } catch (e) {}
      }

      // 2. Lock UI with clear student notification (unless terminating overlay is already displayed)
      if (!isTerminating) {
        showLockOverlay('انتهى وقت الامتحان المخصص لك — جاري حفظ وإرسال إجاباتك إلى النظام...');
      }

      // 3. Priority 1: Summary page finish form/button if on summary.php
      var summaryBtn = document.querySelector('.btn-finishattempt button, .btn-finishattempt input[type="submit"]') ||
                       document.querySelector('#frm-finishattempt input[type="submit"]');
      if (summaryBtn) {
        summaryBtn.click();
        return;
      }
      var summaryForm = document.getElementById('frm-finishattempt') || document.querySelector('form.btn-finishattempt');
      if (summaryForm) {
        summaryForm.submit();
        return;
      }

      // 4. Priority 2: Standard attempt question response form
      var form = document.getElementById('responseform') ||
                 document.querySelector('form.mform') ||
                 document.querySelector('form[action*="processattempt"]');

      if (form) {
        // Ensure all inputs are enabled so student's answers are included in POST
        form.querySelectorAll('input, select, textarea').forEach(function(el) {
          el.disabled = false;
        });

        // Set or inject finishattempt = 1 (CRITICAL: tells Moodle server this attempt is finished)
        var finishInput = form.querySelector('input[name="finishattempt"]');
        if (!finishInput) {
          finishInput = document.createElement('input');
          finishInput.type = 'hidden';
          finishInput.name = 'finishattempt';
          form.appendChild(finishInput);
        }
        finishInput.value = '1';

        // Set or inject timeup = 1
        var timeupInput = form.querySelector('input[name="timeup"]');
        if (!timeupInput) {
          timeupInput = document.createElement('input');
          timeupInput.type = 'hidden';
          timeupInput.name = 'timeup';
          form.appendChild(timeupInput);
        }
        timeupInput.value = '1';

        // Bypass Moodle FormChangeChecker dialogs
        try {
          if (typeof M !== 'undefined' && M.mod_quiz && M.mod_quiz.timer && M.mod_quiz.timer.FormChangeChecker) {
            M.mod_quiz.timer.FormChangeChecker.markFormSubmitted(timeupInput);
          }
          if (typeof M !== 'undefined' && M.core_formchangechecker) {
            M.core_formchangechecker.set_form_submitted();
          }
        } catch (fcErr) {}

        // Send telemetry event
        handleEvent('attempt_auto_submitted', {
          reason: isTerminating ? 'teacher_terminated' : 'time_reduced_expired',
          timestamp: Date.now()
        });

        // Submit form
        setTimeout(function() {
          try {
            HTMLFormElement.prototype.submit.call(form);
          } catch (sErr) {
            form.submit();
          }
        }, 400);
        return;
      }

      // 5. Fallback redirect directly to processattempt.php
      if (moodleContext.quiz && moodleContext.quiz.attempt_id) {
        var sesskeyVal = moodleContext.sesskey || (document.querySelector('input[name="sesskey"]') ? document.querySelector('input[name="sesskey"]').value : '');
        var pUrl = (moodleContext.site_url || '').replace(/\/+$/, '') + '/mod/quiz/processattempt.php?attempt=' +
          encodeURIComponent(moodleContext.quiz.attempt_id) + '&finishattempt=1&timeup=1&sesskey=' +
          encodeURIComponent(sesskeyVal);
        window.location.href = pUrl;
      }
    } catch (e) {
      console.error('[ExamMonitor] submitQuizGracefully error:', e);
    }
  }

  function hookResponseForm() {
    try {
      var form = document.getElementById('responseform') || document.querySelector('form[action*="processattempt"]');
      if (!form || form._emHooked) return;
      form._emHooked = true;

      var enforceFinishOnTimeout = function() {
        var timerKey = getQuizStorageKey('exammonitor_reduced_sec');
        var rSec = parseInt(localStorage.getItem(timerKey) || '0', 10);
        var timeupInput = form.querySelector('input[name="timeup"]');
        var isTimeUp = (timeupInput && String(timeupInput.value) === '1');

        if (typeof M !== 'undefined' && M.mod_quiz && M.mod_quiz.timer && typeof M.mod_quiz.timer.endtime === 'number') {
          if (M.mod_quiz.timer.endtime - new Date().getTime() <= 0) {
            isTimeUp = true;
          }
        }

        if (isTimeUp || rSec > 0) {
          var finishInput = form.querySelector('input[name="finishattempt"]');
          if (!finishInput) {
            finishInput = document.createElement('input');
            finishInput.type = 'hidden';
            finishInput.name = 'finishattempt';
            form.appendChild(finishInput);
          }
          if (isTimeUp) {
            finishInput.value = '1';
            if (timeupInput) timeupInput.value = '1';
          }
        }
      };

      form.addEventListener('submit', enforceFinishOnTimeout, true);

      var origSubmit = form.submit;
      form.submit = function() {
        enforceFinishOnTimeout();
        return origSubmit.apply(this, arguments);
      };
    } catch (e) {}
  }

  function showLockOverlay(customMsg) {
    try {
      var curPath = window.location.pathname || '';
      var curHref = window.location.href || '';
      var submitKey = getQuizStorageKey('exammonitor_submitted');
      var termKey = getQuizStorageKey('exammonitor_terminated');
      if (curPath.indexOf('review.php') !== -1 || curHref.indexOf('review.php') !== -1 || curPath.indexOf('view.php') !== -1 ||
          sessionStorage.getItem(submitKey) === '1' || sessionStorage.getItem(termKey) === '1') {
        return;
      }
      isExamLocked = true;
      var lockKey = getQuizStorageKey('exammonitor_locked');
      sessionStorage.setItem(lockKey, '1');

      var msg = customMsg || 'تم إغلاق هذا الامتحان من قبل مدرّس المساق.<br>لا يمكنك تعديل أي إجابة أو استكمال الامتحان.';
      var title = customMsg ? 'انتهى وقت الامتحان' : 'تم قفل الامتحان من قِبل المدرّس';

      var existing = document.getElementById('exammonitor-locked');
      if (!existing) {
        var overlay = document.createElement('div');
        overlay.id = 'exammonitor-locked';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:#7f1d1d;display:flex;align-items:center;justify-content:center;user-select:none;pointer-events:all;';
        overlay.innerHTML = '<div style="text-align:center;color:#fff;padding:40px;max-width:550px;">' +
          '<div style="font-size:72px;margin-bottom:20px;">🔒</div>' +
          '<h1 style="font-size:28px;font-weight:900;margin:0 0 16px;letter-spacing:-0.5px;">' + title + '</h1>' +
          '<p style="font-size:17px;line-height:1.7;opacity:0.9;margin:0 0 20px;font-weight:600;">' + msg + '</p>' +
          '<div style="display:inline-block;background:rgba(0,0,0,0.3);padding:10px 24px;border-radius:30px;font-size:13px;font-weight:700;">حالة المحاولة: مقفلة مؤقتاً</div>' +
          '</div>';
        document.body.appendChild(overlay);
      }

      // Block interaction with student answers while keeping form parameters intact
      document.querySelectorAll('input:not([type="hidden"]), textarea, select, button, a').forEach(function(el) {
        el.style.pointerEvents = 'none';
        el.tabIndex = -1;
      });
    } catch (e) {}
  }

  function reduceTime(minutes) {
    try {
      var min = parseInt(minutes, 10) || 5;
      var timerKey = getQuizStorageKey('exammonitor_reduced_sec');
      var curReducedSec = parseInt(localStorage.getItem(timerKey) || '0', 10);
      curReducedSec += min * 60;
      localStorage.setItem(timerKey, curReducedSec);
      sessionStorage.setItem(timerKey, curReducedSec);

      showToast('⚠ تم تقليص وقت الامتحان بـ ' + min + ' دقائق من قِبل المدرّس');
      applyReducedTime();
    } catch (e) {
      showToast('تم تقليص الوقت بـ ' + minutes + ' دقائق');
    }
  }

  function applyReducedTime() {
    try {
      var timerKey = getQuizStorageKey('exammonitor_reduced_sec');
      var totalReducedSec = parseInt(localStorage.getItem(timerKey) || '0', 10);

      // Make sure response form is hooked
      hookResponseForm();

      // Check if attempt was already submitted
      var submitKey = getQuizStorageKey('exammonitor_submitted');
      if (sessionStorage.getItem(submitKey) === '1') {
        return;
      }

      // 1. Hook into Moodle YUI / JS native timer object if available
      if (typeof M !== 'undefined' && M.mod_quiz && M.mod_quiz.timer) {
        var timerObj = M.mod_quiz.timer;

        // Capture base endtime once (in milliseconds)
        if (typeof timerObj.endtime === 'number' && timerObj.endtime > 0) {
          if (!timerObj._baseEndtime) {
            timerObj._baseEndtime = timerObj.endtime;
          }
        }

        // Wrap update method if not already wrapped
        if (typeof timerObj.update === 'function' && !timerObj._emWrappedUpdate) {
          timerObj._emWrappedUpdate = true;
          var origMoodleUpdate = timerObj.update;

          timerObj.update = function() {
            var curTimerKey = getQuizStorageKey('exammonitor_reduced_sec');
            var rSec = parseInt(localStorage.getItem(curTimerKey) || '0', 10);
            if (rSec > 0 && timerObj._baseEndtime) {
              timerObj.endtime = timerObj._baseEndtime - (rSec * 1000);
            }

            var secRemaining = Math.floor((timerObj.endtime - new Date().getTime()) / 1000);
            if (secRemaining < 0) {
              // Time has expired!
              if (typeof timerObj.stop === 'function') {
                try { timerObj.stop(null); } catch (e) {}
              }
              var elTime = document.getElementById('quiz-time-left');
              if (elTime) {
                elTime.textContent = '00:00 (انتهى الوقت)';
              }
              submitQuizGracefully();
              return;
            }

            return origMoodleUpdate.apply(this, arguments);
          };
        }

        // Wrap updateEndTime if present
        if (typeof timerObj.updateEndTime === 'function' && !timerObj._emWrappedUpdateEndTime) {
          timerObj._emWrappedUpdateEndTime = true;
          var origMoodleUpdateEndTime = timerObj.updateEndTime;
          timerObj.updateEndTime = function(timeleft) {
            origMoodleUpdateEndTime.apply(this, arguments);
            timerObj._baseEndtime = timerObj.endtime;
            var curTimerKey = getQuizStorageKey('exammonitor_reduced_sec');
            var rSec = parseInt(localStorage.getItem(curTimerKey) || '0', 10);
            if (rSec > 0) {
              timerObj.endtime = timerObj._baseEndtime - (rSec * 1000);
            }
          };
        }

        // Apply reduction to Moodle timer
        if (totalReducedSec > 0 && timerObj._baseEndtime) {
          timerObj.endtime = timerObj._baseEndtime - (totalReducedSec * 1000);
          var currentSecLeft = Math.floor((timerObj.endtime - new Date().getTime()) / 1000);
          if (currentSecLeft < 0) {
            var elTime2 = document.getElementById('quiz-time-left');
            if (elTime2) {
              elTime2.textContent = '00:00 (انتهى الوقت)';
            }
            submitQuizGracefully();
            return;
          } else if (typeof timerObj.update === 'function') {
            timerObj.update();
          }
        }
      }

      // 2. Intercept visible timer DOM elements (always or as fallback)
      var timerEls = document.querySelectorAll('#quiz-timer, #timerobject, .mod_quiz-timer, #quiz-time-left, [data-timer]');
      if (totalReducedSec > 0 && timerEls.length > 0) {
        timerEls.forEach(function(el) {
          // If Moodle timer already handles it and it's not timed out, let Moodle render
          if (typeof M !== 'undefined' && M.mod_quiz && M.mod_quiz.timer && M.mod_quiz.timer._emWrappedUpdate) {
            var mSec = Math.floor((M.mod_quiz.timer.endtime - new Date().getTime()) / 1000);
            if (mSec < 0) {
              el.textContent = '00:00 (انتهى الوقت)';
              submitQuizGracefully();
            }
            return;
          }

          // Fallback DOM calculation if Moodle timer is absent
          if (typeof el._emBaseSec !== 'number') {
            var text = el.innerText || el.textContent || '';
            var match = text.match(/(\d+):(\d+)(?::(\d+))?/);
            if (match) {
              var h = 0, m = 0, s = 0;
              if (match[3] !== undefined) {
                h = parseInt(match[1], 10);
                m = parseInt(match[2], 10);
                s = parseInt(match[3], 10);
              } else {
                m = parseInt(match[1], 10);
                s = parseInt(match[2], 10);
              }
              el._emBaseSec = h * 3600 + m * 60 + s;
              el._emCapturedAt = Date.now();
            }
          }

          if (typeof el._emBaseSec === 'number') {
            var elapsed = Math.floor((Date.now() - el._emCapturedAt) / 1000);
            var remaining = Math.max(0, el._emBaseSec - elapsed - totalReducedSec);
            if (remaining <= 0) {
              el.textContent = '00:00 (انتهى الوقت)';
              submitQuizGracefully();
            } else {
              var newH = Math.floor(remaining / 3600);
              var newM = Math.floor((remaining % 3600) / 60);
              var newS = remaining % 60;
              var formatted = (newH > 0 ? (newH + ':') : '') +
                (newM < 10 ? '0' : '') + newM + ':' +
                (newS < 10 ? '0' : '') + newS;
              var prefix = (el.textContent.indexOf('الوقت') !== -1 ? 'الوقت المتبقي: ' : (el.textContent.indexOf('Time') !== -1 ? 'Time left: ' : ''));
              el.textContent = prefix + formatted;
            }
          }
        });
      }
    } catch (e) {
      console.warn('[ExamMonitor] applyReducedTime error:', e);
    }
  }

  function startTimerManager() {
    if (timerManagerInterval) return;
    applyReducedTime();
    timerManagerInterval = setInterval(applyReducedTime, 500);
  }

  function getApiUrl(subpath) {
    if (!serverUrl) return '';
    try {
      var u = new URL(serverUrl, window.location.href);
      var cleanPath = u.pathname.replace(/\/telemetry\/?$/i, '').replace(/\/+$/, '');
      return u.origin + cleanPath + subpath;
    } catch (e) {
      var urlWithoutQuery = serverUrl.split('?')[0].split('#')[0];
      var base = urlWithoutQuery.replace(/\/telemetry\/?$/i, '').replace(/\/+$/, '');
      return base + subpath;
    }
  }

  function acknowledgeAction(actionId) {
    if (!serverUrl || !pluginSecret) return;
    try {
      var ackUrl = getApiUrl('/api/teacher/actions/' + actionId + '/ack');
      if (pluginSecret) {
        ackUrl += (ackUrl.indexOf('?') === -1 ? '?' : '&') + 'k=' + encodeURIComponent(pluginSecret);
      }
      fetch(ackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Exam-Monitor-Secret': pluginSecret || ''
        },
        body: JSON.stringify({ secret: pluginSecret }),
      });
    } catch (e) {}
  }

  function pollTeacherActions() {
    if (!serverUrl || !pluginSecret) return;
    try {
      var checkUrl = getApiUrl('/api/teacher/actions/check');
      if (pluginSecret) {
        checkUrl += (checkUrl.indexOf('?') === -1 ? '?' : '&') + 'k=' + encodeURIComponent(pluginSecret);
      }

      var reqData = {
        secret: pluginSecret,
        session_id: sessionId || '',
        student_id: (moodleContext.student && moodleContext.student.id) ? parseInt(moodleContext.student.id, 10) : 0,
        exam_id: (moodleContext.quiz && moodleContext.quiz.id) ? parseInt(moodleContext.quiz.id, 10) : 0,
      };

      fetch(checkUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Exam-Monitor-Secret': pluginSecret || ''
        },
        body: JSON.stringify(reqData),
      })
      .then(function(res) {
        if (!res.ok) return null;
        return res.text();
      })
      .then(function(rawText) {
        if (!rawText) return;
        var data = null;
        try {
          var startIdx = rawText.indexOf('{');
          var endIdx = rawText.lastIndexOf('}');
          if (startIdx !== -1 && endIdx > startIdx) {
            data = JSON.parse(rawText.substring(startIdx, endIdx + 1));
          } else {
            data = JSON.parse(rawText);
          }
        } catch (parseErr) {
          console.warn('[ExamMonitor Action Poll JSON Error]', parseErr, rawText.substring(0, 100));
          return;
        }
        if (!data) return;

        // 1. Permanent lock check from server (only if attempt is actively ongoing)
        var submitKey = getQuizStorageKey('exammonitor_submitted');
        var termKey = getQuizStorageKey('exammonitor_terminated');
        var isAlreadyFinished = isTerminating || isSubmittingGracefully || sessionStorage.getItem(submitKey) === '1' || sessionStorage.getItem(termKey) === '1';

        if (data.is_locked && !isAlreadyFinished) {
          showLockOverlay();
        } else if (!data.is_locked) {
          hideLockOverlay();
        }

        // 2. Cumulative reduced minutes from server
        if (typeof data.total_reduced_minutes === 'number' && data.total_reduced_minutes > 0) {
          var timerKey = getQuizStorageKey('exammonitor_reduced_sec');
          var targetSec = data.total_reduced_minutes * 60;
          var curSec = parseInt(sessionStorage.getItem(timerKey) || localStorage.getItem(timerKey) || '0', 10);
          if (curSec < targetSec) {
            var diffMin = Math.round((targetSec - curSec) / 60);
            sessionStorage.setItem(timerKey, targetSec);
            showToast('⚠ تم تقليص وقت الامتحان بـ ' + (diffMin > 0 ? diffMin : data.total_reduced_minutes) + ' دقائق من قِبل المدرّس', true);
            applyReducedTime();
          }
        }

        // 3. Process actions list with deduplication
        var actions = data.actions || [];
        if (actions.length > 0) {
          console.log('⚡ [ExamMonitor Actions Received]', actions);
        }

        actions.forEach(function(action) {
          if (!action || !action.id) return;
          if (processedActionIds[action.id]) {
            acknowledgeAction(action.id);
            return;
          }
          processedActionIds[action.id] = true;

          if (action.action === 'send_message') {
            showMessageOverlay(action.message || 'رسالة من المدرّس');
            acknowledgeAction(action.id);
            handleEvent('teacher_action_received', { action_type: 'send_message', action_id: action.id });
          } else if (action.action === 'block_copy') {
            enforce.copy = true;
            acknowledgeAction(action.id);
            showToast('⚠️ قام المدرس بتفعيل منع النسخ لهذا الامتحان', true);
            handleEvent('teacher_action_received', { action_type: 'block_copy', action_id: action.id });
          } else if (action.action === 'allow_copy') {
            enforce.copy = false;
            acknowledgeAction(action.id);
            showToast('ℹ️ قام المدرس بالسماح بالنسخ في الامتحان', true);
            handleEvent('teacher_action_received', { action_type: 'allow_copy', action_id: action.id });
          } else if (action.action === 'block_paste') {
            enforce.paste = true;
            acknowledgeAction(action.id);
            showToast('⚠️ قام المدرس بتفعيل منع اللصق لهذا الامتحان', true);
            handleEvent('teacher_action_received', { action_type: 'block_paste', action_id: action.id });
          } else if (action.action === 'allow_paste') {
            enforce.paste = false;
            acknowledgeAction(action.id);
            showToast('ℹ️ قام المدرس بالسماح باللصق في الامتحان', true);
            handleEvent('teacher_action_received', { action_type: 'allow_paste', action_id: action.id });
          } else if (action.action === 'terminate_session') {
            acknowledgeAction(action.id);
            handleEvent('teacher_action_received', { action_type: 'terminate_session', action_id: action.id });
            terminateAndSubmitQuiz(action.message);
          } else if (action.action === 'lock_exam') {
            showLockOverlay();
            acknowledgeAction(action.id);
            handleEvent('teacher_action_received', { action_type: 'lock_exam', action_id: action.id });
          } else if (action.action === 'unlock_exam') {
            hideLockOverlay();
            acknowledgeAction(action.id);
            handleEvent('teacher_action_received', { action_type: 'unlock_exam', action_id: action.id });
          } else if (action.action === 'reduce_time') {
            var min = parseInt(action.minutes, 10) || 5;
            var timerKey = getQuizStorageKey('exammonitor_reduced_sec');
            var curSec = parseInt(sessionStorage.getItem(timerKey) || '0', 10);
            var newSec = Math.max(curSec, min * 60);
            sessionStorage.setItem(timerKey, newSec);
            showToast('⚠ تم تقليص وقت الامتحان بـ ' + min + ' دقائق من قِبل المدرّس', true);
            acknowledgeAction(action.id);
            handleEvent('teacher_action_received', { action_type: 'reduce_time', action_id: action.id, minutes: min });
            applyReducedTime();
          }
        });
      })
      .catch(function(err) {
        console.warn('[ExamMonitor Action Poll Error]', err);
      });
    } catch (e) {}
  }

  function startActionPolling() {
    if (actionPollTimer) return;
    pollTeacherActions();
    actionPollTimer = setInterval(pollTeacherActions, ACTION_POLL_INTERVAL_MS);
  }

  // =====================================================
  // Public API
  // =====================================================
  return {
    init: function (config) {
      moodleContext = config || {};
      serverUrl = (moodleContext.settings && moodleContext.settings.server_url) || '';
      pluginSecret = (moodleContext.settings && moodleContext.settings.sync_secret) || '';
      sessionId = getSessionId();

      // 1. Safety check: Never run monitoring, timers or lock overlay on review.php, view.php, summary.php (completed), or finished attempt
      var curPath = window.location.pathname || '';
      var curSearch = window.location.search || '';
      var curHref = window.location.href || '';

      var submitKey = getQuizStorageKey('exammonitor_submitted');
      var termKey = getQuizStorageKey('exammonitor_terminated');
      var lockKey = getQuizStorageKey('exammonitor_locked');
      var timerKey = getQuizStorageKey('exammonitor_reduced_sec');

      var isFinishedOrReview = curPath.indexOf('review.php') !== -1 ||
                               curSearch.indexOf('review.php') !== -1 ||
                               curHref.indexOf('review.php') !== -1 ||
                               curPath.indexOf('view.php') !== -1 ||
                               curSearch.indexOf('view.php') !== -1 ||
                               (typeof M !== 'undefined' && M.cfg && (M.cfg.pageType === 'mod-quiz-review' || M.cfg.pageType === 'mod-quiz-view'));

      var isContextFinished = Boolean(moodleContext.quiz && (moodleContext.quiz.state === 'finished' || moodleContext.quiz.state === 'abandoned'));
      var isSubmittedOrTerminated = (sessionStorage.getItem(submitKey) === '1' || sessionStorage.getItem(termKey) === '1');
      var isSummaryComplete = curPath.indexOf('summary.php') !== -1 && (isSubmittedOrTerminated || document.getElementById('responseform') === null);

      if (isFinishedOrReview || isContextFinished || isSummaryComplete) {
        // Attempt is finished. Clean up all stored locks and timers so student sees Moodle screen peacefully
        try {
          sessionStorage.removeItem(submitKey);
          sessionStorage.removeItem(termKey);
          sessionStorage.removeItem(lockKey);
          localStorage.removeItem(lockKey);
          sessionStorage.removeItem(timerKey);
          localStorage.removeItem(timerKey);
          var existingOverlay = document.getElementById('exammonitor-locked');
          if (existingOverlay && existingOverlay.parentNode) {
            existingOverlay.parentNode.removeChild(existingOverlay);
          }
          var existingTerm = document.getElementById('exammonitor-terminated');
          if (existingTerm && existingTerm.parentNode) {
            existingTerm.parentNode.removeChild(existingTerm);
          }
        } catch (e) {}
        console.log('ℹ [ExamMonitor] Attempt finished/submitted. Monitoring completely deactivated.');
        return; // HALT IMMEDIATELY! NO REDIRECTS, NO OVERLAYS, NO REFRESH LOOPS!
      }

      console.log('🚀 [ExamMonitor Initialized]', {
        student: moodleContext.student,
        quiz: moodleContext.quiz,
        server: serverUrl
      });

      // Immediate check for session lock
      if (sessionStorage.getItem(lockKey) === '1') {
        showLockOverlay();
      }

      hookResponseForm();

      if (moodleContext.settings && moodleContext.settings.enforce) {
        enforce = {
          copy: Boolean(moodleContext.settings.enforce.copy),
          paste: Boolean(moodleContext.settings.enforce.paste),
          rightclick: Boolean(moodleContext.settings.enforce.rightclick),
          print: Boolean(moodleContext.settings.enforce.print),
          shortcuts: Boolean(moodleContext.settings.enforce.shortcuts),
          fullscreen: Boolean(moodleContext.settings.enforce.fullscreen),
        };
      }

      registerBrowserEventListeners();
      registerScreenshotListeners();
      registerPrintListener();
      registerAnswerEventListeners();
      registerNetworkEventListeners();
      registerFullscreenListener();
      registerLockListeners();

      startBatchTimer();
      startHeartbeat();
      startIdleDetection();
      startSummaryFlush();
      startTimerManager();
      startActionPolling();
      startDevToolsTrap();

      // Request fullscreen on start if enforced
      requestFullscreen();

      // Count visible question blocks in Moodle DOM
      var totalQuestions = document.querySelectorAll('.que').length || 1;

      // Send initial page_view event immediately so student appears in dashboard in real-time
      handleEvent('page_view', {
        page_url: window.location.href,
        total_questions: totalQuestions,
        device_telemetry: getDeviceTelemetry(),
        network_info: getNetworkInfo(),
      });

      // Retry queued events from previous sessions
      retryLocalQueue();
    },
  };
});
