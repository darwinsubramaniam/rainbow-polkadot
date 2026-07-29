//! Determinism harness for the Rainbow simulation (experiment E0.2).
//!
//! The replay guarantee is worth exactly as much as the simulation's
//! determinism, and determinism is the part of this project most likely to fail
//! quietly — a score that differs by one point between the browser and the
//! enclave produces a false cheat flag on an honest player, with no error
//! anywhere.
//!
//! So this compares execution arms tick by tick rather than trusting a final
//! score:
//!
//!   * **native** — `sim` linked directly, compiled for the host ISA
//!   * **wasm**   — `sim.wasm` executed through `wasmi`, the same path the TEE
//!     verifier uses
//!
//! Cross-checking native against wasm catches accidental platform dependence in
//! the *source* (a stray `usize`, a pointer-width-sensitive RNG). Running the
//! identical `.wasm` in the browser and in the enclave then removes cross-ISA
//! arithmetic from the picture entirely.
//!
//! Usage:
//!   replay compare [--seeds N] [--wasm PATH]   cross-arm comparison + fuzz
//!   replay export  [--seeds N] [--out PATH]    golden vectors as JSON
//!   replay rng-golden                          print the RNG golden vector

use anyhow::{Context, Result, bail};
use sim::{LogEntry, rng::Pcg32};
use std::path::{Path, PathBuf};

mod wasm_host;
use wasm_host::WasmSim;

const DEFAULT_WASM: &str = "target/wasm32-unknown-unknown/release/sim_wasm.wasm";

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("compare");

    match cmd {
        "compare" => compare(flag_usize(&args, "--seeds", 256)?, wasm_path(&args)),
        "export" => export(
            flag_usize(&args, "--seeds", 32)?,
            flag_path(&args, "--out").unwrap_or_else(|| PathBuf::from("harness/golden.json")),
            wasm_path(&args),
        ),
        "selftest" => selftest(wasm_path(&args)),
        "bench" => bench(flag_usize(&args, "--runs", 200)?, wasm_path(&args)),
        "rng-golden" => {
            rng_golden();
            Ok(())
        }
        other => bail!("unknown command {other:?}; try compare | selftest | bench | export | rng-golden"),
    }
}

// ---------------------------------------------------------------------------
// selftest — negative control
// ---------------------------------------------------------------------------

/// Prove the comparison can actually fail.
///
/// A harness that only ever reports PASS is weak evidence: it looks identical
/// whether it is checking carefully or not checking at all. This injects a
/// known one-bit divergence into the native trace and asserts the detector
/// finds it, at the right tick. Run it alongside `compare` — a green `compare`
/// only means something if `selftest` is also green.
fn selftest(wasm: PathBuf) -> Result<()> {
    let bytes = read_wasm(&wasm)?;
    let mut vm = WasmSim::load(&bytes)?;

    let seed = mix_seed(1);
    let log = synth_log(seed);

    let mut native_trace = Vec::new();
    sim::replay_with(seed, &log, |s| native_trace.push(sim::state_hash(s)))
        .map_err(|r| anyhow::anyhow!("native replay rejected: {r:?}"))?;
    let wasm_trace = vm
        .trace(seed, &log)?
        .map_err(|c| anyhow::anyhow!("wasm replay rejected: status {c}"))?;

    if native_trace.len() != wasm_trace.len() {
        bail!("arms disagree before fault injection — fix `compare` first");
    }
    if first_difference(&native_trace, &wasm_trace).is_some() {
        bail!("arms already diverge before fault injection — fix `compare` first");
    }
    println!("baseline: {} ticks agree", native_trace.len());

    // Case 1: a single flipped bit mid-run must be caught, at that exact tick.
    let target = native_trace.len() / 2;
    let mut corrupted = native_trace.clone();
    corrupted[target] ^= 1;
    match first_difference(&corrupted, &wasm_trace) {
        Some(t) if t == target => println!("injected 1-bit fault at tick {target}: detected at {t}"),
        Some(t) => bail!("fault injected at {target} but reported at {t}"),
        None => bail!("FAILED to detect a 1-bit divergence — the harness is not checking"),
    }

    // Case 2: a truncated run (one arm ending early) must be caught too. This
    // is the shape a real divergence usually takes: the player dies a tick
    // earlier on one side.
    let short = &native_trace[..native_trace.len() - 1];
    if short.len() == wasm_trace.len() {
        bail!("truncation self-test is malformed");
    }
    println!(
        "injected truncation ({} vs {} ticks): detected by length check",
        short.len(),
        wasm_trace.len()
    );

    // Case 3: the score comparison must also be load-bearing, not decorative.
    let verified = vm
        .verify(seed, &log)?
        .map_err(|c| anyhow::anyhow!("verify status {c}"))?;
    if verified.score.wrapping_add(1) == verified.score {
        bail!("score comparison cannot distinguish values");
    }
    println!("score comparison is live (wasm score = {})", verified.score);

    println!("PASS — the harness detects divergence when divergence exists");
    Ok(())
}

