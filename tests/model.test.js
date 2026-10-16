// SPDX-License-Identifier: AGPL-3.0-only
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const {
  Simulation, Mulberry32, toroidalManhattanDistance, moveToward, movementSteps,
  predationProbability, damageIncrement, advanceDamage, applyReproductiveDamage, cellIndex,
  createFixedPermutationConditions, generateExogenousVSequence, runFixedPermutationArrangementComparison,
  DEFAULTS, DIFFUSION_LIMITS
} = require('../model.js');
const {
  PRESET_TYPE, ParameterPresetLibrary, captureParameterPreset,
  parseParameterPresetJSON, applyParameterPreset
} = require('../preset-library.js');

function smallSimulation(extra = {}) {
  return new Simulation({
    size: 16, seed: 123456, initialHerbivores: 8, initialCarnivores: 3,
    initialInfectionCount: 0, maxPopulation: 100, ...extra
  });
}

function agent({ id, x, y, diet = 0.1, armor = 0.2, efficiency = 1, aggression = 1,
  compartment = 'S', energy = 1, motility = 0.5, stage = 'juvenile', culture = null }) {
  return {
    id, lineage: id, x, y, diet,
    traits: { efficiency, armor, aggression, motility, sense: 0.5, longevity: 1 },
    age: 0, stage, energy, damage: 0,
    compartment, infectionTime: 0, immunity: 0,
    reproductions: 0, cooldown: 0, lastMoveDistance: 0, dead: false,
    memory: new Float32Array(64), culture: culture ? Float32Array.from(culture) : new Float32Array(8)
  };
}

test('seeded runs are deterministic across reset and repeated ticks', () => {
  const a = smallSimulation();
  const b = smallSimulation();
  for (let i = 0; i < 15; i++) { a.step(); b.step(); }
  assert.deepEqual(a.snapshot(), b.snapshot());
  a.reset();
  b.reset();
  assert.deepEqual(a.snapshot(), b.snapshot());
});

test('save/load restores PRNG state and exact continuation', () => {
  const original = smallSimulation();
  for (let i = 0; i < 7; i++) original.step();
  const checkpoint = original.snapshot();
  assert.equal(Number.isInteger(checkpoint.rngState), true);
  const restored = new Simulation({ size: 8, initialHerbivores: 0, initialCarnivores: 0 });
  restored.loadSnapshot(checkpoint);
  for (let i = 0; i < 12; i++) { original.step(); restored.step(); }
  assert.deepEqual(restored.snapshot(), original.snapshot());
});

test('failed snapshot load is transactional', () => {
  const sim = smallSimulation();
  const before = sim.snapshot();
  const invalid = sim.snapshot();
  invalid.U[0] = NaN;
  assert.throws(() => sim.loadSnapshot(invalid), /field values/);
  assert.deepEqual(sim.snapshot(), before);
});

test('Gray–Scott state and agent state stay finite and bounded', () => {
  const sim = smallSimulation({ size: 24 });
  for (let i = 0; i < 40; i++) sim.step();
  for (const field of [sim.U, sim.V]) {
    for (const value of field) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
  }
  for (const a of sim.agents) {
    assert.ok(Number.isFinite(a.energy) && a.energy >= 0 && a.energy <= 18);
    assert.ok(Number.isFinite(a.damage) && a.damage >= 0 && a.damage <= 1);
  }
});

test('toroidal Manhattan distance and movement agree across wrap boundaries', () => {
  assert.equal(cellIndex(-9, 0, 8), 7);
  assert.equal(cellIndex(0, -9, 8), 56);
  assert.equal(toroidalManhattanDistance({ x: 0, y: 0 }, { x: 7, y: 0 }, 8), 1);
  assert.equal(toroidalManhattanDistance({ x: 7, y: 0 }, { x: 0, y: 0 }, 8), 1);
  assert.equal(toroidalManhattanDistance({ x: 0, y: 0 }, { x: 7, y: 7 }, 8), 2);
  assert.deepEqual(moveToward(7, 0, 0, 0, 8, 1), { x: 0, y: 0 });
  assert.equal(toroidalManhattanDistance({ x: 7, y: 0 }, moveToward(7, 0, 0, 0, 8, 1), 8), 1);
});

