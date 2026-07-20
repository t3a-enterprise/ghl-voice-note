/**
 * T3A Voice Recorder — botão de microfone no composer do GoHighLevel
 * ------------------------------------------------------------------
 * Grava voice note no browser, converte para WAV 16kHz mono e injeta no
 * input de anexo nativo do GHL. O GHL faz o upload normalmente; a Trinity
 * recebe pelo webhook, converte para OGG/Opus e envia como PTT nativo.
 *
 * Vanilla JS ES2020. Sem build, sem dependência, sem framework.
 * Roda dentro do SPA Vue do GHL via Settings > Company > Whitelabel > Custom JS.
 *
 * FILOSOFIA: em caso de qualquer dúvida, o botão NÃO aparece.
 * Nunca quebrar a tela de Conversations — nem para quem não usa a feature.
 *
 * Seletores validados em 2026-07-20 (Chrome 150).
 */
(function () {
  "use strict";

  // Marca SÍNCRONA — antes de qualquer await. Impede dupla execução do loader.
  if (window.__T3A_VOICE__) return;
  window.__T3A_VOICE__ = { version: "1.2.0", bootedAt: Date.now() };

  // ==================================================================
  // CONFIG
  // ==================================================================
  var CFG = {
    // OPT-OUT: por padrão o microfone vale para TODAS as sub-accounts —
    // cliente novo já nasce com ele. Quem desliga é o `blocked` do config.json.
    //
    // Modo opcional de rollout restrito: declarar a lista no Custom JS do GHL
    // (que é privado — este arquivo é público e ID de sub-account é dado de
    // cliente) faz o script atender SÓ aquelas sub-accounts:
    //
    //   <script>window.__T3A_VOICE_LOCATIONS__ = ["abc123"];</script>
    //
    // Lista ausente ou vazia = todas. Pegar o ID na URL:
    // /v2/location/<ESTE_PEDACO>/conversations/...
    allowedLocations: (Array.isArray(window.__T3A_VOICE_LOCATIONS__) &&
                       window.__T3A_VOICE_LOCATIONS__.length)
      ? window.__T3A_VOICE_LOCATIONS__
      : null,

    killSwitchUrl: "https://t3a-enterprise.github.io/ghl-voice-note/config.json",
    killSwitchTimeoutMs: 4000,
    recheckMs: 15 * 60 * 1000,

    maxDurationMs: 150000,   // 2min30 — 150s x 32.000 B/s = 4,8MB (teto GHL = 5MB decimal)
    maxBytes: 5000000,       // 5 MB DECIMAL (ATTACHMENT_SIZE_LIMIT do GHL)
    minDurationSec: 0.7,     // abaixo disso é clique acidental
    targetSampleRate: 16000, // 32.000 B/s mono 16-bit
    normalizeVolume: true,   // corrige microfone fraco (problema real observado em teste)
    normalizeTargetPeak: 0.89,
    encodeTimeoutMs: 15000,

    debug: false,
  };

  var SEL = {
    // NUNCA usar 'input[type=file]' genérico aqui: fora do composer ele pega o
    // input do avatar, do import de CSV ou da Media Library — e o áudio iria
    // parar num formulário aleatório do CRM do cliente.
    fileInput: ["input.hr-upload-file-input", "input.n-upload-file-input"],
    composerRoot: ["#composer-textarea"],
    footer: ["#conv-composer-footer"],
    textarea: ["#conv-composer-textarea-input", 'textarea[placeholder*="mensagem" i]'],
    sendButton: ["#conv-send-button-simple"],
  };

  var TAG = "t3a-voice-recorder";
  var LOG = "[T3A-VOICE]";

  // ==================================================================
  // UTILITÁRIOS SEGUROS
  // ==================================================================
  function log() {
    if (!CFG.debug) return;
    try { console.log.apply(console, [LOG].concat([].slice.call(arguments))); } catch (e) {}
  }
  function warn() {
    try { console.warn.apply(console, [LOG].concat([].slice.call(arguments))); } catch (e) {}
  }

  /** Envolve fn em try/catch cobrindo TAMBÉM o ramo assíncrono. */
  function safe(fn, label) {
    return function () {
      try {
        var r = fn.apply(this, arguments);
        if (r && typeof r.then === "function") {
          return r.catch(function (e) { warn("async falhou em " + label + ":", e && e.message); });
        }
        return r;
      } catch (e) {
        warn("falhou em " + label + ":", e && e.message);
      }
    };
  }

  function qs(list) {
    for (var i = 0; i < list.length; i++) {
      try {
        var el = document.querySelector(list[i]);
        if (el) return el;
      } catch (e) { /* seletor inválido — tenta o próximo */ }
    }
    return null;
  }

  /** Busca o input de arquivo SEMPRE dentro do composer. Nunca varre a página. */
  function findFileInput() {
    var root = qs(SEL.composerRoot);
    if (!root) return null;
    for (var i = 0; i < SEL.fileInput.length; i++) {
      try {
        var el = root.querySelector(SEL.fileInput[i]);
        if (el) return el;
      } catch (e) {}
    }
    return null;
  }

  function currentLocationId() {
    var m = String(location.pathname).match(/location\/([^/]+)/);
    return m ? m[1] : null;
  }

  // ==================================================================
  // ÁUDIO
  // ==================================================================

  // AudioContext é SINGLETON de página. O Chrome trava em 6 contextos por
  // documento — um por gravação faria o botão morrer na 6ª.
  var sharedCtx = null;

  function getAudioContext() {
    if (sharedCtx && sharedCtx.state !== "closed") return sharedCtx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { sharedCtx = new AC({ sampleRate: CFG.targetSampleRate }); }
    catch (e1) {
      try { sharedCtx = new AC(); } catch (e2) { return null; }
    }
    return sharedCtx;
  }

  function closeSharedCtx() {
    if (!sharedCtx) return;
    try { if (sharedCtx.state !== "closed") sharedCtx.close(); } catch (e) {}
    sharedCtx = null;
  }

  /** Reamostra por média de bloco (decimação simples vira chiado metálico). */
  function downsample(input, inRate, outRate) {
    if (outRate >= inRate) return input.slice(0);
    var ratio = inRate / outRate;
    var outLen = Math.floor(input.length / ratio);
    var out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) {
      var start = Math.floor(i * ratio);
      var end = Math.min(Math.floor((i + 1) * ratio), input.length);
      var sum = 0, n = 0;
      for (var j = start; j < end; j++) { sum += input[j]; n++; }
      out[i] = n ? sum / n : 0;
    }
    return out;
  }

  function normalize(samples, targetPeak) {
    var peak = 0;
    for (var i = 0; i < samples.length; i++) {
      var a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }
    if (peak < 0.0001 || peak >= targetPeak) return samples;
    var gain = targetPeak / peak;
    for (var k = 0; k < samples.length; k++) samples[k] *= gain;
    log("normalizado: pico", peak.toFixed(3), "ganho", gain.toFixed(2) + "x");
    return samples;
  }

  /** Float32 [-1,1] → WAV PCM 16-bit mono. Header RIFF de 44 bytes. */
  function encodeWav(samples, sampleRate) {
    var buf = new ArrayBuffer(44 + samples.length * 2);
    var v = new DataView(buf);
    function str(off, s) { for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); }

    var dataSize = samples.length * 2;
    str(0, "RIFF");
    v.setUint32(4, 36 + dataSize, true);
    str(8, "WAVE");
    str(12, "fmt ");
    v.setUint32(16, 16, true);          // tamanho do bloco fmt
    v.setUint16(20, 1, true);           // PCM
    v.setUint16(22, 1, true);           // mono
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true); // byteRate = rate * canais * bytes
    v.setUint16(32, 2, true);           // blockAlign
    v.setUint16(34, 16, true);          // bits por amostra
    str(36, "data");
    v.setUint32(40, dataSize, true);

    var off = 44;
    for (var i = 0; i < samples.length; i++, off += 2) {
      // clamp ANTES de escalar; faixa int16 é assimétrica (-32768..32767)
      var s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  function pickMimeType() {
    var cands = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"];
    for (var i = 0; i < cands.length; i++) {
      try { if (MediaRecorder.isTypeSupported(cands[i])) return cands[i]; } catch (e) {}
    }
    return "";
  }

  // ==================================================================
  // WEB COMPONENT
  // ==================================================================
  function defineComponent() {
    if (customElements.get(TAG)) return;

    var Recorder = function () {
      var self = Reflect.construct(HTMLElement, [], Recorder);
      self._state = "idle";
      self._chunks = [];
      self._stream = null;
      self._rec = null;
      self._ctx = null;
      self._timer = null;
      self._autostop = null;
      self._doneTimer = null;
      self._watchdog = null;
      self._cleanupId = null;
      self._startedAt = 0;
      self._cancelled = false;
      return self;
    };
    Recorder.prototype = Object.create(HTMLElement.prototype);
    Recorder.prototype.constructor = Recorder;
    Object.setPrototypeOf(Recorder, HTMLElement);

    Recorder.prototype.connectedCallback = safe(function () {
      // Vue faz remove+append no mesmo tick: cancela o cleanup agendado.
      if (this._cleanupId) { clearTimeout(this._cleanupId); this._cleanupId = null; }
      if (this._built) return;
      this._built = true;
      this._render();
    }, "connectedCallback");

    Recorder.prototype.disconnectedCallback = safe(function () {
      // AGENDA o cleanup em vez de executar na hora: assim dá para distinguir
      // "o Vue moveu o nó" (reconecta no mesmo tick) de "saiu de vez".
      var self = this;
      if (this._cleanupId) clearTimeout(this._cleanupId);
      this._cleanupId = setTimeout(safe(function () {
        self._cleanupId = null;
        if (self.isConnected) return;   // era só um move do Vue
        self._abort();
      }, "deferredCleanup"), 0);
    }, "disconnectedCallback");

    Recorder.prototype._render = function () {
      var sh = this.attachShadow({ mode: "open" });
      sh.innerHTML =
        '<style>' +
        ':host{display:inline-flex;align-items:center;font-family:inherit}' +
        '.wrap{display:inline-flex;align-items:center;gap:6px}' +
        'button{all:unset;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;' +
        'width:28px;height:28px;border-radius:4px;color:#667085;transition:background .15s}' +
        'button:hover{background:rgba(0,0,0,.06)}' +
        'button:focus-visible{outline:2px solid #2970ff;outline-offset:1px}' +
        '.rec{color:#d92d20}' +
        '.dot{width:7px;height:7px;border-radius:50%;background:#d92d20;animation:b 1s infinite}' +
        '@keyframes b{0%,100%{opacity:1}50%{opacity:.25}}' +
        '.t{font-size:12px;color:#475467;font-variant-numeric:tabular-nums;min-width:34px}' +
        '.msg{font-size:11px;color:#d92d20;max-width:220px}' +
        '.ok{display:inline-flex;align-items:center;justify-content:center;' +
        'width:28px;height:28px;color:#12b76a}' +
        '</style>' +
        '<div class="wrap"></div>';
      this._wrap = sh.querySelector(".wrap");
      this._paint();
    };

    Recorder.prototype._icon = function (kind) {
      if (kind === "mic") {
        return '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
          'stroke-width="2" stroke-linecap="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>' +
          '<path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>';
      }
      if (kind === "stop") {
        return '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">' +
          '<rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
      }
      return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<polyline points="20 6 9 17 4 12"/></svg>';
    };

    Recorder.prototype._paint = function () {
      if (!this._wrap) return;
      var w = this._wrap, self = this;
      w.innerHTML = "";

      function btn(html, title, cls, onClick) {
        var b = document.createElement("button");
        b.innerHTML = html;
        b.title = title;
        b.setAttribute("aria-label", title);
        if (cls) b.className = cls;
        b.addEventListener("click", safe(onClick, "click:" + title));
        w.appendChild(b);
        return b;
      }
      function span(cls, text) {
        var s = document.createElement("span");
        s.className = cls;
        if (text) s.textContent = text;
        w.appendChild(s);
        return s;
      }

      if (this._state === "idle") {
        btn(this._icon("mic"), "Gravar áudio", "", function (e) {
          e.preventDefault(); e.stopPropagation();
          self._start();
        });

      } else if (this._state === "requesting" || this._state === "encoding") {
        span("t", "...");

      } else if (this._state === "recording") {
        span("dot");
        this._timeEl = span("t", "0:00");
        btn(this._icon("stop"), "Parar gravação", "rec", function (e) {
          e.preventDefault(); e.stopPropagation();
          self._stop();
        });

      } else if (this._state === "done") {
        // O anexo já está na área de anexos do GHL — quem quiser ouvir ou
        // remover, faz por lá. Um player nosso aqui só duplicaria, e um botão
        // "descartar" seria mentira: o arquivo já foi entregue ao GHL.
        var ok = span("ok");
        ok.innerHTML = this._icon("check");
        ok.title = "Áudio anexado";

      } else if (this._state === "error") {
        span("msg", this._errMsg || "Erro ao gravar");
        btn(this._icon("mic"), "Tentar de novo", "", function (e) {
          e.preventDefault(); e.stopPropagation();
          self._setState("idle");
        });
      }
    };

    Recorder.prototype._setState = function (s, msg) {
      this._state = s;
      this._errMsg = msg || "";
      this._paint();
    };

    Recorder.prototype._start = safe(function () {
      var self = this;
      if (this._state !== "idle") return;
      this._cancelled = false;
      this._setState("requesting");

      // iOS: criar/resumir o AudioContext ANTES de getUserMedia. A Promise do
      // getUserMedia consome o crédito do gesto do usuário; depois dela o
      // AudioContext fica preso em "suspended".
      this._ctx = getAudioContext();
      if (!this._ctx) { this._setState("error", "Áudio não suportado"); return; }
      if (this._ctx.state === "suspended") { try { this._ctx.resume(); } catch (e) {} }

      navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      }).then(function (stream) {
        // O usuário pode ter trocado de conversa durante o prompt de permissão.
        if (self._cancelled || !self.isConnected) {
          stream.getTracks().forEach(function (t) { t.stop(); });
          if (self._state === "requesting") self._setState("idle");
          return;
        }
        self._stream = stream;
        var mime = pickMimeType();
        self._rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        self._chunks = [];
        self._rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) self._chunks.push(ev.data); };
        self._rec.onstop = safe(function () { self._encode(); }, "onstop");
        // Fone Bluetooth desconectando no meio emite error e pode nunca emitir stop.
        self._rec.onerror = safe(function () {
          self._clearTimers();
          self._releaseStream();
          self._setState("error", "A gravação foi interrompida");
        }, "recError");
        self._rec.start();
        self._startedAt = Date.now();
        self._setState("recording");
        self._timer = setInterval(safe(function () { self._tick(); }, "tick"), 200);
        self._autostop = setTimeout(safe(function () { self._stop(); }, "autostop"), CFG.maxDurationMs);
      }).catch(function (err) {
        var m = "Erro no microfone";
        if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) m = "Permissão negada";
        else if (err && err.name === "NotFoundError") m = "Microfone não encontrado";
        self._setState("error", m);
        self._releaseStream();
      });
    }, "_start");

    Recorder.prototype._tick = function () {
      if (this._state !== "recording" || !this._timeEl) return;
      var s = Math.floor((Date.now() - this._startedAt) / 1000);
      var mm = Math.floor(s / 60), ss = s % 60;
      this._timeEl.textContent = mm + ":" + (ss < 10 ? "0" : "") + ss;
    };

    /** Se _encode/_attach morrerem de forma imprevista, não deixa a UI travada. */
    Recorder.prototype._armWatchdog = function () {
      var self = this;
      clearTimeout(this._watchdog);
      this._watchdog = setTimeout(safe(function () {
        if (self._state === "encoding") self._setState("error", "Falha ao processar áudio");
      }, "watchdog"), CFG.encodeTimeoutMs);
    };

    Recorder.prototype._stop = safe(function () {
      if (this._state !== "recording") return;
      this._clearTimers();
      this._setState("encoding");
      try {
        this._rec.stop();
        this._armWatchdog();
      } catch (e) {
        // Sem o onstop, _encode() nunca roda e o microfone ficaria aceso.
        this._releaseStream();
        this._setState("error", "Falha ao parar");
      }
    }, "_stop");

    Recorder.prototype._encode = safe(function () {
      var self = this;
      var blob = new Blob(this._chunks, { type: this._chunks.length ? this._chunks[0].type : "audio/webm" });
      this._chunks = [];
      this._releaseStream();

      if (!blob.size) { this._setState("error", "Gravação vazia"); return; }

      blob.arrayBuffer().then(function (ab) {
        var ctx = getAudioContext();
        if (!ctx) throw new Error("sem AudioContext");
        return ctx.decodeAudioData(ab);
      }).then(function (audioBuf) {
        // A taxa real é a do AudioBuffer — pedir 16kHz no construtor não garante
        // que o browser entregou 16kHz. Só isso é fonte de verdade.
        var samples = audioBuf.getChannelData(0);
        var rate = audioBuf.sampleRate;
        // Nunca faz upsample. Se a fonte vier abaixo de 16kHz (headset Bluetooth
        // em HFP), o header TEM que declarar a taxa real — senão a voz toca
        // acelerada e o backend converte o erro sem perceber.
        var outRate = Math.min(rate, CFG.targetSampleRate);
        samples = (outRate < rate) ? downsample(samples, rate, outRate) : samples.slice(0);

        if (samples.length / outRate < CFG.minDurationSec) {
          self._setState("error", "Áudio muito curto");
          return;
        }
        if (CFG.normalizeVolume) samples = normalize(samples, CFG.normalizeTargetPeak);

        var wav = encodeWav(samples, outRate);
        log("WAV", wav.size, "bytes /", (samples.length / outRate).toFixed(1) + "s @", outRate + "Hz");

        if (wav.size > CFG.maxBytes) {
          self._setState("error", "Áudio grande demais. Grave até 2min30.");
          return;
        }
        self._blob = wav;
        self._attach();
      }).catch(function (err) {
        warn("encode falhou:", err && err.message);
        self._setState("error", "Falha ao processar áudio");
      });
    }, "_encode");

    /** Injeta o WAV no input de arquivo nativo do GHL. */
    Recorder.prototype._attach = safe(function () {
      // Se o componente já saiu do DOM, o composer visível pode ser de OUTRA
      // conversa — anexar aqui mandaria o áudio para o lead errado.
      if (!this.isConnected) { this._blob = null; this._state = "idle"; return; }

      var input = findFileInput();
      if (!input) { this._setState("error", "Campo de anexo não encontrado"); return; }

      var dt = new DataTransfer();
      // Preserva o que o atendente já tinha anexado — a FileList é substituída
      // por inteiro, então sem isso um PDF anexado antes sumiria em silêncio.
      var previous = input.files ? Array.prototype.slice.call(input.files) : [];
      previous.forEach(function (f) { dt.items.add(f); });

      var name = "gravacao-" + Date.now() + ".wav";
      // type explícito: o `accept` do input está vazio, então o GHL valida o
      // formato por JS — provavelmente olhando file.type.
      dt.items.add(new File([this._blob], name, { type: "audio/wav" }));

      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));

      // NÃO validar por input.files.length aqui: o GHL consome o arquivo,
      // move para a lista interna de anexos e ZERA o input. Checar o tamanho
      // depois do dispatch dava falso negativo (validado em 2026-07-20).
      log("anexado:", name, this._blob.size, "bytes");

      this._setState("done");
      var self = this;
      this._doneTimer = setTimeout(safe(function () {
        if (self._state === "done") self._discard();
      }, "doneTimer"), 2500);
    }, "_attach");

    Recorder.prototype._discard = safe(function () {
      this._blob = null;
      this._setState("idle");
    }, "_discard");

    Recorder.prototype._clearTimers = function () {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      if (this._autostop) { clearTimeout(this._autostop); this._autostop = null; }
      if (this._doneTimer) { clearTimeout(this._doneTimer); this._doneTimer = null; }
      if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; }
    };

    Recorder.prototype._releaseStream = function () {
      try {
        if (this._stream) this._stream.getTracks().forEach(function (t) { t.stop(); });
      } catch (e) {}
      this._stream = null;
    };

    /** Remoção real do DOM: mata gravação em curso sem deixar nada pendurado. */
    Recorder.prototype._abort = function () {
      this._cancelled = true;
      this._clearTimers();
      try {
        if (this._rec && this._rec.state !== "inactive") {
          // Sem isso, o onstop dispararia _encode()/_attach() de um elemento
          // morto — e o áudio cairia na conversa que estiver aberta na hora.
          this._rec.onstop = null;
          this._rec.onerror = null;
          this._rec.stop();
        }
      } catch (e) {}
      this._rec = null;
      this._releaseStream();
      this._chunks = [];
      this._blob = null;
      this._state = "idle";
    };

    try {
      customElements.define(TAG, Recorder);
    } catch (e) {
      warn("customElements.define falhou:", e && e.message);
    }
  }

  // ==================================================================
  // INJEÇÃO + SOBREVIVÊNCIA AO RE-RENDER DO VUE
  // ==================================================================
  var observer = null;
  var enabled = false;

  function inject() {
    if (!enabled) return;
    var footer = qs(SEL.footer);
    if (!footer) return;
    if (footer.querySelector(TAG)) return;   // já está lá
    if (!findFileInput()) return;            // sem input não adianta injetar

    var el = document.createElement(TAG);
    el.setAttribute("data-t3a", "1");
    footer.appendChild(el);
    log("botão injetado");
  }

  function removeAll() {
    try {
      document.querySelectorAll(TAG).forEach(function (el) {
        try { if (el._abort) el._abort(); } catch (e) {}
        el.remove();
      });
    } catch (e) {}
  }

  function startObserver() {
    if (observer) return;
    var root = document.getElementById("app") || document.body;
    if (!root) return;
    var pending = false;
    observer = new MutationObserver(function () {
      // Debounce em microtask: o próprio append dispara o observer, e sem isso
      // vira recursão.
      if (pending) return;
      pending = true;
      Promise.resolve().then(function () {
        pending = false;
        safe(inject, "inject")();
      });
    });
    observer.observe(root, { childList: true, subtree: true });
    log("observer ativo");
  }

  function stopObserver() {
    if (!observer) return;
    try { observer.disconnect(); } catch (e) {}
    observer = null;
  }

  // ==================================================================
  // GUARDS: location allowlist → kill switch → boot
  // ==================================================================
  function locationAllowed() {
    var id = currentLocationId();
    if (!id) return false;                       // fora de uma sub-account
    if (!CFG.allowedLocations) return true;      // opt-out: todas
    return CFG.allowedLocations.indexOf(id) !== -1;
  }

  function checkKillSwitch() {
    // Cache-busting: o CDN do GitHub Pages guarda ~10min, e o kill switch
    // precisa valer imediatamente quando é acionado.
    var url = CFG.killSwitchUrl + "?t=" + Date.now();
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, CFG.killSwitchTimeoutMs);

    return fetch(url, { signal: ctrl.signal, cache: "no-store" })
      .then(function (r) { clearTimeout(to); return r.ok ? r.json() : null; })
      .then(function (cfg) {
        if (!cfg) return false;                                  // fail-closed
        if (cfg.enabled !== true) return false;
        var id = currentLocationId();
        if (Array.isArray(cfg.blocked) && cfg.blocked.indexOf(id) !== -1) return false;
        return true;
      })
      .catch(function (e) {
        clearTimeout(to);
        // Não gated por CFG.debug: se a CSP do GHL bloquear github.io, este é o
        // único rastro de por que a feature nunca liga.
        warn("kill switch inacessível (fail-closed):", e && e.message);
        return false;
      });
  }

  function applyState(on) {
    if (on === enabled) return;
    enabled = on;
    if (on) { defineComponent(); startObserver(); safe(inject, "inject")(); }
    else { stopObserver(); removeAll(); closeSharedCtx(); }
    log("estado:", on ? "ATIVO" : "desligado");
  }

  var boot = safe(function () {
    if (!locationAllowed()) { applyState(false); return; }      // barato primeiro
    return checkKillSwitch().then(applyState);
  }, "boot");

  // Navegação SPA: o GHL troca de rota sem recarregar a página.
  function watchRoutes() {
    var lastHref = location.href;
    var lastLoc = currentLocationId();
    setInterval(safe(function () {
      if (location.href === lastHref) return;
      lastHref = location.href;
      var loc = currentLocationId();
      var locChanged = loc !== lastLoc;
      lastLoc = loc;
      if (!locationAllowed()) { applyState(false); return; }
      if (enabled) { safe(inject, "inject")(); return; }
      // Só reconsulta o kill switch quando a SUB-ACCOUNT muda. Abrir cada
      // conversa muda a URL, mas não muda nada que o kill switch decida —
      // sem isso seriam centenas de requests por atendente por dia.
      if (locChanged) boot();
    }, "routeWatch"), 1000);

    try {
      if (window.AppUtils && window.AppUtils.StoreEvents &&
          typeof window.AppUtils.StoreEvents.on === "function") {
        window.AppUtils.StoreEvents.on("routeLoaded", safe(inject, "routeLoaded"));
      }
    } catch (e) { /* AppUtils é do GHL, pode mudar sem aviso */ }
  }

  // A aba do atendente fica dias aberta — sem re-checagem, o kill switch só
  // valeria no próximo reload.
  setInterval(safe(function () {
    if (!locationAllowed()) { applyState(false); return; }
    return checkKillSwitch().then(applyState);
  }, "recheck"), CFG.recheckMs);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { boot(); watchRoutes(); });
  } else {
    boot();
    watchRoutes();
  }

  window.__T3A_VOICE__.disable = function () { applyState(false); };
  window.__T3A_VOICE__.enable = function () { defineComponent(); applyState(true); };
  window.__T3A_VOICE__.debug = function () { CFG.debug = true; };
})();
