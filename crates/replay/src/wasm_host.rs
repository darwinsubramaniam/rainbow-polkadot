//! Runs `sim.wasm` through `wasmi` — the same path the TEE verifier takes.
//!
//! `wasmi` is an interpreter, not a JIT. That matters here: there is no
//! optimising backend that could, in principle, reassociate anything. It
//! executes the module's instructions as written, which is exactly the property
//! an attestation should be built on.

use anyhow::{Context, Result, bail};
use sim::LogEntry;
use wasmi::{Engine, Instance, Linker, Memory, Module, Store};

pub const LOG_ENTRY_SIZE: usize = 8;
const VERIFY_OUT_SIZE: usize = 24;

pub struct WasmSim {
    store: Store<()>,
    instance: Instance,
    memory: Memory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifyOut {
    pub score: u64,
    pub state_hash: u64,
    pub tick: u32,
    pub over: u32,
}

impl WasmSim {
    pub fn load(wasm: &[u8]) -> Result<Self> {
        let engine = Engine::default();
        let module = Module::new(&engine, wasm).context("sim.wasm failed to parse")?;
        let mut store = Store::new(&engine, ());
        let linker = <Linker<()>>::new(&engine);
        let instance = linker
            .instantiate_and_start(&mut store, &module)
            .context("sim.wasm failed to instantiate")?;
        let memory = instance
            .get_memory(&store, "memory")
            .context("sim.wasm exports no linear memory")?;

        let mut me = WasmSim {
            store,
            instance,
            memory,
        };
        me.check_rules_agree()?;
        Ok(me)
    }

    /// Assert the module agrees with the natively linked crate about the rules.
    ///
    /// A stale `sim.wasm` next to a rebuilt native crate is the single most
    /// likely way to get a confusing determinism failure, and it is not a real
    /// divergence. Catching it here turns a mystery into an error message.
    fn check_rules_agree(&mut self) -> Result<()> {
        let abi = self.call0("sim_abi_version")?;
        if abi != 2 {
            bail!("sim.wasm ABI version {abi}, expected 2 — rebuild it");
        }
        let max_ticks = self.call0("sim_max_ticks")?;
        if max_ticks != sim::MAX_TICKS {
            bail!(
                "rules mismatch: sim.wasm MAX_TICKS={max_ticks}, native={} — sim.wasm is stale",
                sim::MAX_TICKS
            );
        }
        let buttons = self.call0("sim_valid_buttons")?;
        if buttons != sim::VALID_BUTTONS as u32 {
            bail!(
                "rules mismatch: sim.wasm VALID_BUTTONS={buttons:#x}, native={:#x} — sim.wasm is stale",
                sim::VALID_BUTTONS
            );
        }
        Ok(())
    }

    fn call0(&mut self, name: &str) -> Result<u32> {
        let f = self
            .instance
            .get_typed_func::<(), u32>(&self.store, name)
            .with_context(|| format!("sim.wasm exports no {name}()"))?;
        Ok(f.call(&mut self.store, ())?)
    }

    fn alloc(&mut self, len: usize) -> Result<u32> {
        if len == 0 {
            return Ok(0);
        }
        let f = self
            .instance
            .get_typed_func::<u32, u32>(&self.store, "sim_alloc")?;
        let ptr = f.call(&mut self.store, len as u32)?;
        if ptr == 0 {
            bail!("sim_alloc({len}) returned null");
        }
        Ok(ptr)
    }

    fn dealloc(&mut self, ptr: u32, len: usize) -> Result<()> {
        if ptr == 0 || len == 0 {
            return Ok(());
        }
        let f = self
            .instance
            .get_typed_func::<(u32, u32), ()>(&self.store, "sim_dealloc")?;
        f.call(&mut self.store, (ptr, len as u32))?;
        Ok(())
    }

    fn write_log(&mut self, log: &[LogEntry]) -> Result<(u32, usize)> {
        let bytes = encode_log(log);
        let ptr = self.alloc(bytes.len())?;
        if !bytes.is_empty() {
            self.memory
                .write(&mut self.store, ptr as usize, &bytes)
                .context("writing log into wasm memory")?;
        }
        Ok((ptr, bytes.len()))
    }

    /// Validate and replay, returning what the enclave would learn.
    pub fn verify(&mut self, seed: u64, log: &[LogEntry]) -> Result<Result<VerifyOut, i32>> {
        let (log_ptr, log_bytes) = self.write_log(log)?;
        let out_ptr = self.alloc(VERIFY_OUT_SIZE)?;

        let f = self
            .instance
            .get_typed_func::<(u64, u32, u32, u32), i32>(&self.store, "sim_verify")?;
        let status = f.call(
            &mut self.store,
            (seed, log_ptr, log.len() as u32, out_ptr),
        )?;

        let result = if status < 0 {
            Err(status)
        } else {
            let mut buf = [0u8; VERIFY_OUT_SIZE];
            self.memory.read(&self.store, out_ptr as usize, &mut buf)?;
            Ok(VerifyOut {
                score: u64::from_le_bytes(buf[0..8].try_into().unwrap()),
                state_hash: u64::from_le_bytes(buf[8..16].try_into().unwrap()),
                tick: u32::from_le_bytes(buf[16..20].try_into().unwrap()),
                over: u32::from_le_bytes(buf[20..24].try_into().unwrap()),
            })
        };

        self.dealloc(out_ptr, VERIFY_OUT_SIZE)?;
        self.dealloc(log_ptr, log_bytes)?;
        Ok(result)
    }

    /// Replay, collecting one state hash per tick.
    pub fn trace(&mut self, seed: u64, log: &[LogEntry]) -> Result<Result<Vec<u64>, i32>> {
        let cap = sim::MAX_TICKS as usize;
        let (log_ptr, log_bytes) = self.write_log(log)?;
        let out_ptr = self.alloc(cap * 8)?;

        let f = self
            .instance
            .get_typed_func::<(u64, u32, u32, u32, u32), i32>(&self.store, "sim_trace")?;
        let status = f.call(
            &mut self.store,
            (seed, log_ptr, log.len() as u32, out_ptr, cap as u32),
        )?;

        let result = if status < 0 {
            Err(status)
        } else {
            let n = status as usize;
            let mut raw = vec![0u8; n * 8];
            self.memory.read(&self.store, out_ptr as usize, &mut raw)?;
            Ok(raw
                .chunks_exact(8)
                .map(|c| u64::from_le_bytes(c.try_into().unwrap()))
                .collect())
        };

        self.dealloc(out_ptr, cap * 8)?;
        self.dealloc(log_ptr, log_bytes)?;
        Ok(result)
    }
}

pub fn encode_log(log: &[LogEntry]) -> Vec<u8> {
    let mut out = Vec::with_capacity(log.len() * LOG_ENTRY_SIZE);
    for e in log {
        out.extend_from_slice(&e.tick.to_le_bytes());
        out.extend_from_slice(&(e.buttons as u32).to_le_bytes());
    }
    out
}
