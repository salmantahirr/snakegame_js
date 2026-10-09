(() => {
  "use strict";

  const STORAGE_KEYS = {
    highScore: "spaceStrikeHighScore",
    soundOn: "spaceStrikeSoundOn",
    controlMode: "spaceStrikeControlMode"
  };

  const STATES = {
    START: "start",
    PLAYING: "playing",
    PAUSED: "paused",
    GAME_OVER: "game_over"
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  const circleHit = (a, b) => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const r = a.radius + b.radius;
    return dx * dx + dy * dy <= r * r;
  };

  const storage = {
    get(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw === null ? fallback : raw;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, String(value));
      } catch {
        // localStorage may be blocked; game continues safely
      }
    }
  };

  class AudioManager {
    constructor(enabled = true) {
      this.enabled = enabled;
      this.ctx = null;
      this.gain = null;
      this.failed = false;
    }

    initialize() {
      if (this.ctx || this.failed || !this.enabled) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        this.failed = true;
        return;
      }
      try {
        this.ctx = new Ctx();
        this.gain = this.ctx.createGain();
        this.gain.gain.value = 0.08;
        this.gain.connect(this.ctx.destination);
      } catch {
        this.failed = true;
      }
    }

    setEnabled(enabled) {
      this.enabled = enabled;
      if (this.ctx && this.gain) {
        this.gain.gain.value = enabled ? 0.08 : 0;
      }
    }

    blip(type, freq, duration, gainValue = 0.25, slideTo = null) {
      if (!this.enabled || !this.ctx || !this.gain) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, now + duration);
      gain.gain.setValueAtTime(gainValue, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
      osc.connect(gain);
      gain.connect(this.gain);
      osc.start(now);
      osc.stop(now + duration);
    }

    laser() { this.blip("sawtooth", 640, 0.07, 0.08, 420); }
    hit() { this.blip("square", 240, 0.1, 0.09, 140); }
    explosion() { this.blip("triangle", 130, 0.18, 0.13, 70); }
    damage() { this.blip("square", 180, 0.18, 0.11, 90); }
    wave() { this.blip("sine", 380, 0.22, 0.1, 680); }
    gameOver() { this.blip("sawtooth", 220, 0.4, 0.1, 55); }
  }

  class InputHandler {
    constructor() {
      this.left = false;
      this.right = false;
      this.fire = false;
      this.pausePressed = false;
      this.startPressed = false;
      this.mutePressed = false;
      this.bound = false;
      this.pointerMap = new Map();
      this.mouseAimRatio = null;
      this.mouseFollowEnabled = true;
      this.canvasPointerId = null;
      this.mouseFirePointerId = null;
    }

    bind(game) {
      if (this.bound) return;
      this.bound = true;

      const setKey = (code, active) => {
        if (code === "ArrowLeft" || code === "KeyA") this.left = active;
        if (code === "ArrowRight" || code === "KeyD") this.right = active;
        if (code === "Space") this.fire = active;
      };

      window.addEventListener("keydown", (event) => {
        if (["Space", "ArrowLeft", "ArrowRight"].includes(event.code)) {
          event.preventDefault();
        }
        if ((event.code === "Space" || event.code === "Enter") && game.state === STATES.START) {
          this.startPressed = true;
        }
        if (event.code === "KeyP" || event.code === "Escape") {
          this.pausePressed = true;
        }
        if (event.code === "KeyM") {
          this.mutePressed = true;
        }
        setKey(event.code, true);
      });

      window.addEventListener("keyup", (event) => {
        setKey(event.code, false);
      });

      const attachHoldButton = (button, action) => {
        const release = (id) => {
          if (typeof id === "number") this.pointerMap.delete(id);
          if (![...this.pointerMap.values()].includes(action)) this[action] = false;
        };

        button.addEventListener("pointerdown", (event) => {
          if (game.state !== STATES.PLAYING) return;
          event.preventDefault();
          button.setPointerCapture?.(event.pointerId);
          this.pointerMap.set(event.pointerId, action);
          this[action] = true;
        });

        const onPointerEnd = (event) => {
          event.preventDefault();
          release(event.pointerId);
        };

        button.addEventListener("pointerup", onPointerEnd);
        button.addEventListener("pointercancel", onPointerEnd);
        button.addEventListener("lostpointercapture", onPointerEnd);
      };

      attachHoldButton(game.leftBtn, "left");
      attachHoldButton(game.rightBtn, "right");
      attachHoldButton(game.fireBtn, "fire");

      const updateMouseAim = (clientX) => {
        const rect = game.canvas.getBoundingClientRect();
        if (rect.width <= 0) return;
        this.mouseAimRatio = clamp((clientX - rect.left) / rect.width, 0, 1);
      };

      const onCanvasPointerMove = (event) => {
        if (game.state !== STATES.PLAYING) return;
        if (event.pointerType === "mouse") {
          updateMouseAim(event.clientX);
          return;
        }
        if (event.pointerId !== this.canvasPointerId) return;
        event.preventDefault();
        updateMouseAim(event.clientX);
      };

      const stopCanvasPointer = (event) => {
        if (event.pointerId !== this.canvasPointerId) return;
        this.canvasPointerId = null;
      };

      game.canvas.addEventListener("pointerdown", (event) => {
        if (game.state !== STATES.PLAYING) return;
        if (event.pointerType === "mouse") {
          if (event.button !== 0) return;
          event.preventDefault();
          this.mouseFirePointerId = event.pointerId;
          this.fire = true;
          updateMouseAim(event.clientX);
          return;
        }
        if (this.canvasPointerId !== null) return;
        event.preventDefault();
        game.canvas.setPointerCapture?.(event.pointerId);
        this.canvasPointerId = event.pointerId;
        updateMouseAim(event.clientX);
      });

      game.canvas.addEventListener("pointermove", onCanvasPointerMove);
      game.canvas.addEventListener("pointerup", stopCanvasPointer);
      game.canvas.addEventListener("pointercancel", stopCanvasPointer);
      game.canvas.addEventListener("lostpointercapture", stopCanvasPointer);

      const onMousePointerEnd = (event) => {
        if (event.pointerId !== this.mouseFirePointerId) return;
        this.mouseFirePointerId = null;
        this.fire = [...this.pointerMap.values()].includes("fire");
      };

      window.addEventListener("pointerup", onMousePointerEnd);
      window.addEventListener("pointercancel", onMousePointerEnd);
      window.addEventListener("blur", () => this.clearGameplayInputs());
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) this.clearGameplayInputs();
      });

      game.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    }

    clearGameplayInputs() {
      this.left = false;
      this.right = false;
      this.fire = false;
      this.pointerMap.clear();
      this.canvasPointerId = null;
      this.mouseFirePointerId = null;
    }

    getMouseTargetX(width, min, max) {
      if (!this.mouseFollowEnabled || this.mouseAimRatio === null) return null;
      const x = this.mouseAimRatio * width;
      return clamp(x, min, max);
    }

    consumePause() {
      const pressed = this.pausePressed;
      this.pausePressed = false;
      return pressed;
    }

    consumeStart() {
      const pressed = this.startPressed;
      this.startPressed = false;
      return pressed;
    }

    consumeMute() {
      const pressed = this.mutePressed;
      this.mutePressed = false;
      return pressed;
    }
  }

  class Player {
    constructor(game) {
      this.game = game;
      this.width = 44;
      this.height = 58;
      this.radius = 18;
      this.speed = 360;
      this.x = game.width / 2;
      this.y = game.height - 74;
      this.invulnerable = 0;
      this.hitFlash = 0;
      this.fireCooldown = 0;
      this.enginePulse = 0;
    }

    reset() {
      this.x = this.game.width / 2;
      this.y = this.game.height - 74;
      this.invulnerable = 0;
      this.hitFlash = 0;
      this.fireCooldown = 0;
      this.enginePulse = 0;
    }

    takeHit() {
      if (this.invulnerable > 0) return false;
      this.invulnerable = 1.15;
      this.hitFlash = 0.25;
      return true;
    }

    update(dt, input) {
      const minX = this.radius + 8;
      const maxX = this.game.width - this.radius - 8;
      const dir = (input.left ? -1 : 0) + (input.right ? 1 : 0);
      if (dir !== 0) {
        this.x += dir * this.speed * dt;
      } else {
        const mouseTargetX = input.getMouseTargetX(this.game.width, minX, maxX);
        if (mouseTargetX !== null) {
          const follow = clamp(dt * 16, 0, 1);
          this.x += (mouseTargetX - this.x) * follow;
        }
      }
      this.x = clamp(this.x, minX, maxX);

      if (this.fireCooldown > 0) this.fireCooldown -= dt;
      if (this.invulnerable > 0) this.invulnerable -= dt;
      if (this.hitFlash > 0) this.hitFlash -= dt;
      this.enginePulse += dt * 10;

      if (input.fire && this.fireCooldown <= 0) {
        this.fireCooldown = this.game.playerFireRate;
        this.game.spawnPlayerLaser(this.x, this.y - this.height / 2);
      }

      if (Math.random() < 0.45) {
        this.game.spawnParticle({
          x: this.x + (Math.random() - 0.5) * 8,
          y: this.y + this.height / 2 - 4,
          vx: (Math.random() - 0.5) * 25,
          vy: 70 + Math.random() * 70,
          life: 0.34,
          size: 2.4,
          color: "rgba(255,150,70,0.85)"
        });
      }
    }

    draw(ctx) {
      ctx.save();
      ctx.translate(this.x, this.y);

      if (this.invulnerable > 0 && Math.floor(this.invulnerable * 18) % 2 === 0) {
        ctx.globalAlpha = 0.42;
      }

      const glow = 12 + Math.sin(this.enginePulse) * 3;
      ctx.shadowBlur = glow;
      ctx.shadowColor = "rgba(60, 220, 255, 0.8)";

      ctx.fillStyle = this.hitFlash > 0 ? "#ffd0d9" : "#7de8ff";
      ctx.beginPath();
      ctx.moveTo(0, -28);
      ctx.lineTo(14, 20);
      ctx.lineTo(0, 10);
      ctx.lineTo(-14, 20);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = "#22466f";
      ctx.fillRect(-20, 8, 40, 11);

      ctx.fillStyle = "#c88aff";
      ctx.beginPath();
      ctx.ellipse(0, -4, 7, 10, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(255, 138, 79, 0.9)";
      ctx.beginPath();
      ctx.moveTo(-5, 20);
      ctx.lineTo(0, 35 + Math.sin(this.enginePulse * 1.8) * 2);
      ctx.lineTo(5, 20);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  class Enemy {
    constructor(game, type, x, y) {
      this.game = game;
      this.type = type;
      this.x = x;
      this.y = y;
      this.age = 0;
      this.hitFlash = 0;
      this.rotation = Math.random() * Math.PI * 2;
      this.alive = true;

      const data = {
        scout: { radius: 15, speed: 110, hp: 1, points: 10, color: "#7ff2ff", weave: 22 },
        heavy: { radius: 21, speed: 76, hp: 3, points: 25, color: "#9ea6ff", weave: 10 },
        meteor: { radius: 19, speed: 92, hp: 2, points: 15, color: "#9f8a75", weave: 0 },
        elite: { radius: 24, speed: 136, hp: 5, points: 50, color: "#ff8cff", weave: 26 }
      }[type];

      this.radius = data.radius;
      this.speed = data.speed + Math.random() * 18;
      this.maxHp = data.hp;
      this.hp = data.hp;
      this.points = data.points;
      this.color = data.color;
      this.weave = data.weave;
      this.weaveOffset = Math.random() * Math.PI * 2;
    }

    damage(amount) {
      this.hp -= amount;
      this.hitFlash = 0.09;
      if (this.hp <= 0) {
        this.alive = false;
      }
    }

    update(dt) {
      this.age += dt;
      this.y += this.speed * dt;
      if (this.weave > 0) {
        this.x += Math.sin(this.age * 2.4 + this.weaveOffset) * this.weave * dt;
      }
      if (this.type === "meteor") this.rotation += dt * 1.8;
      if (this.hitFlash > 0) this.hitFlash -= dt;
    }

    draw(ctx) {
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.rotate(this.type === "meteor" ? this.rotation : 0);

      if (this.type === "meteor") {
        ctx.fillStyle = this.hitFlash > 0 ? "#ddd" : "#8f7d67";
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const angle = (i / 8) * Math.PI * 2;
          const r = this.radius * (0.8 + Math.sin(i * 2.3) * 0.15);
          ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
        }
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.shadowBlur = this.type === "elite" ? 18 : 10;
        ctx.shadowColor = this.color;
        ctx.fillStyle = this.hitFlash > 0 ? "#fff" : this.color;
        ctx.beginPath();
        ctx.moveTo(0, -this.radius);
        ctx.lineTo(this.radius, this.radius * 0.8);
        ctx.lineTo(0, this.radius * 0.38);
        ctx.lineTo(-this.radius, this.radius * 0.8);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = "rgba(18,30,58,0.7)";
        ctx.beginPath();
        ctx.ellipse(0, -3, this.radius * 0.33, this.radius * 0.24, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      if (this.hp > 1) {
        ctx.fillStyle = "rgba(255,255,255,0.82)";
        ctx.fillRect(-this.radius, this.radius + 4, (this.hp / this.maxHp) * this.radius * 2, 3);
      }
      ctx.restore();
    }
  }

  class Projectile {
    constructor(x, y, vy, radius = 4) {
      this.x = x;
      this.y = y;
      this.vy = vy;
      this.radius = radius;
      this.alive = true;
    }

    update(dt) {
      this.y += this.vy * dt;
      if (this.y < -25) this.alive = false;
    }

    draw(ctx) {
      ctx.save();
      ctx.shadowBlur = 12;
      ctx.shadowColor = "#3df5ff";
      ctx.fillStyle = "#72f2ff";
      ctx.fillRect(this.x - 2, this.y - 12, 4, 14);
      ctx.restore();
    }
  }

  class Particle {
    constructor(config) {
      this.x = config.x;
      this.y = config.y;
      this.vx = config.vx;
      this.vy = config.vy;
      this.life = config.life;
      this.maxLife = config.life;
      this.size = config.size;
      this.color = config.color;
    }

    update(dt) {
      this.life -= dt;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.vx *= 0.99;
      this.vy *= 0.99;
    }

    draw(ctx) {
      if (this.life <= 0) return;
      ctx.save();
      const alpha = this.life / this.maxLife;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size * alpha, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  class Game {
    constructor() {
      this.canvas = document.getElementById("gameCanvas");
      this.ctx = this.canvas.getContext("2d");
      this.startOverlay = document.getElementById("startOverlay");
      this.pauseOverlay = document.getElementById("pauseOverlay");
      this.gameOverOverlay = document.getElementById("gameOverOverlay");
      this.waveNotice = document.getElementById("waveNotice");

      this.scoreEl = document.getElementById("scoreValue");
      this.highScoreEl = document.getElementById("highScoreValue");
      this.livesEl = document.getElementById("livesValue");
      this.waveEl = document.getElementById("waveValue");
      this.startHighScoreEl = document.getElementById("startHighScore");
      this.soundToggle = document.getElementById("soundToggle");
      this.devicePromptEl = document.getElementById("devicePrompt");
      this.mobileModeBtn = document.getElementById("mobileModeBtn");
      this.desktopModeBtn = document.getElementById("desktopModeBtn");
      this.mobileHowTo = document.getElementById("mobileHowTo");
      this.desktopHowTo = document.getElementById("desktopHowTo");

      this.finalScoreEl = document.getElementById("finalScore");
      this.finalHighScoreEl = document.getElementById("finalHighScore");
      this.finalWaveEl = document.getElementById("finalWave");
      this.finalKillsEl = document.getElementById("finalKills");
      this.newRecordEl = document.getElementById("newRecordText");

      this.playNowBtn = document.getElementById("playNowBtn");
      this.resumeBtn = document.getElementById("resumeBtn");
      this.pauseRestartBtn = document.getElementById("pauseRestartBtn");
      this.playAgainBtn = document.getElementById("playAgainBtn");
      this.menuBtn = document.getElementById("menuBtn");

      this.leftBtn = document.getElementById("leftBtn");
      this.rightBtn = document.getElementById("rightBtn");
      this.fireBtn = document.getElementById("fireBtn");

      this.state = STATES.START;
      this.width = 420;
      this.height = 740;
      this.dpr = 1;
      this.lastTime = 0;
      this.rafId = 0;

      this.player = null;
      this.playerFireRate = 0.18;
      this.projectiles = [];
      this.enemies = [];
      this.particles = [];
      this.stars = { near: [], mid: [], far: [] };
      this.previewEnemies = [];
      this.screenShake = 0;
      this.waveNoticeTimer = 0;

      this.score = 0;
      this.kills = 0;
      this.wave = 1;
      this.lives = 3;
      this.enemySpawnTimer = 0;
      this.enemySpawnInterval = 1.2;
      this.waveTimer = 0;
      this.nextWaveScore = 120;
      this.hudCache = {};
      this.highScore = Number(storage.get(STORAGE_KEYS.highScore, 0)) || 0;
      this.runStartHighScore = this.highScore;
      this.controlMode = null;
      this.isTouchDevice = window.matchMedia("(hover: none), (pointer: coarse)").matches;

      const savedSound = storage.get(STORAGE_KEYS.soundOn, "true");
      this.soundOn = savedSound !== "false";
      this.audio = new AudioManager(this.soundOn);
      this.input = new InputHandler();

      this.bindEvents();
      document.body.classList.toggle("touch-device", this.isTouchDevice);
      this.restoreControlMode();
      this.resize();
      this.initStars();
      this.player = new Player(this);
      this.previewEnemies = this.buildPreviewEnemies();
      this.updateHud(true);

      this.loop = this.loop.bind(this);
      this.rafId = requestAnimationFrame(this.loop);
    }

    bindEvents() {
      this.input.bind(this);

      this.playNowBtn.addEventListener("click", () => {
        if (!this.controlMode) {
          this.setControlMode(this.getRecommendedControlMode(), { persist: false });
          this.devicePromptEl.textContent = "Using recommended controls. You can switch any time.";
        }
        this.audio.initialize();
        this.startGame();
      });

      this.mobileModeBtn.addEventListener("click", () => this.setControlMode("mobile"));
      this.desktopModeBtn.addEventListener("click", () => this.setControlMode("desktop"));

      this.resumeBtn.addEventListener("click", () => this.togglePause(false));
      this.pauseRestartBtn.addEventListener("click", () => this.startGame());
      this.playAgainBtn.addEventListener("click", () => this.startGame());
      this.menuBtn.addEventListener("click", () => this.backToMenu());

      this.soundToggle.addEventListener("click", () => {
        this.soundOn = !this.soundOn;
        storage.set(STORAGE_KEYS.soundOn, this.soundOn);
        this.audio.initialize();
        this.audio.setEnabled(this.soundOn);
        this.syncSoundButton();
      });

      window.addEventListener("resize", () => this.resize());
    }

    getRecommendedControlMode() {
      return this.isTouchDevice ? "mobile" : "desktop";
    }

    restoreControlMode() {
      const savedMode = storage.get(STORAGE_KEYS.controlMode, "");
      if (savedMode === "mobile" || savedMode === "desktop") {
        this.setControlMode(savedMode, { persist: false });
      } else {
        this.setControlMode(null, { persist: false });
      }
    }

    setControlMode(mode, options = {}) {
      const { persist = true } = options;
      this.controlMode = mode === "mobile" || mode === "desktop" ? mode : null;
      const mobileSelected = this.controlMode === "mobile";
      const desktopSelected = this.controlMode === "desktop";

      this.mobileModeBtn.classList.toggle("active", mobileSelected);
      this.desktopModeBtn.classList.toggle("active", desktopSelected);
      this.mobileHowTo.classList.toggle("active", mobileSelected);
      this.desktopHowTo.classList.toggle("active", desktopSelected);
      this.mobileHowTo.setAttribute("aria-hidden", mobileSelected ? "false" : "true");
      this.desktopHowTo.setAttribute("aria-hidden", desktopSelected ? "false" : "true");

      this.mobileModeBtn.setAttribute("aria-pressed", mobileSelected ? "true" : "false");
      this.desktopModeBtn.setAttribute("aria-pressed", desktopSelected ? "true" : "false");

      if (this.controlMode) {
        this.devicePromptEl.textContent = "";
        if (persist) storage.set(STORAGE_KEYS.controlMode, this.controlMode);
      } else {
        this.devicePromptEl.textContent = "Choose MOBILE or DESKTOP controls before you launch.";
      }
    }

    syncSoundButton() {
      this.soundToggle.textContent = this.soundOn ? "🔊 Sound" : "🔇 Sound";
      this.soundToggle.setAttribute("aria-label", this.soundOn ? "Disable sound" : "Enable sound");
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      this.width = Math.max(320, Math.floor(rect.width));
      this.height = Math.max(440, Math.floor(rect.height));
      this.dpr = clamp(window.devicePixelRatio || 1, 1, 2);
      this.canvas.width = Math.floor(this.width * this.dpr);
      this.canvas.height = Math.floor(this.height * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      if (this.player) {
        this.player.y = this.height - 74;
        this.player.x = clamp(this.player.x, this.player.radius + 8, this.width - this.player.radius - 8);
      }
      this.initStars();
      this.previewEnemies = this.buildPreviewEnemies();
    }

    initStars() {
      const createLayer = (count, minSpeed, maxSpeed, minSize, maxSize) => {
        const arr = [];
        for (let i = 0; i < count; i++) {
          arr.push({
            x: Math.random() * this.width,
            y: Math.random() * this.height,
            speed: minSpeed + Math.random() * (maxSpeed - minSpeed),
            size: minSize + Math.random() * (maxSize - minSize),
            alpha: 0.25 + Math.random() * 0.65
          });
        }
        return arr;
      };
      this.stars.far = createLayer(80, 5, 16, 1, 1.8);
      this.stars.mid = createLayer(44, 14, 38, 1.3, 2.1);
      this.stars.near = createLayer(24, 25, 58, 1.6, 3.2);
    }

    buildPreviewEnemies() {
      return new Array(5).fill(null).map((_, index) => ({
        x: this.width * (0.18 + index * 0.17),
        y: 130 + (index % 2) * 42,
        drift: Math.random() * Math.PI * 2
      }));
    }

    startGame() {
      this.state = STATES.PLAYING;
      this.input.clearGameplayInputs();
      this.runStartHighScore = this.highScore;
      this.score = 0;
      this.kills = 0;
      this.wave = 1;
      this.lives = 3;
      this.enemySpawnTimer = 0;
      this.enemySpawnInterval = 1.18;
      this.waveTimer = 0;
      this.nextWaveScore = 120;
      this.waveNoticeTimer = 0;
      this.screenShake = 0;
      this.projectiles.length = 0;
      this.enemies.length = 0;
      this.particles.length = 0;
      this.player.reset();
      this.showWaveText("WAVE 1");
      this.audio.wave();
      this.showOnlyOverlay(null);
      document.body.classList.add("playing");
      this.updateHud(true);
    }

    backToMenu() {
      this.state = STATES.START;
      this.input.clearGameplayInputs();
      this.projectiles.length = 0;
      this.enemies.length = 0;
      this.particles.length = 0;
      this.waveNoticeTimer = 0;
      this.showOnlyOverlay(this.startOverlay);
      document.body.classList.remove("playing");
      this.startHighScoreEl.textContent = String(this.highScore);
      if (!this.controlMode) {
        this.setControlMode(this.getRecommendedControlMode(), { persist: false });
      }
    }

    togglePause(forceResume = false) {
      if (this.state === STATES.GAME_OVER || this.state === STATES.START) return;
      if (forceResume) {
        this.state = STATES.PLAYING;
        this.input.clearGameplayInputs();
        this.showOnlyOverlay(null);
        return;
      }
      if (this.state === STATES.PLAYING) {
        this.state = STATES.PAUSED;
        this.input.clearGameplayInputs();
        this.showOnlyOverlay(this.pauseOverlay);
      } else if (this.state === STATES.PAUSED) {
        this.state = STATES.PLAYING;
        this.input.clearGameplayInputs();
        this.showOnlyOverlay(null);
      }
    }

    showOnlyOverlay(overlay) {
      [this.startOverlay, this.pauseOverlay, this.gameOverOverlay].forEach((item) => {
        const visible = item === overlay;
        item.classList.toggle("visible", visible);
        item.setAttribute("aria-hidden", visible ? "false" : "true");
      });
    }

    showWaveText(message) {
      this.waveNotice.textContent = message;
      this.waveNotice.classList.add("show");
      this.waveNoticeTimer = 1.2;
    }

    spawnParticle(config) {
      this.particles.push(new Particle(config));
    }

    spawnExplosion(x, y, color, intensity = 10) {
      for (let i = 0; i < intensity; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 45 + Math.random() * 140;
        this.spawnParticle({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 0.34 + Math.random() * 0.32,
          size: 2 + Math.random() * 3,
          color
        });
      }
    }

    spawnPlayerLaser(x, y) {
      this.projectiles.push(new Projectile(x, y, -470));
      this.audio.laser();
      this.spawnParticle({
        x,
        y: y + 16,
        vx: (Math.random() - 0.5) * 24,
        vy: 46,
        life: 0.16,
        size: 2.2,
        color: "rgba(140,250,255,0.8)"
      });
    }

    randomEnemyType() {
      const pool = ["scout", "scout", "heavy", "meteor"];
      if (this.wave >= 3) pool.push("meteor");
      if (this.wave >= 4) pool.push("elite");
      if (this.wave >= 6) pool.push("heavy", "elite");
      return pool[Math.floor(Math.random() * pool.length)];
    }

    spawnEnemy() {
      const type = this.randomEnemyType();
      const x = 25 + Math.random() * (this.width - 50);
      const y = -40 - Math.random() * 70;
      this.enemies.push(new Enemy(this, type, x, y));
    }

    loseLife() {
      if (!this.player.takeHit()) return;
      this.lives -= 1;
      this.audio.damage();
      this.screenShake = Math.max(this.screenShake, 8);
      this.spawnExplosion(this.player.x, this.player.y, "rgba(255,120,150,0.8)", 12);

      if (this.lives <= 0) {
        this.gameOver();
      }
      this.updateHud();
    }

    gameOver() {
      this.state = STATES.GAME_OVER;
      this.input.clearGameplayInputs();
      this.audio.gameOver();

      this.finalScoreEl.textContent = String(this.score);
      this.finalHighScoreEl.textContent = String(this.highScore);
      this.finalWaveEl.textContent = String(this.wave);
      this.finalKillsEl.textContent = String(this.kills);
      this.newRecordEl.textContent = this.score > this.runStartHighScore ? "✨ NEW HIGH SCORE!" : "";

      this.showOnlyOverlay(this.gameOverOverlay);
      document.body.classList.remove("playing");
    }

    updateWave(dt) {
      this.waveTimer += dt;
      const scoreTrigger = this.score >= this.nextWaveScore;
      const timeTrigger = this.waveTimer >= 22;
      if (!scoreTrigger && !timeTrigger) return;

      this.wave += 1;
      this.waveTimer = 0;
      this.nextWaveScore += 120 + this.wave * 28;
      this.enemySpawnInterval = Math.max(0.34, this.enemySpawnInterval - 0.08);
      this.showWaveText(`WAVE ${this.wave}`);
      this.audio.wave();
      this.updateHud();
    }

    checkCollisions() {
      for (let i = this.projectiles.length - 1; i >= 0; i--) {
        const p = this.projectiles[i];
        if (!p.alive) continue;

        for (let j = this.enemies.length - 1; j >= 0; j--) {
          const enemy = this.enemies[j];
          if (!enemy.alive) continue;
          if (!circleHit(p, enemy)) continue;

          p.alive = false;
          enemy.damage(1);
          this.spawnExplosion(p.x, p.y, "rgba(125,245,255,0.75)", 4);
          this.audio.hit();

          if (!enemy.alive) {
            this.score += enemy.points;
            this.kills += 1;
            this.highScore = Math.max(this.highScore, this.score);
            storage.set(STORAGE_KEYS.highScore, this.highScore);
            this.spawnExplosion(enemy.x, enemy.y, enemy.type === "elite" ? "rgba(255,120,255,0.8)" : "rgba(255,190,110,0.8)", enemy.type === "elite" ? 24 : 14);
            if (enemy.type === "elite") this.screenShake = Math.max(this.screenShake, 10);
            this.audio.explosion();
          }

          break;
        }
      }

      for (let i = this.enemies.length - 1; i >= 0; i--) {
        const enemy = this.enemies[i];
        if (!enemy.alive) continue;
        if (enemy.y - enemy.radius > this.height + 8) {
          enemy.alive = false;
          this.loseLife();
          continue;
        }

        if (this.player.invulnerable > 0) continue;
        if (circleHit(enemy, this.player)) {
          enemy.alive = false;
          this.spawnExplosion(enemy.x, enemy.y, "rgba(255,170,120,0.8)", 9);
          this.loseLife();
        }
      }

      this.projectiles = this.projectiles.filter((item) => item.alive);
      this.enemies = this.enemies.filter((item) => item.alive);
    }

    updatePlaying(dt) {
      this.player.update(dt, this.input);

      this.enemySpawnTimer += dt;
      if (this.enemySpawnTimer >= this.enemySpawnInterval) {
        this.enemySpawnTimer -= this.enemySpawnInterval;
        this.spawnEnemy();
      }

      this.projectiles.forEach((p) => p.update(dt));
      this.enemies.forEach((enemy) => enemy.update(dt));
      this.particles.forEach((particle) => particle.update(dt));
      this.particles = this.particles.filter((p) => p.life > 0);

      this.checkCollisions();
      this.updateWave(dt);

      if (this.waveNoticeTimer > 0) {
        this.waveNoticeTimer -= dt;
        if (this.waveNoticeTimer <= 0) this.waveNotice.classList.remove("show");
      }

      this.screenShake = Math.max(0, this.screenShake - dt * 18);
      this.updateHud();
    }

    updateHud(force = false) {
      const livesDisplay = String(Math.max(0, this.lives));
      const next = {
        score: String(this.score),
        high: String(this.highScore),
        lives: livesDisplay,
        wave: String(this.wave)
      };

      if (force || this.hudCache.score !== next.score) this.scoreEl.textContent = next.score;
      if (force || this.hudCache.high !== next.high) {
        this.highScoreEl.textContent = next.high;
        this.startHighScoreEl.textContent = next.high;
      }
      if (force || this.hudCache.lives !== next.lives) this.livesEl.textContent = next.lives;
      if (force || this.hudCache.wave !== next.wave) this.waveEl.textContent = next.wave;

      this.hudCache = next;
      this.syncSoundButton();
    }

    updateStars(dt) {
      const speedScale = this.state === STATES.PLAYING ? 1 : 0.4;
      const moveLayer = (layer) => {
        for (const star of layer) {
          star.y += star.speed * dt * speedScale;
          if (star.y > this.height + 4) {
            star.y = -2;
            star.x = Math.random() * this.width;
          }
        }
      };
      moveLayer(this.stars.far);
      moveLayer(this.stars.mid);
      moveLayer(this.stars.near);
    }

    drawBackground() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.width, this.height);

      const g = ctx.createLinearGradient(0, 0, 0, this.height);
      g.addColorStop(0, "#050b1f");
      g.addColorStop(1, "#02040d");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.width, this.height);

      const drawLayer = (layer, color) => {
        ctx.fillStyle = color;
        for (const star of layer) {
          ctx.globalAlpha = star.alpha;
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
          ctx.fill();
        }
      };

      drawLayer(this.stars.far, "#c8dcff");
      drawLayer(this.stars.mid, "#9ac4ff");
      drawLayer(this.stars.near, "#d7f8ff");
      ctx.globalAlpha = 1;
    }

    drawStartScene(dt) {
      const ctx = this.ctx;
      const centerY = this.height * 0.73;

      this.player.x = this.width / 2;
      this.player.y = centerY;
      this.player.enginePulse += dt * 3.4;
      this.player.draw(ctx);

      ctx.save();
      for (let i = 0; i < this.previewEnemies.length; i++) {
        const p = this.previewEnemies[i];
        p.drift += dt * (0.9 + i * 0.1);
        const x = p.x + Math.sin(p.drift) * 16;
        const y = p.y + Math.cos(p.drift * 1.4) * 7;
        const type = i % 4 === 3 ? "elite" : i % 3 === 2 ? "meteor" : "scout";
        const enemy = new Enemy(this, type, x, y);
        enemy.draw(ctx);
      }
      ctx.restore();
    }

    drawPlaying() {
      const ctx = this.ctx;

      if (this.screenShake > 0) {
        const intensity = this.screenShake;
        ctx.save();
        ctx.translate((Math.random() - 0.5) * intensity, (Math.random() - 0.5) * intensity);
      }

      this.player.draw(ctx);
      this.projectiles.forEach((p) => p.draw(ctx));
      this.enemies.forEach((enemy) => enemy.draw(ctx));
      this.particles.forEach((particle) => particle.draw(ctx));

      if (this.player.hitFlash > 0) {
        ctx.fillStyle = "rgba(255,70,90,0.18)";
        ctx.fillRect(0, 0, this.width, this.height);
      }

      if (this.screenShake > 0) {
        ctx.restore();
      }
    }

    loop(timestamp) {
      if (!this.lastTime) this.lastTime = timestamp;
      const dt = Math.min(0.05, (timestamp - this.lastTime) / 1000);
      this.lastTime = timestamp;

      if (this.input.consumeMute()) {
        this.soundOn = !this.soundOn;
        storage.set(STORAGE_KEYS.soundOn, this.soundOn);
        this.audio.initialize();
        this.audio.setEnabled(this.soundOn);
      }

      if (this.input.consumeStart() && this.state === STATES.START) {
        if (!this.controlMode) {
          this.setControlMode(this.getRecommendedControlMode(), { persist: false });
          this.devicePromptEl.textContent = "Using recommended controls. You can switch any time.";
        }
        this.audio.initialize();
        this.startGame();
      }

      if (this.input.consumePause()) {
        this.togglePause();
      }

      this.updateStars(dt);
      this.drawBackground();

      if (this.state === STATES.START) {
        this.drawStartScene(dt);
      } else {
        this.drawPlaying();
      }

      if (this.state === STATES.PLAYING) {
        this.updatePlaying(dt);
      }

      this.rafId = requestAnimationFrame(this.loop);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const game = new Game();
    game.syncSoundButton();
  });
})();
