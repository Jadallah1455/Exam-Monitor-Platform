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

  async function sendBatch(events) {
    if (!serverUrl || events.length === 0) return;
    try {
      var payload = JSON.stringify({ events: events });

      var response = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Exam-Monitor-Secret': pluginSecret || ''
        },
        body: payload,
        keepalive: true
      });

      if (!response.ok && response.status !== 204) {
        throw new Error('HTTP ' + response.status);
      }

      resetRetryDelay();
    } catch (e) {
      var localQueue = getLocalQueue();
      localQueue.push.apply(localQueue, events);
      saveLocalQueue(localQueue);
      var delay = getNextRetryDelay();
      setTimeout(retryLocalQueue, delay);
    }
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
  function showToast(message) {
    if (!enforce.copy && !enforce.paste && !enforce.rightclick && !enforce.print && !enforce.shortcuts) return;
    try {
      var existing = document.getElementById('exammonitor-toast');
      if (existing) existing.remove();
      var toast = document.createElement('div');
      toast.id = 'exammonitor-toast';
      toast.textContent = message;
      toast.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999999;background:#b91c1c;color:#fff;padding:12px 18px;border-radius:10px;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;box-shadow:0 4px 18px rgba(0,0,0,0.35);transition:opacity .3s;max-width:320px;';
      document.body.appendChild(toast);
      window.setTimeout(function () { toast.style.opacity = '0'; window.setTimeout(function () { toast.remove(); }, 350); }, 2600);
    } catch (e) {}
  }

  // =====================================================
  // Question / Answer info
  // =====================================================
  function getQuestionContainer(element) { return element.closest('.que'); }

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
    var tag = element.tagName.toLowerCase();
    var type = element.type || tag;
    var vi = {};
    if (type === 'password') {
      vi = { has_value: Boolean(element.value), value_length: element.value.length };
    } else if (tag === 'textarea' || type === 'text') {
      var tv = element.value || '';
      vi = {
        has_value: tv.length > 0,
        value_length: tv.length,
        word_count: tv.trim() ? tv.trim().split(/\s+/).length : 0,
        answer_text: tv,
        answer_value: tv,
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

    document.addEventListener('copy', function (event) {
      var sel = window.getSelection();
      var selLen = sel ? sel.toString().length : 0;
      handleEvent('copy', {
        action: enforce.copy ? 'copy_blocked' : 'copy_detected',
        selection_length: selLen,
        selection_text: selLen > 0 ? sel.toString().substring(0, 200) : '',
      });
      if (enforce.copy) { event.preventDefault(); showToast('النسخ غير مسموح خلال هذا الامتحان'); }
      resetIdle();
    });

    document.addEventListener('paste', function (event) {
      handleEvent('paste', { action: enforce.paste ? 'paste_blocked' : 'paste_detected' });
      if (enforce.paste) { event.preventDefault(); showToast('اللصق غير مسموح خلال هذا الامتحان'); }
      resetIdle();
    });

    document.addEventListener('contextmenu', function (event) {
      handleEvent('right_click', { action: enforce.rightclick ? 'context_menu_blocked' : 'context_menu_opened' });
      if (enforce.rightclick) event.preventDefault();
      resetIdle();
    });

    document.addEventListener('cut', function (event) {
      handleEvent('cut', { action: enforce.copy ? 'cut_blocked' : 'cut_detected' });
      if (enforce.copy) event.preventDefault();
      resetIdle();
    });

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

    document.addEventListener('input', debounce(function (e) {
      try {
        var evt = e || window.event;
        var element = (evt && evt.target) ? evt.target : null;
        if (!element || typeof element.matches !== 'function' || !element.matches('textarea, input[type="text"]')) return;
        var qInfo = getQuestionInfo(element);
        var aInfo = getAnswerInfo(element);
        handleEvent('answer_changed', {
          question: qInfo,
          answer: aInfo,
          question_id: qInfo.question_dom_id || qInfo.question_number || 'q',
          question_type: qInfo.question_type || 'essay',
          answer_text: element.value || '',
        });
      } catch (err) {}
    }, 2000), true);
  }

  function registerNetworkEventListeners() {
    window.addEventListener('online', function () {
      handleEvent('network_online', { reason: 'browser_detected_online_status' });
      retryLocalQueue();
    });
    window.addEventListener('offline', function () {
      handleEvent('network_offline', { reason: 'browser_detected_offline_status' });
    });
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

  function getQuizStorageKey(prefix) {
    var qid = (moodleContext.quiz && moodleContext.quiz.id) || '0';
    var uid = (moodleContext.student && moodleContext.student.id) || '0';
    return prefix + '_q' + qid + '_u' + uid;
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

  function showLockOverlay() {
    try {
      var lockKey = getQuizStorageKey('exammonitor_locked');
      localStorage.setItem(lockKey, '1');
      sessionStorage.setItem(lockKey, '1');

      var existing = document.getElementById('exammonitor-locked');
      if (!existing) {
        var overlay = document.createElement('div');
        overlay.id = 'exammonitor-locked';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:#7f1d1d;display:flex;align-items:center;justify-content:center;user-select:none;pointer-events:all;';
        overlay.innerHTML = '<div style="text-align:center;color:#fff;padding:40px;max-width:550px;">' +
          '<div style="font-size:72px;margin-bottom:20px;">🔒</div>' +
          '<h1 style="font-size:28px;font-weight:900;margin:0 0 16px;letter-spacing:-0.5px;">تم قفل الامتحان من قِبل المدرّس</h1>' +
          '<p style="font-size:17px;line-height:1.7;opacity:0.9;margin:0 0 20px;font-weight:600;">تم إنهاء وإغلاق محاولتك في هذا الامتحان بقرار مباشر من مدرّس المساق.<br>لا يمكنك تعديل أي إجابة أو استكمال الامتحان.</p>' +
          '<div style="display:inline-block;background:rgba(0,0,0,0.3);padding:10px 24px;border-radius:30px;font-size:13px;font-weight:700;">حالة المحاولة: مقفلة نهائياً</div>' +
          '</div>';
        document.body.appendChild(overlay);
      }

      // Disable all inputs, forms, and buttons completely
      document.querySelectorAll('input, textarea, select, button, a').forEach(function(el) {
        el.disabled = true;
        el.style.pointerEvents = 'none';
        el.tabIndex = -1;
      });

      // Intercept any clicks and keyboard events
      window.addEventListener('keydown', function(e) { e.stopImmediatePropagation(); e.preventDefault(); }, true);
      window.addEventListener('keyup', function(e) { e.stopImmediatePropagation(); e.preventDefault(); }, true);
      window.addEventListener('keypress', function(e) { e.stopImmediatePropagation(); e.preventDefault(); }, true);
      window.addEventListener('contextmenu', function(e) { e.stopImmediatePropagation(); e.preventDefault(); }, true);

      // Auto-submit responseform to permanently finish the attempt on Moodle if not submitted
      try {
        var respForm = document.getElementById('responseform') || document.querySelector('form.quiz-form') || document.querySelector('form[action*="attempt.php"]');
        if (respForm && !respForm.dataset.emAutoFinished) {
          respForm.dataset.emAutoFinished = 'true';
          respForm.submit();
        }
      } catch (e) {}
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
      if (totalReducedSec <= 0) return;

      // 1. If Moodle YUI / JS timer object exists, modify it
      if (typeof M !== 'undefined' && M.mod_quiz && M.mod_quiz.timer) {
        if (typeof M.mod_quiz.timer.seconds === 'number') {
          if (!M.mod_quiz.timer._emAdjusted) {
            M.mod_quiz.timer._emAdjusted = totalReducedSec;
            M.mod_quiz.timer.seconds = Math.max(0, M.mod_quiz.timer.seconds - totalReducedSec);
          }
        }
      }

      // 2. Intercept visible timer DOM elements
      var timerEls = document.querySelectorAll('#quiz-timer, #timerobject, .mod_quiz-timer, #quiz-time-left, [data-timer]');
      timerEls.forEach(function(el) {
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
          var currentRemaining = h * 3600 + m * 60 + s;
          if (!el.dataset.emRawTime) {
            el.dataset.emRawTime = currentRemaining;
          }
          var adjusted = parseInt(el.dataset.emRawTime, 10) - totalReducedSec;
          if (adjusted <= 0) {
            el.textContent = '00:00 (انتهى الوقت)';
            showLockOverlay();
          } else {
            var newH = Math.floor(adjusted / 3600);
            var newM = Math.floor((adjusted % 3600) / 60);
            var newS = adjusted % 60;
            var formatted = (newH > 0 ? (newH + ':') : '') +
              (newM < 10 ? '0' : '') + newM + ':' +
              (newS < 10 ? '0' : '') + newS;
            el.textContent = (text.indexOf('الوقت') !== -1 ? 'الوقت المتبقي: ' : (text.indexOf('Time') !== -1 ? 'Time left: ' : '')) + formatted;
          }
        }
      });
    } catch (e) {}
  }

  function startTimerManager() {
    if (timerManagerInterval) return;
    timerManagerInterval = setInterval(applyReducedTime, 500);
  }

  function acknowledgeAction(actionId) {
    if (!serverUrl || !pluginSecret) return;
    try {
      fetch(serverUrl.replace('/telemetry', '/api/teacher/actions/' + actionId + '/ack'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: pluginSecret }),
      });
    } catch (e) {}
  }

  function pollTeacherActions() {
    if (!serverUrl || !pluginSecret) return;
    try {
      var checkUrl = serverUrl.replace('/telemetry', '/api/teacher/actions/check');
      fetch(checkUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: pluginSecret,
          session_id: sessionId,
          student_id: moodleContext.student ? moodleContext.student.id : 0,
          exam_id: moodleContext.quiz ? moodleContext.quiz.id : 0,
        }),
      })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (!data) return;

        // Permanent lock check from server
        if (data.is_locked) {
          showLockOverlay();
        }

        // Cumulative reduced minutes from server
        if (data.total_reduced_minutes && data.total_reduced_minutes > 0) {
          var timerKey = getQuizStorageKey('exammonitor_reduced_sec');
          var targetSec = data.total_reduced_minutes * 60;
          if (parseInt(localStorage.getItem(timerKey) || '0', 10) < targetSec) {
            localStorage.setItem(timerKey, targetSec);
            sessionStorage.setItem(timerKey, targetSec);
            applyReducedTime();
          }
        }

        var actions = data.actions || [];
        actions.forEach(function(action) {
          if (action.action === 'send_message') {
            showMessageOverlay(action.message || 'رسالة من المدرّس');
            acknowledgeAction(action.id);
            handleEvent('teacher_action_received', { action_type: 'send_message', action_id: action.id });
          } else if (action.action === 'lock_exam') {
            showLockOverlay();
            acknowledgeAction(action.id);
            handleEvent('teacher_action_received', { action_type: 'lock_exam', action_id: action.id });
          } else if (action.action === 'reduce_time') {
            reduceTime(action.minutes || 5);
            acknowledgeAction(action.id);
            handleEvent('teacher_action_received', { action_type: 'reduce_time', action_id: action.id, minutes: action.minutes });
          }
        });
      })
      .catch(function() {});
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

      console.log('🚀 [ExamMonitor Initialized]', {
        student: moodleContext.student,
        quiz: moodleContext.quiz,
        server: serverUrl
      });

      // Immediate check for persistent lock
      var lockKey = getQuizStorageKey('exammonitor_locked');
      if (localStorage.getItem(lockKey) === '1' || sessionStorage.getItem(lockKey) === '1') {
        showLockOverlay();
      }

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

      startBatchTimer();
      startHeartbeat();
      startIdleDetection();
      startSummaryFlush();
      startTimerManager();
      startActionPolling();

      // Request fullscreen on start if enforced
      requestFullscreen();

      // Send initial page_view event immediately so student appears in dashboard in real-time
      handleEvent('page_view', {
        page_url: window.location.href,
        device_telemetry: getDeviceTelemetry(),
        network_info: getNetworkInfo(),
      });

      // Retry queued events from previous sessions
      retryLocalQueue();
    },
  };
});