test('motility provides a movement benefit with bounded per-tick distance', () => {
  const slowSteps = movementSteps(0.2);
  const fastSteps = movementSteps(2.2);
  assert.ok(fastSteps > slowSteps);
  const destination = moveToward(0, 0, 7, 7, 16, fastSteps);
  assert.ok(toroidalManhattanDistance({ x: 0, y: 0 }, destination, 16) <= fastSteps);
});

test('predation probability is always a valid probability', () => {
  for (const aggression of [0, 0.15, 1, 2.5, 100]) {
    for (const armor of [0, 0.15, 0.5, 2.5]) {
      const p = predationProbability(aggression, armor);
      assert.ok(Number.isFinite(p) && p >= 0 && p <= 1);
    }
  }
  assert.equal(predationProbability(2.5, 0.15), 1);
});

test('diffusion controls stay in range, guard timestep and do not require DV < DU', () => {
  const sim = smallSimulation();
  const high = sim.setDiffusionParameters({ DU: 0.30, DV: 0.25, DT: 0.8 });
  assert.equal(high.DU, DIFFUSION_LIMITS.DU_MAX);
  assert.equal(high.DV, DIFFUSION_LIMITS.DV_MAX);
  assert.ok(high.DT <= 0.8 / (4 * 0.30));
  assert.equal(high.requestedDT, 0.8);
  const lowerDiffusion = sim.setDiffusionParameters({ DU: 0.10, DV: 0.20 });
  assert.equal(lowerDiffusion.DV, 0.20);
  assert.ok(lowerDiffusion.DV > lowerDiffusion.DU);
  assert.equal(lowerDiffusion.DT, 0.8, 'reducing diffusion restores the fixed requested timestep');
  assert.equal(lowerDiffusion.requestedDT, 0.8);
  assert.throws(() => sim.setDiffusionParameters({ DT: 0.1, DU: NaN }));
  assert.equal(sim.requestedDT, 0.8, 'failed settings updates do not partially change the requested timestep');
});

test('F/K controls clamp to the supported parameter ranges', () => {
  const sim = smallSimulation();
  assert.deepEqual(sim.setReactionParameters({ F: 99, K: -2 }), { F: 0.09, K: 0.03 });
});

test('smaller timestep improves one fixed Gray–Scott convergence check at equal simulated time', () => {
  function initial() {
    const sim = smallSimulation({ size: 16, initialHerbivores: 0, initialCarnivores: 0 });
    sim.parameters.F = 0;
    sim.parameters.K = 0;
    sim.parameters.DU = 0.08;
    sim.parameters.DV = 0.04;
    for (let y = 0; y < sim.size; y++) {
      for (let x = 0; x < sim.size; x++) {
        const i = y * sim.size + x;
        sim.U[i] = 0.75 + 0.01 * Math.sin(2 * Math.PI * x / sim.size);
        sim.V[i] = 0.10 + 0.02 * Math.cos(2 * Math.PI * y / sim.size);
      }
    }
    return sim;
  }
  function evolve(dt, steps) {
    const sim = initial();
    sim.setDiffusionParameters({ DT: dt });
    for (let i = 0; i < steps; i++) sim.simulateSubstrate();
    return { U: sim.U, V: sim.V };
  }
  const coarse = evolve(0.1, 2);
  const medium = evolve(0.05, 4);
  const reference = evolve(0.00625, 32);
  const error = result => {
    let sum = 0;
    for (let i = 0; i < result.U.length; i++) sum += (result.U[i] - reference.U[i]) ** 2 + (result.V[i] - reference.V[i]) ** 2;
    return Math.sqrt(sum / (2 * result.U.length));
  };
  assert.ok(error(medium) < error(coarse));
  // One-point convergence sanity check; not a full nonlinear stability proof.
});

test('runs with different DT can advance to equal recorded substrate time', () => {
  const options = { size: 8, initialHerbivores: 0, initialCarnivores: 0, seasonalForcing: false, telemetryInterval: 1 };
  const coarse = smallSimulation(options);
  const fine = smallSimulation(options);
  coarse.setDiffusionParameters({ DT: 0.1 });
  fine.setDiffusionParameters({ DT: 0.05 });
  const coarseResult = coarse.advanceToSimulatedTime(0.23);
  const fineResult = fine.advanceToSimulatedTime(0.23);
  assert.ok(Math.abs(coarseResult.simulatedTime - 0.23) < 1e-12);
  assert.ok(Math.abs(fineResult.simulatedTime - 0.23) < 1e-12);
  assert.equal(coarseResult.ticksAdvanced, 3);
  assert.equal(fineResult.ticksAdvanced, 5);
  assert.ok(Math.abs(coarse.history.at(-1).simulatedTime - 0.23) < 1e-12);
  assert.ok(Math.abs(fine.snapshot().simulatedTime - 0.23) < 1e-12);
  assert.equal(coarse.parameters.DT, 0.1, 'partial final step does not alter the ongoing guarded timestep');
});

