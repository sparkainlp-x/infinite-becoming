// SPDX-License-Identifier: AGPL-3.0-only
/* Parameter-only preset storage. Full world checkpoints are handled by model.js. */
(function (root, factory) {
  const model = root?.SyntheticEcoModel || (typeof require === 'function' ? require('./model.js') : null);
  const api = factory(model);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SyntheticEcoPresets = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Model) {
  'use strict';
  if (!Model) throw new Error('Load model.js before preset-library.js.');

  const TYPE = 'synthetic-eco-parameter-preset';
  const LIBRARY_TYPE = 'synthetic-eco-parameter-preset-library';
  const VERSION = 1;
  const LIMITS = Model.DIFFUSION_LIMITS;
  const REACTION = Model.REACTION_LIMITS;
  const finite = Number.isFinite;

  function validateParameterPreset(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== TYPE || value.version !== VERSION) {
      throw new TypeError('Unsupported parameter-preset schema.');
    }
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    if (!name || name.length > 80) throw new TypeError('Preset name must contain 1–80 characters.');
    if (!Number.isInteger(value.seed) || value.seed < 0 || value.seed > 0xffffffff) throw new TypeError('Preset seed must be an unsigned 32-bit integer.');
    for (const key of ['F', 'K', 'DU', 'DV', 'requestedDT']) {
      if (!finite(value[key])) throw new TypeError(`Preset ${key} must be finite.`);
    }
    if (value.F < REACTION.F_MIN || value.F > REACTION.F_MAX || value.K < REACTION.K_MIN || value.K > REACTION.K_MAX) {
      throw new RangeError('Preset F/K values are outside the supported ranges.');
    }
    if (value.DU < LIMITS.DU_MIN || value.DU > LIMITS.DU_MAX || value.DV < LIMITS.DV_MIN || value.DV > LIMITS.DV_MAX) {
      throw new RangeError('Preset DU/DV values are outside the supported ranges.');
    }
    if (value.requestedDT < LIMITS.DT_MIN || value.requestedDT > LIMITS.DT_MAX) {
      throw new RangeError('Preset requestedDT is outside the supported range.');
    }
    const createdAt = value.createdAt ?? new Date(0).toISOString();
    if (typeof createdAt !== 'string' || !finite(Date.parse(createdAt))) throw new TypeError('Preset createdAt must be a valid date string.');
    return Object.freeze({
      type: TYPE, version: VERSION, name, createdAt, seed: value.seed,
      F: value.F, K: value.K, DU: value.DU, DV: value.DV, requestedDT: value.requestedDT
    });
  }

  function captureParameterPreset(name, simulation, createdAt = new Date().toISOString()) {
    if (!(simulation instanceof Model.Simulation)) throw new TypeError('A Simulation instance is required.');
    return validateParameterPreset({
      type: TYPE, version: VERSION, name, createdAt, seed: simulation.seed,
      F: simulation.parameters.F, K: simulation.parameters.K,
      DU: simulation.parameters.DU, DV: simulation.parameters.DV,
      requestedDT: simulation.requestedDT
    });
  }

  function parseParameterPresetJSON(text) {
    if (typeof text !== 'string' || text.length > 4096) throw new RangeError('Preset import must be text no larger than 4 KB.');
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw new TypeError('Preset import is not valid JSON.'); }
    return validateParameterPreset(parsed);
  }

  function applyParameterPreset(simulation, value) {
    if (!(simulation instanceof Model.Simulation)) throw new TypeError('A Simulation instance is required.');
    // Complete validation happens before the first mutation.
    const preset = validateParameterPreset(value);
    simulation.seed = preset.seed;
    simulation.config.seed = preset.seed;
    simulation.setReactionParameters({ F: preset.F, K: preset.K });
    simulation.setDiffusionParameters({ DU: preset.DU, DV: preset.DV, DT: preset.requestedDT });
    // Unlike a substrate-only reseed, this resets fields, agents, tick, history,
    // extinction bookkeeping and PRNG to the saved seed and initial conditions.
    simulation.reset();
    return preset;
  }

  class ParameterPresetLibrary {
    constructor(storage = globalThis.localStorage, key = 'infiniteBecoming.parameterPresets.v1') {
      this.storage = storage;
      this.key = key;
    }

    list() {
      if (!this.storage) throw new Error('Browser storage is unavailable.');
      let raw;
      try { raw = this.storage.getItem(this.key); }
      catch (error) { throw new Error(`Could not read preset storage: ${error.message}`); }
      if (raw === null) return [];
      let data;
      try { data = JSON.parse(raw); }
      catch { throw new TypeError('Stored preset library is not valid JSON.'); }
      if (!data || data.type !== LIBRARY_TYPE || data.version !== VERSION || !Array.isArray(data.presets)) {
        throw new TypeError('Stored preset library has an unsupported schema.');
      }
      if (data.presets.length > 100) throw new RangeError('Preset library exceeds the 100-item limit.');
      const presets = data.presets.map(validateParameterPreset);
      if (new Set(presets.map(preset => preset.name)).size !== presets.length) throw new TypeError('Preset library contains duplicate names.');
      return presets;
    }

    write(presets) {
      if (!this.storage) throw new Error('Browser storage is unavailable.');
      const checked = presets.map(validateParameterPreset);
      if (checked.length > 100) throw new RangeError('Preset library exceeds the 100-item limit.');
      const payload = JSON.stringify({ type: LIBRARY_TYPE, version: VERSION, presets: checked });
      try { this.storage.setItem(this.key, payload); }
      catch (error) { throw new Error(`Could not write preset storage: ${error.message}`); }
    }

    upsert(value) {
      const preset = validateParameterPreset(value);
      const presets = this.list();
      const index = presets.findIndex(item => item.name === preset.name);
      if (index < 0 && presets.length >= 100) throw new RangeError('Preset library exceeds the 100-item limit.');
      if (index < 0) presets.push(preset); else presets[index] = preset;
      this.write(presets);
      return preset;
    }

    saveCurrent(name, simulation, createdAt) {
      return this.upsert(captureParameterPreset(name, simulation, createdAt));
    }

    importJSON(text) { return this.upsert(parseParameterPresetJSON(text)); }

    get(name) { return this.list().find(preset => preset.name === name) ?? null; }

    exportJSON(name) {
      const preset = this.get(name);
      if (!preset) throw new Error('Preset was not found.');
      return JSON.stringify(preset, null, 2);
    }

    apply(name, simulation) {
      const preset = this.get(name);
      if (!preset) throw new Error('Preset was not found.');
      return applyParameterPreset(simulation, preset);
    }

    delete(name) {
      const presets = this.list();
      const remaining = presets.filter(preset => preset.name !== name);
      if (remaining.length === presets.length) return false;
      this.write(remaining);
      return true;
    }

    clear() { this.write([]); }
  }

  return Object.freeze({
    PRESET_TYPE: TYPE, PRESET_LIBRARY_TYPE: LIBRARY_TYPE, PRESET_VERSION: VERSION,
    validateParameterPreset, captureParameterPreset, parseParameterPresetJSON,
    applyParameterPreset, ParameterPresetLibrary
  });
});
