// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Infinite Becoming — synthetic, uncalibrated eco-evolutionary model.
 * Gray–Scott U and V are dimensionless state variables, not literal
 * ecological nutrient or biomass measurements.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SyntheticEcoModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MODEL_VERSION = 4;
  const TRAITS = Object.freeze(['efficiency', 'sense', 'motility', 'armor', 'longevity', 'aggression']);
  const MEMORY_REGIONS = 64;
  const CULTURE_CHANNELS = 8;
  const AGENT_FIELDS = new Set(['id', 'lineage', 'x', 'y', 'diet', 'traits', 'age', 'stage', 'energy', 'damage', 'compartment', 'infectionTime', 'immunity', 'reproductions', 'cooldown', 'lastMoveDistance', 'dead', 'memory', 'culture']);
  const CHECKPOINT_STORAGE_LIMIT = 4 * 1024 * 1024;
  const INITIAL_V_BACKGROUND = 0.05;
  const SEASONAL_FORCING_AMPLITUDE = 0.0001;
  const DEFAULTS = Object.freeze({
    size: 96,
    seed: 20261015,
    F: 0.0545,
    K: 0.062,
    DU: 0.16,
    DV: 0.08,
    DT: 0.8,
    seasonalForcing: true,
    initialHerbivores: 20,
    initialCarnivores: 4,
    maxPopulation: 100,
    telemetryInterval: 10,
    maxHistory: 5000,
    grazingRate: 0.01,
    vReseedRate: 0,
    beta: 0.16,
    recoveryProbability: 0.018,
    diseaseMortalityProbability: 0.004,
    initialInfectionCount: 0
  });
  const DIFFUSION_LIMITS = Object.freeze({
    DU_MIN: 0.02, DU_MAX: 0.30, DV_MIN: 0.01, DV_MAX: 0.25,
    DT_MIN: 0.001, DT_MAX: 0.8, SAFETY_FACTOR: 0.8
  });
  const REACTION_LIMITS = Object.freeze({ F_MIN: 0.005, F_MAX: 0.09, K_MIN: 0.03, K_MAX: 0.08 });

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const mean = values => values.length ? values.reduce((sum, x) => sum + x, 0) / values.length : 0;
  const variance = values => {
    if (values.length < 2) return 0;
    const m = mean(values);
    return mean(values.map(x => (x - m) ** 2));
  };
  const finite = Number.isFinite;

  class Mulberry32 {
    constructor(seed = DEFAULTS.seed) {
      this.state = Number(seed) >>> 0;
    }
    next() {
      let t = this.state = (this.state + 0x6D2B79F5) >>> 0;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    gaussian() {
      let u = 0, v = 0;
      while (u === 0) u = this.next();
      while (v === 0) v = this.next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
    snapshot() { return this.state >>> 0; }
    restore(state) {
      if (!Number.isInteger(state) || state < 0 || state > 0xffffffff) {
        throw new TypeError('PRNG state must be an unsigned 32-bit integer.');
      }
      this.state = state >>> 0;
    }
  }

  function signedWrappedDelta(from, to, size) {
    const forward = ((to - from) % size + size) % size;
    const backward = forward - size;
    return Math.abs(forward) <= Math.abs(backward) ? forward : backward;
  }

  function toroidalManhattanDistance(a, b, size) {
    return Math.abs(signedWrappedDelta(a.x, b.x, size)) +
      Math.abs(signedWrappedDelta(a.y, b.y, size));
  }

  function moveToward(fromX, fromY, toX, toY, size, maxSteps) {
    let x = fromX, y = fromY;
    let dx = signedWrappedDelta(x, toX, size);
    let dy = signedWrappedDelta(y, toY, size);
    let remaining = Math.max(0, Math.floor(maxSteps));
    while (remaining > 0 && (dx !== 0 || dy !== 0)) {
      if (dx !== 0 && (dy === 0 || Math.abs(dx) >= Math.abs(dy))) {
        x = (x + Math.sign(dx) + size) % size;
      } else {
        y = (y + Math.sign(dy) + size) % size;
      }
      remaining--;
      dx = signedWrappedDelta(x, toX, size);
      dy = signedWrappedDelta(y, toY, size);
    }
    return { x, y };
  }

  function movementSteps(motility) {
    const bounded = clamp(Number(motility), 0.15, 2.5);
    return Math.min(3, 1 + Math.floor(bounded));
  }

  function predationProbability(aggression, armor) {
    const raw = 0.42 * Number(aggression) / (Number(armor) + 0.22);
    return clamp(finite(raw) ? raw : 0, 0, 1);
  }

  function transmissionProbability(beta, armor) {
    const raw = Number(beta) / (Number(armor) + 0.45);
    return clamp(finite(raw) ? raw : 0, 0, 1);
  }

  // Diffusion-only forward-Euler ceiling for a unit-grid, 2-D five-point
  // Laplacian. The safety factor is a guard, not a proof of full Gray–Scott
  // stability: reaction terms, clamping, and nonlinear dynamics still matter.
  function diffusionOnlyTimeStepLimit(DU, DV) {
    const largestDiffusion = Math.max(Number(DU), Number(DV));
    if (!finite(largestDiffusion) || largestDiffusion < 0) throw new TypeError('Diffusion rates must be finite and non-negative.');
    return largestDiffusion === 0 ? Infinity : 1 / (4 * largestDiffusion);
  }

  function guardDiffusionSettings({ DU, DV, DT }) {
    if (![DU, DV, DT].every(value => finite(Number(value)))) throw new TypeError('Diffusion settings must be finite numbers.');
    const u = clamp(Number(DU), DIFFUSION_LIMITS.DU_MIN, DIFFUSION_LIMITS.DU_MAX);
    const v = clamp(Number(DV), DIFFUSION_LIMITS.DV_MIN, DIFFUSION_LIMITS.DV_MAX);
    const diffusionLimit = diffusionOnlyTimeStepLimit(u, v);
    const guardedCeiling = Math.min(DIFFUSION_LIMITS.DT_MAX, DIFFUSION_LIMITS.SAFETY_FACTOR * diffusionLimit);
    return {
      DU: u,
      DV: v,
      DT: clamp(Number(DT), DIFFUSION_LIMITS.DT_MIN, guardedCeiling),
      diffusionOnlyLimit: diffusionLimit,
      guardedCeiling
    };
  }

  // Age-related wear accrues once per tick; reproduction wear is charged
  // once at the birth event rather than repeatedly from the cumulative count.
  const REPRODUCTIVE_WEAR_PER_BIRTH_EVENT = 0.00045;
  function damageIncrement(longevity) {
    const raw = 0.0032 * (2 - Number(longevity));
    return Math.max(0, finite(raw) ? raw : 0);
  }

  function advanceDamage(current, longevity) {
    const raw = Number(current) + damageIncrement(longevity);
    return clamp(finite(raw) ? raw : 0, 0, 1);
  }

  function applyReproductiveDamage(current) {
    const raw = Number(current) + REPRODUCTIVE_WEAR_PER_BIRTH_EVENT;
    return clamp(finite(raw) ? raw : 0, 0, 1);
  }

  function cellIndex(x, y, size) {
    const wrappedX = ((x % size) + size) % size;
    const wrappedY = ((y % size) + size) % size;
    return wrappedY * size + wrappedX;
  }

  function makeFixedPermutation(size, seed = DEFAULTS.seed) {
    if (!Number.isInteger(size) || size < 1) throw new TypeError('Permutation size must be a positive integer.');
    const permutation = Array.from({ length: size }, (_, i) => i);
    const rng = new Mulberry32(seed);
    for (let i = permutation.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [permutation[i], permutation[j]] = [permutation[j], permutation[i]];
    }
    return permutation;
  }

  function permuteSpatialFrame(frame, permutation) {
    if (!frame || typeof frame.length !== 'number' || frame.length !== permutation.length) {
      throw new TypeError('Frame length must match the spatial permutation.');
    }
    const out = new Float32Array(frame.length);
    for (let destination = 0; destination < permutation.length; destination++) {
      const source = permutation[destination];
      if (!Number.isInteger(source) || source < 0 || source >= permutation.length) {
        throw new TypeError('Permutation contains an invalid source index.');
      }
      out[destination] = frame[source];
    }
    return out;
  }

  // Uses exactly one spatial mapping for every frame. This preserves every
  // source cell's temporal sequence while changing where that sequence occurs.
  function createFixedPermutationConditions(frames, permutation) {
    if (!Array.isArray(frames) || frames.length === 0) throw new TypeError('Provide at least one pre-generated frame.');
    const size = frames[0]?.length;
    if (!Number.isInteger(size) || size < 1) throw new TypeError('Frames must be non-empty numeric arrays.');
    if (!Array.isArray(permutation) || permutation.length !== size) throw new TypeError('Permutation size does not match frames.');
    const sorted = [...permutation].sort((a, b) => a - b);
    if (sorted.some((x, i) => x !== i)) throw new TypeError('Permutation must contain each spatial index exactly once.');
    const controlFrames = frames.map(frame => {
      if (!frame || typeof frame.length !== 'number' || frame.length !== size || typeof frame[Symbol.iterator] !== 'function') {
        throw new TypeError('All frames must have the same spatial size and be iterable.');
      }
      if (Array.from(frame).some(value => !finite(value) || value < 0 || value > 1)) {
        throw new TypeError('Frame values must be finite and in [0, 1].');
      }
      return Float32Array.from(frame);
    });
    const permutedFrames = controlFrames.map(frame => permuteSpatialFrame(frame, permutation));
    return { controlFrames, permutedFrames, permutation: [...permutation] };
  }

  function validateOptions(options) {
    const unknownFields = Object.keys(options ?? {}).filter(key => !Object.hasOwn(DEFAULTS, key));
    if (unknownFields.length) throw new TypeError(`Unknown configuration field(s): ${unknownFields.join(', ')}.`);
    const config = { ...DEFAULTS, ...options };
    const integerMinimum = { size: 8, initialHerbivores: 0, initialCarnivores: 0, maxPopulation: 0, telemetryInterval: 1, maxHistory: 0, initialInfectionCount: 0 };
    for (const [key, minimum] of Object.entries(integerMinimum)) {
      if (!Number.isInteger(config[key]) || config[key] < minimum) throw new TypeError(`${key} must be an integer >= ${minimum}.`);
    }
    if (config.size > 256 || config.maxPopulation > 2000 || config.maxHistory > 10000) {
      throw new RangeError('Grid, population, or history exceeds the supported resource limit.');
    }
    if (config.initialHerbivores + config.initialCarnivores > config.maxPopulation) {
      throw new RangeError('Initial population cannot exceed maxPopulation.');
    }
    if (typeof config.seasonalForcing !== 'boolean') throw new TypeError('seasonalForcing must be a boolean.');
    for (const key of ['F', 'K', 'DU', 'DV', 'DT', 'beta', 'recoveryProbability', 'diseaseMortalityProbability', 'grazingRate', 'vReseedRate']) {
      if (!finite(config[key]) || config[key] < 0) throw new TypeError(`${key} must be a finite non-negative number.`);
    }
    if (config.grazingRate > 0.22) throw new RangeError('grazingRate must be in [0, 0.22].');
    if (config.vReseedRate > 0.02) throw new RangeError('vReseedRate must be in [0, 0.02].');
    for (const key of ['beta', 'recoveryProbability', 'diseaseMortalityProbability']) {
      if (config[key] > 1) throw new RangeError(`${key} must be a probability in [0, 1].`);
    }
    if (!Number.isInteger(config.seed) || config.seed < 0 || config.seed > 0xffffffff) {
      throw new TypeError('seed must be an unsigned 32-bit integer.');
    }
    return config;
  }

  class Simulation {
    constructor(options = {}) {
      this.config = validateOptions(options);
      this.parameters = {
        F: this.config.F, K: this.config.K, DU: this.config.DU, DV: this.config.DV,
        DT: this.config.DT, beta: this.config.beta,
        recoveryProbability: this.config.recoveryProbability,
        diseaseMortalityProbability: this.config.diseaseMortalityProbability
      };
      this.requestedDT = clamp(Number(this.parameters.DT), DIFFUSION_LIMITS.DT_MIN, DIFFUSION_LIMITS.DT_MAX);
      this.setReactionParameters({ F: this.parameters.F, K: this.parameters.K });
      const diffusion = this.setDiffusionParameters({ DU: this.parameters.DU, DV: this.parameters.DV, DT: this.parameters.DT });
      Object.assign(this.config, { DU: diffusion.DU, DV: diffusion.DV, DT: diffusion.DT, F: this.parameters.F, K: this.parameters.K });
      this.size = this.config.size;
      this.area = this.size * this.size;
      this.seed = this.config.seed;
      this.rng = new Mulberry32(this.seed);
      this.reset();
    }

    setDiffusionParameters(values = {}) {
      let nextRequestedDT = this.requestedDT;
      if (values.DT !== undefined) {
        if (!finite(Number(values.DT))) throw new TypeError('Requested time step must be finite.');
        nextRequestedDT = clamp(Number(values.DT), DIFFUSION_LIMITS.DT_MIN, DIFFUSION_LIMITS.DT_MAX);
      }
      const guarded = guardDiffusionSettings({
        DU: values.DU ?? this.parameters.DU,
        DV: values.DV ?? this.parameters.DV,
        DT: nextRequestedDT ?? values.DT ?? this.parameters.DT
      });
      this.requestedDT = nextRequestedDT;
      Object.assign(this.parameters, { DU: guarded.DU, DV: guarded.DV, DT: guarded.DT });
      if (this.config) Object.assign(this.config, { DU: guarded.DU, DV: guarded.DV, DT: guarded.DT });
      return this.diffusionDiagnostics();
    }

    setReactionParameters(values = {}) {
      const F = Number(values.F ?? this.parameters.F);
      const K = Number(values.K ?? this.parameters.K);
      if (!finite(F) || !finite(K)) throw new TypeError('F and K must be finite numbers.');
      this.parameters.F = clamp(F, REACTION_LIMITS.F_MIN, REACTION_LIMITS.F_MAX);
      this.parameters.K = clamp(K, REACTION_LIMITS.K_MIN, REACTION_LIMITS.K_MAX);
      if (this.config) Object.assign(this.config, { F: this.parameters.F, K: this.parameters.K });
      return { F: this.parameters.F, K: this.parameters.K };
    }

    diffusionDiagnostics() {
      const diffusionOnlyLimit = diffusionOnlyTimeStepLimit(this.parameters.DU, this.parameters.DV);
      const guardedCeiling = Math.min(DIFFUSION_LIMITS.DT_MAX, DIFFUSION_LIMITS.SAFETY_FACTOR * diffusionOnlyLimit);
      return {
        DU: this.parameters.DU,
        DV: this.parameters.DV,
        ratio: this.parameters.DV === 0 ? Infinity : this.parameters.DU / this.parameters.DV,
        DT: this.parameters.DT,
        requestedDT: this.requestedDT,
        diffusionOnlyLimit,
        guardedCeiling,
        diffusionOnlyMargin: this.parameters.DT / diffusionOnlyLimit
      };
    }

    reset() {
      this.rng = new Mulberry32(this.seed);
      this.tick = 0;
      this.simulatedTime = 0;
      this.nextId = 1;
      this.temperature = 18;
      this.season = 'Spring';
      this.U = new Float32Array(this.area);
      this.V = new Float32Array(this.area);
      this.U2 = new Float32Array(this.area);
      this.V2 = new Float32Array(this.area);
      this.agents = [];
      this.history = [];
      this.extinctionEvents = [];
      this.extinctionRecorded = { herbivores: false, carnivores: false };
      for (let i = 0; i < this.area; i++) {
        this.U[i] = 1;
        this.V[i] = this.rng.next() < 0.04 ? 0.7 + this.rng.next() * 0.3 : 0;
      }
      for (let k = 0; k < 24; k++) {
        const cx = Math.floor(this.rng.next() * this.size);
        const cy = Math.floor(this.rng.next() * this.size);
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (dx * dx + dy * dy <= 4) this.V[cellIndex(cx + dx, cy + dy, this.size)] = 0.8 + this.rng.next() * 0.2;
          }
        }
      }
      for (let i = 0; i < this.area; i++) this.V[i] = Math.min(1, this.V[i] + INITIAL_V_BACKGROUND);
      for (let i = 0; i < this.config.initialHerbivores; i++) {
        this.agents.push(this.makeAgent(Math.floor(this.rng.next() * this.size), Math.floor(this.rng.next() * this.size), null, null, this.rng.next() * 0.35));
      }
      for (let i = 0; i < this.config.initialCarnivores; i++) {
        this.agents.push(this.makeAgent(Math.floor(this.rng.next() * this.size), Math.floor(this.rng.next() * this.size), null, null, 0.68 + this.rng.next() * 0.32));
      }
      const infectedCount = Math.min(this.config.initialInfectionCount, this.agents.length);
      for (let i = 0; i < infectedCount; i++) {
        const j = i + Math.floor(this.rng.next() * (this.agents.length - i));
        [this.agents[i], this.agents[j]] = [this.agents[j], this.agents[i]];
        this.agents[i].compartment = 'I';
        this.agents[i].infectionTime = this.tick;
      }
      this.agents.sort((a, b) => a.id - b.id);
      this.updateClimate();
      this.recordTelemetry();
      return this;
    }

    makeAgent(x, y, mother = null, father = null, forcedDiet = null) {
      const traits = {};
      for (const key of TRAITS) {
        const base = mother && father
          ? (this.rng.next() < 0.5 ? mother.traits[key] : father.traits[key])
          : 0.65;
        const value = mother && father ? base + this.rng.gaussian() * 0.055 : base + this.rng.gaussian() * 0.16;
        traits[key] = clamp(value, 0.15, 2.5);
      }
      let diet;
      if (forcedDiet !== null) diet = clamp(forcedDiet, 0, 1);
      else if (mother && father) diet = clamp((mother.diet + father.diet) / 2 + this.rng.gaussian() * 0.035, 0, 1);
      else diet = this.rng.next() < 0.78 ? this.rng.next() * 0.35 : 0.68 + this.rng.next() * 0.32;
      const culture = new Float32Array(CULTURE_CHANNELS);
      if (mother && father) {
        for (let i = 0; i < CULTURE_CHANNELS; i++) {
          culture[i] = clamp(((mother.culture?.[i] ?? 0) + (father.culture?.[i] ?? 0)) * 0.5 + this.rng.gaussian() * 0.025, 0, 1);
        }
      }
      const id = this.nextId++;
      return {
        id,
        lineage: mother ? mother.lineage : id,
        x: ((Math.floor(x) % this.size) + this.size) % this.size,
        y: ((Math.floor(y) % this.size) + this.size) % this.size,
        diet, traits,
        age: 0, stage: 'juvenile', energy: 8, damage: 0,
        compartment: 'S', infectionTime: 0, immunity: 0,
        reproductions: 0, cooldown: 0, lastMoveDistance: 0, dead: false,
        memory: new Float32Array(MEMORY_REGIONS), culture
      };
    }

    updateClimate() {
      const phase = (this.tick % 900) / 900;
      this.temperature = 18 + 14 * Math.sin(phase * 2 * Math.PI);
      this.season = phase < 0.25 ? 'Spring' : phase < 0.5 ? 'Summer' : phase < 0.75 ? 'Autumn' : 'Winter';
    }

    seasonalForcingAt(tick = this.tick) {
      const baseF = this.parameters.F;
      const baseK = this.parameters.K;
      if (!this.config.seasonalForcing) return { F: baseF, K: baseK };
      const phase = (tick % 900) / 900;
      const angle = phase * 2 * Math.PI;
      return {
        F: clamp(baseF * (1 + SEASONAL_FORCING_AMPLITUDE * Math.sin(angle)), REACTION_LIMITS.F_MIN, REACTION_LIMITS.F_MAX),
        K: clamp(baseK * (1 + SEASONAL_FORCING_AMPLITUDE * Math.cos(angle)), REACTION_LIMITS.K_MIN, REACTION_LIMITS.K_MAX)
      };
    }

    laplacian(field, x, y) {
      const n = this.size;
      return field[cellIndex(x + 1, y, n)] + field[cellIndex(x - 1, y, n)] +
        field[cellIndex(x, y + 1, n)] + field[cellIndex(x, y - 1, n)] - 4 * field[cellIndex(x, y, n)];
    }

    simulateSubstrate(exogenousVFrame = null) {
      const { F, K } = this.seasonalForcingAt();
      const { DU, DV, DT } = this.parameters;
      this.simulatedTime += DT;
      const exogenousV = exogenousVFrame !== null;
      if (exogenousV) this.V = Float32Array.from(exogenousVFrame);
      for (let y = 0; y < this.size; y++) {
        for (let x = 0; x < this.size; x++) {
          const i = cellIndex(x, y, this.size);
          const u = this.U[i], v = this.V[i];
          const reaction = u * v * v;
          this.U2[i] = clamp(u + DT * (DU * this.laplacian(this.U, x, y) - reaction + F * (1 - u)), 0, 1);
          if (!exogenousV) this.V2[i] = clamp(v + DT * (DV * this.laplacian(this.V, x, y) + reaction - (F + K) * v), 0, 1);
        }
      }
      [this.U, this.U2] = [this.U2, this.U];
      if (!exogenousV) [this.V, this.V2] = [this.V2, this.V];
    }

    updateEpidemiology() {
      // Freeze tick-start compartments and positions: infections acquired in
      // this stage are ineligible to transmit until the next tick.
      const alive = this.agents.filter(a => !a.dead).sort((a, b) => a.id - b.id);
      const infectious = alive.filter(a => a.compartment === 'I');
      const susceptible = alive.filter(a => a.compartment === 'S');
      const exposureSurvival = new Map(susceptible.map(a => [a.id, 1]));
      for (const source of infectious) {
        for (const target of susceptible) {
          if (source.id === target.id || toroidalManhattanDistance(source, target, this.size) > 1) continue;
          const p = transmissionProbability(this.parameters.beta, target.traits.armor);
          exposureSurvival.set(target.id, exposureSurvival.get(target.id) * (1 - p));
        }
      }
      const newlyInfected = [];
      for (const target of susceptible) {
        const exposure = 1 - exposureSurvival.get(target.id);
        if (this.rng.next() < exposure) newlyInfected.push(target);
      }

      const transitions = [];
      for (const source of infectious) {
        const recoveryP = clamp(this.parameters.recoveryProbability * (0.7 + 0.5 * source.traits.armor), 0, 1);
        if (this.rng.next() < recoveryP) transitions.push([source, 'R']);
        else if (this.rng.next() < clamp(this.parameters.diseaseMortalityProbability, 0, 1)) transitions.push([source, 'D']);
      }
      for (const [agent, compartment] of transitions) {
        if (compartment === 'D') agent.dead = true;
        else { agent.compartment = 'R'; agent.immunity = 1; }
      }
      for (const target of newlyInfected) {
        if (!target.dead && target.compartment === 'S') {
          target.compartment = 'I';
          target.infectionTime = this.tick;
        }
      }
    }

    behaveAndMove() {
      const living = this.agents.filter(a => !a.dead).sort((a, b) => a.id - b.id);
      const startPositions = new Map(living.map(a => [a.id, { x: a.x, y: a.y }]));
      const moves = [];
      for (const agent of living) {
        const start = startPositions.get(agent.id);
        const range = Math.min(6, Math.ceil(agent.traits.sense * 2.6));
        let targetX = start.x, targetY = start.y;
        if (agent.diet < 0.5) {
          let bestScore = -Infinity;
          for (let dy = -range; dy <= range; dy++) {
            for (let dx = -range; dx <= range; dx++) {
              const x = (start.x + dx + this.size) % this.size;
              const y = (start.y + dy + this.size) % this.size;
              const region = Math.min(7, Math.floor(y * 8 / this.size)) * 8 + Math.min(7, Math.floor(x * 8 / this.size));
              const distance = toroidalManhattanDistance(start, { x, y }, this.size);
              const remembered = agent.memory[region] || 0;
              const sharedCue = agent.culture[region % CULTURE_CHANNELS] || 0;
              const score = this.V[cellIndex(x, y, this.size)] + 0.10 * remembered + 0.04 * sharedCue - 0.028 * distance + this.rng.next() * 0.004;
              if (score > bestScore) { bestScore = score; targetX = x; targetY = y; }
            }
          }
        } else {
          let target = null, nearest = Infinity;
          for (const prey of living) {
            if (prey.diet >= 0.5) continue;
            const pos = startPositions.get(prey.id);
            const distance = toroidalManhattanDistance(start, pos, this.size);
            if (distance <= range && distance < nearest) { target = pos; nearest = distance; }
          }
          if (target) { targetX = target.x; targetY = target.y; }
          else {
            targetX = (start.x + Math.floor(this.rng.next() * 3) - 1 + this.size) % this.size;
            targetY = (start.y + Math.floor(this.rng.next() * 3) - 1 + this.size) % this.size;
          }
        }
        const destination = moveToward(start.x, start.y, targetX, targetY, this.size, movementSteps(agent.traits.motility));
        moves.push({ agent, x: destination.x, y: destination.y, distance: toroidalManhattanDistance(start, destination, this.size) });
      }
      for (const move of moves) {
        move.agent.x = move.x;
        move.agent.y = move.y;
        move.agent.lastMoveDistance = move.distance;
        const coldOrHeatStress = this.temperature < 8 ? 1.55 : this.temperature > 31 ? 1.25 : 1;
        const basal = 0.0068 * coldOrHeatStress * (1 + 0.28 * move.agent.traits.motility);
        const movementCost = 0.004 * move.distance;
        const diseaseCost = move.agent.compartment === 'I' ? 0.016 : 0;
        const senescenceCost = move.agent.stage === 'elder' ? 0.003 : 0;
        move.agent.energy = clamp(move.agent.energy - basal - movementCost - diseaseCost - senescenceCost, 0, 18);
        const region = Math.min(7, Math.floor(move.agent.y * 8 / this.size)) * 8 + Math.min(7, Math.floor(move.agent.x * 8 / this.size));
        const observed = this.V[cellIndex(move.agent.x, move.agent.y, this.size)];
        move.agent.memory[region] = clamp(move.agent.memory[region] * 0.82 + observed * 0.18, 0, 1);
        const channel = region % CULTURE_CHANNELS;
        move.agent.culture[channel] = clamp(move.agent.culture[channel] * 0.995 + observed * 0.005, 0, 1);
      }
    }

    feedSimultaneously() {
      const living = this.agents.filter(a => !a.dead).sort((a, b) => a.id - b.id);
      const byCell = new Map();
      for (const agent of living) {
        const i = cellIndex(agent.x, agent.y, this.size);
        if (!byCell.has(i)) byCell.set(i, { herbivores: [], carnivores: [] });
        byCell.get(i)[agent.diet < 0.5 ? 'herbivores' : 'carnivores'].push(agent);
      }

      // Proportional, simultaneous allocation: array iteration order cannot
      // let the first herbivore consume a patch before the others feed.
      for (const [i, group] of byCell) {
        const grazers = group.herbivores;
        if (!grazers.length) continue;
        const requested = grazers.length * this.config.grazingRate;
        const totalIntake = Math.min(Math.max(0, this.V[i]), requested);
        const perAgent = totalIntake / grazers.length;
        for (const grazer of grazers) grazer.energy = clamp(grazer.energy + perAgent * 11 * grazer.traits.efficiency, 0, 18);
        this.V[i] = Math.max(0, this.V[i] - totalIntake);
      }

      // Each carnivore makes at most one capture proposal from tick-stage
      // prey; a prey can be awarded to at most one successful predator.
      const proposals = [];
      for (const group of byCell.values()) {
        if (!group.herbivores.length || !group.carnivores.length) continue;
        for (const predator of group.carnivores) {
          const prey = group.herbivores[Math.floor(this.rng.next() * group.herbivores.length)];
          const chance = predationProbability(predator.traits.aggression, prey.traits.armor);
          if (this.rng.next() < chance) proposals.push({ predator, prey });
        }
      }
      const claims = new Map();
      for (const proposal of proposals) {
        if (!claims.has(proposal.prey.id)) claims.set(proposal.prey.id, []);
        claims.get(proposal.prey.id).push(proposal);
      }
      for (const contenders of claims.values()) {
        const winner = contenders[Math.floor(this.rng.next() * contenders.length)];
        const { predator, prey } = winner;
        if (predator.dead || prey.dead) continue;
        const preyEnergy = prey.energy;
        prey.dead = true;
        predator.energy = clamp(predator.energy + preyEnergy * 0.58 * predator.traits.efficiency, 0, 18);
        if (prey.compartment === 'I' && this.rng.next() < 0.35 && predator.compartment === 'S') {
          predator.compartment = 'I';
          predator.infectionTime = this.tick;
        }
      }
    }

    learnSimultaneously() {
      const living = this.agents.filter(agent => !agent.dead).sort((a, b) => a.id - b.id);
      const teachers = living.filter(agent => agent.stage !== 'juvenile' && agent.energy > 4);
      const sourceCulture = new Map(teachers.map(agent => [agent.id, Float32Array.from(agent.culture)]));
      const transfers = [];
      for (const student of living) {
        if (student.stage !== 'juvenile') continue;
        const nearby = teachers.filter(teacher => toroidalManhattanDistance(student, teacher, this.size) <= 2);
        if (!nearby.length) continue;
        const teacher = nearby[Math.floor(this.rng.next() * nearby.length)];
        const inherited = sourceCulture.get(teacher.id);
        const learned = new Float32Array(CULTURE_CHANNELS);
        for (let channel = 0; channel < CULTURE_CHANNELS; channel++) {
          learned[channel] = clamp(student.culture[channel] * 0.9 + inherited[channel] * 0.1, 0, 1);
        }
        transfers.push([student, learned]);
      }
      for (const [student, learned] of transfers) student.culture = learned;
      return transfers.length;
    }

    reproduceSimultaneously() {
      const eligible = this.agents.filter(a => !a.dead && a.stage !== 'juvenile' && a.cooldown <= 0 &&
        a.energy >= 8 && a.compartment !== 'I').sort((a, b) => a.id - b.id);
      const used = new Set();
      const pairings = [];
      for (const parent of eligible) {
        if (used.has(parent.id)) continue;
        const mate = eligible.find(candidate => candidate.id !== parent.id && !used.has(candidate.id) &&
          candidate.energy >= 8 && toroidalManhattanDistance(parent, candidate, this.size) <= 2 &&
          Math.abs(parent.diet - candidate.diet) < 0.28);
        if (!mate) continue;
        used.add(parent.id);
        used.add(mate.id);
        pairings.push([parent, mate]);
      }
      const births = [];
      const livingCount = this.agents.reduce((count, agent) => count + (agent.dead ? 0 : 1), 0);
      for (const [a, b] of pairings) {
        if (livingCount + births.length >= this.config.maxPopulation) break;
        a.energy = Math.max(0, a.energy - 3.1);
        b.energy = Math.max(0, b.energy - 3.1);
        a.cooldown = 22;
        b.cooldown = 22;
        a.reproductions++;
        b.reproductions++;
        a.damage = applyReproductiveDamage(a.damage);
        b.damage = applyReproductiveDamage(b.damage);
        births.push(this.makeAgent(a.x, a.y, a, b));
      }
      this.agents.push(...births);
    }

    ageAndSelect() {
      for (const agent of this.agents) {
        if (agent.dead) continue;
        agent.age++;
        if (agent.stage === 'juvenile' && agent.age > 24) agent.stage = 'mature';
        else if (agent.stage === 'mature' && agent.age > 105) agent.stage = 'elder';
        agent.damage = advanceDamage(agent.damage, agent.traits.longevity);
        const maxLife = 165 * agent.traits.longevity;
        const infectionHazard = agent.compartment === 'I' ? 0.0055 : 0;
        const senescenceHazard = 0.00005 * Math.exp(0.28 * (agent.age / maxLife)) * (1 + agent.damage * 7);
        const hazard = clamp(0.00018 + infectionHazard + senescenceHazard, 0, 1);
        if (this.rng.next() < hazard || agent.age > maxLife * 1.35 || agent.energy <= 0) agent.dead = true;
        if (agent.cooldown > 0) agent.cooldown--;
      }
      this.agents = this.agents.filter(a => !a.dead).sort((a, b) => a.id - b.id);
    }

    step(options = {}) {
      let exogenousFrame = null;
      if (options.exogenousVFrame !== undefined) {
        const frame = options.exogenousVFrame;
        if (!frame || frame.length !== this.area) throw new TypeError('Exogenous V frame must match simulation area.');
        if (Array.from(frame).some(value => !finite(value) || value < 0 || value > 1)) {
          throw new TypeError('Exogenous V values must be finite and in [0, 1].');
        }
        exogenousFrame = Float32Array.from(frame);
      }
      const hadAgents = this.agents.length > 0;
      this.tick++;
      this.updateClimate();
      if (exogenousFrame !== null) {
        this.simulateSubstrate(exogenousFrame);
        // The supplied V(t) drives U's substrate response for this tick; the
        // next external frame replaces V rather than using an internally evolved V.
      } else {
        this.simulateSubstrate();
        this.applyVReseed();
      }
      this.updateEpidemiology();
      this.behaveAndMove();
      this.feedSimultaneously();
      this.learnSimultaneously();
      this.reproduceSimultaneously();
      this.ageAndSelect();
      if (this.tick % this.config.telemetryInterval === 0 || (hadAgents && this.agents.length === 0)) this.recordTelemetry();
      return options.includeStatistics ? this.statistics() : undefined;
    }

    advanceToSimulatedTime(targetTime, maxSteps = 1000000) {
      if (!finite(targetTime) || targetTime < this.simulatedTime) throw new TypeError('Target simulated time must be finite and not earlier than the current time.');
      if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new TypeError('maxSteps must be a positive integer.');
      const startingTick = this.tick;
      const tolerance = 1e-12 * Math.max(1, Math.abs(targetTime));
      if (targetTime - this.simulatedTime > maxSteps * this.parameters.DT + tolerance) {
        throw new RangeError('Target time exceeds maxSteps at the current timestep.');
      }
      while (this.simulatedTime + this.parameters.DT <= targetTime + tolerance) this.step();
      const remainder = targetTime - this.simulatedTime;
      if (remainder > tolerance) {
        const originalDT = this.parameters.DT;
        this.parameters.DT = remainder;
        this.config.DT = remainder;
        try { this.step(); }
        finally { this.parameters.DT = originalDT; this.config.DT = originalDT; }
      }
      return { targetTime, simulatedTime: this.simulatedTime, ticksAdvanced: this.tick - startingTick, tick: this.tick };
    }

    introducePathogen() {
      const candidates = this.agents.filter(a => !a.dead && a.compartment === 'S').sort((a, b) => a.id - b.id);
      if (!candidates.length) return null;
      const target = candidates[Math.floor(this.rng.next() * candidates.length)];
      target.compartment = 'I';
      target.infectionTime = this.tick;
      return target.id;
    }

    perturbV(amount = 0.28) {
      for (let i = 0; i < this.area; i++) this.V[i] = clamp(this.V[i] + amount, 0, 1);
    }

    setVReseedRate(rate) {
      const value = Number(rate);
      if (!finite(value) || value < 0 || value > 0.02) throw new RangeError('vReseedRate must be in [0, 0.02].');
      this.config.vReseedRate = value;
      return value;
    }

    applyVReseed() {
      const amount = this.config.vReseedRate;
      if (amount === 0) return false;
      const index = Math.floor(this.rng.next() * this.area);
      this.V[index] = clamp(this.V[index] + amount, 0, 1);
      return true;
    }

    statistics() {
      const herbs = this.agents.filter(a => a.diet < 0.5);
      const carnivores = this.agents.length - herbs.length;
      const juveniles = this.agents.filter(a => a.stage === 'juvenile').length;
      const mature = this.agents.filter(a => a.stage === 'mature').length;
      const elders = this.agents.filter(a => a.stage === 'elder').length;
      const created = this.nextId - 1;
      const initialPopulation = this.config.initialHerbivores + this.config.initialCarnivores;
      const infected = this.agents.filter(a => a.compartment === 'I').length;
      const recovered = this.agents.filter(a => a.compartment === 'R').length;
      const traits = {};
      for (const key of TRAITS) {
        const values = this.agents.map(a => a.traits[key]);
        traits[key] = { mean: mean(values), variance: variance(values), sd: Math.sqrt(variance(values)) };
      }
      let memoryTotal = 0, cultureTotal = 0;
      for (const agent of this.agents) {
        for (const value of agent.memory) memoryTotal += value;
        for (const value of agent.culture) cultureTotal += value;
      }
      const memorySignal = this.agents.length ? memoryTotal / (this.agents.length * MEMORY_REGIONS) : 0;
      const sharedCueSignal = this.agents.length ? cultureTotal / (this.agents.length * CULTURE_CHANNELS) : 0;
      return {
        tick: this.tick,
        simulatedTime: this.simulatedTime,
        herbivores: herbs.length,
        carnivores,
        total: this.agents.length,
        juveniles, mature, elders,
        totalBirths: Math.max(0, created - initialPopulation),
        totalDeaths: Math.max(0, created - this.agents.length),
        susceptible: this.agents.length - infected - recovered,
        infected,
        recovered,
        infectionPrevalence: this.agents.length ? infected / this.agents.length : 0,
        meanU: mean(Array.from(this.U)),
        meanV: mean(Array.from(this.V)),
        temperature: this.temperature,
        season: this.season,
        baselineF: this.parameters.F,
        baselineK: this.parameters.K,
        seasonalF: this.seasonalForcingAt().F,
        seasonalK: this.seasonalForcingAt().K,
        DU: this.parameters.DU,
        DV: this.parameters.DV,
        DT: this.parameters.DT,
        memorySignal,
        sharedCueSignal,
        traits,
        extinctions: this.extinctionEvents.length
      };
    }

    recordTelemetry() {
      const stats = this.statistics();
      for (const [role, count] of [['herbivores', stats.herbivores], ['carnivores', stats.carnivores]]) {
        if (count === 0 && !this.extinctionRecorded[role]) {
          this.extinctionRecorded[role] = true;
          this.extinctionEvents.push({ tick: this.tick, role });
        }
      }
      const forcing = this.seasonalForcingAt();
      const row = {
        tick: stats.tick, simulatedTime: stats.simulatedTime, herbivores: stats.herbivores, carnivores: stats.carnivores,
        total: stats.total, juveniles: stats.juveniles, mature: stats.mature, elders: stats.elders,
        totalBirths: stats.totalBirths, totalDeaths: stats.totalDeaths,
        susceptible: stats.susceptible, infected: stats.infected,
        recovered: stats.recovered, infectionPrevalence: stats.infectionPrevalence,
        meanU: stats.meanU, meanV: stats.meanV, temperature: stats.temperature,
        season: stats.season, baselineF: this.parameters.F, baselineK: this.parameters.K,
        seasonalF: forcing.F, seasonalK: forcing.K,
        DU: this.parameters.DU, DV: this.parameters.DV, DT: this.parameters.DT,
        memorySignal: stats.memorySignal, sharedCueSignal: stats.sharedCueSignal,
        extinctionEvents: this.extinctionEvents.length
      };
      for (const key of TRAITS) {
        row[`${key}Mean`] = stats.traits[key].mean;
        row[`${key}SD`] = stats.traits[key].sd;
      }
      this.history.push(row);
      if (this.history.length > this.config.maxHistory) this.history.shift();
      return row;
    }

    exportCSV() {
      if (!this.history.length) return '';
      const keys = Object.keys(this.history[0]);
      const quote = value => typeof value === 'string' ? `"${value.replaceAll('"', '""')}"` : String(value);
      return [keys.map(quote).join(','), ...this.history.map(row => keys.map(key => quote(row[key])).join(','))].join('\n');
    }

    snapshot() {
      return {
        modelVersion: MODEL_VERSION,
        config: { ...this.config, ...this.parameters, seed: this.seed },
        parameters: { ...this.parameters },
        seed: this.seed,
        rngState: this.rng.snapshot(),
        requestedDT: this.requestedDT,
        tick: this.tick,
        simulatedTime: this.simulatedTime,
        nextId: this.nextId,
        temperature: this.temperature,
        season: this.season,
        U: Array.from(this.U),
        V: Array.from(this.V),
        agents: this.agents.map(a => ({ ...a, traits: { ...a.traits }, memory: Array.from(a.memory), culture: Array.from(a.culture) })),
        history: this.history.map(row => ({ ...row })),
        extinctionEvents: this.extinctionEvents.map(event => ({ ...event })),
        extinctionRecorded: { ...this.extinctionRecorded }
      };
    }

    loadSnapshot(snapshot) {
      // Validate the complete checkpoint into temporary values before changing
      // any live state, including agent learning arrays and export telemetry.
      if (!snapshot || snapshot.modelVersion !== MODEL_VERSION || !snapshot.config || !snapshot.parameters) {
        throw new TypeError('Unsupported or malformed state version.');
      }
      if (!Number.isInteger(snapshot.seed) || snapshot.seed < 0 || snapshot.seed > 0xffffffff) {
        throw new TypeError('Saved seed must be an unsigned 32-bit integer.');
      }
      const config = validateOptions(snapshot.config);
      if (config.seed !== snapshot.seed) throw new TypeError('Saved seed does not match saved configuration.');
      const area = config.size * config.size;
      if (!Array.isArray(snapshot.U) || !Array.isArray(snapshot.V) || snapshot.U.length !== area || snapshot.V.length !== area) {
        throw new TypeError('Saved fields do not match configured grid dimensions.');
      }
      for (const field of [snapshot.U, snapshot.V]) {
        if (field.some(value => !finite(value) || value < 0 || value > 1)) throw new TypeError('Saved field values must be finite and in [0, 1].');
      }
      const U = Float32Array.from(snapshot.U), V = Float32Array.from(snapshot.V);
      if (!Array.isArray(snapshot.agents) || snapshot.agents.length > config.maxPopulation ||
          !Number.isSafeInteger(snapshot.tick) || snapshot.tick < 0 ||
          !finite(snapshot.simulatedTime) || snapshot.simulatedTime < 0 ||
          !Number.isSafeInteger(snapshot.nextId) || snapshot.nextId < 1 || !Number.isInteger(snapshot.rngState) ||
          !finite(snapshot.temperature) || snapshot.temperature < -100 || snapshot.temperature > 100 ||
          !['Spring', 'Summer', 'Autumn', 'Winter'].includes(snapshot.season)) {
        throw new TypeError('Saved simulation metadata is invalid.');
      }
      const ids = new Set();
      let maximumId = 0;
      const agents = snapshot.agents.map(agent => {
        if (!agent || typeof agent !== 'object' || Array.isArray(agent) ||
            Object.keys(agent).some(key => !AGENT_FIELDS.has(key)) ||
            !Number.isSafeInteger(agent.id) || agent.id < 1 || ids.has(agent.id) ||
            !Number.isSafeInteger(agent.lineage) || agent.lineage < 1 ||
            !Number.isInteger(agent.x) || !Number.isInteger(agent.y) ||
            agent.x < 0 || agent.x >= config.size || agent.y < 0 || agent.y >= config.size ||
            !finite(agent.diet) || agent.diet < 0 || agent.diet > 1 ||
            !['juvenile', 'mature', 'elder'].includes(agent.stage) ||
            !Number.isSafeInteger(agent.age) || agent.age < 0 ||
            !finite(agent.energy) || agent.energy < 0 || agent.energy > 18 ||
            !finite(agent.damage) || agent.damage < 0 || agent.damage > 1 ||
            !['S', 'I', 'R'].includes(agent.compartment) ||
            !Number.isSafeInteger(agent.infectionTime) || agent.infectionTime < 0 || agent.infectionTime > snapshot.tick ||
            !finite(agent.immunity) || agent.immunity < 0 || agent.immunity > 1 ||
            !Number.isSafeInteger(agent.reproductions) || agent.reproductions < 0 ||
            !Number.isSafeInteger(agent.cooldown) || agent.cooldown < 0 ||
            !finite(agent.lastMoveDistance) || agent.lastMoveDistance < 0 || agent.lastMoveDistance > 3 ||
            agent.dead !== false || !agent.traits || typeof agent.traits !== 'object' || Array.isArray(agent.traits) ||
            Object.keys(agent.traits).some(key => !TRAITS.includes(key)) ||
            TRAITS.some(key => !finite(agent.traits[key]) || agent.traits[key] < 0.15 || agent.traits[key] > 2.5) ||
            !Array.isArray(agent.memory) || agent.memory.length !== MEMORY_REGIONS ||
            agent.memory.some(value => !finite(value) || value < 0 || value > 1) ||
            !Array.isArray(agent.culture) || agent.culture.length !== CULTURE_CHANNELS ||
            agent.culture.some(value => !finite(value) || value < 0 || value > 1)) {
          throw new TypeError('Saved agent record is invalid.');
        }
        ids.add(agent.id);
        maximumId = Math.max(maximumId, agent.id);
        return { ...agent, traits: { ...agent.traits }, memory: Float32Array.from(agent.memory), culture: Float32Array.from(agent.culture) };
      });
      if (snapshot.nextId <= maximumId) throw new TypeError('Saved nextId must exceed every existing agent ID.');
      const parameters = { ...snapshot.parameters };
      for (const key of ['F', 'K', 'DU', 'DV', 'DT', 'beta', 'recoveryProbability', 'diseaseMortalityProbability']) {
        if (!finite(parameters[key]) || parameters[key] < 0) throw new TypeError(`Saved parameter ${key} is invalid.`);
      }
      if (parameters.F < REACTION_LIMITS.F_MIN || parameters.F > REACTION_LIMITS.F_MAX ||
          parameters.K < REACTION_LIMITS.K_MIN || parameters.K > REACTION_LIMITS.K_MAX ||
          parameters.DU < DIFFUSION_LIMITS.DU_MIN || parameters.DU > DIFFUSION_LIMITS.DU_MAX ||
          parameters.DV < DIFFUSION_LIMITS.DV_MIN || parameters.DV > DIFFUSION_LIMITS.DV_MAX ||
          ['beta', 'recoveryProbability', 'diseaseMortalityProbability'].some(key => parameters[key] > 1)) {
        throw new RangeError('Saved model parameters are outside the supported ranges.');
      }
      const requestedDT = snapshot.requestedDT === undefined ? parameters.DT : snapshot.requestedDT;
      if (!finite(requestedDT) || requestedDT < DIFFUSION_LIMITS.DT_MIN || requestedDT > DIFFUSION_LIMITS.DT_MAX) {
        throw new TypeError('Saved requested time step is invalid.');
      }
      const guardedDiffusion = guardDiffusionSettings({ ...parameters, DT: requestedDT });
      if (Math.abs(parameters.DT - guardedDiffusion.DT) > 1e-12) throw new TypeError('Saved active time step does not match its guarded request.');
      for (const key of ['F', 'K', 'DU', 'DV', 'DT', 'beta', 'recoveryProbability', 'diseaseMortalityProbability']) {
        if (config[key] !== parameters[key]) throw new TypeError(`Saved configuration and parameter ${key} do not match.`);
      }
      if (!Array.isArray(snapshot.history) || snapshot.history.length > config.maxHistory ||
          !Array.isArray(snapshot.extinctionEvents) || snapshot.extinctionEvents.length > 2 ||
          !snapshot.extinctionRecorded || typeof snapshot.extinctionRecorded !== 'object') {
        throw new TypeError('Saved telemetry metadata is invalid.');
      }
      const historyKeys = ['tick', 'simulatedTime', 'herbivores', 'carnivores', 'total', 'juveniles', 'mature', 'elders', 'totalBirths', 'totalDeaths', 'susceptible', 'infected', 'recovered', 'infectionPrevalence', 'meanU', 'meanV', 'temperature', 'season', 'baselineF', 'baselineK', 'seasonalF', 'seasonalK', 'DU', 'DV', 'DT', 'memorySignal', 'sharedCueSignal', 'extinctionEvents', ...TRAITS.flatMap(key => [`${key}Mean`, `${key}SD`])];
      const history = snapshot.history.map(row => {
        if (!row || typeof row !== 'object' || Array.isArray(row) || historyKeys.some(key => !Object.hasOwn(row, key)) ||
            historyKeys.some(key => key === 'season' ? !['Spring', 'Summer', 'Autumn', 'Winter'].includes(row[key]) : !finite(row[key])) ||
            !Number.isSafeInteger(row.tick) || row.tick < 0 || row.tick > snapshot.tick || row.simulatedTime < 0 || row.simulatedTime > snapshot.simulatedTime + 1e-9) {
          throw new TypeError('Saved telemetry row is invalid.');
        }
        return { ...row };
      });
      const extinctionEvents = snapshot.extinctionEvents.map(event => {
        if (!event || !Number.isSafeInteger(event.tick) || event.tick < 0 || event.tick > snapshot.tick ||
            !['herbivores', 'carnivores'].includes(event.role)) throw new TypeError('Saved extinction event is invalid.');
        return { tick: event.tick, role: event.role };
      });
      const roles = extinctionEvents.map(event => event.role);
      if (new Set(roles).size !== roles.length ||
          typeof snapshot.extinctionRecorded.herbivores !== 'boolean' || typeof snapshot.extinctionRecorded.carnivores !== 'boolean' ||
          snapshot.extinctionRecorded.herbivores !== roles.includes('herbivores') ||
          snapshot.extinctionRecorded.carnivores !== roles.includes('carnivores')) {
        throw new TypeError('Saved extinction flags do not match their events.');
      }
      const rng = new Mulberry32(snapshot.seed);
      rng.restore(snapshot.rngState);

      this.config = config;
      this.size = config.size;
      this.area = area;
      this.seed = snapshot.seed;
      this.parameters = parameters;
      this.requestedDT = requestedDT;
      this.rng = rng;
      this.tick = snapshot.tick;
      this.simulatedTime = snapshot.simulatedTime;
      this.nextId = snapshot.nextId;
      this.temperature = snapshot.temperature;
      this.season = snapshot.season;
      this.U = U;
      this.V = V;
      this.U2 = new Float32Array(area);
      this.V2 = new Float32Array(area);
      this.agents = agents.sort((a, b) => a.id - b.id);
      this.history = history;
      this.extinctionEvents = extinctionEvents;
      this.extinctionRecorded = { ...snapshot.extinctionRecorded };
      return this;
    }

    saveToStorage(storage = globalThis.localStorage, key = 'infiniteBecoming.synthetic.v4') {
      if (!storage || typeof storage.setItem !== 'function') throw new Error('Browser storage is unavailable.');
      const serialized = JSON.stringify(this.snapshot());
      if (serialized.length > CHECKPOINT_STORAGE_LIMIT) throw new RangeError('Checkpoint exceeds the 4 MiB storage safety limit.');
      storage.setItem(key, serialized);
    }

    loadFromStorage(storage = globalThis.localStorage, key = 'infiniteBecoming.synthetic.v4') {
      if (!storage || typeof storage.getItem !== 'function') throw new Error('Browser storage is unavailable.');
      const raw = storage.getItem(key);
      if (raw === null) return false;
      if (raw.length > CHECKPOINT_STORAGE_LIMIT) throw new RangeError('Checkpoint exceeds the 4 MiB storage safety limit.');
      this.loadSnapshot(JSON.parse(raw));
      return true;
    }
  }

  function generateExogenousVSequence(options = {}) {
    const { steps = 100, ...simulationOptions } = options;
    if (!Number.isInteger(steps) || steps < 1) throw new TypeError('steps must be a positive integer.');
    const sim = new Simulation({
      ...simulationOptions,
      initialHerbivores: 0,
      initialCarnivores: 0,
      initialInfectionCount: 0
    });
    const frames = [];
    for (let i = 0; i < steps; i++) {
      sim.step();
      frames.push(Float32Array.from(sim.V));
    }
    return frames;
  }

  function runFixedPermutationArrangementComparison(options = {}) {
    const { frames, permutation, permutationSeed = DEFAULTS.seed, simulationOptions = {} } = options;
    if (!Array.isArray(frames) || frames.length === 0) throw new TypeError('Provide a pre-generated exogenous V(t) sequence.');
    const size = simulationOptions.size ?? DEFAULTS.size;
    const area = size * size;
    const fixedPermutation = permutation ? [...permutation] : makeFixedPermutation(area, permutationSeed);
    const conditions = createFixedPermutationConditions(frames, fixedPermutation);
    if (area !== fixedPermutation.length) throw new TypeError('Frame area must equal the simulation grid area.');
    const control = new Simulation({ ...simulationOptions, size });
    const rearranged = new Simulation({ ...simulationOptions, size });
    const controlSeries = [], rearrangedSeries = [];
    for (let t = 0; t < frames.length; t++) {
      controlSeries.push(control.step({ exogenousVFrame: conditions.controlFrames[t], includeStatistics: true }));
      rearrangedSeries.push(rearranged.step({ exogenousVFrame: conditions.permutedFrames[t], includeStatistics: true }));
    }
    return {
      design: 'paired pre-generated exogenous V(t); one fixed spatial permutation across all frames',
      controlSeries, rearrangedSeries, permutation: fixedPermutation,
      controlSnapshot: control.snapshot(), rearrangedSnapshot: rearranged.snapshot()
    };
  }

  return Object.freeze({
    MODEL_VERSION, TRAITS, DEFAULTS, DIFFUSION_LIMITS, REACTION_LIMITS, MEMORY_REGIONS, CULTURE_CHANNELS, Mulberry32, Simulation,
    clamp, mean, variance, cellIndex,
    signedWrappedDelta, toroidalManhattanDistance, moveToward, movementSteps,
    predationProbability, transmissionProbability, damageIncrement, advanceDamage, applyReproductiveDamage,
    diffusionOnlyTimeStepLimit, guardDiffusionSettings,
    makeFixedPermutation, permuteSpatialFrame, createFixedPermutationConditions,
    generateExogenousVSequence, runFixedPermutationArrangementComparison
  });
});
