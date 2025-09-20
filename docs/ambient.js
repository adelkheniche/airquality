(function () {
  const MOBILE_BREAKPOINT = 640;
  const layerSelector = '.ambient-layer';
  const canvasId = 'ambient-canvas';

  const state = {
    canvas: null,
    ctx: null,
    width: 0,
    height: 0,
    particles: [],
    rafId: null,
    targetIntensity: 0.2,
    currentIntensity: 0.2,
    isMobile: false,
  };

  const rand = (min, max) => Math.random() * (max - min) + min;

  function ensureCanvas() {
    if (state.canvas) {
      return true;
    }

    const canvas = document.getElementById(canvasId);
    const layer = document.querySelector(layerSelector);
    if (!canvas || !layer) {
      return false;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return false;
    }

    state.canvas = canvas;
    state.ctx = ctx;

    if (typeof ResizeObserver === 'function') {
      const resizeObserver = new ResizeObserver(() => {
        resizeCanvas();
      });
      resizeObserver.observe(document.body);
    }

    window.addEventListener('resize', () => {
      resizeCanvas();
    });

    resizeCanvas();

    return true;
  }

  function resizeCanvas() {
    if (!state.canvas) return;
    const dpr = window.devicePixelRatio || 1;
    state.width = window.innerWidth;
    state.height = window.innerHeight;
    state.canvas.width = state.width * dpr;
    state.canvas.height = state.height * dpr;
    state.canvas.style.width = `${state.width}px`;
    state.canvas.style.height = `${state.height}px`;
    state.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.isMobile = state.width <= MOBILE_BREAKPOINT;
    spawnParticles();
  }

  function spawnParticles() {
    if (!state.ctx) return;

    const maxParticles = state.isMobile ? 24 : 60;
    const minParticles = state.isMobile ? 8 : 16;
    const desired = Math.round(
      minParticles + (maxParticles - minParticles) * clamp(state.currentIntensity, 0, 1)
    );

    state.particles.length = desired;
    for (let i = 0; i < desired; i += 1) {
      const existing = state.particles[i];
      const baseSpeed = state.isMobile ? 0.12 : 0.18;
      if (existing) {
        existing.radius = rand(0.8, state.isMobile ? 2 : 3);
        existing.speed = rand(baseSpeed * 0.5, baseSpeed * 1.6);
        continue;
      }
      state.particles[i] = {
        x: rand(0, state.width),
        y: rand(0, state.height),
        radius: rand(0.8, state.isMobile ? 2 : 3),
        speed: rand(baseSpeed * 0.5, baseSpeed * 1.6),
        drift: rand(-0.5, 0.5),
      };
    }
  }

  function clamp(v, min, max) {
    return Math.min(Math.max(v, min), max);
  }

  function step() {
    state.rafId = window.requestAnimationFrame(step);
    if (!state.ctx) return;

    const ctx = state.ctx;
    ctx.clearRect(0, 0, state.width, state.height);

    const easedIntensity = state.currentIntensity + (state.targetIntensity - state.currentIntensity) * 0.05;
    state.currentIntensity = easedIntensity;

    const opacityBase = clamp(0.08 + easedIntensity * 0.22, 0.08, 0.3);

    spawnParticles();

    ctx.save();
    ctx.fillStyle = `rgba(129, 30, 235, ${opacityBase})`;

    const speedScale = 0.4 + easedIntensity * 1.8;

    for (let i = 0; i < state.particles.length; i += 1) {
      const p = state.particles[i];
      if (!p) continue;
      p.y += p.speed * speedScale;
      p.x += p.drift * 0.2;

      if (p.y - p.radius > state.height) {
        p.y = -p.radius;
        p.x = rand(0, state.width);
      } else if (p.x < -p.radius) {
        p.x = state.width + p.radius;
      } else if (p.x > state.width + p.radius) {
        p.x = -p.radius;
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function init() {
    if (!ensureCanvas()) {
      return;
    }
    if (!state.rafId) {
      step();
    }
  }

  function setQuality({ pm25 = null, pctOver = null, severity = null } = {}) {
    let base = 0.2;
    const numericPm = Number(pm25);
    const numericPct = Number(pctOver);

    if (severity === 'risk') {
      base = 1;
    } else if (severity === 'warn') {
      base = 0.55;
    } else if (severity === 'good') {
      base = 0.25;
    } else {
      if (Number.isFinite(numericPm)) {
        if (numericPm >= 25) {
          base = 1;
        } else if (numericPm >= 15) {
          base = 0.75;
        } else if (numericPm >= 12) {
          base = 0.5;
        } else {
          base = 0.25;
        }
      }
    }

    if (Number.isFinite(numericPct)) {
      base = Math.max(base, clamp(numericPct / 25, 0.15, 1));
    }

    state.targetIntensity = clamp(base, 0.15, 1);
  }

  function pulse() {
    state.currentIntensity = clamp(state.currentIntensity + 0.15, 0.15, 1);
  }

  document.addEventListener('DOMContentLoaded', init, { once: true });

  window.AmbientParticles = {
    init,
    setQuality,
    pulse,
  };
})();