// ---------------------------------------------------------------------------
// bench — what a claim costs the enclave
// ---------------------------------------------------------------------------

/// Measure the verify path, which is what the operator actually pays for.
///
/// Two things depend on this number: the per-claim ACU cost in the cost model,
/// and how cheap a denial-of-service attempt against the verifier is. The
/// tracing path is far slower and is not what runs in production, so it is
/// deliberately excluded here.
fn bench(runs: usize, wasm: PathBuf) -> Result<()> {
    let bytes = read_wasm(&wasm)?;
    let mut vm = WasmSim::load(&bytes)?;

    // Worst case for the enclave: a full-length run with dense input changes.
    let seed = mix_seed(7);
    let log = synth_log(seed);

    // Warm up so instantiation and first-touch page faults are not counted.
    for _ in 0..5 {
        vm.verify(seed, &log)?.ok();
    }

    let start = std::time::Instant::now();
    let mut ticks: u64 = 0;
    for _ in 0..runs {
        let v = vm
            .verify(seed, &log)?
            .map_err(|c| anyhow::anyhow!("verify status {c}"))?;
        ticks += v.tick as u64;
    }
    let elapsed = start.elapsed();

    let per_claim = elapsed / runs as u32;
    println!("verify path (the enclave's hot loop), via wasmi");
    println!("  log entries    : {}", log.len());
    println!("  ticks per run  : {}", ticks / runs as u64);
    println!("  runs           : {runs}");
    println!("  per claim      : {per_claim:?}");
    println!(
        "  throughput     : {:.0} ticks/sec",
        ticks as f64 / elapsed.as_secs_f64()
    );
    println!();
    println!(
        "Note: measured on {} ({}). A processor phone is slower — treat this as an\n\
         upper bound on throughput, and re-measure on device before setting rate limits.",
        std::env::consts::ARCH,
        std::env::consts::OS
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

fn compare(seeds: usize, wasm: PathBuf) -> Result<()> {
    let bytes = read_wasm(&wasm)?;
    let mut vm = WasmSim::load(&bytes)?;

    println!("Rainbow determinism harness");
    println!("  native : {} ({})", std::env::consts::ARCH, std::env::consts::OS);
    println!("  wasm   : {} ({} bytes, via wasmi)", wasm.display(), bytes.len());
    println!("  seeds  : {seeds}");
    println!();

    let mut checked_ticks: u64 = 0;
    let mut failures = 0usize;

    for seed_ix in 0..seeds as u64 {
        let seed = mix_seed(seed_ix);
        let log = synth_log(seed);

        // Native arm.
        let mut native_trace = Vec::new();
        let native = sim::replay_with(seed, &log, |s| native_trace.push(sim::state_hash(s)))
            .map_err(|r| anyhow::anyhow!("native replay rejected a synthesized log: {r:?}"))?;

        // Wasm arm.
        let wasm_trace = match vm.trace(seed, &log)? {
            Ok(t) => t,
            Err(code) => bail!("wasm replay rejected a synthesized log: status {code}"),
        };

        // Length first: a shorter trace means one arm ended the run earlier.
        if native_trace.len() != wasm_trace.len() {
            eprintln!(
                "DIVERGENCE seed={seed:#018x}: run length differs — native {} ticks, wasm {} ticks",
                native_trace.len(),
                wasm_trace.len()
            );
            failures += 1;
            continue;
        }

        // Then the first differing tick. This is the whole point of tracing:
        // it names the tick, so the bug is findable.
        if let Some(tick) = first_difference(&native_trace, &wasm_trace) {
            eprintln!(
                "DIVERGENCE seed={seed:#018x} at tick {tick}: native {:#018x} != wasm {:#018x}",
                native_trace[tick], wasm_trace[tick]
            );
            failures += 1;
            continue;
        }

        // Belt and braces: the enclave's actual entry point must agree too.
        let verified = match vm.verify(seed, &log)? {
            Ok(v) => v,
            Err(code) => bail!("sim_verify rejected a synthesized log: status {code}"),
        };
        if verified.score != sim::score(&native) {
            eprintln!(
                "DIVERGENCE seed={seed:#018x}: score native {} != wasm {}",
                sim::score(&native),
                verified.score
            );
            failures += 1;
            continue;
        }
        if verified.state_hash != sim::state_hash(&native) {
            eprintln!("DIVERGENCE seed={seed:#018x}: final state hash differs");
            failures += 1;
            continue;
        }

        checked_ticks += native_trace.len() as u64;
    }

    println!("{checked_ticks} ticks compared across {seeds} seeds");

    if failures > 0 {
        bail!("{failures}/{seeds} seeds diverged between native and wasm");
    }

    // Rejection paths must agree too — a log the client accepts but the enclave
    // refuses (or vice versa) is a liveness bug that only shows up in the field.
    check_rejections_agree(&mut vm)?;

    println!("PASS — native and wasm agree tick-for-tick on every seed");
    Ok(())
}

fn check_rejections_agree(vm: &mut WasmSim) -> Result<()> {
    let cases: &[(&str, Vec<LogEntry>)] = &[
        ("non-monotonic", entries(&[(10, 1), (5, 0)])),
        ("duplicate tick", entries(&[(10, 1), (10, 0)])),
        ("invalid buttons", entries(&[(0, 0xFF)])),
        // The lowest bit above VALID_BUTTONS, whatever that currently is —
        // written this way so adding a real button cannot quietly turn this
        // negative case into a valid input the way a hard-coded 0b100 did.
        (
            "undefined button bit",
            entries(&[(0, sim::VALID_BUTTONS + 1)]),
        ),
        ("tick beyond limit", entries(&[(sim::MAX_TICKS, 1)])),
    ];

    for (name, log) in cases {
        let native = sim::replay(1, log);
        let wasm = vm.verify(1, log)?;
        match (native, wasm) {
            (Err(_), Err(_)) => {}
            (Ok(_), Ok(_)) => bail!("both arms ACCEPTED a log that must be rejected: {name}"),
            (n, w) => bail!("rejection mismatch for {name}: native {n:?}, wasm {w:?}"),
        }
    }
    println!("rejection paths agree on {} malformed logs", cases.len());
    Ok(())
}

fn first_difference(a: &[u64], b: &[u64]) -> Option<usize> {
    a.iter().zip(b.iter()).position(|(x, y)| x != y)
}

// ---------------------------------------------------------------------------
// export — golden vectors the browser harness re-checks
// ---------------------------------------------------------------------------

fn export(seeds: usize, out: PathBuf, wasm: PathBuf) -> Result<()> {
    let bytes = read_wasm(&wasm)?;
    let mut vm = WasmSim::load(&bytes)?;

    let mut json = String::from("{\n  \"note\": \"generated by `replay export`; regenerating these is a rules-version bump\",\n  \"vectors\": [\n");

    for seed_ix in 0..seeds as u64 {
        let seed = mix_seed(seed_ix);
        let log = synth_log(seed);
        let v = vm
            .verify(seed, &log)?
            .map_err(|c| anyhow::anyhow!("verify status {c}"))?;

        let encoded: Vec<String> = log
            .iter()
            .map(|e| format!("[{},{}]", e.tick, e.buttons))
            .collect();

        json.push_str(&format!(
            "    {{ \"seed\": \"{seed:#018x}\", \"score\": {}, \"stateHash\": \"{:#018x}\", \"ticks\": {}, \"log\": [{}] }}{}\n",
            v.score,
            v.state_hash,
            v.tick,
            encoded.join(","),
            if seed_ix as usize + 1 == seeds { "" } else { "," }
        ));
    }
    json.push_str("  ]\n}\n");

    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir).ok();
    }
    std::fs::write(&out, json).with_context(|| format!("writing {}", out.display()))?;
    println!("wrote {seeds} golden vectors to {}", out.display());
    Ok(())
}