test('age-related damage is nonnegative, monotone and bounded for longevity up to 2.5', () => {
  for (const longevity of [0.15, 1, 2, 2.5]) {
    const increment = damageIncrement(longevity);
    assert.ok(increment >= 0);
    let previous = 0.25;
    for (let i = 0; i < 100; i++) {
      const next = advanceDamage(previous, longevity);
      assert.ok(next >= previous && next <= 1);
      previous = next;
    }
  }
  assert.equal(damageIncrement(2.5), 0);
  assert.equal(damageIncrement(1), 0.0032);
  assert.ok(damageIncrement(1) >= damageIncrement(2));
  assert.equal(advanceDamage(0.99, 1), 0.9932);
  assert.equal(applyReproductiveDamage(0.9999), 1);
});

test('reproductive wear is charged once at birth, not repeated from cumulative births', () => {
  const sim = smallSimulation({ size: 8, initialHerbivores: 0, initialCarnivores: 0 });
  const parentA = agent({ id: 1, x: 1, y: 1, stage: 'mature', energy: 12 });
  const parentB = agent({ id: 2, x: 2, y: 1, stage: 'mature', energy: 12 });
  sim.agents = [parentA, parentB];
  sim.rng.next = () => 0.99999;

  sim.reproduceSimultaneously();
  assert.equal(parentA.reproductions, 1);
  assert.equal(parentB.reproductions, 1);
  assert.equal(parentA.damage, 0.00045);
  assert.equal(parentB.damage, 0.00045);

  for (let i = 0; i < 5; i++) sim.ageAndSelect();
  const expected = 0.00045 + 5 * damageIncrement(1);
  assert.ok(Math.abs(parentA.damage - expected) < 1e-12);
  assert.ok(Math.abs(parentB.damage - expected) < 1e-12);
});

test('birth cap counts living agents after same-tick deaths, not retained corpses', () => {
  const sim = smallSimulation({ size: 8, initialHerbivores: 0, initialCarnivores: 0, maxPopulation: 3 });
  const parentA = agent({ id: 1, x: 1, y: 1, diet: 0.1, stage: 'mature', energy: 12 });
  const parentB = agent({ id: 2, x: 2, y: 1, diet: 0.1, stage: 'mature', energy: 12 });
  const corpse = { ...agent({ id: 3, x: 3, y: 3 }), dead: true };
  sim.agents = [parentA, parentB, corpse];
  sim.nextId = 4;
  sim.rng.next = () => 0.99999;
  sim.reproduceSimultaneously();
  assert.equal(sim.agents.filter(item => !item.dead).length, 3);
  assert.equal(sim.agents.length, 4, 'the dead record may remain until normal tick cleanup');
});

test('new infections cannot transmit again during the same epidemiology update', () => {
  const sim = smallSimulation({ size: 8, initialHerbivores: 0, initialCarnivores: 0 });
  sim.tick = 17;
  sim.agents = [
    agent({ id: 1, x: 0, y: 0, compartment: 'I' }),
    agent({ id: 2, x: 1, y: 0, compartment: 'S' }),
    agent({ id: 3, x: 2, y: 0, compartment: 'S' })
  ];
  sim.agents[0].infectionTime = 4;
  sim.parameters.beta = 10;
  sim.parameters.recoveryProbability = 0;
  sim.parameters.diseaseMortalityProbability = 0;
  sim.updateEpidemiology();
  assert.equal(sim.agents.find(a => a.id === 2).compartment, 'I');
  assert.equal(sim.agents.find(a => a.id === 2).infectionTime, 17);
  assert.equal(sim.agents.find(a => a.id === 3).compartment, 'S');
  assert.equal(sim.agents.find(a => a.id === 1).infectionTime, 4);
});

