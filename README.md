# Infinite Becoming — synthetic ecosystem game

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23423943.svg)](https://doi.org/10.5281/zenodo.23423943)

A small, local, browser-playable ecosystem toy prepared for Spark. It runs without third-party runtime dependencies and makes no claim to simulate consciousness or predict real ecosystems.

**Play online:** https://sparkainlp-x.github.io/infinite-becoming/

## Run locally

Serve this folder with a local static server so the local content security policy and separate source files load consistently:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Play

- **Pause / Resume, Step, Reset, and speed** control the simulation clock. Reset repeats the current seed deterministically within the same browser engine; **New seed & reset** starts a different run with a new seed.
- Click a lifeform on the field to inspect its role, energy, age, traits, damage, and reproduction count.
- **Introduce pathogen** seeds infection in one susceptible agent. **Perturb V field** applies a direct field disturbance; V remains a dimensionless state variable, not a literal food stock.
- Tune baseline **F/K** and diffusion **DU/DV**. Requested and active **Δt** are displayed but have no direct slider. Parameter sets and saved presets reset the full run to their recorded seed. The timestep guard estimates a diffusion-only limit; it does not establish nonlinear stability.
- **Save state / Load state** uses browser local storage for a full checkpoint. JSON export is also a full checkpoint, but the UI does not import world-checkpoint JSON; CSV export contains recorded telemetry. The separate preset library stores parameters and seed only. Parameter-preset JSON imports are checked and selected for review before application.

The canvas and controls work locally. State remains in this browser unless you explicitly export it; no network service is used by the game.

## Synthetic mechanics

- A periodic 2-D reaction–diffusion substrate supplies dimensionless U/V fields. Agents use an invented V-intake rule, compete for local intake, and interact through bounded foraging, movement, predation, two-parent reproduction with inherited/mutated traits, disease, aging, and mortality.
- Each agent has a coarse private memory trace of observed V. A small set of shared cues can be adjusted by experience, inherited imperfectly by offspring, and copied by nearby juveniles. These are game-state variables, not evidence about learning or intelligence.
- Seasonality changes illustrative temperature and applies a small bounded, phase-aligned F/K modulation around baseline values. It is therefore a bundled condition rather than a temperature-only experiment.
- Toroidal geometry is used consistently for sensing, distance, movement, and contact. Feeding and infection exposure are staged to avoid array-order dependence and same-tick infection cascades.

## Frozen baseline persistence regression

The checked-in regression uses the fixed seeds `20261015`–`20261019`, a 1,200-tick horizon, and a persistence criterion requiring at least one agent at every tick from 1,101 through 1,200. The observed result is **1/5 seeds (20%)** meeting that criterion (seed `20261015`). This is a disclosed synthetic code-test result, not a general ecological viability estimate. V reseeding is zero by default and excluded from these baseline runs.

## Limitations

- U/V are not literal nutrient/biomass measurements; traits, energy, disease, reproduction, seasonal effects, and ecological couplings are synthetic and uncalibrated.
- No empirical fitting or ecological prediction is intended. Built-in parameter sets are just parameter starting points; they do not promise named pattern outcomes.
- The timestep guard is a conservative diffusion-only forward-Euler estimate for a unit-grid five-point Laplacian. Nonlinear reactions, clipping, and coupled agent behavior need separate stability and convergence investigation. Agent rules and seasonal cycles still advance per model tick, so aligning substrate time does not make all simulation conditions equivalent.
- Reproduction is an abstract two-parent pairing rule. The game does not model biological sex, ornaments, or mating preferences.
- Checkpoint schema version 4 is strict and transactional. Older version-2 and version-3 world checkpoints are not compatible; parameter presets have their own versioned schema.

## Tests

Run the Node.js regression suite:

```sh
npm test
```

The suite covers deterministic runs and exact save/load continuation (including PRNG state), strict checkpoint-field rejection and storage bounds, bounded substrate and agents, same-tick birth caps, toroidal movement, motility, timestep behavior, infection staging, simultaneous feeding, synthetic memory and cue transfer, parameter-preset import/application, UI accessibility/documentation checks, and fixed spatial-permutation invariants.

## License

Licensed under **AGPL-3.0-only**; see [`LICENSE`](LICENSE). The project has no third-party runtime dependencies.

## DOI

Concept DOI (all versions): [10.5281/zenodo.23423943](https://doi.org/10.5281/zenodo.23423943). Version DOI for v0.1.0: [10.5281/zenodo.23423944](https://doi.org/10.5281/zenodo.23423944).