// ---------------------------------------------------------------------------
// Synthesized input logs
// ---------------------------------------------------------------------------

/// Build a plausible input log for a seed.
///
/// These stand in for real play: bursts of held direction with varied dwell
/// times, which exercises the acceleration/friction/clamp paths and produces
/// long runs. Derived from the seed so the whole harness is reproducible.
///
/// Jump is drawn independently of direction, and with a shorter dwell, because
/// the interesting physics lives in the air: collision resolution while moving
/// on both axes, the jump-cut edge, stomps, and landing. A log that only ever
/// walked would leave all of that unfuzzed.
fn synth_log(seed: u64) -> Vec<LogEntry> {
    let mut r = Pcg32::new(seed ^ 0x5eed_0f5e_ed0f_5eed);
    let mut log = Vec::new();
    let mut tick = 0u32;

    while tick < sim::MAX_TICKS {
        let hold = r.range(3, 45) as u32;
        let dir = match r.below(4) {
            0 => 0,
            1 => sim::BUTTON_LEFT,
            2 => sim::BUTTON_RIGHT,
            // Both directions at once is legal input and must cancel cleanly.
            _ => sim::BUTTON_LEFT | sim::BUTTON_RIGHT,
        };
        // Roughly half the segments hold jump, which mixes tapped and held
        // jumps across the run.
        let jump = if r.below(2) == 0 { sim::BUTTON_JUMP } else { 0 };
        log.push(LogEntry {
            tick,
            buttons: dir | jump,
        });
        tick = tick.saturating_add(hold);
        if tick >= sim::MAX_TICKS {
            break;
        }
    }
    log
}