test('a recovered predator cannot be reinfected by consuming infected prey', () => {
  const sim = smallSimulation({ size: 8, initialHerbivores: 0, initialCarnivores: 0 });
  const recoveredPredator = agent({ id: 1, x: 0, y: 0, diet: 0.8, compartment: 'R', energy: 10 });
  const infectedPrey = agent({ id: 2, x: 0, y: 0, diet: 0.1, compartment: 'I', energy: 4 });
  sim.agents = [recoveredPredator, infectedPrey];
  sim.rng.next = () => 0;
  sim.feedSimultaneously();
  assert.equal(infectedPrey.dead, true);
  assert.equal(recoveredPredator.compartment, 'R');
});

test('agents retain bounded private observations and juveniles copy shared cues simultaneously', () => {
  const sim = smallSimulation({ size: 8, initialHerbivores: 0, initialCarnivores: 0 });
  sim.V.fill(0.6);
  const teacher = agent({ id: 1, x: 2, y: 2, stage: 'mature', energy: 6, culture: new Array(8).fill(0.8) });
  const student = agent({ id: 2, x: 2, y: 2 });
  sim.agents = [teacher, student];
  sim.behaveAndMove();
  assert.ok(student.memory.some(value => value > 0));
  const learned = sim.learnSimultaneously();
  assert.equal(learned, 1);
  assert.ok(student.culture.every(value => value > 0.07 && value < 0.09));
  assert.ok(teacher.culture.every(value => value > 0.79 && value < 0.81));
  assert.ok(sim.statistics().memorySignal > 0);
  assert.ok(sim.statistics().sharedCueSignal > 0);
});

test('checkpoint loading rejects corrupt agent identities, learning arrays, parameters and telemetry transactionally', () => {
  const sim = smallSimulation();
  const invalidCases = [
    snapshot => { snapshot.agents[0].energy = NaN; },
    snapshot => { snapshot.agents[1].id = snapshot.agents[0].id; },
    snapshot => { snapshot.agents[0].memory[0] = 2; },
    snapshot => { snapshot.agents[0].unexpected = true; },
    snapshot => { snapshot.agents[0].traits.unexpected = 1; },
    snapshot => { snapshot.config.unexpected = true; },
    snapshot => { snapshot.nextId = 1; },
    snapshot => { snapshot.seed = 'not-a-seed'; },
    snapshot => { snapshot.config.seed = (snapshot.config.seed + 1) >>> 0; },
    snapshot => { snapshot.temperature = NaN; },
    snapshot => { snapshot.history[0].meanU = NaN; },
    snapshot => { snapshot.parameters.DU = 50; }
  ];
  for (const corrupt of invalidCases) {
    const before = sim.snapshot();
    const invalid = sim.snapshot();
    corrupt(invalid);
    assert.throws(() => sim.loadSnapshot(invalid));
    assert.deepEqual(sim.snapshot(), before);
  }
});

test('simulation rejects invalid option bounds that can disable recording or exhaust browser resources', () => {
  assert.throws(() => new Simulation({ telemetryInterval: 0 }), /telemetryInterval/);
  assert.throws(() => new Simulation({ size: 257 }), /resource limit/);
  assert.throws(() => new Simulation({ seed: -1 }), /unsigned 32-bit/);
  assert.throws(() => new Simulation({ unexpected: true }), /Unknown configuration field/);
});

test('herbivore intake is allocated simultaneously and independent of array order', () => {
  function run(order) {
    const sim = smallSimulation({ size: 8, initialHerbivores: 0, initialCarnivores: 0, grazingRate: 0.22 });
    sim.V.fill(0);
    sim.V[0] = 0.3;
    const grazers = [
      agent({ id: 1, x: 0, y: 0, energy: 1, efficiency: 0.8 }),
      agent({ id: 2, x: 0, y: 0, energy: 1, efficiency: 1.0 }),
      agent({ id: 3, x: 0, y: 0, energy: 1, efficiency: 1.2 })
    ];
    sim.agents = order === 'forward' ? grazers : [...grazers].reverse();
    sim.feedSimultaneously();
    return { energy: Object.fromEntries(sim.agents.map(a => [a.id, a.energy])), remainingV: sim.V[0] };
  }
  assert.deepEqual(run('forward'), run('reverse'));
  assert.equal(run('forward').remainingV, 0);
});

