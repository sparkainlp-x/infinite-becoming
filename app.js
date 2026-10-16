// SPDX-License-Identifier: AGPL-3.0-only
    (() => {
      'use strict';
      const { Simulation, DEFAULTS, REACTION_LIMITS, DIFFUSION_LIMITS } = window.SyntheticEcoModel;
      const { ParameterPresetLibrary, applyParameterPreset } = window.SyntheticEcoPresets;
      const $ = id => document.getElementById(id);
      const canvas = $('world');
      const ctx = canvas.getContext('2d', { alpha: false });
      const sim = new Simulation();
      const fieldCanvas = document.createElement('canvas');
      const fieldCtx = fieldCanvas.getContext('2d', { alpha: false });
      let fieldImageData;
      function ensureFieldBuffer() {
        if (fieldCanvas.width !== sim.size || fieldCanvas.height !== sim.size || !fieldImageData) {
          fieldCanvas.width = sim.size;
          fieldCanvas.height = sim.size;
          fieldImageData = fieldCtx.createImageData(sim.size, sim.size);
        }
      }
      let presetLibrary;
      try { presetLibrary = new ParameterPresetLibrary(window.localStorage); }
      catch { presetLibrary = new ParameterPresetLibrary(null); }
      const BUILTIN_PRESETS = {
        'set-a': { name: 'Set A', F: 0.0282, K: 0.0541, DU: 0.16, DV: 0.08 },
        'set-b': { name: 'Set B', F: 0.058, K: 0.065, DU: 0.16, DV: 0.08 },
        'set-c': { name: 'Set C', F: 0.029, K: 0.057, DU: 0.16, DV: 0.08 },
        'set-d': { name: 'Set D', F: 0.0545, K: 0.062, DU: 0.16, DV: 0.08 },
        'set-e': { name: 'Set E', F: 0.0367, K: 0.0649, DU: 0.16, DV: 0.08 },
        'set-f': { name: 'Set F', F: 0.0208, K: 0.0576, DU: 0.16, DV: 0.08 },
        'set-g': { name: 'Set G', F: 0.09, K: 0.059, DU: 0.16, DV: 0.08 },
        'set-h': { name: 'Set H', F: 0.062, K: 0.0609, DU: 0.16, DV: 0.08 },
        baseline: { name: 'Baseline', F: 0.0545, K: 0.062, DU: 0.16, DV: 0.08 }
      };
      const BUILTIN_REQUESTED_DT = DEFAULTS.DT;
      const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
      let running = !motionPreference.matches;
      let speed = 1;
      let selectedId = null;
      let lastSummaryTick = -1;
      let message = 'Synthetic model initialized. All state remains local unless you export it.';

      function setLog(text) { message = text; $('log').textContent = `[t=${sim.tick}] ${text}`; }
      function syncPauseButton() {
        const button = $('pause');
        button.textContent = running ? 'Pause' : 'Resume';
        button.setAttribute('aria-pressed', String(running));
      }
      function fitCanvas() {
        const rect = canvas.getBoundingClientRect();
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        canvas.width = Math.max(1, Math.round(rect.width * dpr));
        canvas.height = Math.max(1, Math.round(rect.height * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      function draw() {
        const rect = canvas.getBoundingClientRect();
        const w = rect.width, h = rect.height;
        ctx.fillStyle = '#03060b';
        ctx.fillRect(0, 0, w, h);
        const cell = Math.min(w, h) / sim.size;
        const ox = (w - cell * sim.size) / 2;
        const oy = (h - cell * sim.size) / 2;
        ensureFieldBuffer();
        const pixels = fieldImageData.data;
        for (let i = 0; i < sim.area; i++) {
          const u = sim.U[i], v = sim.V[i], offset = i * 4;
          pixels[offset] = Math.max(0, Math.min(255, 5 + 22 * u - 7 * v)) | 0;
          pixels[offset + 1] = Math.max(0, Math.min(255, 10 + 185 * v - 8 * u)) | 0;
          pixels[offset + 2] = Math.max(0, Math.min(255, 25 + 72 * v + 28 * u)) | 0;
          pixels[offset + 3] = 255;
        }
        fieldCtx.putImageData(fieldImageData, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(fieldCanvas, ox, oy, cell * sim.size, cell * sim.size);
        for (const a of sim.agents) {
          const px = ox + (a.x + 0.5) * cell;
          const py = oy + (a.y + 0.5) * cell;
          const radius = Math.max(2, cell * 0.22);
          ctx.fillStyle = a.compartment === 'I' ? '#ffd36a' : a.compartment === 'R' ? '#78adff' : a.diet < 0.5 ? '#65dda8' : '#ff817e';
          ctx.beginPath();
          if (a.diet < 0.5) ctx.arc(px, py, radius, 0, Math.PI * 2);
          else { ctx.moveTo(px, py - radius * 1.3); ctx.lineTo(px + radius * 1.2, py + radius); ctx.lineTo(px - radius * 1.2, py + radius); ctx.closePath(); }
          ctx.fill();
          if (a.id === selectedId) {
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, py, radius + 4, 0, Math.PI * 2); ctx.stroke();
          }
        }
      }
      function updateUI() {
        const s = sim.statistics();
        $('herb').textContent = s.herbivores;
        $('carn').textContent = s.carnivores;
        $('total').textContent = s.total;
        $('sus').textContent = s.susceptible;
        $('infected').textContent = s.infected;
        $('recovered').textContent = s.recovered;
        $('prevalence').textContent = `${(100 * s.infectionPrevalence).toFixed(1)}%`;
        $('age-structure').textContent = `${s.juveniles} / ${s.mature} / ${s.elders}`;
        $('birth-death').textContent = `${s.totalBirths} / ${s.totalDeaths}`;
        $('mean-u').textContent = s.meanU.toFixed(3);
        $('mean-v').textContent = s.meanV.toFixed(3);
        $('memory-signal').textContent = s.memorySignal.toFixed(3);
        $('culture-signal').textContent = s.sharedCueSignal.toFixed(3);
        for (const [key, id] of [['efficiency','trait-eff'], ['sense','trait-sense'], ['motility','trait-motility'], ['armor','trait-armor'], ['longevity','trait-longevity'], ['aggression','trait-aggression']]) {
          const t = s.traits[key]; $(id).textContent = s.total ? `${t.mean.toFixed(2)} ± ${t.sd.toFixed(2)}` : '—';
        }
        $('tick').textContent = sim.tick;
        $('sim-time').textContent = s.simulatedTime.toFixed(3);
        $('season').textContent = s.season;
        $('temperature').textContent = `${s.temperature.toFixed(1)}°C`;
        const forcing = sim.seasonalForcingAt();
        $('base-fk').textContent = `${sim.parameters.F.toFixed(4)} / ${sim.parameters.K.toFixed(4)}`;
        $('fk').textContent = `${forcing.F.toFixed(4)} / ${forcing.K.toFixed(4)}`;
        $('feed-value').textContent = sim.parameters.F.toFixed(4);
        $('kill-value').textContent = sim.parameters.K.toFixed(4);
        $('feed-rate').value = sim.parameters.F;
        $('kill-rate').value = sim.parameters.K;
        $('v-reseed').value = sim.config.vReseedRate;
        $('v-reseed-value').textContent = sim.config.vReseedRate.toFixed(3);
        $('du-value').textContent = sim.parameters.DU.toFixed(3);
        $('dv-value').textContent = sim.parameters.DV.toFixed(3);
        $('diff-u').value = sim.parameters.DU;
        $('diff-v').value = sim.parameters.DV;
        const diffusion = sim.diffusionDiagnostics();
        $('diff-ratio').textContent = diffusion.ratio.toFixed(2);
        $('diff-dt').textContent = `${diffusion.requestedDT.toFixed(3)} / ${diffusion.DT.toFixed(3)}`;
        $('diff-ceiling').textContent = `${diffusion.diffusionOnlyLimit.toFixed(3)} / ${diffusion.guardedCeiling.toFixed(3)}`;
        $('seed').textContent = sim.seed;
        const a = sim.agents.find(item => item.id === selectedId);
        if (!a) selectedId = null;
        $('selected-id').textContent = a ? `${a.id} / ${a.lineage}` : '—';
        $('selected-role').textContent = a ? `${a.diet < 0.5 ? 'Herbivore-role' : 'Carnivore-role'} / ${a.compartment}` : '—';
        $('selected-energy').textContent = a ? `${a.energy.toFixed(2)} / ${a.age}` : '—';
        $('selected-damage').textContent = a ? `${(100 * a.damage).toFixed(1)}% / ${(165 * a.traits.longevity).toFixed(0)} ticks` : '—';
        $('selected-traits').textContent = a ? [a.traits.efficiency, a.traits.sense, a.traits.motility, a.traits.armor, a.traits.longevity, a.traits.aggression].map(x => x.toFixed(2)).join(' · ') : '—';
        $('selected-repro').textContent = a ? a.reproductions : '—';
        if (sim.tick !== lastSummaryTick && (sim.tick === 0 || sim.tick % sim.config.telemetryInterval === 0 || s.total === 0)) {
          $('world-summary').textContent = `Tick ${sim.tick}, ${s.season}: ${s.total} agents, including ${s.herbivores} herbivore-role and ${s.carnivores} carnivore-role agents; ${s.infected} infected. Mean dimensionless U ${s.meanU.toFixed(3)}, V ${s.meanV.toFixed(3)}.`;
          lastSummaryTick = sim.tick;
        }
        drawPopulationChart();
      }
      function drawPopulationChart() {
        const chart = $('population-chart');
        const chartCtx = chart.getContext('2d');
        const width = chart.width, height = chart.height;
        chartCtx.clearRect(0, 0, width, height);
        const rows = sim.history;
        if (rows.length < 2) {
          chartCtx.strokeStyle = '#ffffff24';
          chartCtx.lineWidth = 1;
          chartCtx.beginPath();
          chartCtx.moveTo(18, 8); chartCtx.lineTo(18, height - 14);
          chartCtx.lineTo(width - 8, height - 14);
          chartCtx.stroke();
          chartCtx.fillStyle = '#91a0bf';
          chartCtx.font = '12px ui-sans-serif, system-ui, sans-serif';
          chartCtx.textAlign = 'center';
          chartCtx.textBaseline = 'middle';
          chartCtx.fillText('Collecting initial samples', width / 2, (height - 6) / 2);
          return;
        }
        let max = 1;
        for (const row of rows) max = Math.max(max, row.total);
        const points = Math.min(400, rows.length);
        for (const [key, color] of [['total', '#e5edf8'], ['herbivores', '#65dda8'], ['carnivores', '#ff817e']]) {
          chartCtx.strokeStyle = color; chartCtx.lineWidth = key === 'total' ? 1.6 : 1;
          chartCtx.beginPath();
          for (let index = 0; index < points; index++) {
            const row = rows[Math.floor(index * (rows.length - 1) / (points - 1))];
            const x = index / (points - 1) * (width - 2) + 1;
            const y = height - 2 - row[key] / max * (height - 6);
            if (index === 0) chartCtx.moveTo(x, y); else chartCtx.lineTo(x, y);
          }
          chartCtx.stroke();
        }
      }
      function refreshPresetList() {
        const select = $('preset-list');
        select.replaceChildren();
        try {
          const presets = presetLibrary.list().sort((a, b) => a.name.localeCompare(b.name));
          if (!presets.length) {
            const option = document.createElement('option'); option.value = ''; option.textContent = 'No saved parameter presets'; select.appendChild(option);
            return;
          }
          for (const preset of presets) {
            const option = document.createElement('option'); option.value = preset.name;
            option.textContent = `${preset.name} · seed ${preset.seed}`; select.appendChild(option);
          }
        } catch (error) {
          const option = document.createElement('option'); option.value = ''; option.textContent = 'Preset storage unavailable/invalid'; select.appendChild(option);
          setLog(`Preset library could not be read: ${error.message}`);
        }
      }
      function previewBuiltInPreset() {
        const values = BUILTIN_PRESETS[$('builtin-preset').value];
        $('builtin-preview').textContent = values
          ? `Selected — not applied: ${values.name} · seed ${DEFAULTS.seed} · F ${values.F.toFixed(4)} · K ${values.K.toFixed(4)} · DU ${values.DU.toFixed(3)} · DV ${values.DV.toFixed(3)} · requested Δt ${BUILTIN_REQUESTED_DT.toFixed(3)}.`
          : 'Unknown parameter set.';
      }
      function previewCustomPreset() {
        const name = $('preset-list').value;
        if (!name) { $('custom-preview').textContent = 'No custom preset selected. Imported presets are not applied until you choose Load & reset.'; return; }
        try {
          const preset = presetLibrary.get(name);
          $('custom-preview').textContent = preset
            ? `Selected — not applied: ${preset.name} · seed ${preset.seed} · F ${preset.F.toFixed(4)} · K ${preset.K.toFixed(4)} · DU ${preset.DU.toFixed(3)} · DV ${preset.DV.toFixed(3)} · requested Δt ${preset.requestedDT.toFixed(3)}. Parameter preset only; no world state.`
            : 'Selected preset is not available.';
        } catch (error) { $('custom-preview').textContent = `Preset preview unavailable: ${error.message}`; }
      }
      function applyBuiltInPreset() {
        const selected = $('builtin-preset').value;
        const values = BUILTIN_PRESETS[selected];
        if (!values) return setLog('Unknown built-in parameter set.');
        const payload = {
          type: window.SyntheticEcoPresets.PRESET_TYPE, version: 1,
          name: values.name, createdAt: new Date(0).toISOString(), seed: DEFAULTS.seed,
          F: values.F, K: values.K, DU: values.DU, DV: values.DV, requestedDT: BUILTIN_REQUESTED_DT
        };
        try {
          applyParameterPreset(sim, payload);
          selectedId = null; running = true; syncPauseButton();
          $('preset-status').textContent = `Applied ${values.name} · seed ${sim.seed}`;
          $('builtin-preview').textContent = `Applied ${values.name} · seed ${sim.seed} · F ${values.F.toFixed(4)} · K ${values.K.toFixed(4)} · DU ${values.DU.toFixed(3)} · DV ${values.DV.toFixed(3)}. Full world reset.`;
          setLog(`Applied ${values.name}; reset fields, agents, tick, history and PRNG to recorded seed ${sim.seed}.`);
          updateUI(); draw();
        } catch (error) { setLog(`Parameter set rejected: ${error.message}`); }
      }
      function tickOnce() {
        sim.step();
        if (sim.agents.length === 0) {
          running = false;
          syncPauseButton();
          setLog('All agents are dead. Simulation paused; final chart and state are preserved.');
          return false;
        }
        return true;
      }
      function chooseNewSeed() {
        const buffer = new Uint32Array(1);
        try { window.crypto.getRandomValues(buffer); return buffer[0]; }
        catch { return (Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0; }
      }
      function animate() {
        if (running) for (let i = 0; i < speed; i++) if (!tickOnce()) break;
        draw(); updateUI();
        requestAnimationFrame(animate);
      }
      function selectAgentByKeyboard(key) {
        const agents = [...sim.agents].sort((a, b) => a.id - b.id);
        if (!agents.length) { setLog('No living agents are available to select.'); return; }
        const current = agents.findIndex(agent => agent.id === selectedId);
        const direction = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
        const next = key === 'Home' ? 0 : key === 'End' ? agents.length - 1 :
          current < 0 ? (direction > 0 ? 0 : agents.length - 1) : (current + direction + agents.length) % agents.length;
        selectedId = agents[next].id;
        setLog(`Selected agent #${selectedId} with the keyboard.`);
        updateUI(); draw();
      }
      function download(name, content, type) {
        const url = URL.createObjectURL(new Blob([content], { type }));
        const link = document.createElement('a'); link.href = url; link.download = name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }

      canvas.addEventListener('click', event => {
        const rect = canvas.getBoundingClientRect();
        const cell = Math.min(rect.width, rect.height) / sim.size;
        const ox = (rect.width - cell * sim.size) / 2, oy = (rect.height - cell * sim.size) / 2;
        const x = Math.floor((event.clientX - rect.left - ox) / cell);
        const y = Math.floor((event.clientY - rect.top - oy) / cell);
        const target = sim.agents.find(a => a.x === x && a.y === y);
        selectedId = target ? target.id : null;
        if (target) setLog(`Selected agent #${target.id} (${target.compartment}).`);
        updateUI();
      });
      canvas.addEventListener('keydown', event => {
        if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        selectAgentByKeyboard(event.key);
      });
      $('pause').addEventListener('click', () => {
        running = !running; syncPauseButton();
      });
      $('step').addEventListener('click', () => {
        running = false; syncPauseButton();
        if (tickOnce()) setLog('Advanced one model tick.');
        updateUI(); draw();
      });
      $('reset').addEventListener('click', () => {
        sim.reset(); selectedId = null; running = true; syncPauseButton(); setLog('Reset fields, agents, tick, history and PRNG to the current seed; current parameters were retained.');
      });
      $('new-seed').addEventListener('click', () => {
        let nextSeed = chooseNewSeed();
        while (nextSeed === sim.seed) nextSeed = chooseNewSeed();
        sim.seed = nextSeed; sim.config.seed = nextSeed; sim.reset();
        selectedId = null; running = true; syncPauseButton();
        $('preset-status').textContent = `New deterministic seed · ${nextSeed}`;
        setLog(`Started a fresh run with seed ${nextSeed}; use Save state or Export JSON to preserve it.`);
        updateUI(); draw();
      });
      $('speed').addEventListener('input', event => {
        speed = Number(event.target.value); $('speed-label').textContent = `${speed}×`;
      });
      $('v-reseed').addEventListener('input', event => {
        try { sim.setVReseedRate(Number(event.target.value)); updateUI(); }
        catch (error) { setLog(`V reseed setting rejected: ${error.message}`); }
      });
      $('feed-rate').addEventListener('input', event => {
        sim.setReactionParameters({ F: Number(event.target.value) }); $('preset-status').textContent = 'Custom parameters in current run'; updateUI(); previewBuiltInPreset();
      });
      $('kill-rate').addEventListener('input', event => {
        sim.setReactionParameters({ K: Number(event.target.value) }); $('preset-status').textContent = 'Custom parameters in current run'; updateUI(); previewBuiltInPreset();
      });
      $('diff-u').addEventListener('input', event => {
        sim.setDiffusionParameters({ DU: Number(event.target.value) }); $('preset-status').textContent = 'Custom parameters in current run'; updateUI(); previewBuiltInPreset();
      });
      $('diff-v').addEventListener('input', event => {
        sim.setDiffusionParameters({ DV: Number(event.target.value) }); $('preset-status').textContent = 'Custom parameters in current run'; updateUI(); previewBuiltInPreset();
      });
      $('builtin-preset').addEventListener('change', previewBuiltInPreset);
      $('apply-builtin').addEventListener('click', applyBuiltInPreset);
      $('save').addEventListener('click', () => {
        try { sim.saveToStorage(); $('preset-status').textContent = 'Full world checkpoint saved'; setLog('Saved complete world checkpoint, including PRNG state, in this browser.'); }
        catch (error) { setLog(`Save failed: ${error.message}`); }
      });
      $('load').addEventListener('click', () => {
        try {
          if (!sim.loadFromStorage()) setLog('No local checkpoint was found.');
          else { selectedId = null; $('preset-status').textContent = 'Full world checkpoint loaded'; setLog('Restored local world checkpoint, including PRNG state.'); updateUI(); draw(); }
        } catch (error) { setLog(`Load failed; current state was left unchanged (${error.message}).`); }
      });
      $('json').addEventListener('click', () => {
        download(`infinite-becoming-state-seed-${sim.seed}-t${sim.tick}.json`, JSON.stringify(sim.snapshot(), null, 2), 'application/json');
        setLog('Exported a reproducible JSON checkpoint.');
      });
      $('csv').addEventListener('click', () => {
        const csv = sim.exportCSV();
        if (!csv) { setLog('No telemetry available to export.'); return; }
        download(`infinite-becoming-telemetry-seed-${sim.seed}.csv`, csv, 'text/csv;charset=utf-8');
        setLog(`Exported ${sim.history.length} telemetry rows.`);
      });
      $('pathogen').addEventListener('click', () => {
        const id = sim.introducePathogen();
        setLog(id === null ? 'No susceptible agents remain.' : `Introduced infection into agent #${id}.`);
      });
      $('bloom').addEventListener('click', () => { sim.perturbV(0.28); setLog('Applied an external perturbation to dimensionless V.'); });
      $('preset-save').addEventListener('click', () => {
        try {
          const preset = presetLibrary.saveCurrent($('preset-name').value, sim);
          refreshPresetList(); $('preset-list').value = preset.name; previewCustomPreset();
          setLog(`Saved parameter preset “${preset.name}” (parameters and seed only; not the current world).`);
        } catch (error) { setLog(`Preset save failed: ${error.message}`); }
      });
      $('preset-refresh').addEventListener('click', () => { refreshPresetList(); previewCustomPreset(); });
      $('preset-list').addEventListener('change', previewCustomPreset);
      $('preset-load').addEventListener('click', () => {
        try {
          const name = $('preset-list').value;
          if (!name) return setLog('Select a parameter preset first.');
          const preset = presetLibrary.apply(name, sim);
          selectedId = null; running = true; syncPauseButton();
          $('preset-status').textContent = `Applied ${preset.name} · seed ${sim.seed}`;
          $('custom-preview').textContent = `Applied to current run: ${preset.name} · seed ${preset.seed} · F ${preset.F.toFixed(4)} · K ${preset.K.toFixed(4)} · DU ${preset.DU.toFixed(3)} · DV ${preset.DV.toFixed(3)}. Full world reset; preset itself stores parameters only.`;
          setLog(`Loaded parameter preset “${preset.name}”; full run reset to recorded seed ${sim.seed}.`);
          updateUI(); draw();
        } catch (error) { setLog(`Preset load failed: ${error.message}`); }
      });
      $('preset-delete').addEventListener('click', () => {
        try {
          const name = $('preset-list').value;
          if (!name) return setLog('Select a parameter preset first.');
          if (!presetLibrary.delete(name)) return setLog('Preset was not found.');
          refreshPresetList(); previewCustomPreset(); setLog(`Deleted parameter preset “${name}”.`);
        } catch (error) { setLog(`Preset delete failed: ${error.message}`); }
      });
      $('preset-export').addEventListener('click', () => {
        try {
          const name = $('preset-list').value;
          if (!name) return setLog('Select a parameter preset first.');
          download(`infinite-becoming-parameters-${name.replace(/[^a-z0-9_-]+/gi, '_')}.json`, presetLibrary.exportJSON(name), 'application/json');
          setLog(`Exported parameter preset “${name}”; this is not a full world checkpoint.`);
        } catch (error) { setLog(`Preset export failed: ${error.message}`); }
      });
      $('preset-import').addEventListener('click', () => $('preset-file').click());
      $('preset-clear').addEventListener('click', () => {
        try {
          if (!presetLibrary.list().length) return setLog('There are no saved parameter presets to clear.');
          if (!window.confirm('Clear all saved parameter presets from this browser?')) return;
          presetLibrary.clear(); refreshPresetList(); previewCustomPreset(); setLog('Cleared all saved parameter presets. The current world was not changed.');
        } catch (error) { setLog(`Preset clear failed: ${error.message}`); }
      });
      $('preset-file').addEventListener('change', event => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (file.size > 4096) { setLog('Preset import rejected: file exceeds the 4 KB limit.'); event.target.value = ''; return; }
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const preset = presetLibrary.importJSON(String(reader.result));
            refreshPresetList(); $('preset-list').value = preset.name; previewCustomPreset();
            setLog(`Imported parameter preset “${preset.name}”; it is selected for review, not loaded or applied.`);
          } catch (error) { setLog(`Preset import rejected; nothing applied: ${error.message}`); }
        };
        reader.onerror = () => setLog('Preset import failed: could not read the file.');
        reader.readAsText(file);
        event.target.value = '';
      });
      motionPreference.addEventListener?.('change', event => {
        if (!event.matches || !running) return;
        running = false;
        syncPauseButton();
        setLog('Paused because the reduced-motion preference was enabled. Press Resume to run the simulation.');
      });
      window.addEventListener('resize', fitCanvas);
      $('feed-rate').min = REACTION_LIMITS.F_MIN; $('feed-rate').max = REACTION_LIMITS.F_MAX;
      $('kill-rate').min = REACTION_LIMITS.K_MIN; $('kill-rate').max = REACTION_LIMITS.K_MAX;
      $('diff-u').min = DIFFUSION_LIMITS.DU_MIN; $('diff-u').max = DIFFUSION_LIMITS.DU_MAX;
      $('diff-v').min = DIFFUSION_LIMITS.DV_MIN; $('diff-v').max = DIFFUSION_LIMITS.DV_MAX;
      refreshPresetList(); previewBuiltInPreset(); previewCustomPreset(); fitCanvas(); syncPauseButton();
      if (motionPreference.matches) setLog('Reduced-motion preference detected; simulation starts paused. Press Resume to run.');
      updateUI(); animate();
    })();