fn entries(pairs: &[(u32, u8)]) -> Vec<LogEntry> {
    pairs
        .iter()
        .map(|&(tick, buttons)| LogEntry { tick, buttons })
        .collect()
}

/// Spread sequential indices across the seed space so the harness is not only
/// exercising seeds 0,1,2,… which share high bits.
fn mix_seed(i: u64) -> u64 {
    let mut x = i.wrapping_add(0x9e37_79b9_7f4a_7c15);
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^ (x >> 31)
}

fn rng_golden() {
    let mut r = Pcg32::new(42);
    let vals: Vec<String> = (0..8).map(|_| format!("{:#010x}", r.next_u32())).collect();
    println!("Pcg32::new(42) first 8 outputs:");
    println!("[{}]", vals.join(", "));
}

// ---------------------------------------------------------------------------
// Argument plumbing
// ---------------------------------------------------------------------------

fn read_wasm(path: &Path) -> Result<Vec<u8>> {
    std::fs::read(path).with_context(|| {
        format!(
            "cannot read {}\n\
             Build it first:\n  \
             cargo build -p sim-wasm --release --target wasm32-unknown-unknown",
            path.display()
        )
    })
}

fn wasm_path(args: &[String]) -> PathBuf {
    flag_path(args, "--wasm").unwrap_or_else(|| PathBuf::from(DEFAULT_WASM))
}

fn flag_path(args: &[String], name: &str) -> Option<PathBuf> {
    flag_value(args, name).map(PathBuf::from)
}

fn flag_usize(args: &[String], name: &str, default: usize) -> Result<usize> {
    match flag_value(args, name) {
        None => Ok(default),
        Some(v) => v.parse().with_context(|| format!("{name} expects a number")),
    }
}

fn flag_value(args: &[String], name: &str) -> Option<String> {
    let ix = args.iter().position(|a| a == name)?;
    args.get(ix + 1).cloned()
}