test('fixed permutation preserves each spatial cell temporal trace and each frame mean', () => {
  const frames = [
    Float32Array.from([0.1, 0.2, 0.3, 0.4]),
    Float32Array.from([0.5, 0.6, 0.7, 0.8]),
    Float32Array.from([0.9, 0.15, 0.25, 0.35])
  ];
  const permutation = [2, 0, 3, 1];
  const { controlFrames, permutedFrames } = createFixedPermutationConditions(frames, permutation);
  for (let t = 0; t < frames.length; t++) {
    assert.ok(Math.abs(controlFrames[t].reduce((a, b) => a + b, 0) - permutedFrames[t].reduce((a, b) => a + b, 0)) < 1e-6);
    for (let destination = 0; destination < permutation.length; destination++) {
      assert.equal(permutedFrames[t][destination], frames[t][permutation[destination]]);
    }
  }
  for (let destination = 0; destination < permutation.length; destination++) {
    const source = permutation[destination];
    assert.deepEqual(permutedFrames.map(frame => frame[destination]), frames.map(frame => frame[source]));
  }
  assert.throws(() => createFixedPermutationConditions([Float32Array.from([0, NaN, 0, 1])], permutation), /finite and in \[0, 1\]/);
});

test('U continues its substrate response while V is supplied exogenously', () => {
  const sim = smallSimulation({ size: 8, initialHerbivores: 0, initialCarnivores: 0 });
  sim.U.fill(1); sim.U2.fill(1); sim.V.fill(0); sim.V2.fill(0);
  const frame = new Float32Array(sim.area).fill(1);
  sim.step({ exogenousVFrame: frame });
  assert.ok(sim.U.every(value => Math.abs(value - 0.2) < 1e-6));
  assert.ok(sim.V.every(value => value === 1));
  assert.ok(frame.every(value => value === 1), 'the caller-owned V frame is unchanged');
  assert.equal(sim.simulatedTime, sim.parameters.DT);
});

test('paired arrangement comparison uses a pre-generated exogenous V(t) sequence', () => {
  const frames = Array.from({ length: 3 }, (_, t) => Float32Array.from({ length: 64 }, (_, i) => ((i * 3 + t * 7) % 20) / 20));
  const result = runFixedPermutationArrangementComparison({
    frames,
    permutationSeed: 88,
    simulationOptions: { size: 8, seed: 99, initialHerbivores: 6, initialCarnivores: 2, initialInfectionCount: 0 }
  });
  assert.match(result.design, /pre-generated exogenous V\(t\)/);
  assert.equal(result.controlSeries.length, frames.length);
  assert.equal(result.rearrangedSeries.length, frames.length);
  assert.equal(new Set(result.permutation).size, 64);
  assert.equal(result.controlSnapshot.tick, 3);
  assert.equal(result.rearrangedSnapshot.tick, 3);
});

test('invalid exogenous frames are rejected without advancing the simulation', () => {
  const sim = smallSimulation({ size: 8, initialHerbivores: 0, initialCarnivores: 0 });
  const before = sim.snapshot();
  const invalid = new Float32Array(sim.area);
  invalid[0] = NaN;
  assert.throws(() => sim.step({ exogenousVFrame: invalid }), /finite and in \[0, 1\]/);
  assert.deepEqual(sim.snapshot(), before);
});

test('exogenous V sequence generator accepts its helper-only steps option', () => {
  const frames = generateExogenousVSequence({ steps: 2, size: 8, seed: 99, vReseedRate: 0 });
  assert.equal(frames.length, 2);
  assert.equal(frames[0].length, 64);
  assert.ok(frames.every(frame => frame.every(value => Number.isFinite(value) && value >= 0 && value <= 1)));
});

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

test('parameter preset library round-trips parameters and seed only', () => {
  const storage = new MemoryStorage();
  const library = new ParameterPresetLibrary(storage);
  const sim = smallSimulation();
  sim.setReactionParameters({ F: 0.04, K: 0.06 });
  sim.setDiffusionParameters({ DU: 0.20, DV: 0.10 });
  const saved = library.saveCurrent('  local test  ', sim, '2026-10-15T00:00:00.000Z');
  assert.equal(saved.name, 'local test');
  assert.equal(library.list().length, 1);
  const exported = library.exportJSON('local test');
  const restored = parseParameterPresetJSON(exported);
  assert.deepEqual(restored, saved);
  assert.equal(Object.hasOwn(restored, 'agents'), false);
  assert.equal(Object.hasOwn(restored, 'U'), false);
  const imported = library.importJSON(exported);
  assert.deepEqual(imported, saved);
  assert.equal(library.list().length, 1, 'import replaces same-name preset rather than duplicating it');
});

test('invalid preset imports are rejected without storage or world mutation', () => {
  const storage = new MemoryStorage();
  const library = new ParameterPresetLibrary(storage);
  const sim = smallSimulation();
  const valid = captureParameterPreset('valid', sim, '2026-10-15T00:00:00.000Z');
  library.upsert(valid);
  const storedBefore = storage.getItem(library.key);
  const stateBefore = sim.snapshot();
  assert.throws(() => library.importJSON('{bad json'), /valid JSON/);
  assert.throws(() => library.importJSON(JSON.stringify({ ...valid, DU: 50 })), /outside the supported ranges/);
  assert.throws(() => applyParameterPreset(sim, { ...valid, F: 10 }), /outside the supported ranges/);
  assert.equal(storage.getItem(library.key), storedBefore);
  assert.deepEqual(sim.snapshot(), stateBefore);
});

test('applying a parameter preset performs a reproducible full reset at its recorded seed', () => {
  const sim = smallSimulation();
  for (let i = 0; i < 5; i++) sim.step();
  const preset = {
    type: PRESET_TYPE, version: 1, name: 'restart test', createdAt: '2026-10-15T00:00:00.000Z',
    seed: 98765, F: 0.03, K: 0.055, DU: 0.12, DV: 0.09, requestedDT: 0.8
  };
  applyParameterPreset(sim, preset);
  assert.equal(sim.tick, 0);
  assert.equal(sim.history.length, 1);
  assert.equal(sim.seed, preset.seed);
  const fresh = new Simulation({ ...sim.config, seed: preset.seed });
  assert.equal(sim.rng.snapshot(), fresh.rng.snapshot());
  assert.deepEqual(sim.snapshot(), fresh.snapshot());
});

test('preset library reports local storage write errors', () => {
  const failingStorage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  const library = new ParameterPresetLibrary(failingStorage);
  const sim = smallSimulation();
  assert.throws(() => library.saveCurrent('storage error', sim), /Could not write preset storage/);
});

test('baseline defaults keep seasonal F bounded and expose conservative grazing demand', () => {
  assert.equal(DEFAULTS.F, 0.0545);
  assert.equal(DEFAULTS.initialHerbivores, 20);
  assert.equal(DEFAULTS.initialCarnivores, 4);
  assert.equal(DEFAULTS.initialInfectionCount, 0);
  assert.equal(DEFAULTS.grazingRate, 0.01);
  const sim = smallSimulation({ size: 8, F: 0.09, initialHerbivores: 0, initialCarnivores: 0 });
  assert.equal(sim.seasonalForcingAt(225).F, 0.09);
  assert.ok(Array.from({ length: 901 }, (_, tick) => sim.seasonalForcingAt(tick).F).every(value => value <= 0.09));

  sim.V.fill(0);
  sim.V[0] = 0.3;
  sim.agents = [1, 2, 3].map(id => agent({ id, x: 0, y: 0, energy: 1 }));
  sim.feedSimultaneously();
  assert.ok(Math.abs(sim.V[0] - 0.27) < 1e-6, 'default grazing demand removes only 0.01 per grazer');
});

test('V reseeding is off by default, deterministic when enabled, and bypassed for exogenous frames', () => {
  assert.equal(DEFAULTS.vReseedRate, 0);
  const baselineA = smallSimulation({ size: 8, initialHerbivores: 0, initialCarnivores: 0 });
  const baselineB = smallSimulation({ size: 8, initialHerbivores: 0, initialCarnivores: 0, vReseedRate: 0 });
  baselineA.step(); baselineB.step();
  assert.deepEqual(baselineA.snapshot(), baselineB.snapshot());

  const enabledA = smallSimulation({ size: 8, initialHerbivores: 0, initialCarnivores: 0, vReseedRate: 0.02 });
  const enabledB = smallSimulation({ size: 8, initialHerbivores: 0, initialCarnivores: 0, vReseedRate: 0.02 });
  for (const sim of [enabledA, enabledB]) {
    sim.U.fill(1); sim.U2.fill(1); sim.V.fill(0); sim.V2.fill(0);
    sim.step({ exogenousVFrame: new Float32Array(sim.area) });
    assert.equal(sim.V.reduce((sum, value) => sum + value, 0), 0, 'exogenous frames are used as supplied');
    sim.step();
  }
  assert.deepEqual(enabledA.snapshot(), enabledB.snapshot());
  assert.ok(Math.abs(enabledA.V.reduce((sum, value) => sum + value, 0) - 0.02) < 1e-6);
  assert.throws(() => enabledA.setVReseedRate(0.021), /\[0, 0\.02\]/);
});

test('extinction records the exact terminal tick even between regular telemetry intervals', () => {
  const sim = smallSimulation({ size: 8, initialHerbivores: 0, initialCarnivores: 0, telemetryInterval: 10 });
  sim.agents = [agent({ id: 1, x: 0, y: 0, diet: 0.8, energy: 0 })];
  sim.nextId = 2;
  sim.V.fill(0);
  sim.step();
  assert.equal(sim.agents.length, 0);
  assert.equal(sim.history.at(-1).tick, 1);
  assert.equal(sim.history.at(-1).total, 0);
});

test('frozen baseline seed suite records survival through a fixed 100-tick persistence window', () => {
  const seeds = [20261015, 20261016, 20261017, 20261018, 20261019];
  const horizon = 1200;
  const persistenceTicks = 100;
  const outcomes = seeds.map(seed => {
    const sim = new Simulation({ seed });
    const finalWindow = [];
    for (let tick = 1; tick <= horizon; tick++) {
      if (sim.agents.length === 0) break;
      sim.step();
      if (tick > horizon - persistenceTicks) finalWindow.push(sim.agents.length);
    }
    return sim.tick === horizon && finalWindow.length === persistenceTicks && finalWindow.every(total => total > 0);
  });
  assert.equal(outcomes[0], true, 'the disclosed default seed must persist through tick 1,200');
  assert.equal(outcomes.filter(Boolean).length, 1, 'exactly one of the five frozen seeds meets the criterion');
});

test('local checkpoints use the v4 key and enforce a 4 MiB limit on save and load', () => {
  const storage = new MemoryStorage();
  const sim = smallSimulation();
  sim.saveToStorage(storage);
  assert.ok(storage.getItem('infiniteBecoming.synthetic.v4'));
  assert.equal(storage.getItem('infiniteBecoming.synthetic.v3'), null);
  const restored = smallSimulation();
  assert.equal(restored.loadFromStorage(storage), true);
  assert.deepEqual(restored.snapshot(), sim.snapshot());

  const oversized = smallSimulation();
  oversized.history = [{ payload: 'x'.repeat(4 * 1024 * 1024) }];
  assert.throws(() => oversized.saveToStorage(new MemoryStorage()), /4 MiB/);
  const oversizedStorage = new MemoryStorage();
  oversizedStorage.setItem('infiniteBecoming.synthetic.v4', 'x'.repeat(4 * 1024 * 1024 + 1));
  assert.throws(() => restored.loadFromStorage(oversizedStorage), /4 MiB/);
});

test('step skips full statistics unless the caller requests them', () => {
  const sim = smallSimulation({ telemetryInterval: 1000 });
  const originalStatistics = sim.statistics.bind(sim);
  let calls = 0;
  sim.statistics = () => { calls++; return originalStatistics(); };
  assert.equal(sim.step(), undefined);
  assert.equal(calls, 0);
  const result = sim.step({ includeStatistics: true });
  assert.equal(calls, 1);
  assert.equal(result.tick, 2);
});

test('UI exposes reduced-motion, canvas, keyboard and readable-control accessibility', () => {
  const html = readFileSync(require.resolve('../index.html'), 'utf8');
  const app = readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(app, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
  assert.match(html, /http-equiv="Content-Security-Policy"[^>]*script-src 'self'/);
  assert.match(html, /<script src="\.\/app\.js"><\/script>/);
  assert.doesNotMatch(html, /<script>\s*[\s\S]*?<\/script>/);
  assert.match(html, /href="\.\/app\.js">UI<\/a>/);
  assert.match(html, /id="world" role="img" tabindex="0"[^>]*aria-describedby="world-summary"/);
  assert.match(html, /id="world-summary" class="sr-only" aria-live="polite"/);
  assert.match(app, /canvas\.addEventListener\('keydown'/);
  assert.match(app, /selectAgentByKeyboard\(event\.key\)/);
  assert.match(app, /All agents are dead\. Simulation paused; final chart and state are preserved\./);
  assert.match(html, /aria-pressed="false"/);
  assert.match(app, /setAttribute\('aria-pressed', String\(running\)\)/);

  for (const id of ['feed-rate', 'kill-rate', 'diff-u', 'diff-v', 'v-reseed', 'speed']) {
    assert.match(html, new RegExp(`<label for="${id}">`), `missing associated label for ${id}`);
    const input = html.match(new RegExp(`<input id="${id}"[^>]*>`))?.[0];
    assert.ok(input, `missing range input ${id}`);
    assert.doesNotMatch(input, /aria-label/, `${id} should inherit its matching visible label`);
  }
  assert.match(app, /\$\('base-fk'\)\.textContent = `\$\{sim\.parameters\.F\.toFixed\(4\)\} \/ \$\{sim\.parameters\.K\.toFixed\(4\)\}`/);
  assert.match(app, /\$\('feed-value'\)\.textContent = sim\.parameters\.F\.toFixed\(4\)/);
  assert.match(app, /\$\('kill-value'\)\.textContent = sim\.parameters\.K\.toFixed\(4\)/);
  const fontSizes = [...`${html}\n${app}`.matchAll(/(?:font-size\s*:\s*|font\s*:\s*|chartCtx\.font\s*=\s*['"])(\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]));
  assert.ok(fontSizes.length > 0 && fontSizes.every(size => size >= 12), `text sizes below 12 px found: ${fontSizes.join(', ')}`);
});

test('README accurately scopes determinism, controls, JSON workflow and model claims', () => {
  const readme = readFileSync(require.resolve('../README.md'), 'utf8');
  const html = readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(readme, /within the same browser engine/);
  assert.match(readme, /\*\*Δt\*\* are displayed but have no direct slider/);
  assert.match(readme, /does not import world-checkpoint JSON/);
  assert.match(readme, /parameter-preset JSON imports are checked/i);
  assert.match(readme, /diffusion-only limit/);
  assert.match(readme, /small bounded, phase-aligned F\/K modulation/);
  assert.match(readme, /observed result is \*\*1\/5 seeds \(20%\)\*\*/);
  assert.match(readme, /not a general ecological viability estimate/);
  assert.equal((readme.match(/consciousness/gi) ?? []).length, 1);
  assert.equal((html.match(/consciousness/gi) ?? []).length, 1);
  assert.doesNotMatch(html, /<input[^>]+id="dt/);
});

test('repository metadata declares local AGPL-only testing and Spark attribution', () => {
  const packageJson = JSON.parse(readFileSync(require.resolve('../package.json'), 'utf8'));
  const zenodo = JSON.parse(readFileSync(require.resolve('../.zenodo.json'), 'utf8'));
  const citation = readFileSync(require.resolve('../CITATION.cff'), 'utf8');
  const workflow = readFileSync(require.resolve('../.github/workflows/test.yml'), 'utf8');
  const license = readFileSync(require.resolve('../LICENSE'), 'utf8');
  const sources = ['../model.js', '../preset-library.js', '../app.js', '../index.html', '../tests/model.test.js']
    .map(path => readFileSync(require.resolve(path), 'utf8'));

  assert.equal(packageJson.private, true);
  assert.equal(packageJson.license, 'AGPL-3.0-only');
  assert.equal(packageJson.scripts.test, 'node --test tests/model.test.js');
  assert.equal(packageJson.dependencies, undefined, 'runtime dependency list stays empty');
  assert.match(workflow, /node-version: \[20, 22\]/);
  assert.match(workflow, /npm test/);
  assert.deepEqual(zenodo.creators.map(creator => creator.name), ['Spark']);
  assert.match(citation, /- name: "Spark"/);
  assert.match(citation, /license: "AGPL-3\.0-only"/);
  assert.deepEqual([...citation.matchAll(/^\s*- name:\s*"?(.+?)"?\s*$/gm)].map(match => match[1]), ['Spark']);
  assert.ok(license.length > 34000 && license.includes('GNU AFFERO GENERAL PUBLIC LICENSE'));
  for (const source of sources) assert.match(source, /SPDX-License-Identifier: AGPL-3\.0-only/);
});
